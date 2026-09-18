// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Relationship Pulse — lightweight NPS / CSAT per account. Mounted at
// /api/pulse behind requireFeature('customer_success_enabled') (see index.js).
//
// FEATURE GATE CHOICE: a satisfaction pulse is a customer-success signal — it
// feeds the same Accounts rollup as account health and renewals, so it lives
// behind the same 'customer_success_enabled' flag as /api/accounts and
// /api/retention. Degrades to the standard "module not enabled" 403 when off.
//
// Endpoints (all auth-required, all org-scoped via qs(req)):
//   POST /          — record a pulse for a company (score + optional
//                     contact/comment; CSAT 1–5 normalized to the stored 0–10
//                     scale — see services/relationshipPulse.js)
//   GET  /?company_id=<id> — pulse history for one company, newest first
//   GET  /summary   — org NPS rollup over the latest pulse per company
//
// All SQL lives in services/relationshipPulse.js (scope-field allowlist +
// fully parameterized). The service throws PulseError({400|404}) for
// validation / cross-org misses; anything else is a 500.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const pulse = require('../services/relationshipPulse');

const router = express.Router();
router.use(authMiddleware);

// Same helper every CRUD route uses: org scope, falling back to user scope.
function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// POST / — record a pulse. 201 with the inserted row (score is the stored
// 0–10 value; `band`/`band_label` are the derived health signal so the client
// can paint the row without re-deriving the mapping).
router.post('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { company_id, contact_id, score, kind, comment } = req.body || {};
    const row = await pulse.recordPulse(
      { sf, sv, orgId: req.orgId, userId: req.userId },
      { companyId: company_id, contactId: contact_id, score, kind, comment },
      pool
    );
    const signal = pulse.pulseHealthSignal(row.score);
    res.status(201).json({ ...row, band: signal?.band || null, band_label: signal?.label || null });
  } catch (error) {
    if (error instanceof pulse.PulseError) {
      return res.status(error.status).json({ error: error.message });
    }
    if (req.log) req.log.error('pulse_record_failed', { error });
    else console.error('Pulse record error:', error.message);
    res.status(500).json({ error: 'Failed to record pulse' });
  }
});

// GET /summary — org-wide NPS rollup (latest pulse per company). Declared
// before GET / only for readability; the two paths don't collide.
router.get('/summary', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const summary = await pulse.pulseSummary({ sf, sv }, pool);
    res.json({ success: true, ...summary });
  } catch (error) {
    if (req.log) req.log.error('pulse_summary_failed', { error });
    else console.error('Pulse summary error:', error.message);
    res.status(500).json({ error: 'Failed to compute pulse summary' });
  }
});

// GET /?company_id=<id> — pulse history for one company, newest first.
// Capped at 200 rows so a heavily-surveyed account can't flood the response.
router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const companyId = parseInt(req.query.company_id, 10);
    if (!Number.isInteger(companyId)) {
      return res.status(400).json({ error: 'company_id query parameter is required' });
    }
    const result = await pool.query(
      `SELECT id, company_id, contact_id, score, kind, comment, recorded_by, created_at
         FROM relationship_pulses
        WHERE ${sf} = $1 AND company_id = $2
        ORDER BY created_at DESC, id DESC
        LIMIT 200`,
      [sv, companyId]
    );
    const pulses = result.rows.map((r) => {
      const signal = pulse.pulseHealthSignal(r.score);
      return { ...r, band: signal?.band || null, band_label: signal?.label || null };
    });
    res.json({ pulses });
  } catch (error) {
    if (req.log) req.log.error('pulse_history_failed', { error });
    else console.error('Pulse history error:', error.message);
    res.status(500).json({ error: 'Failed to fetch pulse history' });
  }
});

module.exports = router;
