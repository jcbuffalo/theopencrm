// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Platform-level AI spend guardrails (2026-09-22, migration 174).
//
// Per-org protection already existed (soft warn $50, hard-cap auto-halt
// $200/month). What did NOT exist was anything bounding the AGGREGATE:
// with a 14-day AI trial at signup (D1), N trial orgs × $200 is an
// unbounded platform cost. This module bounds it three ways and tells the
// owner through the CRM's own notification system (dogfooding):
//
//   1. AI_TRIAL_MAX_ACTIVE (default 25) — at most this many live trials at
//      once. Past it, a new self-serve org provisions with AI
//      'unconfigured' (the CRM works; the copilot asks for a card).
//   2. AI_TRIAL_ORG_HARD_CAP_USD (default 25) — a trial org's monthly hard
//      cap is min(its own cap, this). aiThresholdWorker applies it.
//   3. AI_UNBILLED_MONTHLY_BUDGET_USD (default 300) — month-to-date RAW
//      Anthropic cost (cost_usd_micro, what we pay) across every org whose
//      AI we are not billing (status trial or comped). At 100% new trials
//      are auto-paused (platform_settings.ai_trials_enabled=false) until a
//      super-admin resumes them; existing trials keep running under (2).
//
// Alerts: at 50% / 80% / 100% of the budget and at 80% / 100% of the trial
// slots, ONE notification per (threshold, month) to every super-admin via
// notificationDispatcher.notifyPlatformBudget — the bell, plus email in
// their chosen delivery mode (daily digest / batched / instant), each with
// a one-click "Pause new trials" / "Resume new trials" button
// (services/emailActions.js, actions platform.trials.pause / .resume).
//
// PUBLIC API
//   status({ now })              → the numbers + verdicts (admin card, tests)
//   canProvisionTrial({ db })    → { ok, reason }
//   setTrialsEnabled(bool, { userId })
//   checkAndAlert({ now })       → { fired: [...], paused: bool }

const pool = require('../db');
const platformSettings = require('./platformSettings');

const TRIAL_MAX_ACTIVE = Math.max(0, Number(process.env.AI_TRIAL_MAX_ACTIVE ?? 25));
const TRIAL_ORG_HARD_CAP_USD = Math.max(1, Number(process.env.AI_TRIAL_ORG_HARD_CAP_USD ?? 25));
const UNBILLED_MONTHLY_BUDGET_USD = Math.max(1, Number(process.env.AI_UNBILLED_MONTHLY_BUDGET_USD ?? 300));
const BUDGET_STEPS = [50, 80, 100];
const TRIAL_STEPS = [80, 100];
const SETTING_KEY = 'ai_trials_enabled';

