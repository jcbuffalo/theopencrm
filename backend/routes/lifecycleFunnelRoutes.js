// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Lifecycle Funnel analytics — distribution of the customer base across the
// account lifecycle stages, at-risk exposure, and recent movement. Mounted at
// /api/lifecycle-funnel behind requireFeature('customer_success_enabled')
// (see index.js), right beside its sibling /api/retention.
//
// FEATURE GATE CHOICE: same reasoning as retentionRoutes.js — lifecycle_stage
// is the customer-success relationship field (migration 122), so the whole
// post-sale story stays behind the one 'customer_success_enabled' flag.
// Degrades gracefully to the standard "module not enabled" 403 when off.
//
// Endpoints (all auth-required, all org-scoped via qs(req)):
//   GET / — { distribution, atRisk, movement }
//     distribution — all six canonical stages, zero-filled, with counts + % of base
//     atRisk       — at_risk company count + open-deal value + MRR/ARR at risk
//     movement     — recently-touched accounts by current stage (clearly labeled
//                    'recent_activity': no true transition history exists)
//
// All SQL safety lives in services/lifecycleFunnel.js: org-scoped,
// parameterized queries with an allowlisted scope field; the profile
// terminal-stage map is the constant from services/forecast.js, never user input.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const lifecycleFunnel = require('../services/lifecycleFunnel');

const router = express.Router();
router.use(authMiddleware);

// Same helper every CRUD route uses: org scope, falling back to user scope.
function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// The org's white-label profile drives open-deal classification for the
// at-risk pipeline number. Users with no org fall back to 'generic'.
// (Mirrors retentionRoutes.loadProfile — kept local so the two route files
// stay independent and merge-conflict-free.)
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

// ---------------------------------------------------------------------------
// GET / — lifecycle funnel summary.
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const profile = await loadProfile(req);
    const out = await lifecycleFunnel.getLifecycleFunnel({ sf, sv, profile }, pool);
    res.json({ success: true, ...out });
  } catch (error) {
    if (req.log) req.log.error('lifecycle_funnel_failed', { error });
    else console.error('lifecycle funnel error:', error);
    res.status(500).json({ error: 'Failed to compute lifecycle funnel analytics' });
  }
});

module.exports = router;
