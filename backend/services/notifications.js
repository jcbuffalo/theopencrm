// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// In-app notifications service — the data layer behind the Notification
// Center (nav bell + /notifications page).
//
// Scoping convention: every reader/writer takes an `orgScope` tuple in the
// exact shape routes already produce via qs(req): ['org_id', <orgId>] for
// org members, ['user_id', <userId>] for org-less users. Readers ALWAYS add
// `AND user_id = <recipient>` on top of the scope — notifications are
// personal, so even inside one org a user can only ever see their own rows.
//
// create() is called from services/notificationDispatcher.js (best-effort,
// wrapped in try/catch there) — a failed insert must never break an email/
// SMS dispatch, so this module just throws naturally and lets callers decide.

const pool = require('./../db');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Allowed scope fields — orgScope[0] is interpolated into SQL, so it must
// come from this closed set, never from user input.
const SCOPE_FIELDS = new Set(['org_id', 'user_id']);

function assertScope(orgScope) {
  if (!Array.isArray(orgScope) || !SCOPE_FIELDS.has(orgScope[0])) {
    throw new Error(`notifications: invalid orgScope ${JSON.stringify(orgScope)}`);
  }
  return orgScope;
}

/**
 * Persist one in-app notification for one recipient.
 *
 * @param {object} n
 * @param {[string, number]} n.orgScope — ['org_id', id] or ['user_id', id]
 * @param {number} n.userId — recipient (NOT NULL)
 * @param {string} n.type — dispatcher category or any producer-defined type
 * @param {string} n.title
 * @param {string} [n.body]
 * @param {string} [n.link] — in-app route to open on click (e.g. "/tasks")
 * @param {string} [n.entityType]
 * @param {number} [n.entityId]
 * @returns {Promise<object>} the inserted row
 */
async function create({ orgScope, userId, type, title, body, link, entityType, entityId }) {
  const [sf, sv] = assertScope(orgScope);
  if (!userId) throw new Error('notifications.create: userId is required');
  const orgId = sf === 'org_id' ? sv : null;
  const r = await pool.query(
    `INSERT INTO notifications (org_id, user_id, type, title, body, link, entity_type, entity_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [orgId, userId, type, title || '(untitled)', body || null, link || null, entityType || null, entityId ?? null]
  );
  return r.rows[0];
}

/**
 * List a recipient's notifications, newest first.
 * @param {[string, number]} orgScope
 * @param {number} userId
 * @param {{unreadOnly?: boolean, limit?: number}} [opts]
 */
async function listForUser(orgScope, userId, { unreadOnly = false, limit = DEFAULT_LIMIT } = {}) {
  const [sf, sv] = assertScope(orgScope);
  const cappedLimit = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const r = await pool.query(
    `SELECT * FROM notifications
      WHERE ${sf} = $1 AND user_id = $2
        ${unreadOnly ? 'AND read_at IS NULL' : ''}
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [sv, userId, cappedLimit]
  );
  return r.rows;
}

/** Count a recipient's unread notifications. */
async function unreadCount(orgScope, userId) {
  const [sf, sv] = assertScope(orgScope);
  const r = await pool.query(
    `SELECT COUNT(*)::int AS count FROM notifications
      WHERE ${sf} = $1 AND user_id = $2 AND read_at IS NULL`,
    [sv, userId]
  );
  return r.rows[0] ? r.rows[0].count : 0;
}

/**
 * Mark one of the recipient's notifications read (idempotent — re-marking a
 * read row keeps its original read_at). Returns the updated row, or null
 * when the id doesn't exist inside this scope+recipient (never leaks whether
 * it exists for someone else).
 */
async function markRead(orgScope, userId, id) {
  const [sf, sv] = assertScope(orgScope);
  const r = await pool.query(
    `UPDATE notifications
        SET read_at = COALESCE(read_at, NOW())
      WHERE ${sf} = $1 AND user_id = $2 AND id = $3
      RETURNING *`,
    [sv, userId, id]
  );
  return r.rows[0] || null;
}

/** Mark ALL of the recipient's unread notifications read. Returns the count updated. */
async function markAllRead(orgScope, userId) {
  const [sf, sv] = assertScope(orgScope);
  const r = await pool.query(
    `UPDATE notifications
        SET read_at = NOW()
      WHERE ${sf} = $1 AND user_id = $2 AND read_at IS NULL
      RETURNING id`,
    [sv, userId]
  );
  return r.rowCount || 0;
}

module.exports = { create, listForUser, unreadCount, markRead, markAllRead };