function periodLabel(now) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthBounds(now) {
  return {
    from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

async function trialsEnabled() {
  const v = await platformSettings.get(SETTING_KEY, true);
  return v !== false;
}

async function setTrialsEnabled(enabled, { userId = null } = {}) {
  await platformSettings.set(SETTING_KEY, !!enabled, { userId });
  return !!enabled;
}

// The numbers. `db` lets the provisioning path run this inside its own
// transaction client; everything is read-only.
async function status({ now = new Date(), db = pool } = {}) {
  const { from, to } = monthBounds(now);
  const trials = await db.query(
    `SELECT COUNT(*)::int AS active
       FROM organizations
      WHERE ai_billing_status = 'trial'
        AND (ai_billing_trial_ends_at IS NULL OR ai_billing_trial_ends_at > $1)`,
    [now]
  );
  const spend = await db.query(
    `SELECT
        COALESCE(SUM(e.cost_usd_micro) FILTER (WHERE o.ai_billing_status = 'trial'), 0)::bigint AS trial_micro,
        COALESCE(SUM(e.cost_usd_micro) FILTER (WHERE o.ai_billing_status IN ('trial', 'comped')), 0)::bigint AS unbilled_micro,
        COALESCE(SUM(e.cost_usd_micro), 0)::bigint AS all_micro
       FROM ai_usage_events e
       JOIN organizations o ON o.id = e.org_id
      WHERE e.created_at >= $1 AND e.created_at < $2`,
    [from.toISOString(), to.toISOString()]
  );
  const enabled = await trialsEnabled();
  const active = trials.rows[0] ? Number(trials.rows[0].active) : 0;
  const s = spend.rows[0] || {};
  const unbilled = Number(s.unbilled_micro || 0) / 1e6;
  const trialSpend = Number(s.trial_micro || 0) / 1e6;
  const all = Number(s.all_micro || 0) / 1e6;
  const budgetPct = UNBILLED_MONTHLY_BUDGET_USD > 0 ? (unbilled / UNBILLED_MONTHLY_BUDGET_USD) * 100 : 0;
  const trialPct = TRIAL_MAX_ACTIVE > 0 ? (active / TRIAL_MAX_ACTIVE) * 100 : 100;
  let reason = null;
  if (!enabled) reason = 'paused';
  else if (active >= TRIAL_MAX_ACTIVE) reason = 'max_active';
  else if (unbilled >= UNBILLED_MONTHLY_BUDGET_USD) reason = 'budget';
  return {
    period: periodLabel(now),
    trials_enabled: enabled,
    accepting_trials: reason === null,
    reason,
    active_trials: active,
    trial_max_active: TRIAL_MAX_ACTIVE,
    trial_pct: Math.round(trialPct),
    trial_org_hard_cap_usd: TRIAL_ORG_HARD_CAP_USD,
    mtd_trial_cost_usd: round2(trialSpend),
    mtd_unbilled_cost_usd: round2(unbilled),
    mtd_all_cost_usd: round2(all),
    unbilled_budget_usd: UNBILLED_MONTHLY_BUDGET_USD,
    budget_pct: Math.round(budgetPct),
  };
}

function round2(n) { return Math.round(n * 100) / 100; }

async function canProvisionTrial({ db = pool, now = new Date() } = {}) {
  try {
    const st = await status({ now, db });
    return { ok: st.accepting_trials, reason: st.reason, status: st };
  } catch (err) {
    // Fail OPEN on a read error? No — fail CLOSED. A missing table (pre-174)
    // or a DB blip should not mint a trial we can't see; the org still gets
    // a workspace, just no AI until a card or an admin comp.
    return { ok: false, reason: 'status_unavailable', error: err && err.message };
  }
}

// Effective monthly hard cap for an org: trials are additionally capped by
// AI_TRIAL_ORG_HARD_CAP_USD. Used by aiThresholdWorker.
function effectiveHardCap({ ai_billing_status, orgCapUsd, defaultCapUsd }) {
  const base = Number.isFinite(Number(orgCapUsd)) && orgCapUsd !== null && orgCapUsd !== undefined ? Number(orgCapUsd) : defaultCapUsd;
  if (ai_billing_status === 'trial') return Math.min(base, TRIAL_ORG_HARD_CAP_USD);
  return base;
}

async function claimAlert(key, meta) {
  const r = await pool.query(
    `INSERT INTO platform_budget_alerts (key, meta) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key`,
    [key, JSON.stringify(meta || {})]
  );
  return r.rows.length > 0;
}

// One pass: compute status, fire each crossed threshold once per month,
// auto-pause new trials at 100% of budget. `notify` is injected for tests
// (default: notificationDispatcher.notifyPlatformBudget, required lazily to
// avoid a require cycle).
async function checkAndAlert({ now = new Date(), notify = null } = {}) {
  const send = notify || require('./notificationDispatcher').notifyPlatformBudget;
  const st = await status({ now });
  const fired = [];
  let paused = false;

  for (const step of BUDGET_STEPS) {
    if (st.budget_pct >= step) {
      const key = `unbilled:${st.period}:${step}`;
      if (await claimAlert(key, { pct: st.budget_pct, usd: st.mtd_unbilled_cost_usd })) {
        if (step === 100 && st.trials_enabled) {
          await setTrialsEnabled(false, { userId: null });
          st.trials_enabled = false;
          st.accepting_trials = false;
          st.reason = 'budget';
          paused = true;
        }
        fired.push(key);
        await send({ kind: 'budget', step, status: st, autoPaused: step === 100 && paused });
      }
    }
  }
  for (const step of TRIAL_STEPS) {
    if (st.trial_pct >= step) {
      const key = `trials:${st.period}:${step}`;
      if (await claimAlert(key, { active: st.active_trials, max: st.trial_max_active })) {
        fired.push(key);
        await send({ kind: 'trials', step, status: st, autoPaused: false });
      }
    }
  }
  return { fired, paused, status: st };
}

module.exports = {
  status, canProvisionTrial, effectiveHardCap, trialsEnabled, setTrialsEnabled, checkAndAlert, periodLabel,
  TRIAL_MAX_ACTIVE, TRIAL_ORG_HARD_CAP_USD, UNBILLED_MONTHLY_BUDGET_USD, BUDGET_STEPS, TRIAL_STEPS, SETTING_KEY,
};
