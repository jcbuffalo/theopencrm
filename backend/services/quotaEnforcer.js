// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Tier-aware quota enforcement.
//
// Reads the caller's org tier from organizations.tier, looks up the matching
// limits from TIER_QUOTAS, and compares against the current-month consumption
// in usage_meter. Throws QuotaExceeded on overrun so the caller can return
// a clean 429 with an upgrade prompt.
//
// SOURCE OF TRUTH for tier limits: PLUGIN_PLATFORM_VISION.md §2.3. Update
// here when that doc updates.
//
// The check is fail-open: if the meter read errors, we let the request
// through. We'd rather over-charge a customer than under-deliver during
// a database hiccup. Real billing reconciliation happens monthly.

const pool = require('../db');
const logger = require('./logger');
const orgAiKeys = require('./orgAiKeys');
// usageMeter is intentionally NOT imported here anymore — the AI-quota
// path now reads from ai_usage_events directly. usage_meter is still
// written by services/ai.js for backward compatibility with the /usage
// page and other readers; just nothing in this file consumes it.

// Count AI calls in the current calendar month directly from the
// ai_usage_events ledger (migration 080). This is the canonical per-call
// grain — the usage_meter aggregate is a parallel write that's still kept
// for non-AI metrics. By reading from the ledger here we eliminate the
// dual-ledger divergence the docs sweep flagged (services/usageMeter.js
// vs services/aiMetering.js both counting differently and quotaEnforcer
// only seeing one of them). usage_meter writes still happen in
// services/ai.js so the existing dashboards and historical period queries
// keep working. Migration of those readers to ai_usage_events is a
// follow-up.
//
// Fail-open: any error returns 0 (which lets the request through) and
// logs. A meter outage MUST NOT take AI offline.
async function getMonthlyAiCallCount(orgId) {
  if (!orgId) return 0;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS calls
         FROM ai_usage_events
        WHERE org_id = $1
          AND created_at >= date_trunc('month', NOW())`,
      [orgId]
    );
    return Number(r.rows[0]?.calls || 0);
  } catch (err) {
    logger.warn('quota_ai_event_count_failed', { orgId, error: err.message });
    return 0;
  }
}

const TIER_QUOTAS = {
  free: {
    label: 'Free',
    ai_requests_per_user_per_month: 50,
    plugin_runs_per_org_per_month:  100,
    overageAllowed: false,
  },
  starter: {
    label: 'Starter',
    ai_requests_per_user_per_month: 500,
    plugin_runs_per_org_per_month:  5000,
    overageAllowed: true,
    overage: { ai_request_cents: 2, plugin_run_cents: 0.1 },
  },
  pro: {
    label: 'Professional',
    ai_requests_per_user_per_month: 5000,
    plugin_runs_per_org_per_month:  50000,
    overageAllowed: true,
    overage: { ai_request_cents: 1, plugin_run_cents: 0.05 },
  },
  enterprise: {
    label: 'Enterprise',
    // 'Infinity' is the placeholder for "negotiated, no enforced cap." Real
    // enterprise contracts set explicit ceilings; until we have that
    // contract integration, we don't throttle them.
    ai_requests_per_user_per_month: Infinity,
    plugin_runs_per_org_per_month:  Infinity,
    overageAllowed: true,
  },
};

class QuotaExceeded extends Error {
  constructor({ orgId, tier, metric, limit, current }) {
    super(`Quota exceeded for ${metric}: ${current}/${limit} on tier ${tier}.`);
    this.code = 'QUOTA_EXCEEDED';
    this.statusCode = 429;
    this.details = { orgId, tier, metric, limit, current };
  }
}

async function getOrgTier(orgId) {
  if (!orgId) return 'free';
  try {
    const r = await pool.query('SELECT tier FROM organizations WHERE id = $1', [orgId]);
    return r.rows[0]?.tier || 'free';
  } catch (err) {
    logger.warn('quota_enforcer_tier_lookup_failed', { orgId, error: err.message });
    return 'free';
  }
}

// One row with everything checkAiQuota needs: the tier AND the AI billing
// status (for the paying/comped exemption below). Kept as a SINGLE query so
// the mocked-pool call order in existing test suites doesn't shift — a mock
// that returns only { tier } simply yields ai_billing_status: undefined,
// which is "not exempt", i.e. the historical behavior.
async function getOrgBillingRow(orgId) {
  if (!orgId) return null;
  try {
    const r = await pool.query(
      'SELECT tier, ai_billing_status FROM organizations WHERE id = $1',
      [orgId]
    );
    return r.rows[0] || null;
  } catch (err) {
    logger.warn('quota_enforcer_tier_lookup_failed', { orgId, error: err.message });
    return null;
  }
}

/**
 * Throws QuotaExceeded if the org has hit its AI request quota for the
 * current month. The check counts the org's seats (users) so the
 * per-user-per-month allotment scales with team size.
 *
 * Fail-open on any internal error.
 */
// Org-less (personal-workspace) users also bypass the AI billing gate
// (`allow('personal')` in middleware/requireAiBilling.js) — without a cap
// here they'd have unlimited free AI bounded only by the per-IP limiter.
// Count their calls straight off the ledger by user_id.
async function getMonthlyAiCallCountForUser(userId) {
  if (!userId) return 0;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM ai_usage_events
        WHERE user_id = $1
          AND created_at >= date_trunc('month', CURRENT_TIMESTAMP)`,
      [userId]
    );
    return r.rows[0]?.n || 0;
  } catch (err) {
    logger.warn('quota_ai_user_event_count_failed', { userId, error: err.message });
    return 0; // fail-open, consistent with the org path
  }
}

