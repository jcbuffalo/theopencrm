// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Admin endpoints for the triggered-automation engine.

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../auth');
const { adminMiddleware } = require('../middleware/adminAuth');
const automation = require('../services/automation');
const pool = require('../db');

router.get('/rules', authMiddleware, adminMiddleware, (req, res) => {
  res.json({ success: true, rules: automation.listRules() });
});

router.post('/run', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const summary = await automation.runAll();
    res.json({ success: true, summary });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/runs', authMiddleware, adminMiddleware, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  // Scope to the caller's org. automation_runs spans every tenant, so an
  // unscoped query leaked all orgs' run history (incl. meta/target_id).
  if (!req.orgId) return res.json({ success: true, runs: [] });
  const rows = await pool.query(
    `SELECT id, org_id, rule, target_type, target_id, fired_at, status, meta
     FROM automation_runs WHERE org_id = $1 ORDER BY fired_at DESC LIMIT $2`,
    [req.orgId, limit]
  );
  res.json({ success: true, runs: rows.rows });
});

module.exports = router;
