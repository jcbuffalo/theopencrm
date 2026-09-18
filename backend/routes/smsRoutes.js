// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// SMS messaging — /api/sms.
//
// Communications surface (standard CRM capability). Sending an SMS does three
// things, in order:
//   1. resolves + validates the destination number (org-scoped ownership check
//      on any contact_id / deal_id, exactly like activityRoutes),
//   2. sends via services/sms.js (Twilio adapter — graceful when unconfigured),
//   3. persists BOTH an sms_messages row (system-of-record) AND an
//      activities(type='sms') timeline row so the message shows up on the
//      deal/account 360 alongside emails, calls, and meetings.
//
// GRACEFUL DEGRADATION
//   When Twilio isn't configured we return 503 { configured: false, ... } with
//   setup guidance and DO NOT persist — there's nothing to record. This mirrors
//   the services/sms.js isConfigured() contract; the frontend renders the
//   message as a "not configured" banner instead of a delivery state.
//
// TENANCY
//   Every query is org-scoped via qs(req). A contact_id / deal_id that isn't in
//   the caller's scope yields 400 before anything is sent or written.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const sms = require('../services/sms');
const audit = require('../services/audit');
const { validateBody } = require('../middleware/validate');
const { smsSendSchema } = require('../schemas/communications');

const router = express.Router();
router.use(authMiddleware);

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

const SMS_SENT_EVENT = (audit.EVENTS && audit.EVENTS.SMS_SENT) || 'sms.sent';

// GET /api/sms?contact_id=&deal_id=&limit= — the message log, org-scoped.
router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { contact_id, deal_id, limit = 50 } = req.query;
    let query = `SELECT * FROM sms_messages WHERE ${sf} = $1`;
    const params = [sv];
    if (contact_id) { query += ` AND contact_id = $${params.length + 1}`; params.push(contact_id); }
    if (deal_id)    { query += ` AND deal_id = $${params.length + 1}`;    params.push(deal_id); }
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(Math.min(parseInt(limit, 10) || 50, 200));
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    if (req.log) req.log.error('sms_list_failed', { error });
    res.status(500).json({ error: 'Failed to fetch SMS messages' });
  }
});

// POST /api/sms — send + persist + log activity.
router.post('/', validateBody(smsSendSchema), async (req, res) => {
  try {
    const { contact_id, deal_id, body } = req.body;
    let toNumber = req.body.to_number || null;
    const [sf, sv] = qs(req);

    // Org-scoped ownership checks. Also pull the phone number so the caller can
    // omit to_number and let us resolve it from the contact / deal POC.
    if (contact_id != null) {
      const own = await pool.query(
        `SELECT phone FROM contacts WHERE id = $1 AND ${sf} = $2`, [contact_id, sv]
      );
      if (own.rows.length === 0) return res.status(400).json({ error: 'contact_id not found in your organization' });
      if (!toNumber) toNumber = own.rows[0].phone || null;
    }
    if (deal_id != null) {
      const own = await pool.query(
        `SELECT poc_phone FROM deals WHERE id = $1 AND ${sf} = $2`, [deal_id, sv]
      );
      if (own.rows.length === 0) return res.status(400).json({ error: 'deal_id not found in your organization' });
      if (!toNumber) toNumber = own.rows[0].poc_phone || null;
    }

    if (!toNumber) {
      return res.status(400).json({ error: 'No destination number — pass to_number, or attach a contact/deal that has a phone on file.' });
    }

    // Graceful degradation: mirror the services/sms.js { configured:false }
    // contract. Return before persisting — nothing was sent.
    if (!sms.isConfigured()) {
      return res.status(503).json({
        configured: false,
        error: 'SMS is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER on the backend to enable sending.',
      });
    }

    const outcome = await sms.sendSms(toNumber, body); // 'sent' | 'skipped' | 'failed'
    const status = outcome === 'sent' ? 'sent' : outcome; // persist the raw outcome as status
    const fromNumber = process.env.TWILIO_FROM_NUMBER || null;

    const smsRes = await pool.query(
      `INSERT INTO sms_messages (user_id, org_id, contact_id, deal_id, direction, to_number, from_number, body, status)
       VALUES ($1, $2, $3, $4, 'outbound', $5, $6, $7, $8) RETURNING *`,
      [req.userId, req.orgId || null, contact_id || null, deal_id || null, toNumber, fromNumber, body, status]
    );
    const smsRow = smsRes.rows[0];

    // Timeline activity (type='sms'). Best-effort — a failed activity insert
    // must not lose the recorded send, so it's caught and logged, not thrown.
    let activity = null;
    try {
      const actRes = await pool.query(
        `INSERT INTO activities (user_id, org_id, type, title, contact_id, deal_id, activity_date, description, outcome, direction)
         VALUES ($1, $2, 'sms', $3, $4, $5, CURRENT_TIMESTAMP, $6, $7, 'outbound') RETURNING *`,
        [req.userId, req.orgId || null, `SMS to ${toNumber}`, contact_id || null, deal_id || null, body, status]
      );
      activity = actRes.rows[0];
    } catch (actErr) {
      if (req.log) req.log.warn('sms_activity_log_failed', { error: actErr, sms_id: smsRow.id });
      else console.warn('SMS activity log failed (send recorded anyway):', actErr.message);
    }

    // Audit (best-effort — never blocks the response).
    try {
      await audit.fromReq(req, {
        event: SMS_SENT_EVENT,
        targetType: 'sms_message',
        targetId: smsRow.id,
        success: outcome === 'sent',
        meta: { to_number: toNumber, contact_id: contact_id || null, deal_id: deal_id || null, status, outcome },
      });
    } catch { /* audit failures are non-fatal */ }

    return res.status(201).json({ success: true, status, configured: true, sms: smsRow, activity });
  } catch (error) {
    if (req.log) req.log.error('sms_send_failed', { error });
    else console.error('SMS send failed:', error);
    res.status(500).json({ error: 'Failed to send SMS' });
  }
});

module.exports = router;
