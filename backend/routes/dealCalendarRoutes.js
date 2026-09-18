// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Google Calendar — per-deal event routes.
//
// Mount path (set by index.js): /api/deals/:id/calendar-event
//
// All routes:
//   - auth required (authMiddleware)
//   - require the `calendar_enabled` feature flag (applied at the mount)
//   - org-scoped via qs(req)
//
// Endpoints
//   GET  /  — list the deal's calendar_events (synced + created), newest first.
//   POST /  — create a Google Calendar event for the deal and store it.
//
// The POST is the "Schedule meeting" action on a deal: it creates the event on
// the connected org calendar via the Calendar API, then upserts the result into
// calendar_events with source='created' and deal_id set so it shows on the
// account/deal timeline immediately.
//
// Audit event emitted: CALENDAR_EVENT_CREATED on POST success.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { authMiddleware } = require('../auth');
const pool   = require('../db');
const audit  = require('../services/audit');
const calendar = require('../services/calendar');
const calendarSync = require('../services/calendarSync');

const router = express.Router({ mergeParams: true });
router.use(authMiddleware);

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// Create is a write against Google's API + our DB — cap it so a runaway client
// can't spam the calendar. 20 per 15 min per (deal, scope).
const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const dealId = req.params.id ? `deal:${req.params.id}` : 'deal:?';
    const scope  = req.orgId ? `org:${req.orgId}` : `user:${req.userId || ipKeyGenerator(req, res)}`;
    return `calendar-event-create:${scope}:${dealId}`;
  },
  message: { error: 'Too many calendar-event creations for this deal. Try again in 15 minutes.', code: 'CALENDAR_EVENT_RATE_LIMIT' },
});

async function loadDealId(req) {
  const [sf, sv] = qs(req);
  const dealId = Number(req.params.id);
  if (!Number.isFinite(dealId)) return null;
  const r = await pool.query(
    `SELECT id FROM deals WHERE id = $1 AND ${sf} = $2`,
    [dealId, sv]
  );
  return r.rows[0]?.id || null;
}

function rowToResponse(row) {
  if (!row) return null;
  return {
    id:              row.id,
    deal_id:         row.deal_id,
    google_event_id: row.google_event_id,
    title:           row.title,
    description:     row.description,
    start_at:        row.start_at,
    end_at:          row.end_at,
    attendees:       row.attendees || [],
    meeting_link:    row.meeting_link,
    html_link:       row.html_link,
    organizer_email: row.organizer_email,
    status:          row.status,
    source:          row.source,
    created_at:      row.created_at,
  };
}

// Basic email-shape check for attendees (defensive; Google rejects bad ones too).
const EMAIL_RE = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;

// ---------------------------------------------------------------------------
// GET / — the deal's stored calendar events, newest first.
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const dealId = await loadDealId(req);
    if (!dealId) return res.status(404).json({ error: 'Deal not found' });
    const r = await pool.query(
      `SELECT * FROM calendar_events
        WHERE deal_id = $1 AND ${sf} = $2
        ORDER BY start_at DESC NULLS LAST, created_at DESC
        LIMIT 100`,
      [dealId, sv]
    );
    res.json({ events: r.rows.map(rowToResponse) });
  } catch (err) {
    if (req.log) req.log.error('calendar_event_list_failed', { error: err });
    res.status(500).json({ error: 'Failed to list calendar events', requestId: req.requestId });
  }
});

// ---------------------------------------------------------------------------
// POST / — create a Google Calendar event for the deal and store it.
//
// Body: { title, start_at, end_at, attendees?: string[], description? }
// ---------------------------------------------------------------------------
router.post('/', createLimiter, async (req, res) => {
  try {
    const dealId = await loadDealId(req);
    if (!dealId) return res.status(404).json({ error: 'Deal not found' });

    // Graceful degradation — Calendar not configured/connected.
    if (!(await calendar.isConfigured())) {
      return res.status(503).json({ success: false, configured: false, error: 'Calendar integration is not configured on this backend.' });
    }

    const { title, start_at, end_at, attendees, description } = req.body || {};
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title is required' });
    }
    if (!start_at || Number.isNaN(new Date(start_at).getTime())) {
      return res.status(400).json({ error: 'start_at is required and must be a valid date/time' });
    }
    // Default a 30-minute meeting when no end supplied.
    const startDate = new Date(start_at);
    let endDate = end_at ? new Date(end_at) : new Date(startDate.getTime() + 30 * 60 * 1000);
    if (Number.isNaN(endDate.getTime())) {
      return res.status(400).json({ error: 'end_at must be a valid date/time' });
    }
    if (endDate <= startDate) {
      return res.status(400).json({ error: 'end_at must be after start_at' });
    }

    // Validate + de-dupe attendee emails.
    const attendeeEmails = Array.isArray(attendees)
      ? [...new Set(attendees.map((a) => String(a || '').trim().toLowerCase()).filter(Boolean))]
      : [];
    const bad = attendeeEmails.filter((e) => !EMAIL_RE.test(e));
    if (bad.length > 0) {
      return res.status(400).json({ error: `Invalid attendee email(s): ${bad.join(', ')}` });
    }

    const eventResource = {
      summary: title.trim(),
      description: typeof description === 'string' ? description : undefined,
      start: { dateTime: startDate.toISOString() },
      end:   { dateTime: endDate.toISOString() },
      attendees: attendeeEmails.map((email) => ({ email })),
    };

    let created;
    try {
      created = await calendar.insertEvent(req.orgId, eventResource);
    } catch (err) {
      const status = err.code === 'CALENDAR_TOKEN_REVOKED' ? 401
        : err.code === 'CALENDAR_NOT_CONNECTED' || err.code === 'CALENDAR_CONNECTION_INACTIVE' ? 409
        : err.statusCode || 502;
      if (req.log) req.log.warn('calendar_event_create_api_failed', { error: err.message, code: err.code });
      return res.status(status).json({ success: false, error: err.message, code: err.code || 'CALENDAR_API_ERROR' });
    }

    // Normalize the created event + persist it (source='created', deal-linked).
    const norm = calendarSync.normalizeEvent(created);
    const rowId = await calendarSync.upsertEvent({
      orgId: req.orgId,
      dealId,
      event: norm,
      source: 'created',
      createdBy: req.userId,
    });

    const stored = await pool.query(`SELECT * FROM calendar_events WHERE id = $1`, [rowId]);

    audit.fromReq(req, {
      event: audit.EVENTS.CALENDAR_EVENT_CREATED,
      targetType: 'deal',
      targetId: dealId,
      meta: {
        deal_id: dealId,
        google_event_id: norm.google_event_id,
        attendee_count: attendeeEmails.length,
      },
    });

    return res.status(201).json({ success: true, event: rowToResponse(stored.rows[0]) });
  } catch (err) {
    if (req.log) req.log.error('calendar_event_create_failed', { error: err });
    res.status(500).json({ error: 'Failed to create calendar event', requestId: req.requestId });
  }
});

module.exports = router;
