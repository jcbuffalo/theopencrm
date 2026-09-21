// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// My Day — the personal relationship work-queue behind GET /api/my-day.
//
// One aggregated payload answering "what needs me today?":
//   • tasksDue             — MY open tasks due today or overdue (soonest first)
//   • renewals             — service contracts renewing in the next 30 days
//   • atRiskAccounts       — customer accounts with lifecycle_stage = 'at_risk'
//   • quietAccounts        — customer accounts with no touch in > 30 days
//   • dealsNeedingAttention — open deals past their expected close date or with
//                             no activity in > 14 days
//   • nextSteps            — open deals whose committed next_step_date
//                             (migration 172) is today or overdue, most overdue
//                             first
//   • has_data             — { deals, contacts, companies } row counts so the
//                             Chat front door can pick its empty state without
//                             fetching the full lists (null if the count fails)
//
// Scoping: every query is org-scoped via qs(req) → [sf, sv]. tasksDue is
// ADDITIONALLY user-scoped — a task counts as "mine" when it's assigned to me,
// or unassigned but created by me (assigned_to IS NULL AND user_id = me).
//
// Resilience: each section runs inside its own try/catch and degrades to []
// on failure, so an org without the customer-success tables (or any single
// broken source) still gets a 200 with the sections that DID load. This is a
// core surface — deliberately NOT feature-gated at the mount.

const express = require('express');
const { authMiddleware } = require('../auth');
const { loadMyDay } = require('../services/myDay');

const router = express.Router();
router.use(authMiddleware);

// Returns [scopeField, scopeValue] for the current request's tenancy.
// Falls back to user_id when the user doesn't belong to an org.
function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// The queue itself lives in services/myDay.js (shared with the daily
// notification digest email). This route only adds auth + scoping.
router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    res.json(await loadMyDay({ sf, sv, userId: req.userId, log: req.log || null }));
  } catch (error) {
    if (req.log) req.log.error('my_day_failed', { error });
    else console.error('My Day error:', error.message);
    res.status(500).json({ error: 'Failed to fetch My Day' });
  }
});

module.exports = router;
