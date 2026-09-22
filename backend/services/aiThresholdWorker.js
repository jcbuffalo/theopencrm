// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// AI monthly spending-threshold notifier + hard-cap auto-halt.
//
// Hourly tick, two ceilings per org:
//   • SOFT (ai_monthly_threshold_usd, default $50): fire ONE admin warning per
//     (org, YYYY-MM) via adminNotify. Idempotent through
//     organizations.ai_threshold_last_warned_period.
//   • HARD (ai_monthly_hard_cap_usd, migration 162, default $200 via
//     AI_MONTHLY_HARD_CAP_DEFAULT_USD): AUTO-HALT the org — status 'halted',
//     reason 'auto_threshold' — the same state the gate
//     (middleware/requireAiBilling.js) already blocks with a "threshold
//     reached, ask your admin" message. Applies only to 'active' and 'trial'
//     orgs (comped is an explicit operator grant; BYO-key usage carries
//     charged_usd 0 and never accrues). The worker AUTO-RESUMES
//     auto_threshold-halted orgs when the month rolls over — the cap is
//     per-month, not a death sentence — restoring 'active' (live sub),
//     'trial' (unexpired trial), else 'unconfigured'; manual /billing/ai/resume
//     still works any time.
//
// HISTORY: this worker was warn-only by owner directive until 2026-09-14,
// when the owner requested the $200 auto-halt ("I don't want to give away
// infinite tokens"). The old directive is superseded.
//
// Mirror of services/aiBilling.js shape — scheduler + module exports.

const pool = require('../db');
const logger = require('./logger');
const audit = require('./audit');
const adminNotify = require('./adminNotify');
const aiMetering = require('./aiMetering');
const requireAiBilling = require('../middleware/requireAiBilling');

// NULL cap → this default. Finite-check so an explicit env 0 is honored.
const DEFAULT_HARD_CAP_USD = (() => {
  const p = Number(process.env.AI_MONTHLY_HARD_CAP_DEFAULT_USD);
  return Number.isFinite(p) ? p : 200;
})();

