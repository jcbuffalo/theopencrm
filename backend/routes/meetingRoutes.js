// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// In-app Meetings + the merged Calendar agenda.
//
// Two routers ship from this file:
//
//   router        → /api/meetings          org-scoped CRUD for the internal
//                                          meetings object (migration 137)
//   agendaRouter  → /api/calendar          GET /agenda?from=&to= — a MERGED,
//                                          time-sorted agenda for the range:
//                                          meetings + MY tasks with a due_date
//                                          in range + (read-only) meeting_logs
//                                          captured by the Teams/Zoom webhooks
//
// Both are CORE surfaces (internal scheduling, no external OAuth) mounted
// UN-gated with plain auth, like /api/my-day. The agendaRouter only answers
// GET /agenda; every other /api/calendar path falls through to the
// Google-Calendar OAuth router (routes/calendarAuthRoutes.js) which IS gated
// by calendar_enabled — this file deliberately does not touch that flag.
//
// Scoping: every query runs through qs(req) → [sf, sv]. The agenda's task lane
// is ADDITIONALLY user-scoped with the same "mine" definition as My Day:
// assigned to me, or unassigned but created by me. Meetings are org-wide (a
// shared team calendar), matching how activities behave.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const { validateBody } = require('../middleware/validate');
const meetingSchemas = require('../schemas/meetings');
const notificationDispatcher = require('../services/notificationDispatcher');

const router = express.Router();
router.use(authMiddleware);

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// Open-task filter shared with My Day / the overdue worker.
const TASK_DONE_STATUSES = ['done', 'completed', 'cancelled'];

// A meeting may only link to a company / deal / contact in the caller's scope.
// Returns an error string (→ 400) or null when everything checks out.
async function checkLinksInScope(req, { company_id, deal_id, contact_id }) {
  const [sf, sv] = qs(req);
  const checks = [
    ['companies', 'company_id', company_id],
    ['deals',     'deal_id',    deal_id],
    ['contacts',  'contact_id', contact_id],
  ];
  for (const [table, field, id] of checks) {
    if (id == null) continue;
    const own = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1 AND ${sf} = $2`, [id, sv]);
    if (own.rows.length === 0) return `${field} not found in your organization`;
  }
  return null;
}

// starts/ends sanity — only when both ends up non-null.
function badTimeOrder(starts_at, ends_at) {
  if (!starts_at || !ends_at) return false;
  return new Date(ends_at).getTime() < new Date(starts_at).getTime();
}

// The SELECT every read path shares: the meeting row plus display names for
// its links, so the Calendar page renders without N follow-up fetches.
const MEETING_SELECT = `
  SELECT m.*,
         co.name AS company_name,
         d.title AS deal_title,
         CASE WHEN ct.id IS NOT NULL THEN ct.first_name || ' ' || ct.last_name END AS contact_name
    FROM meetings m
    LEFT JOIN companies co ON m.company_id = co.id
    LEFT JOIN deals d      ON m.deal_id    = d.id
    LEFT JOIN contacts ct  ON m.contact_id = ct.id`;

router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { from, to, deal_id, company_id, contact_id } = req.query;
    let query = `${MEETING_SELECT} WHERE m.${sf} = $1`;
    const params = [sv];

    if (from && !Number.isNaN(Date.parse(from))) { query += ` AND m.starts_at >= $${params.length + 1}`; params.push(new Date(from)); }
    if (to   && !Number.isNaN(Date.parse(to)))   { query += ` AND m.starts_at <= $${params.length + 1}`; params.push(new Date(to)); }
    if (deal_id)    { query += ` AND m.deal_id = $${params.length + 1}`;    params.push(deal_id); }
    if (company_id) { query += ` AND m.company_id = $${params.length + 1}`; params.push(company_id); }
    if (contact_id) { query += ` AND m.contact_id = $${params.length + 1}`; params.push(contact_id); }

    query += ' ORDER BY m.starts_at ASC, m.created_at ASC LIMIT 500';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch meetings' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(`${MEETING_SELECT} WHERE m.id = $1 AND m.${sf} = $2`, [req.params.id, sv]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Meeting not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch meeting' });
  }
});

router.post('/', validateBody(meetingSchemas.createSchema), async (req, res) => {
  try {
    const { title, starts_at, ends_at, company_id, deal_id, contact_id, location, notes, external_event_id } = req.body;

    if (badTimeOrder(starts_at, ends_at)) {
      return res.status(400).json({ error: 'ends_at must be after starts_at' });
    }
    const linkErr = await checkLinksInScope(req, { company_id, deal_id, contact_id });
    if (linkErr) return res.status(400).json({ error: linkErr });

    const result = await pool.query(
      `INSERT INTO meetings (user_id, org_id, title, starts_at, ends_at, company_id, deal_id, contact_id, location, notes, external_event_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [req.userId, req.orgId || null, title, starts_at, ends_at || null,
       company_id || null, deal_id || null, contact_id || null,
       location || null, notes || null, external_event_id || null, req.userId]
    );

    // Fire-and-forget: notify the linked deal/company owner (the helper
    // resolves the recipient and skips the scheduler). Never breaks the create.
    const createdMeeting = result.rows[0];
    if (createdMeeting.deal_id || createdMeeting.company_id) {
      notificationDispatcher.notifyMeetingScheduled(createdMeeting.id, req.userId)
        .catch(err => console.warn('notify_meeting_scheduled_failed', err && err.message ? err.message : err));
    }

    res.status(201).json(createdMeeting);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create meeting' });
  }
});

