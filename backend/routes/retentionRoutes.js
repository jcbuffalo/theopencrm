// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Retention & expansion analytics — recurring revenue (MRR/ARR), renewals,
// NRR/GRR, expansion, and churn. Mounted at /api/retention behind
// requireFeature('customer_success_enabled') (see index.js).
//
// FEATURE GATE CHOICE: this is a customer-success surface — it lives in the same
// module as the service-contract /renewals rollup, which is already gated on
// 'customer_success_enabled'. Gating retention the same way keeps the whole
// post-sale / retention story behind one flag (rather than the broader
// 'reports_enabled' analytics flag). Degrades gracefully to the standard
// "module not enabled" 403 when the flag is off.
//
// Endpoints (all auth-required, all org-scoped via qs(req)):
//   GET / — retention summary (recurring revenue + renewals + NRR/GRR +
//           expansion + churn)
//
// All SQL safety lives in services/retention.js: two org-scoped, parameterized
// queries (service_contracts + deals); the profile terminal-stage map is a
// constant reused from services/forecast.js, never user input.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const retention = require('../services/retention');

const router = express.Router();
router.use(authMiddleware);

// Same helper every CRUD route uses: org scope, falling back to user scope.
function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// The org's white-label profile drives won-deal classification for the
// expansion heuristic. Users with no org fall back to 'generic'.
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
// GET / — retention summary.
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const profile = await loadProfile(req);
    const out = await retention.getRetention({ sf, sv, profile }, pool);
    res.json({ success: true, ...out });
  } catch (error) {
    if (req.log) req.log.error('retention_failed', { error });
    else console.error('retention error:', error);
    res.status(500).json({ error: 'Failed to compute retention analytics' });
  }
});

module.exports = router;
