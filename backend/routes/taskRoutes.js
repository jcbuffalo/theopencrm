// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const { buildBulkUpdate, buildBulkDelete } = require('./_bulkOps');
const { validateCustomFieldsPayload } = require('./customFieldsRoutes');
const notificationDispatcher = require('../services/notificationDispatcher');
const recurringTasks = require('../services/recurringTasks');
const { validateBody } = require('../middleware/validate');
const taskSchemas = require('../schemas/tasks');
// Plugin trigger engine (migration 164) — fire-and-forget post-commit event
// dispatch to active plugins. emitTaskCompleted never throws / never blocks.
const pluginEvents = require('../services/pluginEvents');

const router = express.Router();
router.use(authMiddleware);

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// Bulk routes must be mounted BEFORE /:id routes so /bulk isn't matched as
// an id. Allowlist covers the four columns the bulk-action bar exposes;
// anything else (title, description, links) still requires per-row PUT.
// zod validates body SHAPE; allowlist inside buildBulkUpdate is the
// authoritative gate against unexpected columns.
router.patch('/bulk', validateBody(taskSchemas.bulkPatchSchema), buildBulkUpdate({
  resource:  'tasks',
  table:     'tasks',
  allowlist: ['assigned_to', 'status', 'due_date', 'priority'],
  qs, pool,
}));
router.delete('/bulk', buildBulkDelete({
  resource: 'tasks', table: 'tasks', qs, pool,
}));

router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { status, contact_id, deal_id } = req.query;
    let query = `SELECT * FROM tasks WHERE ${sf} = $1`;
    const params = [sv];

    if (status)     { query += ` AND status = $${params.length + 1}`;     params.push(status); }
    if (contact_id) { query += ` AND contact_id = $${params.length + 1}`; params.push(contact_id); }
    if (deal_id)    { query += ` AND deal_id = $${params.length + 1}`;    params.push(deal_id); }

    query += ' ORDER BY due_date ASC, created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(`SELECT * FROM tasks WHERE id = $1 AND ${sf} = $2`, [req.params.id, sv]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch task' });
  }
});

router.post('/', validateBody(taskSchemas.createSchema), async (req, res) => {
  try {
    const { title, contact_id, deal_id, description, due_date, status, priority, assigned_to, custom_fields, recurrence_rule } = req.body;
    // zod enforced `title` presence + shape gates (incl. the recurrence_rule
    // allowlist — daily|weekly|biweekly|monthly|null).

    const cfErr = await validateCustomFieldsPayload({ orgId: req.orgId, entity: 'tasks', payload: custom_fields, isCreate: true });
    if (cfErr) return res.status(400).json({ error: cfErr });

    // Multi-tenancy: a task may only be linked to a contact / deal in scope.
    const [sf, sv] = qs(req);
    if (contact_id != null) {
      const own = await pool.query(`SELECT 1 FROM contacts WHERE id = $1 AND ${sf} = $2`, [contact_id, sv]);
      if (own.rows.length === 0) return res.status(400).json({ error: 'contact_id not found in your organization' });
    }
    if (deal_id != null) {
      const own = await pool.query(`SELECT 1 FROM deals WHERE id = $1 AND ${sf} = $2`, [deal_id, sv]);
      if (own.rows.length === 0) return res.status(400).json({ error: 'deal_id not found in your organization' });
    }

    const result = await pool.query(
      `INSERT INTO tasks (user_id, org_id, contact_id, deal_id, title, description, due_date, status, priority, assigned_to, custom_fields, recurrence_rule)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12) RETURNING *`,
      [req.userId, req.orgId || null, contact_id || null, deal_id || null, title, description || null, due_date || null, status || 'open', priority || 'medium', assigned_to || null, JSON.stringify(custom_fields || {}), recurrence_rule || null]
    );

    const created = result.rows[0];

    // Fire-and-forget: tell the assignee (if any, and if it's not the creator
    // themselves) about the new task. Notification failures must NEVER break
    // the user action — hence no await and a swallowed .catch().
    if (created.assigned_to && Number(created.assigned_to) !== Number(req.userId)) {
      notificationDispatcher.notifyTaskAssigned(created.id)
        .catch(err => console.warn('notify_task_assigned_failed', err && err.message ? err.message : err));
    }

    res.status(201).json(created);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create task' });
  }
});

