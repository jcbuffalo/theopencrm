// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// In-app Meetings CRUD + merged Calendar agenda — smoke tests.
//
// Mounts meetingRoutes (+ its agendaRouter) against a tiny Express app
// (mirrors myDay.test.js). The pg pool is fully mocked: each pool.query call
// resolves the next queued response, in the order the route issues them.
//
// Covers:
//   • meetings CRUD org-isolation — scope value threaded into every query,
//     out-of-scope linked deal rejected, cross-org reads/deletes 404
//   • PUT null-clears a link (provided-flag CASE semantics)
//   • agenda merges meetings + my due tasks (+ webhook meeting_logs) within
//     the range, time-sorted and type-labeled; tasks lane is user-scoped
//   • agenda bad range → 400 (from > to, unparseable date, oversized range)
//   • meeting_logs lane degrades to [] instead of 500 when the table's absent
//   • org-less users fall back to user_id scoping

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const meetingRoutes = require('../routes/meetingRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/meetings', meetingRoutes);
  app.use('/calendar', meetingRoutes.agendaRouter);
  return app;
}

const USER_ID = 4242;
const ORG_ID = 7;
const DAY_MS = 86400000;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function daysAheadISO(n) {
  return new Date(Date.now() + n * DAY_MS).toISOString();
}

function mockAuth() {
  mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
}

beforeEach(() => {
  mockPool.query.mockReset();
});

describe('meetings CRUD org-isolation', () => {
  test('POST creates an org-scoped meeting after verifying the linked deal is in scope', async () => {
    mockAuth();
    // checkLinksInScope: deal_id → in scope.
    mockPool.query.mockResolvedValueOnce({ rows: [{ 1: 1 }] });
    // INSERT.
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 1, org_id: ORG_ID, title: 'Kickoff', starts_at: daysAheadISO(1), deal_id: 5 }],
    });

    const res = await request(buildApp())
      .post('/meetings')
      .set('Cookie', authCookie())
      .send({ title: 'Kickoff', starts_at: daysAheadISO(1), deal_id: 5 });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Kickoff');

    const calls = mockPool.query.mock.calls;
    // 4 calls: auth, link check, INSERT, plus the fire-and-forget
    // notifyMeetingScheduled row-load (best-effort — the 201 above already
    // proves its outcome can't affect the response).
    expect(calls).toHaveLength(4);
    // Link check is org-scoped.
    expect(calls[1][0]).toMatch(/FROM deals WHERE id = \$1 AND org_id = \$2/);
    expect(calls[1][1]).toEqual([5, ORG_ID]);
    // INSERT carries user_id + org_id + created_by.
    expect(calls[2][1][0]).toBe(USER_ID);      // user_id
    expect(calls[2][1][1]).toBe(ORG_ID);       // org_id
    expect(calls[2][1][6]).toBe(5);            // deal_id
    expect(calls[2][1][11]).toBe(USER_ID);     // created_by
  });

  test('POST rejects a linked deal outside the org (400, nothing written)', async () => {
    mockAuth();
    // checkLinksInScope: deal not in this org.
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .post('/meetings')
      .set('Cookie', authCookie())
      .send({ title: 'Sneaky', starts_at: daysAheadISO(1), deal_id: 999 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/deal_id not found/);
    // Auth + scope check only — no INSERT.
    expect(mockPool.query.mock.calls).toHaveLength(2);
  });

  test('POST rejects ends_at before starts_at', async () => {
    mockAuth();
    const res = await request(buildApp())
      .post('/meetings')
      .set('Cookie', authCookie())
      .send({ title: 'Backwards', starts_at: daysAheadISO(2), ends_at: daysAheadISO(1) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ends_at must be after/);
  });

  test('GET /:id 404s when the row belongs to another org', async () => {
    mockAuth();
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // scoped SELECT finds nothing

    const res = await request(buildApp())
      .get('/meetings/31337')
      .set('Cookie', authCookie());

    expect(res.status).toBe(404);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/m\.org_id = \$2/);
    expect(params).toEqual(['31337', ORG_ID]);
  });

  test('GET / lists only this org, ordered by starts_at', async () => {
    mockAuth();
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 2, title: 'Standup' }] });

    const res = await request(buildApp())
      .get('/meetings')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/m\.org_id = \$1/);
    expect(sql).toMatch(/ORDER BY m\.starts_at ASC/);
    expect(params[0]).toBe(ORG_ID);
  });

  test('PUT updates in scope and null clears a linked deal (provided-flag CASE)', async () => {
    mockAuth();
    // deal_id: null skips the link-scope check → straight to UPDATE.
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 3, title: 'Renamed', deal_id: null }] });

    const res = await request(buildApp())
      .put('/meetings/3')
      .set('Cookie', authCookie())
      .send({ title: 'Renamed', deal_id: null });

    expect(res.status).toBe(200);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/org_id = \$18/);
    expect(params[0]).toBe('Renamed');
    expect(params[6]).toBe(true);   // deal_id provided flag
    expect(params[7]).toBe(null);   // → cleared
    expect(params[4]).toBe(false);  // company_id untouched
    expect(params[16]).toBe('3');
    expect(params[17]).toBe(ORG_ID);
  });

  test('DELETE 404s cross-org instead of deleting', async () => {
    mockAuth();
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .delete('/meetings/8')
      .set('Cookie', authCookie());

    expect(res.status).toBe(404);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/DELETE FROM meetings WHERE id = \$1 AND org_id = \$2/);
    expect(params).toEqual(['8', ORG_ID]);
  });
});

