// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// AI billing gate.
//
// Sits between authMiddleware and requireFeature('ai_features_enabled') on
// /api/ai and /api/plugins. Returns HTTP 402 (Payment Required) with a
// machine-readable code + action so the frontend can route the user to the
// right CTA (start checkout / contact admin / update payment).
//
// State machine (org.ai_billing_status):
//   unconfigured → BLOCK (code: AI_BILLING_REQUIRED, action: start_billing)
//   trial        → ALLOW until ai_billing_trial_ends_at, then BLOCK
//                  (code: AI_BILLING_TRIAL_EXPIRED, action: start_billing)
//   active       → ALLOW
//   past_due     → ALLOW for 7 days from updated_at (Stripe's dunning window),
//                  then BLOCK (code: AI_BILLING_PAST_DUE, action: update_payment)
//   halted       → BLOCK (code: AI_BILLING_HALTED, action: contact_admin)
//   comped       → ALLOW (super-admin manual grant for early customers)
//   (any)        → ALLOW with status 'byo_key' when the org has stored its own
//                  Anthropic key (org_ai_keys, migration 153) — checked first.
//
// BYPASS RULE — kept deliberately simple:
//   If the requesting user has an admin_users row with role='super_admin',
//   the gate lets the request through regardless of org status or flag. The
//   alternative (every-user-in-the-org check) is fragile against future
//   schema changes. Per-user is what the rest of the codebase uses for
//   privileged paths (see platformIntegrationsRoutes.js).
//
// FEATURE FLAG: if ai_billing_required=false (set per-org via /admin/feature-
// flags), the middleware lets every request through. Legacy orgs that pre-
// date the gate keep working until an admin flips the flag on.
//
// CACHING: 30-second in-process cache keyed by orgId, mirroring featureFlags.js.
// A flag flip propagates within ~30s across pods — acceptable for billing.
//
// Fails OPEN on a DB hiccup. The alternative (deny on transient error) would
// take the whole AI surface down on a single Postgres blip, which is worse
// than the rare unbillable second.

const pool = require('../db');
const featureFlags = require('../services/featureFlags');
// Called through the module object (not destructured) so tests can stub it.
const orgAiKeys = require('../services/orgAiKeys');

const TTL_MS = 30_000;
const cache = new Map(); // orgId → { row, expiresAt }

// 7-day grace window for past_due — Stripe's default dunning is 7 days, so
// matching it means we block the day Stripe gives up. Configurable for tests.
const PAST_DUE_GRACE_DAYS = 7;

const SUPER_ADMIN_CACHE_TTL_MS = 60_000;
const superAdminCache = new Map(); // userId → { isSuper, expiresAt }

async function isSuperAdminCached(userId) {
  if (!userId) return false;
  const cached = superAdminCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.isSuper;
  let isSuper = false;
  try {
    const r = await pool.query(
      `SELECT role FROM admin_users WHERE user_id = $1`,
      [userId]
    );
    isSuper = r.rows[0]?.role === 'super_admin';
  } catch {
    // DB error → don't elevate. Caller path will still hit the failOpen below.
    isSuper = false;
  }
  superAdminCache.set(userId, { isSuper, expiresAt: Date.now() + SUPER_ADMIN_CACHE_TTL_MS });
  return isSuper;
}

async function readOrgBilling(orgId) {
  const cached = cache.get(orgId);
  if (cached && cached.expiresAt > Date.now()) return cached.row;
  const r = await pool.query(
    `SELECT id, ai_billing_status, ai_billing_subscription_id,
            ai_billing_trial_ends_at, ai_halted_reason, updated_at
       FROM organizations WHERE id = $1`,
    [orgId]
  );
  const row = r.rows[0] || null;
  cache.set(orgId, { row, expiresAt: Date.now() + TTL_MS });
  return row;
}

function bustCache(orgId) {
  if (orgId == null) {
    cache.clear();
    return;
  }
  cache.delete(orgId);
}

function _resetCachesForTests() {
  cache.clear();
  superAdminCache.clear();
}

function deny(res, verdict) {
  return res.status(402).json({
    success: false,
    error: verdict.message,
    code: verdict.code,
    action: verdict.action,
    status: verdict.status,
    trial_ends_at: verdict.trial_ends_at || null,
  });
}

function allow(status, extra = {}) {
  return { allowed: true, status, code: null, action: null, message: null, trial_ends_at: null, ...extra };
}

function block(status, code, action, message, extra = {}) {
  return { allowed: false, status, code, action, message, trial_ends_at: null, ...extra };
}