// Gateway mode (spec 202): a self-hosted instance whose AI goes through the
// hosted metered proxy. The gateway enforces billing-side caps (billing
// verdict + hard cap on the platform), so the LOCAL free-tier quota must not
// double-gate — exactly like a BYO key. Gateway mode is only in effect when
// no platform ANTHROPIC_API_KEY exists (resolveApiKey order: byo → platform
// → gateway). Read per call so tests / rotation don't need a restart.
function isGatewayMode() {
  return !!process.env.OPENCRM_AI_GATEWAY_KEY && !process.env.ANTHROPIC_API_KEY;
}

async function checkAiQuota({ orgId, userId = null, userCount = 1 }) {
  // Gateway-key instances are exempt like BYO — the gateway bills and caps.
  if (isGatewayMode()) return;
  if (!orgId) {
    // No org → no billing, no tier: apply the free-tier per-user allotment
    // keyed on the user. Callers without either id stay unmetered (nothing
    // to key a quota on).
    if (!userId) return;
    const perUser = TIER_QUOTAS.free.ai_requests_per_user_per_month;
    const used = await getMonthlyAiCallCountForUser(userId);
    if (used >= perUser) {
      throw new QuotaExceeded({
        orgId: null,
        tier: 'free',
        metric: 'ai_requests',
        limit: perUser,
        current: used,
      });
    }
    return;
  }
  try {
    const row = await getOrgBillingRow(orgId);
    const tier = row?.tier || 'free';

    // EXEMPTIONS — orgs that pay for their AI usage (or bring their own
    // Anthropic key) are never capped by the free-tier allotment:
    //   • ai_billing_status = 'active' — on the metered Stripe plan; every
    //     call is billed, so a hard cap would double-punish a paying customer.
    //   • ai_billing_status = 'comped' — operator explicitly waived billing.
    //   • BYO key stored (migration 154) — the org pays Anthropic directly;
    //     our platform-cost quota is irrelevant. getOrgKey() is cached (30s)
    //     and is a no-op under NODE_ENV=test unless a suite opts in, so this
    //     adds no per-request DB load in tests and negligible load in prod.
    const billing = row?.ai_billing_status;
    if (billing === 'active' || billing === 'comped') return;
    if (await orgAiKeys.getOrgKey(orgId)) return;

    const quotas = TIER_QUOTAS[tier] || TIER_QUOTAS.free;
    const perUser = quotas.ai_requests_per_user_per_month;
    if (perUser === Infinity) return; // unmetered tier

    // Read from the per-call ai_usage_events ledger instead of the
    // usage_meter aggregate. Two reasons:
    //   1. Single source of truth — usage_meter still gets written by
    //      services/ai.js for backward compat, but its grain (YYYY-MM
    //      bucket per metric) drifts from the ledger when one writer
    //      hiccups. The ledger is the cleaner ground truth.
    //   2. The /usage page already reads from ai_usage_events, so a
    //      quota miss here vs there has been the source of "I'm not
    //      over quota on the dashboard but I'm getting 429s" support
    //      tickets.
    const used = await getMonthlyAiCallCount(orgId);

    // Effective monthly limit = per-user × seats.
    const limit = perUser * Math.max(1, userCount);

    if (used >= limit) {
      if (!quotas.overageAllowed) {
        throw new QuotaExceeded({ orgId, tier, metric: 'ai_requests', limit, current: used });
      }
      // Overage allowed → log it so we know billing should pick it up.
      logger.notice('quota_overage_ai_requests', { orgId, tier, used, limit });
    }
  } catch (err) {
    if (err instanceof QuotaExceeded) throw err;
    logger.warn('quota_check_failed', { orgId, error: err.message });
    // fail-open
  }
}

async function getSeatCount(orgId) {
  if (!orgId) return 1;
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c FROM users WHERE org_id = $1 AND status = 'active'`,
      [orgId]
    );
    return Math.max(1, r.rows[0]?.c || 1);
  } catch {
    return 1;
  }
}

module.exports = {
  TIER_QUOTAS,
  QuotaExceeded,
  getOrgTier,
  getOrgBillingRow,
  getSeatCount,
  checkAiQuota,
  getMonthlyAiCallCount,
  isGatewayMode,
};
