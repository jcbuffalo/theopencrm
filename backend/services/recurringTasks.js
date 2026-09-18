// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Recurring-task occurrence spawning (migration 129).
//
// One shared entry point — spawnNextOccurrence(sourceRow) — used by BOTH the
// inline complete handler in routes/taskRoutes.js (the primary trigger: PUT
// status → 'done') and the recurringTaskWorker safety net (catches completes
// that bypassed the route, e.g. the bulk PATCH endpoint).
//
// Duplicate-spawn safety is layered:
//   1. The route only calls this on a status TRANSITION into 'done'
//      (double-complete of an already-done task never reaches here).
//   2. The INSERT itself carries a WHERE NOT EXISTS guard: no successor is
//      created while the series (root task or any occurrence pointing at it)
//      still has a non-done row. This is the authoritative, cross-instance
//      guard — the worker and the route can race and at most one row wins.
//
// Due-date math lives HERE (in JS, not SQL) so it is unit-testable against a
// mocked pool and identical across route + worker. Monthly is calendar-aware:
// Jan 31 + 1 month clamps to Feb 28/29 rather than rolling into March.
//
// Tenancy: the spawned row copies user_id/org_id from the SOURCE ROW, never
// from a request context — required because the worker has no request. The
// source row was itself fetched org-scoped, so scope is preserved.

const pool = require('../db');

const RECURRENCE_RULES = ['daily', 'weekly', 'biweekly', 'monthly'];

const DAY_RULES = { daily: 1, weekly: 7, biweekly: 14 };

/**
 * Next due date for a rule, from a previous due date (ISO string / Date).
 * Falls back to "now" when the previous occurrence had no due date, so a
 * recurring task without one still advances instead of stacking on NULL.
 * @returns {string|null} ISO timestamp, or null for an unknown rule.
 */
function nextDueDate(rule, fromDate) {
  if (!RECURRENCE_RULES.includes(rule)) return null;
  const base = fromDate ? new Date(fromDate) : new Date();
  if (Number.isNaN(base.getTime())) return null;
  const d = new Date(base.getTime());

  if (rule === 'monthly') {
    // Calendar-aware: keep the day-of-month, clamped to the target month's
    // length (Jan 31 → Feb 28/29, not Mar 2/3).
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    const daysInTarget = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, daysInTarget));
  } else {
    d.setUTCDate(d.getUTCDate() + DAY_RULES[rule]);
  }
  return d.toISOString();
}

/**
 * Spawn the next occurrence of a recurring task, given the just-completed
 * source row (a full tasks row). No-ops (returns null) when:
 *   - the row isn't a live recurring task (no/invalid rule, or series stopped
 *     via recurrence_active = false), or
 *   - the series already has an active (non-done) occurrence — enforced
 *     atomically by the WHERE NOT EXISTS inside the INSERT.
 *
 * The new occurrence copies title/description/assignee/priority (and the
 * contact/deal links + custom fields — same org, same scope), advances
 * due_date by the rule's interval, resets status to 'open', and points
 * recurrence_parent_id at the series ROOT (the source's parent, or the source
 * itself when it is the root).
 *
 * @returns {Promise<object|null>} the created row, or null if skipped.
 */
async function spawnNextOccurrence(task, { db = pool } = {}) {
  if (!task || !RECURRENCE_RULES.includes(task.recurrence_rule)) return null;
  if (task.recurrence_active === false) return null;

  const rootId = task.recurrence_parent_id || task.id;
  const dueDate = nextDueDate(task.recurrence_rule, task.due_date);

  const result = await db.query(
    `INSERT INTO tasks (user_id, org_id, contact_id, deal_id, title, description,
                        due_date, status, priority, assigned_to, custom_fields,
                        recurrence_rule, recurrence_parent_id, recurrence_active)
     SELECT $1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10::jsonb, $11, $12, TRUE
      WHERE NOT EXISTS (
        SELECT 1 FROM tasks
         WHERE (id = $12 OR recurrence_parent_id = $12)
           AND status <> 'done'
      )
     RETURNING *`,
    [
      task.user_id,
      task.org_id || null,
      task.contact_id || null,
      task.deal_id || null,
      task.title,
      task.description || null,
      dueDate,
      task.priority || 'medium',
      task.assigned_to || null,
      JSON.stringify(task.custom_fields || {}),
      task.recurrence_rule,
      rootId,
    ]
  );
  return result.rows[0] || null;
}

module.exports = { RECURRENCE_RULES, nextDueDate, spawnNextOccurrence };
