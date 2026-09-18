// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Sales forecasting — weighted pipeline, projected-close-by-period, and quota
// attainment. Mounted at /api/forecast behind requireFeature('reports_enabled')
// (see index.js), so the whole surface degrades gracefully to the standard
// "module not enabled" 403 when reports are off for the org.
//
// Endpoints (all auth-required, all org-scoped via qs(req)):
//   GET    /                — forecast summary (weighted pipeline + by-period +
//                             current-period quota attainment if a quota is set)
//   GET    /quotas          — list this scope's quota targets
//   POST   /quotas          — create a quota target
//   DELETE /quotas/:id      — delete a quota target
//
// All SQL safety lives in services/forecast.js: the aggregate runs ONE org-
// scoped, parameterized query over deals; the profile terminal-stage map is a
// constant, never user input. Quota CRUD binds every value as a parameter.

const express = require('express');
const { z } = require('zod');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const audit = require('../services/audit');
const forecast = require('../services/forecast');

const router = express.Router();
router.use(authMiddleware);

// Same helper every CRUD route uses: org scope, falling back to user scope.
function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// The org's white-label profile drives won/lost/open stage classification.
// Users with no org fall back to 'generic'. One tiny scoped lookup per request.
async function loadProfile(req) {
  if (!req.orgId) return 'generic';
  try {
    const r = await pool.query(
      `SELECT COALESCE(profile, 'generic') AS profile FROM organizations WHERE id = $1`,
      [req.orgId]
    );
    return r.rows[0]?.profile || 'generic';
  } catch {
    return 'generic';
  }
}

// Pick the quota whose window covers `now` for this scope, preferring an
// org-wide quota (owner_id IS NULL) at the finest period granularity. Returns
// the raw row or null.
async function loadCurrentQuota(req) {
  const [sf, sv] = qs(req);
  const r = await pool.query(
    `SELECT id, org_id, user_id, owner_id, period_type, period_start, target_amount
       FROM sales_quotas
      WHERE ${sf} = $1
        AND owner_id IS NULL
        AND period_start <= CURRENT_DATE
        AND (
          (period_type = 'month'   AND period_start >  (CURRENT_DATE - INTERVAL '1 month'))
          OR (period_type = 'quarter' AND period_start > (CURRENT_DATE - INTERVAL '3 month'))
          OR (period_type = 'year'    AND period_start > (CURRENT_DATE - INTERVAL '1 year'))
        )
      ORDER BY period_start DESC
      LIMIT 1`,
    [sv]
  );
  return r.rows[0] || null;
}

// ---------------------------------------------------------------------------
// GET / — forecast summary.
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const profile = await loadProfile(req);
    let quota = null;
    try { quota = await loadCurrentQuota(req); } catch { quota = null; } // quotas table optional
    const out = await forecast.getForecast({ sf, sv, profile, quota }, pool);
    res.json({ success: true, ...out });
  } catch (error) {
    if (req.log) req.log.error('forecast_failed', { error });
    else console.error('forecast error:', error);
    res.status(500).json({ error: 'Failed to compute forecast' });
  }
});

// ---------------------------------------------------------------------------
// GET /quotas — list this scope's quotas.
// ---------------------------------------------------------------------------
router.get('/quotas', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `SELECT id, org_id, user_id, owner_id, period_type, period_start, target_amount, created_at
         FROM sales_quotas
        WHERE ${sf} = $1
        ORDER BY period_start DESC, id DESC`,
      [sv]
    );
    res.json(r.rows);
  } catch (error) {
    if (req.log) req.log.error('quota_list_failed', { error });
    else console.error('quota list error:', error);
    res.status(500).json({ error: 'Failed to load quotas' });
  }
});

const quotaSchema = z.object({
  period_type: z.enum(['month', 'quarter', 'year']),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'period_start must be YYYY-MM-DD'),
  target_amount: z.coerce.number().finite().min(0),
  owner_id: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
});

// ---------------------------------------------------------------------------
// POST /quotas — create a quota target.
// ---------------------------------------------------------------------------
router.post('/quotas', async (req, res) => {
  try {
    const parsed = quotaSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Invalid quota', fields: parsed.error.issues });
    }
    const { period_type, period_start, target_amount, owner_id } = parsed.data;

    const r = await pool.query(
      `INSERT INTO sales_quotas (org_id, user_id, owner_id, period_type, period_start, target_amount, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, org_id, user_id, owner_id, period_type, period_start, target_amount, created_at`,
      [req.orgId || null, req.userId, owner_id ?? null, period_type, period_start, target_amount, req.userId]
    );

    audit.fromReq(req, {
      event: audit.EVENTS.SALES_QUOTA_CREATED,
      targetType: 'sales_quota',
      targetId: r.rows[0].id,
      meta: { period_type, period_start, target_amount },
    });

    res.status(201).json(r.rows[0]);
  } catch (error) {
    if (req.log) req.log.error('quota_create_failed', { error });
    else console.error('quota create error:', error);
    res.status(500).json({ error: 'Failed to create quota' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /quotas/:id — remove a quota (scoped).
// ---------------------------------------------------------------------------
router.delete('/quotas/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `DELETE FROM sales_quotas WHERE id = $1 AND ${sf} = $2 RETURNING id`,
      [id, sv]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Quota not found' });

    audit.fromReq(req, {
      event: audit.EVENTS.SALES_QUOTA_DELETED,
      targetType: 'sales_quota',
      targetId: id,
    });

    res.json({ success: true });
  } catch (error) {
    if (req.log) req.log.error('quota_delete_failed', { error });
    else console.error('quota delete error:', error);
    res.status(500).json({ error: 'Failed to delete quota' });
  }
});

module.exports = router;
