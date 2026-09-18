// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Per-user dashboard layout — /api/dashboard/layout tests (migration 142).
//
// Mounts dashboardRoutes against a tiny Express app (mirrors myDay.test.js).
// The pg pool is fully mocked: each pool.query call resolves the next queued
// response, in the order the route issues them.
//
// Query order:
//   GET /layout : 1. authMiddleware (users row)  2. SELECT from user_dashboards
//   PUT /layout : 1. authMiddleware (users row)  2. INSERT ... ON CONFLICT upsert
//
// Covers: default layout when none saved, save+load round-trip, widgetKey
// allowlist rejection (+ duplicate rejection), and org+user scoping — the
// read is parameterized on BOTH the caller's user_id and org scope, so one
// user's layout is never returned to another.

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const dashboardRoutes = require('../routes/dashboardRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');
const { DEFAULT_LAYOUT, WIDGET_KEYS } = require('../services/dashboardWidgets');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/dashboard', dashboardRoutes);
  return app;
}

const USER_ID = 4242;
const OTHER_USER_ID = 9999;
const ORG_ID = 7;

function authCookie(userId = USER_ID) {
  return [`${AUTH_COOKIE_NAME}=${generateToken(userId)}`];
}

function mockAuth() {
  mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
}

beforeEach(() => {
  mockPool.query.mockReset();
});

describe('GET /dashboard/layout', () => {
  test('returns the DEFAULT layout (saved=false) plus the widget catalog when none saved', async () => {
    mockAuth();
    // 2. user_dashboards select — no row for this user.
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .get('/dashboard/layout')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(false);
    expect(res.body.layout).toEqual(DEFAULT_LAYOUT);
    expect(res.body.defaultLayout).toEqual(DEFAULT_LAYOUT);

    // Every default widget is in the allowlist, and the catalog covers the
    // full registry so the frontend picker can't drift from the backend.
    for (const item of res.body.layout) {
      expect(WIDGET_KEYS).toContain(item.widgetKey);
    }
    expect(res.body.widgets.map((w) => w.key).sort()).toEqual([...WIDGET_KEYS].sort());
    for (const w of res.body.widgets) {
      expect(w.title).toBeTruthy();
      expect(w.source).toMatch(/^(metrics|myday|activities|forecast)$/);
    }
  });

  test('org+user scoping: the read is parameterized on BOTH user_id and org_id', async () => {
    mockAuth();
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await request(buildApp())
      .get('/dashboard/layout')
      .set('Cookie', authCookie());

    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/user_id = \$1/);
    expect(sql).toMatch(/org_id = \$2/);
    expect(params).toEqual([USER_ID, ORG_ID]);
  });

  test("one user's saved layout is never returned to another user", async () => {
    // User A saves; later user B (same org) loads. The select threads B's
    // user_id, so A's row can't match — B falls back to the default layout.
    const savedByA = [{ widgetKey: 'forecast', size: 'full' }];

    // --- user A saves ---
    mockAuth();
    mockPool.query.mockResolvedValueOnce({ rows: [{ layout: savedByA, updated_at: new Date().toISOString() }] });
    const saveRes = await request(buildApp())
      .put('/dashboard/layout')
      .set('Cookie', authCookie(USER_ID))
      .send({ layout: savedByA });
    expect(saveRes.status).toBe(200);
    expect(mockPool.query.mock.calls[1][1][0]).toBe(USER_ID); // upsert keyed on A

    mockPool.query.mockReset();

    // --- user B loads ---
    mockAuth();
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // WHERE user_id = B finds nothing
    const loadRes = await request(buildApp())
      .get('/dashboard/layout')
      .set('Cookie', authCookie(OTHER_USER_ID));

    expect(loadRes.status).toBe(200);
    expect(mockPool.query.mock.calls[1][1]).toEqual([OTHER_USER_ID, ORG_ID]);
    expect(loadRes.body.saved).toBe(false);
    expect(loadRes.body.layout).toEqual(DEFAULT_LAYOUT);
    expect(loadRes.body.layout).not.toEqual(savedByA);
  });

  test('an org-less user falls back to user_id-only scoping', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: null, org_role: null, status: 'active' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .get('/dashboard/layout')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/user_id = \$1 AND user_id = \$2/);
    expect(params).toEqual([USER_ID, USER_ID]);
  });

  test('a missing user_dashboards table (42P01) degrades to the default layout, not a 500', async () => {
    mockAuth();
    mockPool.query.mockRejectedValueOnce(
      Object.assign(new Error('relation "user_dashboards" does not exist'), { code: '42P01' })
    );

    const res = await request(buildApp())
      .get('/dashboard/layout')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(false);
    expect(res.body.layout).toEqual(DEFAULT_LAYOUT);
  });
});