function currentPeriodLabel(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * One pass: walk every org with non-zero MTD AI usage; if any have crossed
 * their threshold AND haven't already been warned for this month, fire the
 * notifier + write the audit event + bump the idempotency column.
 *
 * Returns a summary so the scheduler can log a one-liner per tick.
 */
async function runOnce({ now = new Date() } = {}) {
  const period = currentPeriodLabel(now);
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  // Pull every org that has any MTD AI usage. Joining to ai_usage_events
  // restricts the worst case to orgs that have at least one row this month
  // — billing-relevant orgs only.
  let usageOrgs;
  try {
    usageOrgs = await pool.query(
      `SELECT DISTINCT org_id
         FROM ai_usage_events
        WHERE created_at >= $1 AND created_at < $2 AND org_id IS NOT NULL`,
      [from.toISOString(), to.toISOString()]
    );
  } catch (err) {
    logger.warn('ai_threshold_worker_query_failed', { error: err.message });
    return { checked: 0, warned: 0, halted: 0, resumed: 0, skipped: 0, errors: 1, period };
  }

  let warned = 0;
  let skipped = 0;
  let errors = 0;
  let halted = 0;

  // AUTO-RESUME — a fresh month means a fresh cap. Restore every org this
  // worker auto-halted in a PRIOR month: 'active' when a live subscription is
  // recorded, 'trial' when the trial hasn't expired, else 'unconfigured'
  // (same restore rule as the manual /billing/ai/resume route).
  let resumed = 0;
  try {
    const stale = await pool.query(
      `SELECT id, name, ai_billing_subscription_id, ai_billing_trial_ends_at
         FROM organizations
        WHERE ai_billing_status = 'halted'
          AND ai_halted_reason = 'auto_threshold'
          AND ai_auto_halted_period IS NOT NULL
          AND ai_auto_halted_period <> $1`,
      [period]
    );
    for (const org of stale.rows) {
      const trialLive = org.ai_billing_trial_ends_at
        && new Date(org.ai_billing_trial_ends_at).getTime() > now.getTime();
      const nextStatus = org.ai_billing_subscription_id ? 'active' : (trialLive ? 'trial' : 'unconfigured');
      // eslint-disable-next-line no-await-in-loop
      const r = await pool.query(
        `UPDATE organizations
            SET ai_billing_status = $1,
                ai_halted_at = NULL,
                ai_halted_by_user_id = NULL,
                ai_halted_reason = NULL,
                ai_auto_halted_period = NULL,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $2 AND ai_billing_status = 'halted' AND ai_halted_reason = 'auto_threshold'
          RETURNING id`,
        [nextStatus, org.id]
      );
      if (r.rows.length > 0) {
        requireAiBilling.bustCache(org.id);
        audit.record({
          event: audit.EVENTS.BILLING_AI_RESUMED,
          orgId: org.id,
          meta: { auto: true, restored_status: nextStatus, period },
        }).catch(() => {});
        resumed++;
      }
    }
  } catch (err) {
    logger.warn('ai_threshold_worker_auto_resume_failed', { error: err.message });
  }

  for (const row of usageOrgs.rows) {
    const orgId = row.org_id;
    try {
      // eslint-disable-next-line no-await-in-loop
      const orgRow = await pool.query(
        `SELECT id, name, ai_monthly_threshold_usd, ai_threshold_last_warned_period,
                ai_billing_status, ai_monthly_hard_cap_usd
           FROM organizations WHERE id = $1`,
        [orgId]
      );
      const org = orgRow.rows[0];
      if (!org) { skipped++; continue; }

      // HARD CAP — checked before the warn short-circuit so a month that
      // blows straight past both ceilings still halts even after the warn
      // already fired. Only billable statuses are subject (see header).
      if (org.ai_billing_status === 'active' || org.ai_billing_status === 'trial') {
        // Trial orgs are additionally capped by AI_TRIAL_ORG_HARD_CAP_USD
        // (migration 174 guardrails) — a stranger on a free trial should
        // never be able to spend the $200 general cap.
        const hardCap = require('./platformBudget').effectiveHardCap({
          ai_billing_status: org.ai_billing_status,
          orgCapUsd: org.ai_monthly_hard_cap_usd,
          defaultCapUsd: DEFAULT_HARD_CAP_USD,
        });
        // eslint-disable-next-line no-await-in-loop
        const capSummary = await aiMetering.summarizeMonthForOrg(
          orgId,
          now.getUTCFullYear(),
          now.getUTCMonth() + 1
        );
        const capMtd = Number(capSummary.total_charged_usd || 0);
        if (capMtd >= hardCap) {
          // Atomic claim: only flips billable statuses, so a concurrent tick
          // (or an admin racing a manual halt) can't double-fire.
          // eslint-disable-next-line no-await-in-loop
          const halt = await pool.query(
            `UPDATE organizations
                SET ai_billing_status = 'halted',
                    ai_halted_at = CURRENT_TIMESTAMP,
                    ai_halted_reason = 'auto_threshold',
                    ai_auto_halted_period = $1,
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = $2 AND ai_billing_status IN ('active', 'trial')
              RETURNING id`,
            [period, orgId]
          );
          if (halt.rows.length > 0) {
            requireAiBilling.bustCache(orgId);
            audit.record({
              event: audit.EVENTS.BILLING_AI_HALTED,
              orgId,
              meta: { auto: true, mtd_usage_usd: capMtd, hard_cap_usd: hardCap, period, prior_status: org.ai_billing_status },
            }).catch(() => {});
            // eslint-disable-next-line no-await-in-loop
            await adminNotify.send({
              event: 'signup', // reuse channel, matching the warn path
              subject: `[The Open CRM] AUTO-HALTED org ${org.name || orgId} at AI hard cap $${hardCap.toFixed(2)}`,
              html: `
                <p>Organization <b>${escapeHtml(org.name || `#${orgId}`)}</b> (id=${orgId}) was
                <b>automatically halted</b>: $${capMtd.toFixed(2)} of AI usage in ${period}, over the
                $${hardCap.toFixed(2)} monthly hard cap.</p>
                <p>The org's AI features now return the "threshold reached" message. It will
                auto-resume when the month rolls over; resume sooner or raise the cap at
                <a href="https://app.theopencrm.com/admin/ai-billing">/admin/ai-billing</a>.</p>
              `,
              text: `Org ${org.name || orgId} AUTO-HALTED at $${capMtd.toFixed(2)} (hard cap $${hardCap.toFixed(2)}, ${period}). Resume/raise at /admin/ai-billing.`,
              throttleKey: `ai_hard_cap:${orgId}:${period}`,
              meta: { orgId, mtd_usage_usd: capMtd, hard_cap_usd: hardCap, period },
            }).catch(() => {});
            halted++;
          }
          skipped++; // halted orgs don't also need the soft warn this tick
          continue;
        }
      }

      // Already warned this month — short-circuit.
      if (org.ai_threshold_last_warned_period === period) {
        skipped++;
        continue;
      }

      // Distinguish a NULL (unconfigured → default) from an explicitly set 0
      // (warn on any usage). `x || 50` would wrongly coerce a configured 0 back
      // to 50, silencing the alert the operator intended.
      const rawThreshold = org.ai_monthly_threshold_usd;
      const parsedThreshold = Number(rawThreshold);
      const threshold = (rawThreshold === null || rawThreshold === undefined || !Number.isFinite(parsedThreshold))
        ? 50
        : parsedThreshold;
      // eslint-disable-next-line no-await-in-loop
      const summary = await aiMetering.summarizeMonthForOrg(
        orgId,
        now.getUTCFullYear(),
        now.getUTCMonth() + 1
      );
      const mtd = Number(summary.total_charged_usd || 0);
      if (mtd < threshold) { skipped++; continue; }

      // CLAIM the warn for this (org, period) BEFORE sending, atomically: only
      // one instance's UPDATE flips the period, and only that instance gets a
      // row back. A second instance ticking concurrently (the earlier read
      // showed the period not yet set) loses the claim here and skips —
      // preventing a duplicate alert. `IS DISTINCT FROM` handles the NULL case.
      // eslint-disable-next-line no-await-in-loop
      const claim = await pool.query(
        `UPDATE organizations
            SET ai_threshold_last_warned_period = $1,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
            AND ai_threshold_last_warned_period IS DISTINCT FROM $1
          RETURNING id`,
        [period, orgId]
      );
      if (claim.rows.length === 0) { skipped++; continue; } // another instance won the claim

      // Fire the notification + record the audit. adminNotify failures are
      // non-fatal; the period is already claimed so a transient SMTP outage
      // doesn't cause repeated alerts later.
      // eslint-disable-next-line no-await-in-loop
      await adminNotify.send({
        event: 'signup', // reuse channel until a dedicated event lands
        subject: `[The Open CRM] Org ${org.name || orgId} crossed AI $${threshold.toFixed(2)} threshold`,
        html: `
          <p>Organization <b>${escapeHtml(org.name || `#${orgId}`)}</b> (id=${orgId}) has used
          <b>$${mtd.toFixed(2)}</b> of AI in ${period} — above its
          <b>$${threshold.toFixed(2)}</b> monthly threshold.</p>
          <p>Review or halt usage at <a href="https://app.theopencrm.com/admin/ai-billing">/admin/ai-billing</a>.</p>
          <p>This is a warn-only alert. No automatic halt was applied (per
          configuration). To halt, use the Halt button in the admin panel.</p>
        `,
        text: `Org ${org.name || orgId} crossed AI $${threshold.toFixed(2)} threshold (used $${mtd.toFixed(2)} in ${period}). Halt at /admin/ai-billing if desired.`,
        throttleKey: `ai_threshold:${orgId}:${period}`,
        meta: { orgId, mtd_usage_usd: mtd, threshold_usd: threshold, period },
      });

      // (period already claimed above via the atomic UPDATE)

      audit.record({
        event: audit.EVENTS.BILLING_AI_THRESHOLD_WARNED,
        orgId,
        meta: { mtd_usage_usd: mtd, threshold_usd: threshold, period },
      }).catch(() => {});

      warned++;
    } catch (err) {
      logger.warn('ai_threshold_worker_org_failed', { orgId, error: err.message });
      errors++;
    }
  }

  logger.info('ai_threshold_worker_tick', { checked: usageOrgs.rows.length, warned, halted, resumed, skipped, errors, period });
  return { checked: usageOrgs.rows.length, warned, halted, resumed, skipped, errors, period };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

let timer = null;

function startScheduler({ intervalMinutes = 60 } = {}) {
  if (timer) return;
  // Fire once on boot (delayed slightly so the rest of the boot sequence
  // settles) and then on the configured interval.
  const initialDelayMs = 60 * 1000;
  setTimeout(() => {
    runOnce().catch(err => logger.warn('ai_threshold_worker_initial_failed', { error: err.message }));
    timer = setInterval(() => {
      runOnce().catch(err => logger.warn('ai_threshold_worker_tick_failed', { error: err.message }));
    }, intervalMinutes * 60 * 1000);
    if (timer.unref) timer.unref();
  }, initialDelayMs);
  logger.info('ai_threshold_worker_scheduler_started', { intervalMinutes });
}

function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  runOnce,
  startScheduler,
  stopScheduler,
  DEFAULT_HARD_CAP_USD,
};
