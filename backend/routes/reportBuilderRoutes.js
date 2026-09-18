// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Custom report builder — ad-hoc runs + saved-report CRUD.
//
// Mounted at /api/reports behind requireFeature('reports_enabled') (see
// index.js), so this whole surface degrades gracefully to the standard
// "module not enabled" 403 when reports are off for the org.
//
// Endpoints (all auth-required, all org-scoped via qs(req)):
//   GET    /schema         — allowlist metadata for the builder UI dropdowns
//   POST   /run            — run an ad-hoc config, return chart/table rows
//   GET    /saved          — list saved reports visible to this scope
//   POST   /saved          — create a saved report (name + config)
//   GET    /saved/:id      — fetch one saved report
//   PUT    /saved/:id      — update name/config
//   DELETE /saved/:id      — delete
//
// The run engine (services/reportBuilder.js) owns all SQL safety: allowlist-only
// identifiers, bound parameters, mandatory org scope. Routes never build SQL for
// the aggregate — they only persist the opaque, validated config JSONB.

const express = require('express');
const { z } = require('zod');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const audit = require('../services/audit');
const reportBuilder = require('../services/reportBuilder');

const router = express.Router();
router.use(authMiddleware);

// Same helper every CRUD route uses: org scope, falling back to user scope.
function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

const savedName = z.string().trim().min(1, 'name required').transform(s => s.slice(0, 120));

// ---------------------------------------------------------------------------
// GET /schema — describe the allowlist so the frontend can build its pickers
// without hardcoding column lists that would drift from the engine.
// ---------------------------------------------------------------------------
router.get('/schema', (req, res) => {
  res.json(reportBuilder.describeEntities());
});

// ---------------------------------------------------------------------------
// POST /run — execute an ad-hoc report config. Body IS the config.
// ---------------------------------------------------------------------------
router.post('/run', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const out = await reportBuilder.runReport(req.body || {}, { sf, sv }, pool);
    if (!out.ok) {
      return res.status(400).json({ success: false, error: 'Invalid report config', fields: out.errors });
    }
    res.json({ success: true, config: out.config, rows: out.rows });
  } catch (error) {
    if (req.log) req.log.error('report_run_failed', { error });
    else console.error('report run error:', error);
    res.status(500).json({ error: 'Failed to run report' });
  }
});

// ---------------------------------------------------------------------------
// GET /saved — list this scope's saved reports.
// ---------------------------------------------------------------------------
router.get('/saved', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `SELECT id, org_id, user_id, name, entity, config, created_by, created_at, updated_at
         FROM saved_reports
        WHERE ${sf} = $1
        ORDER BY LOWER(name) ASC`,
      [sv]
    );
    res.json(r.rows);
  } catch (error) {
    if (req.log) req.log.error('saved_reports_list_failed', { error });
    else console.error('saved_reports list error:', error);
    res.status(500).json({ error: 'Failed to load saved reports' });
  }
});

// ---------------------------------------------------------------------------
// POST /saved — persist a named report. Validates the config with the same
// engine schema used by /run, so a saved report is always runnable.
// ---------------------------------------------------------------------------
router.post('/saved', async (req, res) => {
  try {
    const nameParse = savedName.safeParse(req.body && req.body.name);
    if (!nameParse.success) {
      return res.status(400).json({ success: false, error: 'name required' });
    }
    const v = reportBuilder.validateConfig(req.body && req.body.config);
    if (!v.ok) {
      return res.status(400).json({ success: false, error: 'Invalid report config', fields: v.errors });
    }

    const r = await pool.query(
      `INSERT INTO saved_reports (org_id, user_id, name, entity, config, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, org_id, user_id, name, entity, config, created_by, created_at, updated_at`,
      [req.orgId || null, req.userId, nameParse.data, v.config.entity, JSON.stringify(v.config), req.userId]
    );

    audit.fromReq(req, {
      event: audit.EVENTS.SAVED_REPORT_CREATED,
      targetType: 'saved_report',
      targetId: r.rows[0].id,
      meta: { name: nameParse.data, entity: v.config.entity },
    });

    res.status(201).json(r.rows[0]);
  } catch (error) {
    if (req.log) req.log.error('saved_report_create_failed', { error });
    else console.error('saved_report create error:', error);
    res.status(500).json({ error: 'Failed to save report' });
  }
});

// ---------------------------------------------------------------------------
// GET /saved/:id — one saved report (scoped).
// ---------------------------------------------------------------------------
router.get('/saved/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `SELECT id, org_id, user_id, name, entity, config, created_by, created_at, updated_at
         FROM saved_reports WHERE id = $1 AND ${sf} = $2`,
      [id, sv]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Saved report not found' });
    res.json(r.rows[0]);
  } catch (error) {
    if (req.log) req.log.error('saved_report_get_failed', { error });
    else console.error('saved_report get error:', error);
    res.status(500).json({ error: 'Failed to load saved report' });
  }
});

// ---------------------------------------------------------------------------
// PUT /saved/:id — partial update of name and/or config (both re-validated).
// ---------------------------------------------------------------------------
router.put('/saved/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const [sf, sv] = qs(req);

    let name = null;
    if (req.body && req.body.name !== undefined) {
      const nameParse = savedName.safeParse(req.body.name);
      if (!nameParse.success) return res.status(400).json({ success: false, error: 'name required' });
      name = nameParse.data;
    }

    let configJson = null;
    let entity = null;
    if (req.body && req.body.config !== undefined) {
      const v = reportBuilder.validateConfig(req.body.config);
      if (!v.ok) return res.status(400).json({ success: false, error: 'Invalid report config', fields: v.errors });
      configJson = JSON.stringify(v.config);
      entity = v.config.entity;
    }

    if (name === null && configJson === null) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const r = await pool.query(
      `UPDATE saved_reports SET
         name       = COALESCE($1, name),
         config     = COALESCE($2::jsonb, config),
         entity     = COALESCE($3, entity),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 AND ${sf} = $5
       RETURNING id, org_id, user_id, name, entity, config, created_by, created_at, updated_at`,
      [name, configJson, entity, id, sv]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Saved report not found' });
    res.json(r.rows[0]);
  } catch (error) {
    if (req.log) req.log.error('saved_report_update_failed', { error });
    else console.error('saved_report update error:', error);
    res.status(500).json({ error: 'Failed to update saved report' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /saved/:id — remove a saved report (scoped).
// ---------------------------------------------------------------------------
router.delete('/saved/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `DELETE FROM saved_reports WHERE id = $1 AND ${sf} = $2 RETURNING id`,
      [id, sv]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Saved report not found' });
    res.json({ success: true });
  } catch (error) {
    if (req.log) req.log.error('saved_report_delete_failed', { error });
    else console.error('saved_report delete error:', error);
    res.status(500).json({ error: 'Failed to delete saved report' });
  }
});

module.exports = router;