describe('PUT /dashboard/layout', () => {
  test('save + load round-trip: what was PUT comes back from GET', async () => {
    const layout = [
      { widgetKey: 'my_tasks', size: 'full' },
      { widgetKey: 'hit_rate', size: 'half' },
      { widgetKey: 'forecast' }, // size omitted → default filled in
    ];
    const stored = [
      { widgetKey: 'my_tasks', size: 'full' },
      { widgetKey: 'hit_rate', size: 'half' },
      { widgetKey: 'forecast', size: 'half' },
    ];

    // --- PUT ---
    mockAuth();
    mockPool.query.mockResolvedValueOnce({ rows: [{ layout: stored, updated_at: new Date().toISOString() }] });
    const put = await request(buildApp())
      .put('/dashboard/layout')
      .set('Cookie', authCookie())
      .send({ layout });

    expect(put.status).toBe(200);
    expect(put.body.success).toBe(true);
    expect(put.body.saved).toBe(true);
    expect(put.body.layout).toEqual(stored);

    // Upsert is keyed on the caller and carries the org: (user_id, org_id, jsonb).
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/INSERT INTO user_dashboards/);
    expect(sql).toMatch(/ON CONFLICT \(user_id\)/);
    expect(params[0]).toBe(USER_ID);
    expect(params[1]).toBe(ORG_ID);
    expect(JSON.parse(params[2])).toEqual(stored); // sanitized: defaults filled

    mockPool.query.mockReset();

    // --- GET returns the saved row ---
    mockAuth();
    mockPool.query.mockResolvedValueOnce({ rows: [{ layout: stored, updated_at: new Date().toISOString() }] });
    const get = await request(buildApp())
      .get('/dashboard/layout')
      .set('Cookie', authCookie());

    expect(get.status).toBe(200);
    expect(get.body.saved).toBe(true);
    expect(get.body.layout).toEqual(stored);
  });

  test('rejects unknown widgetKeys with a 400 (allowlist)', async () => {
    mockAuth();

    const res = await request(buildApp())
      .put('/dashboard/layout')
      .set('Cookie', authCookie())
      .send({ layout: [{ widgetKey: 'crypto_ticker', size: 'full' }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/widgetKey/);
    // Validation failed before any write — only the auth query ran.
    expect(mockPool.query.mock.calls).toHaveLength(1);
  });

  test('rejects duplicate widgetKeys and bad sizes with a 400', async () => {
    mockAuth();
    const dup = await request(buildApp())
      .put('/dashboard/layout')
      .set('Cookie', authCookie())
      .send({ layout: [{ widgetKey: 'my_tasks' }, { widgetKey: 'my_tasks' }] });
    expect(dup.status).toBe(400);
    expect(dup.body.error).toMatch(/duplicate/i);

    mockPool.query.mockReset();
    mockAuth();
    const badSize = await request(buildApp())
      .put('/dashboard/layout')
      .set('Cookie', authCookie())
      .send({ layout: [{ widgetKey: 'my_tasks', size: 'gigantic' }] });
    expect(badSize.status).toBe(400);
  });

  test('accepts an empty layout (a deliberate "remove everything" is saved, not defaulted)', async () => {
    mockAuth();
    mockPool.query.mockResolvedValueOnce({ rows: [{ layout: [], updated_at: new Date().toISOString() }] });

    const res = await request(buildApp())
      .put('/dashboard/layout')
      .set('Cookie', authCookie())
      .send({ layout: [] });

    expect(res.status).toBe(200);
    expect(res.body.layout).toEqual([]);
    expect(JSON.parse(mockPool.query.mock.calls[1][1][2])).toEqual([]);
  });
});
