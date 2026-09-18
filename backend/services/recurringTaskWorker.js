// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Recurring-task safety-net worker (migration 129).
//
// The PRIMARY spawn path is inline in routes/taskRoutes.js: PUT that
// transitions a recurring task into 'done' immediately creates the next
// occurrence. This worker exists for completes that bypass that handler —
// today that's the bulk PATCH endpoint (status: 'done' via /api/tasks/bulk),
// plus any future writer that flips status directly in SQL.
//
// Per tick:
//   1. Claim a single-runner lease via workerLease (worker_runs table,
//      migration 098) keyed on the current UTC hour — so with multiple Cloud
//      Run instances, exactly one pod performs the sweep per period. This is
//      belt; the WHERE NOT EXISTS guard inside spawnNextOccurrence is
//      suspenders (even two concurrent sweeps can't double-spawn a series).
//   2. Find "orphaned" series: recurring (rule set, series active) tasks
//      whose latest occurrence is done and which have NO non-done occurrence.
//      One row per series (DISTINCT ON the series root), the most recently
//      due occurrence, so the +interval math continues from the right date.
//   3. spawnNextOccurrence(row) for each — same code path as the route.
//
// Idempotent: a spawned successor is a non-done occurrence, so the series
// drops out of the sweep on the next tick; re-running a tick is harmless.
// Capped per tick (default 200) to bound runtime; leftovers catch the next
// hourly period. Scheduler shape mirrors overdueTaskWorker.js.

const pool = require('../db');
const logger = require('./logger');
const workerLease = require('./workerLease');
const { spawnNextOccurrence } = require('./recurringTasks');

const WORKER_NAME = 'recurring_task_spawn';
const DEFAULT_INTERVAL_MIN = 60;
const DEFAULT_MAX_PER_RUN = 200;

let timer = null;

/** Current UTC-hour period key, e.g. '2026-07-13T14'. */
function periodKey(now = new Date()) {
  return now.toISOString().slice(0, 13);
}

async function tick({ maxPerRun = DEFAULT_MAX_PER_RUN } = {}) {
  const key = periodKey();
  try {
    // Single-runner lease: first instance to claim (worker, hour) does the
    // sweep; everyone else skips this period.
    const won = await workerLease.claim(WORKER_NAME, key);
    if (!won) {
      logger.info?.('recurring_task_worker_lease_skipped', { periodKey: key });
      return { spawned: 0, failed: 0, skipped: true };
    }

    // Orphaned series = every occurrence done + series still active. One row
    // per series root; the latest-due done occurrence is the spawn source.
    const orphaned = await pool.query(
      `SELECT DISTINCT ON (COALESCE(t.recurrence_parent_id, t.id)) t.*
         FROM tasks t
        WHERE t.recurrence_rule IS NOT NULL
          AND t.recurrence_active IS NOT FALSE
          AND t.status = 'done'
          AND NOT EXISTS (
            SELECT 1 FROM tasks s
             WHERE COALESCE(s.recurrence_parent_id, s.id) = COALESCE(t.recurrence_parent_id, t.id)
               AND s.status <> 'done'
          )
        ORDER BY COALESCE(t.recurrence_parent_id, t.id), t.due_date DESC NULLS LAST, t.id DESC
        LIMIT $1`,
      [maxPerRun]
    );

    if (orphaned.rows.length === 0) {
      logger.info?.('recurring_task_worker_tick_idle', { periodKey: key });
      return { spawned: 0, failed: 0 };
    }

    let spawnedCount = 0;
    let failed = 0;
    for (const row of orphaned.rows) {
      try {
        const created = await spawnNextOccurrence(row);
        if (created) spawnedCount++;
      } catch (err) {
        failed++;
        logger.warn?.('recurring_task_worker_one_failed', { taskId: row.id, error: err && err.message });
      }
    }

    logger.info?.('recurring_task_worker_tick_end', { spawned: spawnedCount, failed });
    return { spawned: spawnedCount, failed };
  } catch (err) {
    // Release the lease on a failed sweep so a retry within the same period
    // (e.g. another instance's tick) can pick the work back up.
    await workerLease.release(WORKER_NAME, key).catch(() => {});
    logger.warn?.('recurring_task_worker_tick_error', { error: err && err.message });
    return { spawned: 0, failed: 0, error: err && err.message };
  }
}

function startScheduler({ intervalMinutes = DEFAULT_INTERVAL_MIN, maxPerRun = DEFAULT_MAX_PER_RUN } = {}) {
  if (timer) return;
  const ms = Math.max(5, intervalMinutes) * 60 * 1000;
  // First run shortly after boot (after migrations settle), then on interval.
  setTimeout(() => { tick({ maxPerRun }).catch(() => {}); }, 5000);
  timer = setInterval(() => {
    tick({ maxPerRun }).catch(() => {});
  }, ms);
  logger.info?.('recurring_task_worker_started', { intervalMinutes, maxPerRun });
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { tick, startScheduler, stopScheduler, periodKey };