// Pure verdict: "may this org burn AI right now, and if not, why + what to
// do about it". Shared by the gate middleware below and by GET /api/ai/status
// so the frontend can render the right card BEFORE the user types a message
// instead of discovering the 402 as a raw error bubble. Never throws: any DB
// hiccup resolves to an allow with failedOpen=true, matching the gate's
// long-standing fail-open policy.
async function evaluateAiBilling({ orgId, userId, log } = {}) {
  // No org context (personal workspace): let through. There's no Stripe
  // customer to bill, same precedent as featureGate.js for org-less requests.
  // Personal accounts are rate-limited by aiLimiter at the mount regardless.
  if (!orgId) return allow('personal', { reason: 'no_org' });

  try {
    // Bring-your-own key (migration 153): the org pays Anthropic directly, so
    // there is nothing for us to bill and the pay-as-you-go card must never
    // appear. Checked first so the status probe reports 'byo_key' regardless
    // of flag / trial / past-due state. getOrgKey never throws (null on any
    // failure) and is a no-op under NODE_ENV=test unless opted in.
    if (await orgAiKeys.getOrgKey(orgId)) return allow('byo_key', { reason: 'byo_key' });

    // Super-admin always bypasses. Operator self-testing must work even when
    // the operator's own org is unbilled.
    if (await isSuperAdminCached(userId)) return allow('super_admin', { reason: 'super_admin' });

    // Flag check. hasFeature returns Boolean(f[name]) so an explicit false and
    // an unset key look identical; walk the raw map to tell them apart and
    // honor the registry default for the unset case.
    const enabled = await featureFlags.hasFeature(orgId, 'ai_billing_required');
    const flagDefaultsOn = featureFlags.KNOWN_FLAGS.find(f => f.name === 'ai_billing_required')?.defaultValue;
    const features = await featureFlags.getFeatures(orgId);
    const explicitlySet = Object.prototype.hasOwnProperty.call(features, 'ai_billing_required');
    const effectiveOn = explicitlySet ? Boolean(features.ai_billing_required) : (enabled || flagDefaultsOn !== false);
    if (!effectiveOn) return allow('ungated', { reason: 'flag_off' });

    const org = await readOrgBilling(orgId);
    if (!org) {
      // Org row missing entirely (extreme edge). Fail open with a log; better
      // than a billing 402 on a real auth misconfiguration.
      if (log) log.warn('require_ai_billing_org_missing', { orgId });
      return allow('unknown', { reason: 'org_missing', failedOpen: true });
    }

    const status = org.ai_billing_status || 'unconfigured';

    if (status === 'active' || status === 'comped') return allow(status);

    if (status === 'trial') {
      const ends = org.ai_billing_trial_ends_at ? new Date(org.ai_billing_trial_ends_at) : null;
      const endsIso = ends && !Number.isNaN(ends.getTime()) ? ends.toISOString() : null;
      if (ends && ends.getTime() > Date.now()) return allow('trial', { trial_ends_at: endsIso });
      return block(
        'trial',
        'AI_BILLING_TRIAL_EXPIRED',
        'start_billing',
        'Your AI trial has ended. Start the pay-as-you-go plan to keep using AI features.',
        { trial_ends_at: endsIso }
      );
    }

    if (status === 'past_due') {
      const updated = org.updated_at ? new Date(org.updated_at).getTime() : 0;
      const graceMs = PAST_DUE_GRACE_DAYS * 24 * 60 * 60 * 1000;
      if (Date.now() - updated < graceMs) return allow('past_due', { grace: true });
      return block(
        'past_due',
        'AI_BILLING_PAST_DUE',
        'update_payment',
        'Your AI subscription payment is past due. Update your payment method to continue.'
      );
    }

    if (status === 'halted') {
      const reason = org.ai_halted_reason || 'admin';
      const message = reason === 'payment_failed'
        ? 'AI usage is halted due to a payment failure. Update your payment method and ask your admin to resume.'
        : reason === 'auto_threshold'
        ? 'AI usage is halted because the monthly spending threshold was reached. Ask your admin to raise the threshold or resume usage.'
        : 'AI usage is halted by your organization admin.';
      return block('halted', 'AI_BILLING_HALTED', 'contact_admin', message, { halted_reason: reason });
    }

    // 'unconfigured' (or anything unknown: treat as unconfigured)
    return block(
      'unconfigured',
      'AI_BILLING_REQUIRED',
      'start_billing',
      'AI usage requires an active billing subscription. Start your pay-as-you-go plan.'
    );
  } catch (err) {
    // Transient DB / cache hiccup. Log + allow rather than nuke the surface.
    if (log) log.warn('require_ai_billing_failed_open', { error: err.message });
    return allow('unknown', { reason: 'error', failedOpen: true });
  }
}

function requireAiBilling() {
  return async function requireAiBillingMiddleware(req, res, next) {
    // Vitest bypass. Every backend test runs with NODE_ENV=test against mock
    // fixtures; the existing plugin/AI test suites set up orgs that don't carry
    // a billing row, so a gate-on default 402s them. Opt-in for a dedicated
    // billing-gate test via AI_BILLING_REQUIRED_IN_TESTS=true. Prod is never
    // NODE_ENV=test (Cloud Run sets production) so the runtime impact is zero.
    if (process.env.NODE_ENV === 'test' && process.env.AI_BILLING_REQUIRED_IN_TESTS !== 'true') {
      return next();
    }

    const verdict = await evaluateAiBilling({ orgId: req.orgId, userId: req.userId, log: req.log });
    if (verdict.allowed) return next();
    return deny(res, verdict);
  };
}

module.exports = {
  requireAiBilling,
  evaluateAiBilling,
  bustCache,
  _resetCachesForTests,
  PAST_DUE_GRACE_DAYS,
};