router.put('/:id', validateBody(meetingSchemas.updateSchema), async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { title, starts_at, ends_at, company_id, deal_id, contact_id, location, notes, external_event_id } = req.body;

    // Nullable fields need "explicitly null clears it" semantics (you can
    // unlink a deal or blank the location), which COALESCE can't express —
    // a provided-flag drives a CASE per field instead (the taskRoutes
    // recurrence_rule pattern). zod's validateBody replaces req.body with the
    // parsed output, preserving present-vs-absent, so hasOwnProperty is safe.
    const has = (k) => Object.prototype.hasOwnProperty.call(req.body, k);

    if (badTimeOrder(starts_at, ends_at)) {
      return res.status(400).json({ error: 'ends_at must be after starts_at' });
    }
    const linkErr = await checkLinksInScope(req, { company_id, deal_id, contact_id });
    if (linkErr) return res.status(400).json({ error: linkErr });

    const result = await pool.query(
      `UPDATE meetings SET
         title             = COALESCE($1, title),
         starts_at         = COALESCE($2::timestamp, starts_at),
         ends_at           = CASE WHEN $3::boolean  THEN $4::timestamp ELSE ends_at END,
         company_id        = CASE WHEN $5::boolean  THEN $6::integer   ELSE company_id END,
         deal_id           = CASE WHEN $7::boolean  THEN $8::integer   ELSE deal_id END,
         contact_id        = CASE WHEN $9::boolean  THEN $10::integer  ELSE contact_id END,
         location          = CASE WHEN $11::boolean THEN $12           ELSE location END,
         notes             = CASE WHEN $13::boolean THEN $14           ELSE notes END,
         external_event_id = CASE WHEN $15::boolean THEN $16           ELSE external_event_id END,
         updated_at        = CURRENT_TIMESTAMP
       WHERE id = $17 AND ${sf} = $18 RETURNING *`,
      [title ?? null, starts_at ?? null,
       has('ends_at'), has('ends_at') ? ends_at : null,
       has('company_id'), has('company_id') ? company_id : null,
       has('deal_id'), has('deal_id') ? deal_id : null,
       has('contact_id'), has('contact_id') ? contact_id : null,
       has('location'), has('location') ? location : null,
       has('notes'), has('notes') ? notes : null,
       has('external_event_id'), has('external_event_id') ? external_event_id : null,
       req.params.id, sv]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Meeting not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update meeting' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(`DELETE FROM meetings WHERE id = $1 AND ${sf} = $2 RETURNING *`, [req.params.id, sv]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Meeting not found' });
    res.json({ message: 'Meeting deleted', meeting: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete meeting' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/calendar/agenda?from=&to= — the merged agenda.
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;
const MAX_RANGE_DAYS = 92; // ~a quarter; keeps range scans bounded

const agendaRouter = express.Router();
agendaRouter.use(authMiddleware);

agendaRouter.get('/agenda', async (req, res) => {
  try {
    const [sf, sv] = qs(req);

    // Range: default = today 00:00 UTC → +7 days. Explicit bad input is a
    // caller error (400), never a silent empty result.
    const { from: fromRaw, to: toRaw } = req.query;
    if (fromRaw && Number.isNaN(Date.parse(fromRaw))) return res.status(400).json({ error: 'from must be an ISO date' });
    if (toRaw   && Number.isNaN(Date.parse(toRaw)))   return res.status(400).json({ error: 'to must be an ISO date' });
    const from = fromRaw ? new Date(fromRaw) : new Date(new Date().setUTCHours(0, 0, 0, 0));
    const to   = toRaw   ? new Date(toRaw)   : new Date(from.getTime() + 7 * DAY_MS);
    if (to.getTime() < from.getTime()) return res.status(400).json({ error: 'to must be on or after from' });
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
      return res.status(400).json({ error: `range too large (max ${MAX_RANGE_DAYS} days)` });
    }

    // Lane 1 — in-app meetings in range (org-wide: it's the shared calendar).
    const meetingsQ = await pool.query(
      `${MEETING_SELECT}
        WHERE m.${sf} = $1 AND m.starts_at >= $2 AND m.starts_at <= $3
        ORDER BY m.starts_at ASC LIMIT 500`,
      [sv, from, to]
    );
    const meetings = meetingsQ.rows.map((m) => ({
      type: 'meeting',
      id: m.id,
      title: m.title,
      starts_at: m.starts_at,
      ends_at: m.ends_at,
      location: m.location,
      notes: m.notes,
      company_id: m.company_id, company_name: m.company_name,
      deal_id: m.deal_id, deal_title: m.deal_title,
      contact_id: m.contact_id, contact_name: m.contact_name,
      external_event_id: m.external_event_id,
    }));

    // Lane 2 — MY open tasks due in range (same "mine" definition as My Day:
    // assigned to me, or unassigned but created by me). due_date is a date;
    // it sorts as midnight, surfacing due tasks at the top of their day.
    const tasksQ = await pool.query(
      `SELECT t.id, t.title, t.due_date, t.status, t.priority, t.deal_id, t.contact_id,
              d.title AS deal_title,
              CASE WHEN c.id IS NOT NULL THEN c.first_name || ' ' || c.last_name END AS contact_name
         FROM tasks t
         LEFT JOIN deals d    ON t.deal_id = d.id
         LEFT JOIN contacts c ON t.contact_id = c.id
        WHERE t.${sf} = $1
          AND (t.assigned_to = $2 OR (t.assigned_to IS NULL AND t.user_id = $2))
          AND t.due_date IS NOT NULL AND t.due_date >= $3 AND t.due_date <= $4
          AND LOWER(COALESCE(t.status, 'open')) NOT IN (${TASK_DONE_STATUSES.map((s) => `'${s}'`).join(', ')})
        ORDER BY t.due_date ASC LIMIT 500`,
      [sv, req.userId, from, to]
    );
    const tasks = tasksQ.rows.map((t) => ({
      type: 'task',
      id: t.id,
      title: t.title,
      starts_at: t.due_date,
      ends_at: null,
      status: t.status,
      priority: t.priority,
      deal_id: t.deal_id, deal_title: t.deal_title,
      contact_id: t.contact_id, contact_name: t.contact_name,
    }));

    // Lane 3 — read-only meeting logs captured by the Teams/Zoom webhook
    // receivers (migration 045). Best-effort: an org/deploy without the table
    // (or any failure here) degrades this lane to [] rather than 500ing the
    // whole agenda — same section-resilience posture as My Day.
    let logs = [];
    try {
      const logsQ = await pool.query(
        `SELECT id, source, title, occurred_at, duration_minutes, recording_url
           FROM meeting_logs
          WHERE ${sf} = $1 AND occurred_at IS NOT NULL AND occurred_at >= $2 AND occurred_at <= $3
          ORDER BY occurred_at ASC LIMIT 200`,
        [sv, from, to]
      );
      logs = logsQ.rows.map((l) => ({
        type: 'meeting_log',
        id: l.id,
        title: l.title || `${l.source} meeting`,
        starts_at: l.occurred_at,
        ends_at: null,
        source: l.source,
        duration_minutes: l.duration_minutes,
        recording_url: l.recording_url,
      }));
    } catch (error) {
      if (req.log) req.log.warn('agenda_meeting_logs_failed', { error: error.message });
      else console.warn('Agenda meeting_logs lane failed:', error.message);
    }

    const items = [...meetings, ...tasks, ...logs].sort(
      (a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime()
    );

    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      items,
      counts: { meetings: meetings.length, tasks: tasks.length, meeting_logs: logs.length, total: items.length },
    });
  } catch (error) {
    if (req.log) req.log.error('agenda_failed', { error });
    else console.error('Agenda error:', error.message);
    res.status(500).json({ error: 'Failed to fetch agenda' });
  }
});

module.exports = router;
module.exports.agendaRouter = agendaRouter;
