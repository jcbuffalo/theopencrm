// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Saved views — per-user named filter/sort presets, rendered as tabs above
// each list page (Companies / Contacts / Deals / Tasks).
//
// v2 (migration 073) adds:
//   * is_shared      — owner can publish a view to the whole org; other
//                      org members get a read-only copy in their tab strip
//   * display_order  — explicit ordering column so the UI can support
//                      drag-to-reorder without depending on name sort
//
// Endpoints (all auth-required):
//   GET    /?resource=contacts  — list views visible to this user. Includes
//                                 (a) views the user owns and
//                                 (b) shared views from anyone else in the
//                                     same org. Each row carries a `shared`
//                                     boolean: TRUE iff visible-because-shared
//                                     and not owned by the caller.
//   POST   /                    — create. `is_shared` optional.
//   PUT    /:id                 — partial update. Only the owner may edit;
//                                 non-owners on shared views get 403.
//                                 Accepts `display_order` for drag-to-reorder.
//   DELETE /:id                 — delete. Owner only (403 otherwise).
//
// filter_spec / sort_spec stay opaque JSONB — see migration 068 header for
// rationale (no cross-page normalization layer).

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const audit = require('../services/audit');
const { validateBody } = require('../middleware/validate');
const savedViewSchemas = require('../schemas/savedViews');

const router = express.Router();
router.use(authMiddleware);

const VALID_RESOURCES = new Set(['companies', 'contacts', 'deals', 'tasks']);

// Returns an order-stable shape so the frontend can do `views[0]` to find
// the default. Order: defaults first, then by explicit display_order, then
// alpha by name as a deterministic tiebreaker. Includes both user-owned
// views and views shared by other users in the same org.
router.get('/', async (req, res) => {
  try {
    const { resource } = req.query;
    if (!resource || !VALID_RESOURCES.has(resource)) {
      return res.status(400).json({ error: `resource must be one of: ${Array.from(VALID_RESOURCES).join(', ')}` });
    }

    // The OR-with-org-id half is gated on req.orgId so users without an org
    // don't accidentally pull shared rows where org_id IS NULL.
    const r = await pool.query(
      `SELECT id, user_id, org_id, resource, name, filter_spec, sort_spec,
              is_default, is_shared, display_order, created_at, updated_at,
              (user_id <> $1) AS shared
         FROM saved_views
        WHERE resource = $2
          AND (
                user_id = $1
                OR ($3::int IS NOT NULL AND org_id = $3 AND is_shared = TRUE)
              )
        ORDER BY is_default DESC, display_order ASC, LOWER(name) ASC`,
      [req.userId, resource, req.orgId || null]
    );
    res.json(r.rows);
  } catch (error) {
    if (req.log) req.log.error('saved_views_list_failed', { error });
    else console.error('saved_views list error:', error);
    res.status(500).json({ error: 'Failed to load saved views' });
  }
});

router.post('/', validateBody(savedViewSchemas.createSchema), async (req, res) => {
  const { resource, name, filter_spec, sort_spec, is_default, is_shared } = req.body;
  // zod has enforced resource ∈ VALID_RESOURCES and a non-empty trimmed name
  // ≤80 chars. trimmedName is just `name` (already trimmed by the schema).
  const trimmedName = name;

  // Set-default + insert run in a single transaction so we can't briefly
  // observe two defaults at once.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (is_default === true) {
      await client.query(
        `UPDATE saved_views SET is_default = FALSE
          WHERE user_id = $1 AND resource = $2 AND is_default = TRUE`,
        [req.userId, resource]
      );
    }

    const insert = await client.query(
      `INSERT INTO saved_views
         (user_id, org_id, resource, name, filter_spec, sort_spec, is_default, is_shared)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, user_id, org_id, resource, name, filter_spec, sort_spec,
                 is_default, is_shared, display_order, created_at, updated_at,
                 FALSE AS shared`,
      [
        req.userId,
        req.orgId || null,
        resource,
        trimmedName,
        JSON.stringify(filter_spec || {}),
        JSON.stringify(sort_spec || {}),
        is_default === true,
        is_shared === true,
      ]
    );

    await client.query('COMMIT');

    audit.fromReq(req, {
      event: audit.EVENTS.SAVED_VIEW_CREATED,
      targetType: 'saved_view',
      targetId: insert.rows[0].id,
      meta: { resource, name: trimmedName, is_default: is_default === true, is_shared: is_shared === true },
    });

    res.status(201).json(insert.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (req.log) req.log.error('saved_view_create_failed', { error });
    else console.error('saved_view create error:', error);
    res.status(500).json({ error: 'Failed to create saved view' });
  } finally {
    client.release();
  }
});

