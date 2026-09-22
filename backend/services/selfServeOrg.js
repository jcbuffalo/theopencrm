// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Provisions the workspace org for a self-serve signup — the ONE place the
// commercial defaults every new org gets are decided:
//
//   • limits_tier='free' arms the seat/record caps (services/tierLimits.js).
//   • ai_billing_status='trial' for AI_SIGNUP_TRIAL_DAYS (default 14) so the
//     first-run "describe how you sell" builder (routes/onboardingRoutes.js)
//     and the copilot work before a card is on file. The trial is bounded by
//     everything that already bounds AI spend: the free-tier request quota
//     (quotaEnforcer), the chat daily cap, and the per-org monthly hard cap
//     (aiThresholdWorker — applies to trial orgs). Set AI_SIGNUP_TRIAL_DAYS=0
//     to provision new orgs as 'unconfigured' (AI blocked until billing).
//
// Three signup paths call this (password register, Google first sign-in,
// access request) so they can never drift on the defaults.

const DEFAULT_TRIAL_DAYS = 14;

function trialDays() {
  const raw = process.env.AI_SIGNUP_TRIAL_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_TRIAL_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TRIAL_DAYS;
  return Math.min(Math.floor(n), 365);
}

// Returns the inserted { id } row, or null when onConflictDoNothing swallowed
// a duplicate.
async function createSelfServeOrg(db, { name, ownerUserId, onConflictDoNothing = false }) {
  let days = trialDays();
  const cols = ['name', 'owner_user_id', 'limits_tier'];
  const vals = ['$1', '$2', "'free'"];
  const params = [name, ownerUserId];
  // Platform guardrails (migration 174): no trial when trials are paused,
  // the active-trial slots are full, or the unbilled monthly budget is
  // spent. The org still gets its workspace — AI just waits for a card.
  // Test bypass (repo convention for DB-hitting gates — see feedback in
  // CONTRACTOR_ONBOARDING): the signup suites drive this path with ordered
  // pool mocks, so the gate's extra reads would shift every later query.
  // platformBudget.test.js opts back in with PLATFORM_BUDGET_GATE_IN_TESTS.
  const gateOn = process.env.NODE_ENV !== 'test' || process.env.PLATFORM_BUDGET_GATE_IN_TESTS === 'true';
  if (days > 0 && gateOn) {
    const gate = await require('./platformBudget').canProvisionTrial({ db });
    if (!gate.ok) {
      console.info(`[selfServeOrg] no AI trial for new org "${name}": ${gate.reason}`);
      days = 0;
    }
  }
  if (days > 0) {
    params.push(days);
    cols.push('ai_billing_status', 'ai_billing_trial_ends_at');
    vals.push("'trial'", `NOW() + ($${params.length}::int * INTERVAL '1 day')`);
  }
  const r = await db.query(
    `INSERT INTO organizations (${cols.join(', ')}) VALUES (${vals.join(', ')})
     ${onConflictDoNothing ? 'ON CONFLICT DO NOTHING' : ''} RETURNING id`,
    params
  );
  return r.rows[0] || null;
}

module.exports = { createSelfServeOrg, trialDays, DEFAULT_TRIAL_DAYS };
