// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Record comments with @mentions (migration 146) — /api/comments.
// Mirrors routes/dealLineItemRoutes.js in style: plain auth, qs(req) tenancy,
// and an in-scope check on the TARGET entity before any comment SQL runs
// (cross-org entity ids 404 with no existence oracle).
//
// Endpoints (all auth-required, org-scoped):
//   GET    /?entity_type=&entity_id=  — list a record's comments, oldest→newest
//   POST   /                          — add a comment (+ optional mentioned_user_ids)
//   PUT    /:id                       — edit (author only)
//   DELETE /:id                       — remove (author or org owner/admin)
//
// @mentions: the frontend sends an EXPLICIT mentioned_user_ids array (we don't
// re-parse the body server-side — the composer is the source of truth). Every
// id is validated in-org; self-mentions are dropped; each surviving mention
// fans out via notificationDispatcher.notifyMention, strictly fire-and-forget
// so a notification failure never breaks the comment write.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const comments = require('../services/comments');
const notificationDispatcher = require('../services/notificationDispatcher');

const router = express.Router();
router.use(authMiddleware);

// Returns [scopeField, scopeValue] for the current request's tenancy.
function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

const AUTHOR_JOIN = `
  SELECT c.*, u.name AS author_name, u.email AS author_email
    FROM record_comments c
    LEFT JOIN users u ON u.id = c.author_user_id`;

// GET /?entity_type=&entity_id= — the record's thread, oldest first.
router.get('/', async (req, res) => {
  try {
    const { entity_type: entityType, entity_id: entityId } = req.query;
    if (!comments.isValidEntityType(entityType)) {
      return res.status(400).json({ error: 'entity_type must be one of: ' + Object.keys(comments.ENTITY_TABLES).join(', ') });
    }
    const [sf, sv] = qs(req);
    if (!(await comments.entityInScope(entityType, entityId, sf, sv))) {
      return res.status(404).json({ error: 'Record not found' });
    }
    const r = await pool.query(
      `${AUTHOR_JOIN}
        WHERE c.entity_type = $1 AND c.entity_id = $2 AND c.${sf} = $3
        ORDER BY c.created_at ASC, c.id ASC`,
      [entityType, Number(entityId), sv],
    );
    res.json(r.rows);
  } catch (error) {
    console.error('Comments fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// POST / — add a comment. Body: { entity_type, entity_id, body,
// mentioned_user_ids? }. The target entity must be in-scope; every mention
// must be in-org; self-mentions are silently dropped.
router.post('/', async (req, res) => {
  try {
    const bodyIn = req.body || {};
    const { entity_type: entityType, entity_id: entityId } = bodyIn;
    if (!comments.isValidEntityType(entityType)) {
      return res.status(400).json({ error: 'entity_type must be one of: ' + Object.keys(comments.ENTITY_TABLES).join(', ') });
    }
    const norm = comments.normalizeBody(bodyIn.body);
    if (norm.error) return res.status(400).json({ error: norm.error });

    const [sf, sv] = qs(req);
    if (!(await comments.entityInScope(entityType, entityId, sf, sv))) {
      return res.status(404).json({ error: 'Record not found' });
    }

    const mentions = await comments.validateMentions(bodyIn.mentioned_user_ids, req);
    if (mentions.error) return res.status(400).json({ error: mentions.error });

    const ins = await pool.query(
      `INSERT INTO record_comments
         (org_id, user_id, entity_type, entity_id, author_user_id, body)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.orgId || null, req.userId, entityType, Number(entityId), req.userId, norm.body],
    );
    const comment = ins.rows[0];

    // Fan out mentions — best-effort, never blocks or fails the write.
    // Self-mentions are dropped here so the dispatcher is only ever invoked
    // for someone OTHER than the author.
    const recipients = mentions.ids.filter((id) => id !== Number(req.userId));
    for (const mentionedUserId of recipients) {
      notificationDispatcher
        .notifyMention(comment.id, mentionedUserId, req.userId)
        .catch(() => {});
    }

    res.status(201).json({ ...comment, mentioned_user_ids: recipients });
  } catch (error) {
    console.error('Comment create error:', error);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// PUT /:id — edit a comment's body. Author only (admins moderate via DELETE,
// they don't rewrite someone else's words).
router.put('/:id', async (req, res) => {
  try {
    const norm = comments.normalizeBody((req.body || {}).body);
    if (norm.error) return res.status(400).json({ error: norm.error });

    const [sf, sv] = qs(req);
    const existing = await pool.query(
      `SELECT id, author_user_id FROM record_comments WHERE id = $1 AND ${sf} = $2`,
      [req.params.id, sv],
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Comment not found' });
    if (Number(existing.rows[0].author_user_id) !== Number(req.userId)) {
      return res.status(403).json({ error: 'Only the author can edit a comment' });
    }

    const upd = await pool.query(
      `UPDATE record_comments SET body = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2 AND ${sf} = $3 RETURNING *`,
      [norm.body, req.params.id, sv],
    );
    res.json(upd.rows[0]);
  } catch (error) {
    console.error('Comment update error:', error);
    res.status(500).json({ error: 'Failed to update comment' });
  }
});

// DELETE /:id — author or org owner/admin (moderation).
router.delete('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const existing = await pool.query(
      `SELECT id, author_user_id FROM record_comments WHERE id = $1 AND ${sf} = $2`,
      [req.params.id, sv],
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Comment not found' });
    const isAuthor = Number(existing.rows[0].author_user_id) === Number(req.userId);
    if (!isAuthor && !comments.isOrgAdmin(req)) {
      return res.status(403).json({ error: 'Only the author or an org admin can delete a comment' });
    }

    await pool.query(
      `DELETE FROM record_comments WHERE id = $1 AND ${sf} = $2`,
      [req.params.id, sv],
    );
    res.json({ message: 'Comment deleted' });
  } catch (error) {
    console.error('Comment delete error:', error);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

module.exports = router;
