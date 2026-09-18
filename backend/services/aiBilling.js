// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Stripe metered-billing scaffold for Claude AI overage.
//
// STATUS: scaffolded only. Disabled by default via the
// STRIPE_AI_BILLING_ENABLED env-var gate. When disabled, the push job
// LOGS what it would have done and returns early — no Stripe API calls,
// no customer impact. The point is to land the seam in production so we
// can flip a single env var to activate it once the Stripe Meter is
// configured.
//
// HOW IT WORKS (when activated):
//   1. On the 1st of each month, the cron in backend/index.js calls
//      pushMonthlyUsageToStripe().
//   2. We aggregate every org's last-completed-month ai_usage_events
//      total_charged_usd_micro via aiMetering.summarizeLastMonthAllOrgs().
//   3. For each org with a stripe_customer_id (migration 063), we post
//      ONE meter event to Stripe with quantity = charged_usd_micro / 10000
//      (so one "unit" on the meter = $0.01 / one cent of customer-facing
//      charge). Stripe's invoice line item picks it up automatically when
//      the meter is attached to the org's subscription as an overage
//      component.
//   4. The first push for a given (org, month) carries an idempotency key
//      ai-billing-<orgId>-<YYYY-MM> so a re-run of the cron after a
//      partial failure doesn't double-bill.
//
// ACTIVATION PATH — see INTEGRATION_PLAYBOOKS.md §9.
//   1. Create a Stripe Meter, e.g. event_name="ai_overage_tokens",
//      display_name="AI overage", unit_label="cent" (or whatever Stripe
//      calls a per-unit listing today).
//   2. Add it to each tier's subscription product as an overage component
//      priced at $0.01/unit (so 1 unit ≈ 1 cent on the invoice).
//   3. Set env: STRIPE_AI_BILLING_ENABLED=true,
//      STRIPE_AI_METER_NAME=ai_overage_tokens.
//   4. Trigger pushMonthlyUsageToStripe() manually once to backfill last
//      month, then let the cron take over.

const logger = require('./logger');
const pool = require('../db');
const aiMetering = require('./aiMetering');
const stripe = require('./stripe');
const workerLease = require('./workerLease');

const ENABLED = process.env.STRIPE_AI_BILLING_ENABLED === 'true';
const METER_NAME = process.env.STRIPE_AI_METER_NAME || 'ai_overage_tokens';

function isEnabled() {
  return ENABLED;
}

/**
 * Push last-completed-month AI overage usage to Stripe meters.
 * Returns { skipped, posted, errors, results[] } so the cron can log a summary.
 *
 * The disabled path still walks the aggregation so we can verify in
 * production logs that the data shape is correct without sending events
 * (i.e. a dry-run that surfaces the same numbers a real push would).
 */
async function pushMonthlyUsageToStripe() {
  const summaries = await aiMetering.summarizeLastMonthAllOrgs();
  const periodLabel = summaries.length > 0
    ? summaries[0].periodFrom.toISOString().slice(0, 7)
    : new Date().toISOString().slice(0, 7);

  if (!ENABLED) {
    logger.info('ai_billing_disabled_dry_run', {
      orgs_with_usage: summaries.length,
      period: periodLabel,
      sample: summaries.slice(0, 3).map(s => ({
        orgId: s.orgId,
        charged_usd: s.summary.total_charged_usd,
        calls: s.summary.total_calls,
      })),
    });
    return { skipped: summaries.length, posted: 0, errors: 0, results: [], dryRun: true };
  }

  if (!stripe.isConfigured()) {
    logger.warn('ai_billing_stripe_not_configured', { orgs_with_usage: summaries.length });
    return { skipped: summaries.length, posted: 0, errors: 0, results: [], dryRun: true };
  }

  const stripeClient = require('stripe')(process.env.STRIPE_SECRET_KEY);
  let posted = 0;
  let errors = 0;
  const results = [];

  for (const { orgId, summary, periodFrom } of summaries) {
    if (summary.total_charged_usd <= 0) {
      results.push({ orgId, skipped: 'no_usage' });
      continue;
    }
    // Look up billing status + the Stripe customer id for this org.
    const cr = await pool.query(
      `SELECT stripe_customer_id, ai_billing_status FROM organizations WHERE id = $1`,
      [orgId]
    );
    // Comped orgs never get metered usage pushed — they're explicitly
    // free (Northwind, the owner's dogfood workspace). Billing them, even
    // via a meter event that may not attach to an invoice, is wrong and a
    // trust risk. Trial orgs are likewise exempt until they convert.
    const billingStatus = cr.rows[0]?.ai_billing_status;
    if (billingStatus === 'comped' || billingStatus === 'trial') {
      results.push({ orgId, skipped: `billing_status_${billingStatus}` });
      continue;
    }
    // Without a Stripe customer id we can't post a meter event.
    const stripeCustomerId = cr.rows[0]?.stripe_customer_id;
    if (!stripeCustomerId) {
      results.push({ orgId, skipped: 'no_stripe_customer' });
      continue;
    }
    const period = periodFrom.toISOString().slice(0, 7);

    // Durable idempotency (migration 152): if we've already recorded a
    // successful post for this (org, period), skip — regardless of Stripe's
    // ~24h idempotency-key window. This is what makes a manual backfill or a
    // retry days later safe: only orgs that never succeeded get re-posted.
    const already = await pool.query(
      `SELECT 1 FROM ai_billing_posts WHERE org_id = $1 AND period = $2`,
      [orgId, period]
    );
    if (already.rows.length > 0) {
      results.push({ orgId, skipped: 'already_posted' });
      continue;
    }

    // Quantity is integer cents (charged_usd × 100). Stripe meter quantities
    // must be integers; we round and clamp to ≥1 to avoid 0-quantity events.
    const quantity = Math.max(1, Math.round(summary.total_charged_usd * 100));
    const idempotencyKey = `ai-billing-${orgId}-${period}`;
    try {
      const event = await stripeClient.billing.meterEvents.create(
        {
          event_name: METER_NAME,
          payload: {
            stripe_customer_id: stripeCustomerId,
            value: String(quantity),
          },
        },
        { idempotencyKey }
      );
      // Record the successful post durably BEFORE counting it, so a crash
      // right after the Stripe call can't lose the fact that we billed. ON
      // CONFLICT DO NOTHING: if a concurrent run already recorded it, that's
      // fine — the Stripe idempotency key deduped the actual charge too.
      const eventId = event.identifier || event.id || null;
      await pool.query(
        `INSERT INTO ai_billing_posts (org_id, period, stripe_event_id, quantity_cents)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, period) DO NOTHING`,
        [orgId, period, eventId, quantity]
      );
      results.push({ orgId, posted: true, eventId, quantity });
      posted++;
    } catch (err) {
      logger.warn('ai_billing_post_failed', { orgId, error: err.message });
      results.push({ orgId, error: err.message });
      errors++;
    }
  }

  logger.info('ai_billing_push_complete', { posted, errors, period: periodLabel });
  return { skipped: 0, posted, errors, results, dryRun: false };
}

