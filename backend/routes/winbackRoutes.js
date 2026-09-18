// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Win-back board — churned-account re-engagement. Mounted at /api/winback
// behind requireFeature('customer_success_enabled') (see index.js), completing
// the lifecycle loop opened by migrations 122 (lifecycle_stage) + 127
// (churned_at / churned_reason): churn is captured on the lifecycle transition,
// this surface lists WHO churned, WHEN and WHY, and launches the win-back
// motion.
//
// FEATURE GATE CHOICE: same flag as /api/accounts and /api/retention — win-back
// is the tail end of the customer-success motion, so the whole post-sale story
// stays behind one flag.
//
// Endpoints (all auth-required, all org-scoped via qs(req)):
//   GET  /                       — churned companies, most-recent churn first, capped
//   GET  /summary                — light stats: total churned + churned in last 90d
//   POST /:companyId/reengage    — org owner/admin only: create a "Win-back
//                                  outreach" task; optionally move the account
//                                  back to prospect|onboarding (allowlisted)

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');

const router = express.Router();
router.use(authMiddleware);

// Same helper every CRUD route uses: org scope, falling back to user scope.
function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// Re-engagement WRITES are owner/admin gated (same isOrgAdmin pattern as
// company merge): launching a win-back motion mutates the account's lifecycle
// and creates work items. Users without an org are their own admin.
function isOrgAdmin(req) {
  if (!req.orgId) return true;
  return req.orgRole === 'owner' || req.orgRole === 'admin';
}

// Where a re-engaged account may move. Deliberately NOT the full
// LIFECYCLE_STAGES list — a win-back restarts the relationship at the top of
// the lifecycle, it never jumps straight to active/renewed.
const REENGAGE_STAGES = ['prospect', 'onboarding'];

// How many churned accounts the board loads. Win-back is a worked queue, not
// an export; past a few hundred rows the board is unusable anyway.
const BOARD_CAP = 200;

// ---------------------------------------------------------------------------
// GET / — the org's churned accounts, most recent churn first.
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    // NULLS LAST: legacy rows churned before migration 127 have no churned_at;
    // they still belong on the board, just at the bottom of the queue.
    const result = await pool.query(
      `SELECT id, name, industry, type, lifecycle_stage, churned_reason, churned_at,
              CASE WHEN churned_at IS NULL THEN NULL
                   ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - churned_at)) / 86400))::int
              END AS days_since_churn
         FROM companies
        WHERE ${sf} = $1 AND lifecycle_stage = 'churned'
        ORDER BY churned_at DESC NULLS LAST, updated_at DESC
        LIMIT ${BOARD_CAP}`,
      [sv]
    );
    res.json({ companies: result.rows });
  } catch (error) {
    if (req.log) req.log.error('winback_list_failed', { error });
    else console.error('Winback list error:', error);
    res.status(500).json({ error: 'Failed to fetch churned accounts' });
  }
});

// ---------------------------------------------------------------------------
// GET /summary — light stats for the board header. Won-back counts are
// deliberately omitted: churned_at is CLEARED when an account leaves churned
// (see companyRoutes lifecycle handler), so "left churned recently" isn't
// cheaply derivable without an event log.
// ---------------------------------------------------------------------------
router.get('/summary', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(
      `SELECT COUNT(*)::int AS churned_total,
              COUNT(*) FILTER (WHERE churned_at >= CURRENT_TIMESTAMP - interval '90 days')::int AS churned_90d
         FROM companies
        WHERE ${sf} = $1 AND lifecycle_stage = 'churned'`,
      [sv]
    );
    res.json({ summary: result.rows[0] });
  } catch (error) {
    if (req.log) req.log.error('winback_summary_failed', { error });
    else console.error('Winback summary error:', error);
    res.status(500).json({ error: 'Failed to fetch win-back summary' });
  }
});

// ---------------------------------------------------------------------------
// POST /:companyId/reengage  { moveToStage? } — launch the win-back motion.
// Creates a "Win-back outreach" task due in 3 days (tasks have no company FK,
// so the company is named in the title/description) and optionally moves the
// account back to an allowlisted early-lifecycle stage. Default: the account
// STAYS churned until the outreach actually lands.
// ---------------------------------------------------------------------------
router.post('/:companyId/reengage', async (req, res) => {
  try {
    if (!isOrgAdmin(req)) {
      return res.status(403).json({ error: 'Only org owners/admins can start a win-back' });
    }
    const companyId = parseInt(req.params.companyId, 10);
    if (!Number.isInteger(companyId)) {
      return res.status(400).json({ error: 'Invalid company id' });
    }
    const { moveToStage } = req.body || {};
    if (moveToStage != null && !REENGAGE_STAGES.includes(moveToStage)) {
      return res.status(400).json({ error: `moveToStage must be one of: ${REENGAGE_STAGES.join(', ')}` });
    }

    // Scope + state check in one read: the id must be in the caller's org AND
    // actually churned — re-engaging a live account is a client error.
    const [sf, sv] = qs(req);
    const found = await pool.query(
      `SELECT id, name, lifecycle_stage, churned_reason, churned_at
         FROM companies WHERE id = $1 AND ${sf} = $2`,
      [companyId, sv]
    );
    if (found.rows.length === 0) return res.status(404).json({ error: 'Company not found' });
    const company = found.rows[0];
    if (company.lifecycle_stage !== 'churned') {
      return res.status(409).json({ error: 'Company is not churned — win-back only applies to churned accounts' });
    }

    // Due "soon": 3 days out, high priority — a win-back queue that isn't
    // worked promptly is just a churn list with extra steps.
    const description = [
      `Re-engage ${company.name} after churn.`,
      company.churned_reason ? `Churn reason: ${company.churned_reason}.` : null,
      company.churned_at ? `Churned: ${new Date(company.churned_at).toISOString().slice(0, 10)}.` : null,
    ].filter(Boolean).join(' ');
    const taskResult = await pool.query(
      `INSERT INTO tasks (user_id, org_id, title, description, due_date, status, priority)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + interval '3 days', 'open', 'high') RETURNING *`,
      [req.userId, req.orgId || null, `Win-back outreach — ${company.name}`, description]
    );

    // Optional stage move. Mirrors the lifecycle-stage handler's leave-churned
    // semantics: churned_at / churned_reason are cleared, the account is a
    // live relationship again.
    let updated = null;
    if (moveToStage) {
      const upd = await pool.query(
        `UPDATE companies SET lifecycle_stage = $1, churned_at = NULL, churned_reason = NULL,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $2 AND ${sf} = $3 RETURNING *`,
        [moveToStage, companyId, sv]
      );
      updated = upd.rows[0] || null;
    }

    res.status(201).json({
      message: 'Win-back started',
      task: taskResult.rows[0],
      company: updated || company,
    });
  } catch (error) {
    if (req.log) req.log.error('winback_reengage_failed', { error });
    else console.error('Winback reengage error:', error);
    res.status(500).json({ error: 'Failed to start win-back' });
  }
});

module.exports = router;
