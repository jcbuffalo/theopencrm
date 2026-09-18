// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Per-user dashboard layout — the persistence behind the customizable
// /dashboard page (migration 142).
//
// Scoping: per-USER config. Every query is `user_id = $1 AND <scope> = $2`
// where <scope> comes from the standard qs(req) helper — so one user's layout
// is never returned to another user (user_id half) and a stale row from a
// previous org can't leak across tenants (org half). Org-less users fall back
// to user_id = $1 AND user_id = $2, which is harmlessly redundant.
//
// Endpoints (plain auth, core surface — NOT feature-gated, like /api/my-day):
//   GET /layout — { saved, layout, defaultLayout, widgets }
//                 `layout` is the caller's saved layout, or DEFAULT_LAYOUT
//                 when none saved (saved=false). `widgets` is the full
//                 allowlisted catalog so the frontend's "Add widget" picker
//                 and the backend can never drift.
//   PUT /layout — validate against the widget allowlist (schemas/dashboard.js)
//                 and upsert. ON CONFLICT (user_id) — one row per user.
//
// Widgets themselves render from EXISTING endpoints (metrics / my-day /
// activities / forecast) — this router persists composition only and reads
// nothing but user_dashboards. See services/dashboardWidgets.js.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const { validateBody } = require('../middleware/validate');
const { putLayoutSchema } = require('../schemas/dashboard');
const { DEFAULT_LAYOUT, catalog, sanitizeItem } = require('../services/dashboardWidgets');

const router = express.Router();
router.use(authMiddleware);

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

router.get('/layout', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    let row = null;
    try {
      const r = await pool.query(
        `SELECT layout, updated_at FROM user_dashboards
          WHERE user_id = $1 AND ${sf} = $2`,
        [req.userId, sv]
      );
      row = r.rows[0] || null;
    } catch (e) {
      // 42P01 undefined_table — migration 142 not applied yet (older DB).
      // Degrade to the default layout instead of a 500, like /api/my-day does.
      if (e.code !== '42P01') throw e;
    }

    res.json({
      saved: !!row,
      layout: row ? row.layout : DEFAULT_LAYOUT,
      defaultLayout: DEFAULT_LAYOUT,
      widgets: catalog(),
      updated_at: row ? row.updated_at : null,
    });
  } catch (error) {
    if (req.log) req.log.error('dashboard_layout_get_failed', { error });
    else console.error('dashboard layout get error:', error);
    res.status(500).json({ error: 'Failed to load dashboard layout' });
  }
});

router.put('/layout', validateBody(putLayoutSchema), async (req, res) => {
  try {
    // zod has enforced: array, allowlisted widgetKeys, no duplicates, size
    // enum. sanitizeItem strips passthrough extras and fills default sizes so
    // the stored JSONB is exactly [{ widgetKey, size }].
    const layout = req.body.layout.map(sanitizeItem);

    const r = await pool.query(
      `INSERT INTO user_dashboards (user_id, org_id, layout)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (user_id) DO UPDATE
         SET layout = EXCLUDED.layout,
             org_id = EXCLUDED.org_id,
             updated_at = CURRENT_TIMESTAMP
       RETURNING layout, updated_at`,
      [req.userId, req.orgId || null, JSON.stringify(layout)]
    );

    res.json({
      success: true,
      saved: true,
      layout: r.rows[0].layout,
      updated_at: r.rows[0].updated_at,
    });
  } catch (error) {
    if (req.log) req.log.error('dashboard_layout_put_failed', { error });
    else console.error('dashboard layout put error:', error);
    res.status(500).json({ error: 'Failed to save dashboard layout' });
  }
});

module.exports = router;
