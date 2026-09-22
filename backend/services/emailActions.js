// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// One-click actions from a notification email (spec 204, migration 173).
//
// The digest / reminder emails carry buttons like "Mark done", "Snooze a
// day", "Log a touch". Each button is a link to the SPA route
// /act/<token>; that page POSTs /api/email-actions/<token>/apply, so a
// GET from a mail scanner / link previewer never mutates anything. The
// token is the credential:
//
//   - 32 random bytes, hex; only its sha256 is stored (same as
//     password_reset_tokens). A DB read never yields a usable link.
//   - single-use (used_at), 7-day expiry (the digest is daily; a week-old
//     "mark done" is a mistake waiting to happen).
//   - org + user scope come from the token ROW. The apply path never reads
//     an org id or user id from the request, and every UPDATE re-checks the
//     row belongs to that org (or, for org-less users, that user). The user
//     must still be active at apply time.
//
// Actions are deliberately a closed allowlist (ACTIONS below). Each one
// mirrors the exact SQL its in-app route performs, including the side
// effects the route fires (recurrence spawn + plugin task.completed event
// on task completion) so a task completed from email behaves like one
// completed from the Tasks page.
//
// PUBLIC API
//   mint({ orgId, userId, action, entityType, entityId, params? })
//       → { token, url }        (url = `${PUBLIC_BASE_URL}/act/${token}`)
//   describe(token)             → what the token would do, without doing it
//   apply(token, { ip? })       → { ok, action, entity_type, entity_id, result, message }
//   sweep()                     → delete expired/used rows older than 14 days

const crypto = require('crypto');
const pool = require('../db');

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://app.theopencrm.com';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hash(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

// Org scoping for the actions: org members scope on org_id; the personal
// (org-less) workspace scopes on user_id — the same fallback qs(req) makes.
function scopeOf(row) {
  return row.org_id ? ['org_id', row.org_id] : ['user_id', row.user_id];
}