describe('GET /calendar/agenda', () => {
  test('merges meetings + my due tasks + webhook logs, time-sorted and type-labeled', async () => {
    mockAuth();
    // Lane 1: meetings — one on day +2.
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 1, title: 'QBR with Acme', starts_at: daysAheadISO(2), ends_at: null,
               company_id: 9, company_name: 'Acme Co', deal_id: null, deal_title: null,
               contact_id: null, contact_name: null, location: 'Zoom', notes: null, external_event_id: null }],
    });
    // Lane 2: tasks — one due day +1.
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 11, title: 'Send proposal', due_date: daysAheadISO(1), status: 'open',
               priority: 'high', deal_id: 5, deal_title: 'Acme Q3', contact_id: null, contact_name: null }],
    });
    // Lane 3: meeting_logs — one captured today.
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 21, source: 'zoom', title: 'Discovery call', occurred_at: daysAheadISO(0.25),
               duration_minutes: 30, recording_url: null }],
    });

    const res = await request(buildApp())
      .get(`/calendar/agenda?from=${encodeURIComponent(daysAheadISO(0))}&to=${encodeURIComponent(daysAheadISO(7))}`)
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.type)).toEqual(['meeting_log', 'task', 'meeting']);
    expect(res.body.counts).toEqual({ meetings: 1, tasks: 1, meeting_logs: 1, total: 3 });

    const calls = mockPool.query.mock.calls;
    expect(calls).toHaveLength(4);
    // Every lane is org-scoped on the same scope value.
    for (let i = 1; i < 4; i++) expect(calls[i][1][0]).toBe(ORG_ID);
    // The tasks lane is additionally user-scoped ("mine", the My Day rule).
    expect(calls[2][0]).toMatch(/assigned_to = \$2/);
    expect(calls[2][1][1]).toBe(USER_ID);
    // Range params thread into the meetings lane.
    expect(calls[1][0]).toMatch(/starts_at >= \$2 AND m\.starts_at <= \$3/);
  });

  test('bad ranges are 400s, not empty successes', async () => {
    // from > to
    mockAuth();
    let res = await request(buildApp())
      .get(`/calendar/agenda?from=${encodeURIComponent(daysAheadISO(5))}&to=${encodeURIComponent(daysAheadISO(1))}`)
      .set('Cookie', authCookie());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/on or after/);

    // unparseable date
    mockAuth();
    res = await request(buildApp())
      .get('/calendar/agenda?from=not-a-date')
      .set('Cookie', authCookie());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/from must be an ISO date/);

    // oversized range
    mockAuth();
    res = await request(buildApp())
      .get(`/calendar/agenda?from=${encodeURIComponent(daysAheadISO(0))}&to=${encodeURIComponent(daysAheadISO(400))}`)
      .set('Cookie', authCookie());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/range too large/);
  });

  test('a missing meeting_logs table degrades that lane to [] instead of a 500', async () => {
    mockAuth();
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // meetings
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // tasks
    mockPool.query.mockRejectedValueOnce(
      Object.assign(new Error('relation "meeting_logs" does not exist'), { code: '42P01' })
    );

    const res = await request(buildApp())
      .get(`/calendar/agenda?from=${encodeURIComponent(daysAheadISO(0))}&to=${encodeURIComponent(daysAheadISO(7))}`)
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.counts.meeting_logs).toBe(0);
  });

  test('an org-less user falls back to user_id scoping on every lane', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: null, org_role: null, status: 'active' }] });
    for (let i = 0; i < 3; i++) mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .get(`/calendar/agenda?from=${encodeURIComponent(daysAheadISO(0))}&to=${encodeURIComponent(daysAheadISO(7))}`)
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    const calls = mockPool.query.mock.calls;
    for (let i = 1; i < 4; i++) {
      expect(calls[i][1][0]).toBe(USER_ID);
      expect(calls[i][0]).toMatch(/user_id = \$1/);
    }
  });
});