router.put('/:id', validateBody(savedViewSchemas.updateSchema), async (req, res) => {
  const { name, filter_spec, sort_spec, is_default, is_shared, display_order } = req.body;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Pull the row first so we can enforce owner-only edits. A non-owner who
    // can only see this row because is_shared = TRUE must get 403, not 404,
    // so they understand the row exists but they can't mutate it.
    const existing = await client.query(
      `SELECT id, user_id, resource FROM saved_views WHERE id = $1`,
      [id]
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Saved view not found' });
    }
    if (existing.rows[0].user_id !== req.userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only the view owner can modify this view' });
    }
    const { resource } = existing.rows[0];

    if (is_default === true) {
      await client.query(
        `UPDATE saved_views SET is_default = FALSE
          WHERE user_id = $1 AND resource = $2 AND id <> $3 AND is_default = TRUE`,
        [req.userId, resource, id]
      );
    }

    // zod has already trimmed/sliced `name` to ≤80 chars when present.
    const trimmedName = typeof name === 'string' ? name : null;
    const dispOrder   = Number.isFinite(display_order) ? Math.trunc(display_order) : null;

    const r = await client.query(
      `UPDATE saved_views SET
         name          = COALESCE($1, name),
         filter_spec   = COALESCE($2::jsonb, filter_spec),
         sort_spec     = COALESCE($3::jsonb, sort_spec),
         is_default    = COALESCE($4, is_default),
         is_shared     = COALESCE($5, is_shared),
         display_order = COALESCE($6, display_order),
         updated_at    = CURRENT_TIMESTAMP
       WHERE id = $7 AND user_id = $8
       RETURNING id, user_id, org_id, resource, name, filter_spec, sort_spec,
                 is_default, is_shared, display_order, created_at, updated_at,
                 FALSE AS shared`,
      [
        trimmedName,
        filter_spec === undefined ? null : JSON.stringify(filter_spec),
        sort_spec   === undefined ? null : JSON.stringify(sort_spec),
        typeof is_default === 'boolean' ? is_default : null,
        typeof is_shared  === 'boolean' ? is_shared  : null,
        dispOrder,
        id, req.userId,
      ]
    );

    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (req.log) req.log.error('saved_view_update_failed', { error });
    else console.error('saved_view update error:', error);
    res.status(500).json({ error: 'Failed to update saved view' });
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });

    // Same owner-only rule as PUT — non-owners viewing a shared view get 403,
    // not 404, so the UI can distinguish "missing" from "not yours".
    const existing = await pool.query(
      `SELECT user_id FROM saved_views WHERE id = $1`,
      [id]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Saved view not found' });
    if (existing.rows[0].user_id !== req.userId) {
      return res.status(403).json({ error: 'Only the view owner can delete this view' });
    }

    const r = await pool.query(
      `DELETE FROM saved_views WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, req.userId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Saved view not found' });
    res.json({ success: true });
  } catch (error) {
    if (req.log) req.log.error('saved_view_delete_failed', { error });
    else console.error('saved_view delete error:', error);
    res.status(500).json({ error: 'Failed to delete saved view' });
  }
});

module.exports = router;
