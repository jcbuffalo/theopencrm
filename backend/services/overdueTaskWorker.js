// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Background worker that fires "task is overdue" notifications.
//
// Runs hourly (configurable via OVERDUE_WORKER_INTERVAL_MINUTES). Modelled on
// services/accountDeletionWorker.js — the canonical worker pattern in this
// codebase: a module-level interval handle + tick() function + startScheduler()
// / stopScheduler() pair.
//
// On each tick we scan for tasks that are open, past their due_date, and
// haven't been notified about being overdue in the last 24 hours, then for
// each one:
//   1. Call notificationDispatcher.notifyTaskOverdue(taskId) (fire-and-forget,
//      but we await INSIDE the worker so we can stamp the column after).
//   2. UPDATE tasks.last_overdue_notified_at = NOW() so the next tick skips
//      this task for 24h.
//
// Cap per tick = OVERDUE_WORKER_MAX_PER_RUN (default 500) to bound runtime.
// If more tasks are overdue than the cap, the next tick (an hour later) picks
// up the rest — the partial index on last_overdue_notified_at makes the scan
// cheap on repeat runs.

const pool   = require('../db');
const logger = require('./logger');
const notificationDispatcher = require('./notificationDispatcher');
// Plugin trigger engine (migration 164): each newly-overdue task also emits a
// 'task.overdue' plugin event, deduped per (task, UTC day) so a task that
// stays overdue fires at most daily — matching the 24h notification window.
const pluginEvents = require('./pluginEvents');

const DEFAULT_INTERVAL_MIN = 60;
const DEFAULT_MAX_PER_RUN  = 500;

let timer = null;

async function tick({ maxPerRun = DEFAULT_MAX_PER_RUN } = {}) {
  try {
    // CLAIM-then-notify: stamp last_overdue_notified_at atomically as we
    // select, so two backend instances ticking in the same window can't both
    // notify the same task. The inner SELECT ... FOR UPDATE SKIP LOCKED lets a
    // second instance skip rows the first has already locked and claim a
    // disjoint set instead of blocking or duplicating. Only the rows this tick
    // actually claimed come back in RETURNING; we notify exactly those.
    // ORDER BY due_date ASC = most overdue first if we hit the cap.
    const claimed = await pool.query(
      `UPDATE tasks
          SET last_overdue_notified_at = NOW()
        WHERE id IN (
          SELECT id
            FROM tasks
           WHERE status = 'open'
             AND due_date IS NOT NULL
             AND due_date < NOW()
             AND (last_overdue_notified_at IS NULL
                  OR last_overdue_notified_at < NOW() - INTERVAL '24 hours')
           ORDER BY due_date ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, org_id, title, due_date, priority, assigned_to, contact_id, deal_id`,
      [maxPerRun]
    );

    if (claimed.rows.length === 0) {
      logger.info?.('overdue_task_worker_tick_idle');
      return { processed: 0, failed: 0 };
    }

    logger.info?.('overdue_task_worker_tick_start', { count: claimed.rows.length });

    let processed = 0;
    let failed    = 0;

    for (const row of claimed.rows) {
      try {
        // Already stamped by the claiming UPDATE above (the intent of the
        // column is "we considered this task this cycle"); just fire the
        // notification. The dispatcher swallows its own errors — the wrap
        // catches only a require/load or programming error.
        await notificationDispatcher.notifyTaskOverdue(row.id);
        // Plugin trigger (migration 164). emit() never rejects; awaited so
        // dispatch stays sequential inside the tick. Org-scoped only.
        if (row.org_id) {
          const dayKey = new Date().toISOString().slice(0, 10);
          await pluginEvents.emit(row.org_id, 'task.overdue', {
            id: row.id,
            title: row.title,
            due_date: row.due_date,
            priority: row.priority,
            assigned_to: row.assigned_to,
            contact_id: row.contact_id,
            deal_id: row.deal_id,
          }, { dedupeKey: `task.overdue:${row.id}:${dayKey}` });
        }
        processed++;
      } catch (err) {
        failed++;
        logger.warn?.('overdue_task_worker_one_failed', { taskId: row.id, error: err && err.message });
      }
    }

    logger.info?.('overdue_task_worker_tick_end', { processed, failed });
    return { processed, failed };
  } catch (err) {
    logger.warn?.('overdue_task_worker_tick_error', { error: err && err.message });
    return { processed: 0, failed: 0, error: err && err.message };
  }
}

function startScheduler({ intervalMinutes = DEFAULT_INTERVAL_MIN, maxPerRun = DEFAULT_MAX_PER_RUN } = {}) {
  if (timer) return;
  const ms = Math.max(5, intervalMinutes) * 60 * 1000;
  // Run once shortly after startup (5s delay so migrations + the rest of
  // boot finish first), then on interval.
  setTimeout(() => { tick({ maxPerRun }).catch(() => {}); }, 5000);
  timer = setInterval(() => {
    tick({ maxPerRun }).catch(() => {});
  }, ms);
  logger.info?.('overdue_task_worker_started', { intervalMinutes, maxPerRun });
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  tick,
  startScheduler,
  stopScheduler,
};