// --------------------------------------------------------------------------
// Action registry. Each handler receives the token row (org/user scope) and
// returns { result, message }. Throwing an Error with .status renders as
// that HTTP status + message; anything else is a 500.
// --------------------------------------------------------------------------
const ACTIONS = {
  // Same transition PUT /api/tasks/:id { status: 'done' } performs,
  // including the recurrence spawn + task.completed plugin event.
  'task.complete': {
    entityType: 'task',
    label: 'Mark done',
    async run(row) {
      const [sf, sv] = scopeOf(row);
      const prior = await pool.query(`SELECT status FROM tasks WHERE id = $1 AND ${sf} = $2`, [row.entity_id, sv]);
      if (prior.rows.length === 0) throw notFound('That task no longer exists.');
      if (prior.rows[0].status === 'done') {
        return { result: { already_done: true }, message: 'That task was already marked done.' };
      }
      const upd = await pool.query(
        `UPDATE tasks SET status = 'done', updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND ${sf} = $2 RETURNING *`,
        [row.entity_id, sv]
      );
      const task = upd.rows[0];
      try {
        if (task.recurrence_rule && task.recurrence_active !== false) {
          await require('./recurringTasks').spawnNextOccurrence(task);
        }
      } catch (err) { console.warn('email_action_recurrence_spawn_failed', err && err.message); }
      try {
        if (row.org_id) {
          require('./pluginEvents').emitTaskCompleted(row.org_id, task, { priorStatus: prior.rows[0].status, completedBy: row.user_id });
        }
      } catch (err) { console.warn('email_action_plugin_emit_failed', err && err.message); }
      return { result: { id: task.id, title: task.title }, message: `"${task.title || `Task #${task.id}`}" marked done.` };
    },
  },

  // Push the due date out. params.days (default 1) from the LATER of today
  // and the current due date, so snoozing an overdue task lands tomorrow,
  // not "one day less overdue".
  'task.snooze': {
    entityType: 'task',
    label: 'Snooze a day',
    async run(row) {
      const [sf, sv] = scopeOf(row);
      const days = Math.min(Math.max(parseInt(row.params && row.params.days, 10) || 1, 1), 30);
      const upd = await pool.query(
        `UPDATE tasks
            SET due_date = (GREATEST(COALESCE(due_date::date, CURRENT_DATE), CURRENT_DATE) + ($3 * INTERVAL '1 day'))::date,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND ${sf} = $2 AND status <> 'done'
          RETURNING id, title, due_date`,
        [row.entity_id, sv, days]
      );
      if (upd.rows.length === 0) throw notFound('That task is gone or already done.');
      const t = upd.rows[0];
      const when = t.due_date ? new Date(t.due_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : 'later';
      return { result: { id: t.id, due_date: t.due_date }, message: `"${t.title || `Task #${t.id}`}" snoozed to ${when}.` };
    },
  },

  // Same as My Day's "Done" on a next step: PUT /api/deals/:id
  // { next_step: null, next_step_date: null }.
  'deal.next_step.complete': {
    entityType: 'deal',
    label: 'Step done',
    async run(row) {
      const [sf, sv] = scopeOf(row);
      const upd = await pool.query(
        `UPDATE deals SET next_step = NULL, next_step_date = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND ${sf} = $2 RETURNING id, title`,
        [row.entity_id, sv]
      );
      if (upd.rows.length === 0) throw notFound('That deal no longer exists.');
      return { result: { id: upd.rows[0].id }, message: `Next step on "${upd.rows[0].title}" cleared. Set the next one when you open the deal.` };
    },
  },

  // Push a deal's next-step date out params.days (default 1).
  'deal.next_step.snooze': {
    entityType: 'deal',
    label: 'Snooze a day',
    async run(row) {
      const [sf, sv] = scopeOf(row);
      const days = Math.min(Math.max(parseInt(row.params && row.params.days, 10) || 1, 1), 30);
      const upd = await pool.query(
        `UPDATE deals
            SET next_step_date = (GREATEST(COALESCE(next_step_date, CURRENT_DATE), CURRENT_DATE) + ($3 * INTERVAL '1 day'))::date,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND ${sf} = $2 AND next_step IS NOT NULL
          RETURNING id, title, next_step_date`,
        [row.entity_id, sv, days]
      );
      if (upd.rows.length === 0) throw notFound('That deal has no open next step.');
      return { result: { id: upd.rows[0].id, next_step_date: upd.rows[0].next_step_date }, message: `Next step on "${upd.rows[0].title}" moved to ${new Date(upd.rows[0].next_step_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}.` };
    },
  },

  // POST /api/companies/:id/touch — stamps last_touch_at so the account
  // leaves the "gone quiet" list.
  'company.touch': {
    entityType: 'company',
    label: 'Log a touch',
    async run(row) {
      const [sf, sv] = scopeOf(row);
      const upd = await pool.query(
        `UPDATE companies SET last_touch_at = NOW(), updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND ${sf} = $2 RETURNING id, name`,
        [row.entity_id, sv]
      );
      if (upd.rows.length === 0) throw notFound('That account no longer exists.');
      return { result: { id: upd.rows[0].id }, message: `Logged a touch on ${upd.rows[0].name}.` };
    },
  },

  // Platform guardrails (migration 174): the owner's budget alert carries a
  // one-click "Pause new trials". Super-admin is re-checked at APPLY time —
  // a token minted for a super-admin who has since been demoted does nothing.
  'platform.trials.pause': {
    entityType: 'platform',
    label: 'Pause new trials',
    async run(row) {
      await assertSuperAdmin(row.user_id);
      await require('./platformBudget').setTrialsEnabled(false, { userId: row.user_id });
      return { result: { trials_enabled: false }, message: 'New AI trials are paused. Existing trials keep running under their own cap. Resume from /admin/ai-billing.' };
    },
  },
  'platform.trials.resume': {
    entityType: 'platform',
    label: 'Resume new trials',
    async run(row) {
      await assertSuperAdmin(row.user_id);
      await require('./platformBudget').setTrialsEnabled(true, { userId: row.user_id });
      return { result: { trials_enabled: true }, message: 'New AI trials are accepted again.' };
    },
  },

  // Mark one in-app notification read (the digest's "Dismiss").
  'notification.read': {
    entityType: 'notification',
    label: 'Dismiss',
    async run(row) {
      const upd = await pool.query(
        `UPDATE notifications SET read_at = COALESCE(read_at, NOW())
          WHERE id = $1 AND user_id = $2 RETURNING id`,
        [row.entity_id, row.user_id]
      );
      if (upd.rows.length === 0) throw notFound('That notification is gone.');
      return { result: { id: upd.rows[0].id }, message: 'Dismissed.' };
    },
  },
};

function notFound(message) {
  const e = new Error(message);
  e.status = 404;
  return e;
}

async function assertSuperAdmin(userId) {
  const r = await pool.query(`SELECT 1 FROM admin_users WHERE user_id = $1 AND role = 'super_admin'`, [userId]);
  if (r.rows.length === 0) {
    const e = new Error('Only a super-admin can do that.');
    e.status = 403;
    throw e;
  }
}

function isKnownAction(action) {
  return Object.prototype.hasOwnProperty.call(ACTIONS, action);
}

// --------------------------------------------------------------------------

async function mint({ orgId = null, userId, action, entityId, params = {}, ttlMs = TOKEN_TTL_MS }) {
  if (!isKnownAction(action)) throw new Error(`emailActions.mint: unknown action "${action}"`);
  if (!userId) throw new Error('emailActions.mint: userId is required');
  if (!entityId) throw new Error('emailActions.mint: entityId is required');
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO email_action_tokens (org_id, user_id, token_hash, action, entity_type, entity_id, params, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + ($8 * INTERVAL '1 millisecond'))`,
    [orgId || null, userId, hash(token), action, ACTIONS[action].entityType, entityId, JSON.stringify(params || {}), ttlMs]
  );
  return { token, url: `${PUBLIC_BASE_URL}/act/${token}` };
}

// Mint several at once for one email — one round-trip per token is fine at
// digest volumes (a few dozen per email at most).
async function mintMany(base, items) {
  const out = [];
  for (const it of items) out.push(await mint({ ...base, ...it }));
  return out;
}

async function loadRow(token) {
  if (!/^[0-9a-f]{64}$/.test(String(token || ''))) return null;
  const r = await pool.query(
    `SELECT t.*, u.status AS user_status, u.name AS user_name
       FROM email_action_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1`,
    [hash(token)]
  );
  return r.rows[0] || null;
}

function checkRow(row) {
  if (!row) return { ok: false, status: 404, message: 'This link is not valid.' };
  if (row.used_at) return { ok: false, status: 410, message: 'This link was already used.', used: true };
  if (new Date(row.expires_at) <= new Date()) return { ok: false, status: 410, message: 'This link has expired.', expired: true };
  if (row.user_status && row.user_status !== 'active') return { ok: false, status: 403, message: 'Your account is not active.' };
  if (!isKnownAction(row.action)) return { ok: false, status: 400, message: 'Unknown action.' };
  return { ok: true };
}

// What the link will do — for the /act page to show before/without acting.
async function describe(token) {
  const row = await loadRow(token);
  const check = checkRow(row);
  if (!check.ok) return check;
  return { ok: true, action: row.action, label: ACTIONS[row.action].label, entity_type: row.entity_type, entity_id: Number(row.entity_id) };
}

async function apply(token) {
  const row = await loadRow(token);
  const check = checkRow(row);
  if (!check.ok) return check;
  // Claim the token atomically so two clicks (or a retry) can't run it twice.
  const claim = await pool.query(
    `UPDATE email_action_tokens SET used_at = NOW() WHERE id = $1 AND used_at IS NULL RETURNING id`,
    [row.id]
  );
  if (claim.rows.length === 0) return { ok: false, status: 410, message: 'This link was already used.', used: true };
  try {
    const { result, message } = await ACTIONS[row.action].run(row);
    return { ok: true, action: row.action, entity_type: row.entity_type, entity_id: Number(row.entity_id), result, message };
  } catch (err) {
    // Give the token back on a failure that wasn't a mutation, so a
    // transient error is retryable from the same email.
    if (!err.status) {
      try { await pool.query('UPDATE email_action_tokens SET used_at = NULL WHERE id = $1', [row.id]); } catch { /* best effort */ }
    }
    return { ok: false, status: err.status || 500, message: err.status ? err.message : 'Something went wrong. Open the app and try there.' };
  }
}

async function sweep({ olderThanDays = 14 } = {}) {
  const r = await pool.query(
    `DELETE FROM email_action_tokens
      WHERE (used_at IS NOT NULL OR expires_at < NOW())
        AND created_at < NOW() - ($1 * INTERVAL '1 day')`,
    [olderThanDays]
  );
  return r.rowCount || 0;
}

module.exports = { ACTIONS, isKnownAction, mint, mintMany, describe, apply, sweep, PUBLIC_BASE_URL, TOKEN_TTL_MS, _hash: hash };
