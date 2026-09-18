// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Contact relationship cadence (migration 125) — route + service tests.
//
// We mount contactRoutes (which hosts the cadence endpoints) against a tiny
// Express app. The pg pool is fully mocked: each pool.query call resolves the
// next queued response, in the order the route issues them. The
// customer_success_enabled feature gate is spied to `true` (the gate's own
// behaviour gets one dedicated 403 test), mirroring enrichment.test.js.
//
// Query order per request:
//   1. authMiddleware — SELECT org_id, org_role, status FROM users
//   2. the route's own query (gone-quiet SELECT / cadence UPDATE / touch UPDATE)
//
// Covered: gone-quiet math (days_overdue, never-touched), org isolation (scope
// value threaded into every query), touch, cadence PATCH allowlist + input
// validation, the activity-create touch hook, and the feature gate.

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const contactRoutes = require('../routes/contactRoutes');
const activityRoutes = require('../routes/activityRoutes');
const contactCadence = require('../services/contactCadence');
const featureFlags = require('../services/featureFlags');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 4242;
const ORG_ID = 7;
const DAY_MS = 86400000;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function daysAgoISO(n) {
  return new Date(Date.now() - n * DAY_MS).toISOString();
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/contacts', contactRoutes);
  app.use('/api/activities', activityRoutes);
  return app;
}

// authMiddleware issues SELECT org_id, org_role, status FROM users WHERE id=$1.
function queueAuthRow() {
  mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.query.mockResolvedValue({ rows: [] });
  // Force the feature gate on so routes reach their handlers (dedicated 403
  // test below overrides this).
  vi.spyOn(featureFlags, 'hasFeature').mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// GET /api/contacts/gone-quiet
// ---------------------------------------------------------------------------
describe('GET /api/contacts/gone-quiet', () => {
  test('returns overdue contacts with days-overdue math, never-touched flagged', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({
      rows: [
        // Never touched — most overdue, sorted first by the SQL.
        { id: 2, first_name: 'Nia', last_name: 'Quiet', email: null, job_title: null,
          status: 'customer', company_id: null, owner_user_id: null,
          cadence_days: 30, last_touch_at: null },
        // Touched 45 days ago on a 30-day cadence → 15 days overdue.
        { id: 1, first_name: 'Ada', last_name: 'Lovelace', email: 'ada@acme.com', job_title: 'CTO',
          status: 'customer', company_id: 11, owner_user_id: 5,
          cadence_days: 30, last_touch_at: daysAgoISO(45) },
      ],
    });

    const res = await request(buildApp())
      .get('/api/contacts/gone-quiet')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);

    const nia = res.body.contacts.find((c) => c.id === 2);
    expect(nia.never_touched).toBe(true);
    expect(nia.days_since_last_touch).toBe(null);
    expect(nia.days_overdue).toBe(null);

    const ada = res.body.contacts.find((c) => c.id === 1);
    expect(ada.never_touched).toBe(false);
    expect(ada.days_since_last_touch).toBe(45);
    expect(ada.days_overdue).toBe(15);

    // Org isolation: the scope value is threaded into the query, and the SQL
    // only considers contacts that actually have a cadence set.
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(params[0]).toBe(ORG_ID);
    expect(sql).toMatch(/org_id = \$1/);
    expect(sql).toMatch(/cadence_days IS NOT NULL/);
    expect(sql).toMatch(/last_touch_at IS NULL/);
  });

  test('caps ?limit into the 1..200 range and defaults to 50', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await request(buildApp()).get('/api/contacts/gone-quiet?limit=9999').set('Cookie', authCookie());
    expect(mockPool.query.mock.calls[1][1][1]).toBe(200);

    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await request(buildApp()).get('/api/contacts/gone-quiet').set('Cookie', authCookie());
    expect(mockPool.query.mock.calls[3][1][1]).toBe(50);
  });

  test('403s when customer_success_enabled is off for the org', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    queueAuthRow();

    const res = await request(buildApp())
      .get('/api/contacts/gone-quiet')
      .set('Cookie', authCookie());

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
  });
});

// ---------------------------------------------------------------------------
// contactCadence service math (unit-level, mocked rows)
// ---------------------------------------------------------------------------
describe('contactCadence.daysSince', () => {
  test('floors whole days, null/garbage in → null out', () => {
    const now = new Date('2026-07-13T12:00:00Z');
    expect(contactCadence.daysSince('2026-07-03T11:00:00Z', now)).toBe(10);
    expect(contactCadence.daysSince('2026-07-13T01:00:00Z', now)).toBe(0);
    expect(contactCadence.daysSince(null, now)).toBe(null);
    expect(contactCadence.daysSince('not-a-date', now)).toBe(null);
  });
});