// =============================================================================
// Cron: runs every hour, fires the push only on the 1st of the month at
// the configured UTC hour. Hourly cadence keeps the implementation simple
// and is robust to single-tick outages (a missed 03:00 fires at 04:00).
// =============================================================================
// Parse with a finite-check rather than `Number(x) || 3` so an explicitly
// configured 0 (midnight UTC) isn't silently coerced back to the default.
const RUN_HOUR_UTC = (() => {
  const p = Number(process.env.STRIPE_AI_BILLING_RUN_HOUR_UTC);
  return Number.isFinite(p) ? p : 3; // 03:00 UTC = 22:00 US Central
})();
let timer = null;
let lastRunYM = null;

function shouldRunNow(now = new Date()) {
  if (now.getUTCDate() !== 1) return false;
  if (now.getUTCHours() !== RUN_HOUR_UTC) return false;
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  if (lastRunYM === ym) return false;
  return true;
}

function startScheduler({ intervalMinutes = 60 } = {}) {
  if (timer) return;
  timer = setInterval(async () => {
    if (!shouldRunNow()) return;
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    lastRunYM = ym; // in-process guard against a second tick this hour

    // Disabled = a logging dry-run with no customer impact; no cross-instance
    // guard needed (and claiming would wrongly block the first real run once
    // enabled later in the same month).
    if (!ENABLED) {
      try {
        const result = await pushMonthlyUsageToStripe();
        logger.info('ai_billing_cron_tick', { result });
      } catch (err) {
        logger.warn('ai_billing_cron_failed', { error: err.message });
      }
      return;
    }

    // Enabled: claim this (worker, month) across instances before posting real
    // meter events, so only ONE instance bills and a manual backfill run >24h
    // later (past Stripe's idempotency-key window) can't double-charge.
    let claimed = false;
    try {
      claimed = await workerLease.claim('ai_billing', ym);
    } catch (err) {
      logger.warn('ai_billing_claim_failed', { error: err.message });
      return; // if we can't confirm the claim, don't risk a double push
    }
    if (!claimed) {
      logger.info('ai_billing_already_pushed_this_month', { period: ym });
      return;
    }

    try {
      const result = await pushMonthlyUsageToStripe();
      logger.info('ai_billing_cron_tick', { result });
    } catch (err) {
      logger.warn('ai_billing_cron_failed', { error: err.message });
      // Release so a later tick this month can retry (Stripe idempotency keys
      // still protect already-posted orgs within the 24h window).
      await workerLease.release('ai_billing', ym).catch(() => {});
    }
  }, intervalMinutes * 60 * 1000);
  // Allow the process to exit without waiting on the timer.
  if (timer.unref) timer.unref();
  logger.info('ai_billing_scheduler_started', { intervalMinutes, runHourUtc: RUN_HOUR_UTC, enabled: ENABLED });
}

function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  isEnabled,
  pushMonthlyUsageToStripe,
  startScheduler,
  stopScheduler,
  shouldRunNow,
  METER_NAME,
};
