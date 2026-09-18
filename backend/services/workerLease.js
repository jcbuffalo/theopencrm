// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Cross-instance run lease for periodic background workers.
//
// Problem: several workers are per-process setInterval timers with in-memory
// dedupe (a "did I already run this week/month?" variable). With more than one
// Cloud Run instance, or a restart inside the fire window, that memory resets
// and the run can fire twice. This helper replaces the in-memory guard with an
// atomic INSERT ... ON CONFLICT claim against the worker_runs table (migration
// 098): the first caller to claim a (worker, period_key) wins; everyone else is
// told to skip.
//
// Usage:
//   if (await claim('weekly_summary', weekKey)) {
//     try { ...do the work... } catch (e) { await release('weekly_summary', weekKey); throw e; }
//   }

const pool = require('../db');

/**
 * Atomically claim a (worker, period) run. Returns true exactly once across all
 * instances for a given key — the caller that gets true should do the work.
 * @param {string} worker    stable worker name, e.g. 'weekly_summary'
 * @param {string} periodKey the period being run, e.g. '2026-W27' or '2026-07'
 * @returns {Promise<boolean>} true if this caller won the claim
 */
async function claim(worker, periodKey) {
  const r = await pool.query(
    `INSERT INTO worker_runs (worker, period_key)
     VALUES ($1, $2)
     ON CONFLICT (worker, period_key) DO NOTHING
     RETURNING claimed_at`,
    [worker, periodKey]
  );
  return r.rows.length > 0;
}

/**
 * Release a previously-won claim so the run can be retried — call this when the
 * work threw after a successful claim.
 */
async function release(worker, periodKey) {
  await pool.query(
    'DELETE FROM worker_runs WHERE worker = $1 AND period_key = $2',
    [worker, periodKey]
  );
}

module.exports = { claim, release };
