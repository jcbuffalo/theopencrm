// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Call logging — /api/calls.
//
// A "log a call" action. There is NO live telephony / WebRTC in this pass —
// click-to-call is a plain tel: link on the frontend, and a Twilio-Voice
// integration (recording, transcription, real inbound/outbound legs) is a
// future wave. This endpoint just records that a call happened.
//
// STORAGE
//   Calls reuse the activities table (type='call') rather than a redundant
//   call_logs table — activities already carries duration_minutes, outcome,
//   notes/description, contact_id, deal_id, and (as of migration 121) direction.
//   That means logged calls flow through the exact same timeline / account-360
//   aggregators as every other activity, for free.
//
// TENANCY
//   Org-scoped via qs(req); a contact_id / deal_id outside the caller's scope
//   yields 400 before the row is written.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const audit = require('../services/audit');
const { validateBody } = require('../middleware/validate');
const { callLogSchema } = require('../schemas/communications');

const router = express.Router();
router.use(authMiddleware);

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

const CALL_LOGGED_EVENT = (audit.EVENTS && audit.EVENTS.CALL_LOGGED) || 'call.logged';

// POST /api/calls/log — write an activities(type='call') row.
router.post('/log', validateBody(callLogSchema), async (req, res) => {
  try {
    const { contact_id, deal_id, direction, duration_minutes, outcome, notes, title, activity_date } = req.body;
    const [sf, sv] = qs(req);

    if (contact_id != null) {
      const own = await pool.query(`SELECT 1 FROM contacts WHERE id = $1 AND ${sf} = $2`, [contact_id, sv]);
      if (own.rows.length === 0) return res.status(400).json({ error: 'contact_id not found in your organization' });
    }
    if (deal_id != null) {
      const own = await pool.query(`SELECT 1 FROM deals WHERE id = $1 AND ${sf} = $2`, [deal_id, sv]);
      if (own.rows.length === 0) return res.status(400).json({ error: 'deal_id not found in your organization' });
    }

    const resolvedTitle = title || `${direction === 'inbound' ? 'Inbound' : 'Outbound'} call`;
    const when = activity_date || new Date().toISOString();

    const result = await pool.query(
      `INSERT INTO activities (user_id, org_id, type, title, contact_id, deal_id, activity_date, description, duration_minutes, outcome, notes, direction)
       VALUES ($1, $2, 'call', $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [req.userId, req.orgId || null, resolvedTitle, contact_id || null, deal_id || null, when,
       notes || null, duration_minutes || null, outcome || null, notes || null, direction]
    );
    const activity = result.rows[0];

    try {
      await audit.fromReq(req, {
        event: CALL_LOGGED_EVENT,
        targetType: 'activity',
        targetId: activity.id,
        meta: { direction, duration_minutes: duration_minutes || null, outcome: outcome || null, contact_id: contact_id || null, deal_id: deal_id || null },
      });
    } catch { /* audit failures are non-fatal */ }

    res.status(201).json({ success: true, activity });
  } catch (error) {
    if (req.log) req.log.error('call_log_failed', { error });
    else console.error('Call log failed:', error);
    res.status(500).json({ error: 'Failed to log call' });
  }
});

module.exports = router;
