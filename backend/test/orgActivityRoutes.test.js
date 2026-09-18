// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Tests for the per-org Activity feed route — backend/routes/orgActivityRoutes.js.
//
// Scope (per spec): exercise the audit-event denylist and the cursor /
// pagination behavior. Also covers the org-admin role gate (members 403).
//
// Strategy mirrors test/plugin-from-prompt.test.js: mount the router on a
// bare Express app, mock the pg pool by overwriting query() on the live
// instance, and queue per-call mockResolvedValueOnce() responses in the
// order the handler issues them (authMiddleware first, then the parallel
// SELECTs the route fires).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const orgActivityRoutes = require('../routes/orgActivityRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 7777;
const ORG_ID  = 123;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/admin/org-activity', orgActivityRoutes);
  return app;
}

// Queue the authMiddleware lookup so req.orgId / req.orgRole get populated.
function queueAuthRow(role = 'admin') {
  mockPool.query.mockResolvedValueOnce({
    rows: [{ org_id: ORG_ID, org_role: role, status: 'active' }],
  });
}

beforeEach(() => {
  mockPool.query.mockReset();
});

// ---------------------------------------------------------------------------
// Pure-helper coverage. Imported via the `__test__` export so we exercise
// them without driving them through HTTP.
// ---------------------------------------------------------------------------
describe('orgActivityRoutes — pure helpers', () => {
  const { AUDIT_EVENT_DENYLIST, parseSince, parseLimit, parseCursor, microToDollars } =
    orgActivityRoutes.__test__;

  test('AUDIT_EVENT_DENYLIST contains the canonical noisy events', () => {
    expect(AUDIT_EVENT_DENYLIST.has('ai.usage_recorded')).toBe(true);
    expect(AUDIT_EVENT_DENYLIST.has('chat.message')).toBe(true);
    // Spot-check something we should keep visible.
    expect(AUDIT_EVENT_DENYLIST.has('auth.login_success')).toBe(false);
  });

  test('parseSince defaults to 24h on missing / garbage input', () => {
    const before = Date.now();
    const d = parseSince(undefined);
    const ms = before - d.getTime();
    expect(ms).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 100);
    expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 100);
    // Garbage strings → fallback (same window).
    const ms2 = before - parseSince('not-a-window').getTime();
    expect(Math.abs(ms2 - ms)).toBeLessThan(50);
  });

  test('parseSince accepts hours and days, caps at 30d', () => {
    const oneHour = Date.now() - parseSince('1h').getTime();
    expect(oneHour).toBeGreaterThanOrEqual(60 * 60 * 1000 - 100);
    const sevenDays = Date.now() - parseSince('7d').getTime();
    expect(sevenDays).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000 - 100);
    // 9999d should be rejected and fall back to 24h.
    const tooBig = Date.now() - parseSince('9999d').getTime();
    expect(tooBig).toBeLessThan(2 * 24 * 60 * 60 * 1000);
  });

  test('parseLimit clamps to [1,200] and defaults to 50', () => {
    expect(parseLimit(undefined)).toBe(50);
    expect(parseLimit('30')).toBe(30);
    expect(parseLimit('500')).toBe(200);
    expect(parseLimit('-5')).toBe(50);
    expect(parseLimit('garbage')).toBe(50);
  });

  test('parseCursor returns null on garbage and a Date on a real ISO string', () => {
    expect(parseCursor(undefined)).toBeNull();
    expect(parseCursor('not-a-date')).toBeNull();
    const d = parseCursor('2026-05-01T12:00:00Z');
    expect(d instanceof Date).toBe(true);
    expect(d.toISOString()).toBe('2026-05-01T12:00:00.000Z');
  });

  test('microToDollars converts and rounds correctly', () => {
    expect(microToDollars(0)).toBe(0);
    expect(microToDollars(null)).toBe(0);
    expect(microToDollars(1_000_000)).toBe(1);
    expect(microToDollars(123_456)).toBe(0.1235); // round to 4dp
    expect(microToDollars('500000')).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Role-gate behavior. Members must NOT see org activity.
// ---------------------------------------------------------------------------
describe('orgActivityRoutes — role gate', () => {
  test('members get 403 on /summary', async () => {
    queueAuthRow('member');
    const res = await request(buildApp())
      .get('/api/admin/org-activity/summary')
      .set('Cookie', authCookie());
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  test('members get 403 on /feed', async () => {
    queueAuthRow('member');
    const res = await request(buildApp())
      .get('/api/admin/org-activity/feed')
      .set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  test('owners pass the gate', async () => {
    queueAuthRow('owner');
    // 6 count queries + 2 extra (top endpoint, plugin failures).
    for (let i = 0; i < 8; i++) {
      mockPool.query.mockResolvedValueOnce({ rows: [{ n: 0, cost_micro: 0 }] });
    }
    const res = await request(buildApp())
      .get('/api/admin/org-activity/summary')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Denylist propagation — the SQL we issue against audit_log must pass the
// hardcoded denylist as the third bind param of the deny clause. We assert
// that one of the captured calls binds a text[] that includes the noisy
// events.
// ---------------------------------------------------------------------------
describe('orgActivityRoutes — denylist is applied in SQL', () => {
  test('/feed audit query binds the denylist array', async () => {
    queueAuthRow('admin');
    // 6 SELECTs from the parallel feed fan-out — each returns empty rows.
    for (let i = 0; i < 6; i++) {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
    }
    const res = await request(buildApp())
      .get('/api/admin/org-activity/feed')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);

    // Walk every call we made and find one whose SQL hits audit_log and
    // whose final param is an array containing the denylist sentinel.
    const calls = mockPool.query.mock.calls;
    const auditCall = calls.find(([sql]) => /FROM audit_log/i.test(sql));
    expect(auditCall).toBeDefined();
    const params = auditCall[1];
    const lastParam = params[params.length - 1];
    expect(Array.isArray(lastParam)).toBe(true);
    expect(lastParam).toContain('ai.usage_recorded');
    expect(lastParam).toContain('chat.message');
  });

  test('/summary audit query binds the denylist array', async () => {
    queueAuthRow('admin');
    // 8 result rows expected by the summary handler (6 counts + top endpoint + failures).
    for (let i = 0; i < 8; i++) {
      mockPool.query.mockResolvedValueOnce({ rows: [{ n: 0, cost_micro: 0 }] });
    }
    const res = await request(buildApp())
      .get('/api/admin/org-activity/summary')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);

    const calls = mockPool.query.mock.calls;
    const auditCall = calls.find(([sql]) => /FROM audit_log/i.test(sql));
    expect(auditCall).toBeDefined();
    const lastParam = auditCall[1][auditCall[1].length - 1];
    expect(Array.isArray(lastParam)).toBe(true);
    expect(lastParam).toContain('ai.usage_recorded');
  });
});

// ---------------------------------------------------------------------------
// Cursor behavior. When the merged result hits exactly `limit`, next_cursor
// is the ISO of the oldest row. When it returns fewer than `limit`,
// next_cursor must be null. When a cursor is supplied, it must be bound
// into the SQL params for the time-window filter.
// ---------------------------------------------------------------------------
describe('orgActivityRoutes — pagination cursor', () => {
  test('next_cursor is null when fewer than limit items', async () => {
    queueAuthRow('admin');
    // All 6 feed queries return zero rows.
    for (let i = 0; i < 6; i++) mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .get('/api/admin/org-activity/feed?limit=10')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.next_cursor).toBeNull();
  });

  test('next_cursor is the oldest item.at when page fills', async () => {
    queueAuthRow('admin');
    // Build 3 audit rows with descending timestamps so the oldest sets the cursor.
    const t0 = new Date('2026-05-10T12:00:00Z');
    const t1 = new Date('2026-05-10T11:00:00Z');
    const t2 = new Date('2026-05-10T10:00:00Z');
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { at: t0, event: 'auth.login_success', success: true, meta: null, target_type: null, target_id: null, actor_email: 'a@x.com' },
        { at: t1, event: 'deal.created',       success: true, meta: null, target_type: null, target_id: null, actor_email: 'b@x.com' },
        { at: t2, event: 'company.updated',    success: true, meta: null, target_type: null, target_id: null, actor_email: 'c@x.com' },
      ],
    });
    for (let i = 0; i < 5; i++) mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .get('/api/admin/org-activity/feed?limit=3')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(3);
    // The oldest item is the third (t2); its ISO should be the cursor.
    expect(res.body.data.next_cursor).toBe(t2.toISOString());
    // Items must be newest-first.
    expect(new Date(res.body.data.items[0].at).getTime())
      .toBeGreaterThan(new Date(res.body.data.items[2].at).getTime());
  });

  test('cursor is bound into the SQL params when supplied', async () => {
    queueAuthRow('admin');
    for (let i = 0; i < 6; i++) mockPool.query.mockResolvedValueOnce({ rows: [] });

    const cursor = '2026-05-01T00:00:00.000Z';
    const res = await request(buildApp())
      .get(`/api/admin/org-activity/feed?cursor=${encodeURIComponent(cursor)}`)
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);

    // At least one fan-out call should have the cursor Date in its params.
    const calls = mockPool.query.mock.calls;
    const calledWithCursor = calls.some(([, params]) =>
      Array.isArray(params) && params.some(p => p instanceof Date && p.toISOString() === cursor),
    );
    expect(calledWithCursor).toBe(true);
  });

  test('garbage cursor is silently ignored (no 400)', async () => {
    queueAuthRow('admin');
    for (let i = 0; i < 6; i++) mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .get('/api/admin/org-activity/feed?cursor=not-a-date')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
  });
});