describe('contactCadence.goneQuiet (service)', () => {
  test('scopes by the tuple it is given (user_id fallback works too)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await contactCadence.goneQuiet(['user_id', USER_ID], {});
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toMatch(/user_id = \$1/);
    expect(params).toEqual([USER_ID, 50]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/contacts/:id/touch
// ---------------------------------------------------------------------------
describe('POST /api/contacts/:id/touch', () => {
  test('stamps last_touch_at and returns the updated contact', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 9, first_name: 'Ada', last_name: 'Lovelace', last_touch_at: daysAgoISO(0) }],
    });

    const res = await request(buildApp())
      .post('/api/contacts/9/touch')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(9);

    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/SET last_touch_at = NOW\(\)/);
    expect(sql).toMatch(/org_id = \$2/);
    expect(params).toEqual(['9', ORG_ID]);
  });

  test('404s when the id is not visible under the caller scope (cross-org)', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // other org's contact → 0 rows

    const res = await request(buildApp())
      .post('/api/contacts/9999/touch')
      .set('Cookie', authCookie());

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/contacts/:id/cadence
// ---------------------------------------------------------------------------
describe('PATCH /api/contacts/:id/cadence', () => {
  test('updates ONLY the allowlisted columns, ignoring anything else in the body', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 3, cadence_days: 14, owner_user_id: 5 }],
    });

    const res = await request(buildApp())
      .patch('/api/contacts/3/cadence')
      .set('Cookie', authCookie())
      .send({ cadence_days: 14, owner_user_id: 5, email: 'evil@x.com', first_name: 'Hax', status: 'vip' });

    expect(res.status).toBe(200);

    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/cadence_days = \$1/);
    expect(sql).toMatch(/owner_user_id = \$2/);
    // Allowlist: no other column reaches the SQL.
    expect(sql).not.toMatch(/email/);
    expect(sql).not.toMatch(/first_name/);
    expect(sql).not.toMatch(/status/);
    // Org isolation: id + scope value close out the params.
    expect(params).toEqual([14, 5, '3', ORG_ID]);
  });

  test('explicit null clears a value', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 3, cadence_days: null }] });

    const res = await request(buildApp())
      .patch('/api/contacts/3/cadence')
      .set('Cookie', authCookie())
      .send({ cadence_days: null });

    expect(res.status).toBe(200);
    expect(mockPool.query.mock.calls[1][1]).toEqual([null, '3', ORG_ID]);
  });

  test('400s on an empty body and on out-of-range / non-integer values', async () => {
    for (const body of [{}, { cadence_days: 0 }, { cadence_days: 'weekly' }, { cadence_days: 4000 }, { owner_user_id: -1 }]) {
      queueAuthRow();
      const res = await request(buildApp())
        .patch('/api/contacts/3/cadence')
        .set('Cookie', authCookie())
        .send(body);
      expect(res.status).toBe(400);
    }
  });

  test('404s when the id is not in the caller scope', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .patch('/api/contacts/77/cadence')
      .set('Cookie', authCookie())
      .send({ cadence_days: 30 });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Activity-create hook — logging an activity against a contact stamps the touch
// ---------------------------------------------------------------------------
describe('POST /api/activities touch hook', () => {
  test('creating an activity with a contact_id fires a best-effort last_touch_at stamp', async () => {
    queueAuthRow();
    // 2. contact in-scope check
    mockPool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    // 3. INSERT activities
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 100, type: 'call', title: 'Check-in', contact_id: 9, deal_id: null }],
    });
    // 4. the fire-and-forget touch UPDATE
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .post('/api/activities')
      .set('Cookie', authCookie())
      .send({ type: 'call', title: 'Check-in', contact_id: 9, activity_date: '2026-07-10T15:00:00.000Z' });

    expect(res.status).toBe(201);

    const touchCall = mockPool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('SET last_touch_at = NOW()')
    );
    expect(touchCall).toBeTruthy();
    expect(touchCall[0]).toMatch(/org_id = \$2/);
    expect(touchCall[1]).toEqual([9, ORG_ID]);
  });

  test('a failing touch stamp never breaks activity creation', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 101, type: 'call', title: 'Check-in', contact_id: 9, deal_id: null }],
    });
    // Touch UPDATE rejects — must be swallowed.
    mockPool.query.mockRejectedValueOnce(new Error('boom'));

    const res = await request(buildApp())
      .post('/api/activities')
      .set('Cookie', authCookie())
      .send({ type: 'call', title: 'Check-in', contact_id: 9, activity_date: '2026-07-10T15:00:00.000Z' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(101);
  });

  test('no contact_id → no touch stamp issued', async () => {
    queueAuthRow();
    // INSERT only (no contact/deal checks when both ids absent).
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 102, type: 'note', title: 'Standalone', contact_id: null, deal_id: null }],
    });

    const res = await request(buildApp())
      .post('/api/activities')
      .set('Cookie', authCookie())
      .send({ type: 'note', title: 'Standalone', activity_date: '2026-07-10T15:00:00.000Z' });

    expect(res.status).toBe(201);
    const touchCall = mockPool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('SET last_touch_at = NOW()')
    );
    expect(touchCall).toBeUndefined();
  });
});