router.put('/:id', validateBody(taskSchemas.updateSchema), async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { title, contact_id, deal_id, description, due_date, status, priority, assigned_to, custom_fields, recurrence_rule, recurrence_active } = req.body;

    const cfErr = await validateCustomFieldsPayload({ orgId: req.orgId, entity: 'tasks', payload: custom_fields, isCreate: false });
    if (cfErr) return res.status(400).json({ error: cfErr });

    // Capture the prior assignee so we can detect "assigned_to changed to a
    // different user" after the UPDATE. We deliberately read this BEFORE the
    // write so a row that fails the org-scope check still doesn't leak
    // notifications. `status` rides along so we can detect the TRANSITION
    // into 'done' (recurrence spawn trigger) — re-completing an already-done
    // task must not spawn again.
    const prior = await pool.query(
      `SELECT assigned_to, status FROM tasks WHERE id = $1 AND ${sf} = $2`,
      [req.params.id, sv]
    );
    const priorAssignedTo = prior.rows[0] ? prior.rows[0].assigned_to : null;
    const priorStatus     = prior.rows[0] ? prior.rows[0].status : null;

    // recurrence_rule needs "explicitly null clears it" semantics, which
    // COALESCE can't express — so a provided-flag drives a CASE instead.
    const ruleProvided = Object.prototype.hasOwnProperty.call(req.body, 'recurrence_rule');

    const result = await pool.query(
      `UPDATE tasks SET title = COALESCE($1, title), contact_id = COALESCE($2, contact_id),
       deal_id = COALESCE($3, deal_id), description = COALESCE($4, description),
       due_date = COALESCE($5, due_date), status = COALESCE($6, status),
       priority = COALESCE($7, priority),
       assigned_to = COALESCE($11, assigned_to),
       custom_fields = CASE WHEN $10::jsonb IS NULL THEN custom_fields ELSE custom_fields || $10::jsonb END,
       recurrence_rule = CASE WHEN $12::boolean THEN $13 ELSE recurrence_rule END,
       recurrence_active = COALESCE($14, recurrence_active),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $8 AND ${sf} = $9 RETURNING *`,
      [title, contact_id, deal_id, description, due_date, status, priority, req.params.id, sv, custom_fields ? JSON.stringify(custom_fields) : null, assigned_to === undefined ? null : assigned_to, ruleProvided, ruleProvided ? recurrence_rule : null, recurrence_active == null ? null : recurrence_active]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found' });

    const updated = result.rows[0];

    // Recurring tasks: completing an occurrence spawns the next one, inline.
    // Trigger = transition into 'done' (prior status wasn't done). The spawn
    // itself is duplicate-safe (WHERE NOT EXISTS on an active occurrence in
    // the series — see services/recurringTasks.js), and awaited so the next
    // occurrence exists before we respond; but a spawn failure must never
    // fail the complete itself.
    let spawned = null;
    if (
      updated.status === 'done' &&
      priorStatus !== 'done' &&
      updated.recurrence_rule &&
      updated.recurrence_active !== false
    ) {
      try {
        spawned = await recurringTasks.spawnNextOccurrence(updated);
      } catch (err) {
        console.warn('recurring_task_spawn_failed', err && err.message ? err.message : err);
      }
    }

    // Fire-and-forget notification when the assignee changed to a non-null
    // user who isn't the actor. "Changed" means the new value differs from
    // the prior value; this avoids a notification on every PUT that simply
    // re-affirms the same assignee.
    const newAssignedTo = updated.assigned_to;
    if (
      newAssignedTo &&
      Number(newAssignedTo) !== Number(priorAssignedTo) &&
      Number(newAssignedTo) !== Number(req.userId)
    ) {
      notificationDispatcher.notifyTaskAssigned(updated.id)
        .catch(err => console.warn('notify_task_assigned_failed', err && err.message ? err.message : err));
    }

    // Plugin trigger (migration 164): task.completed fires on the SAME
    // transition-into-'done' the recurrence spawn keys off above (prior
    // status wasn't 'done'; re-saving an already-done task doesn't fire).
    // The helper owns the transition check + the per-completion-day dedupe
    // key ('task.completed:<id>:<YYYY-MM-DD>' — re-completed on a later day
    // re-fires, same-day flapping dedupes). Fire-and-forget: never awaited,
    // never fails the update. Bulk PATCH /bulk intentionally does NOT emit —
    // completion side effects (recurrence spawn, assignment notifications)
    // already fire from this per-row PUT only, and this event follows suit.
    if (req.orgId) {
      pluginEvents.emitTaskCompleted(req.orgId, updated, {
        priorStatus,
        completedBy: req.userId,
      });
    }

    // Additive: clients that only know the task shape ignore the extra key;
    // the Tasks page can use it to confirm "next occurrence created".
    res.json(spawned ? { ...updated, spawned_next_occurrence: spawned } : updated);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update task' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(`DELETE FROM tasks WHERE id = $1 AND ${sf} = $2 RETURNING *`, [req.params.id, sv]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    res.json({ message: 'Task deleted', task: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

module.exports = router;
