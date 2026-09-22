// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Hourly scheduler for the platform AI budget guardrails (migration 174).
// Each tick: services/platformBudget.checkAndAlert() — computes month-to-
// date unbilled cost + active trials, fires each crossed threshold once per
// month to every super-admin through the CRM's own notification path, and
// auto-pauses new trials at 100% of the budget. Same shape as the other
// workers (module-level timer, tick, start/stop).

const platformBudget = require('./platformBudget');

const DEFAULT_INTERVAL_MIN = 60;
let timer = null;
let running = false;

async function tick({ now = new Date() } = {}) {
  if (running) return { skipped: 'busy' };
  running = true;
  try {
    const out = await platformBudget.checkAndAlert({ now });
    if (out.fired.length || out.paused) console.info('[platform-budget] tick', JSON.stringify({ fired: out.fired, paused: out.paused, budget_pct: out.status.budget_pct, active_trials: out.status.active_trials }));
    return out;
  } catch (err) {
    console.warn('platform_budget_worker_tick_error', err && err.message);
    return { fired: [], paused: false, error: err && err.message };
  } finally {
    running = false;
  }
}

function startScheduler({ intervalMinutes = DEFAULT_INTERVAL_MIN } = {}) {
  if (timer) return;
  const ms = Math.max(1, Number(intervalMinutes) || DEFAULT_INTERVAL_MIN) * 60 * 1000;
  setTimeout(() => { tick().catch(() => {}); }, 45000);
  timer = setInterval(() => { tick().catch(() => {}); }, ms);
  if (timer.unref) timer.unref();
  console.log(`💸 Platform AI budget worker started (every ${ms / 60000} min; max ${platformBudget.TRIAL_MAX_ACTIVE} trials, $${platformBudget.TRIAL_ORG_HARD_CAP_USD}/trial-org, $${platformBudget.UNBILLED_MONTHLY_BUDGET_USD}/mo unbilled budget)`);
}

function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { tick, startScheduler, stopScheduler };
