// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Sequence analytics (GET /api/sequences/:id/stats + migration 143 send
// attribution) — rollup math, per-step attribution, org isolation, zero state.
//
// Same harness as sequences.test.js: the campaigns_enabled gate + auth are
// SQL-shape-routed, everything else consumes a FIFO queue and is recorded for
// assertions. sequenceStats issues exactly five queries in order:
//   1 scoped sequence lookup   2 steps   3 enrollment rollup
//   4 email_sends rollup (attribution columns, migration 143)
//   5 unsubscribed-by-step rollup

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { requireFeature } = require('../middleware/featureGate');
const sequenceRoutes = require('../routes/sequenceRoutes');
const sequences = require('../services/sequences');
const email = require('../services/email');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 6101;

// Unique org id per test — dodges featureFlags' 30s in-process cache.
let orgSeq = 90_000;
let ORG_ID = null;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/sequences', requireFeature('campaigns_enabled'), sequenceRoutes);
  return app;
}

let queue = [];
let calls = [];

function prime({ features = {} } = {}) {
  ORG_ID = ++orgSeq;
  queue = [];
  calls = [];
  mockPool.query.mockImplementation(async (sql, params) => {
    const text = String(sql);
    if (/FROM users/i.test(text)) {
      return { rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] };
    }
    if (/SELECT features(, profile)? FROM organizations/i.test(text)) {
      return { rows: [{ features }] };
    }
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(text)) {
      return { rows: [] };
    }
    calls.push([text, params]);
    return queue.length > 0 ? queue.shift() : { rows: [] };
  });
  mockPool.connect.mockImplementation(async () => ({
    query: mockPool.query,
    release: () => {},
  }));
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  mockPool.query.mockResolvedValue({ rows: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Rollup math
// ---------------------------------------------------------------------------
describe('GET /api/sequences/:id/stats — rollup math', () => {
  test('merges enrollment, send, and unsubscribe rollups with derived rates', async () => {
    prime();
    queue.push({ rows: [{ id: 9, name: 'Onboarding', is_active: true }] }); // 1 seq lookup
    queue.push({
      rows: [
        { step_order: 0, delay_days: 0, subject: 'Welcome' },
        { step_order: 1, delay_days: 3, subject: 'Check-in' },
      ],
    }); // 2 steps
    queue.push({ rows: [{ enrolled: 10, active: 5, completed: 2, stopped: 1, unsubscribed: 2 }] }); // 3 enrollments
    queue.push({
      rows: [
        { step_order: 0, sent: 8, opened: 4 },
        { step_order: 1, sent: 4, opened: 1 },
      ],
    }); // 4 sends
    queue.push({ rows: [{ step_order: 1, unsubscribed: 2 }] }); // 5 unsubs by step

    const res = await request(buildApp())
      .get('/api/sequences/9/stats')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.sequence).toEqual({ id: 9, name: 'Onboarding', is_active: true });
    expect(res.body.totals).toEqual({
      enrolled: 10,
      active: 5,
      completed: 2,
      stopped: 1,
      unsubscribed: 2,
      sent: 12,
      opened: 5,
      open_rate: 0.417, // 5/12 to 3dp
      unsub_rate: 0.2,  // 2/10
    });

    // Per-step attribution: opens land on THEIR step, unsub lands on step 1.
    expect(res.body.steps).toEqual([
      { step_order: 0, subject: 'Welcome', delay_days: 0, sent: 8, opened: 4, open_rate: 0.5, unsubscribed: 0 },
      { step_order: 1, subject: 'Check-in', delay_days: 3, sent: 4, opened: 1, open_rate: 0.25, unsubscribed: 2 },
    ]);

    // No click tracking exists — the field is omitted, not zeroed.
    expect(res.body.totals).not.toHaveProperty('clicked');
    expect(res.body.steps[0]).not.toHaveProperty('clicked');
  });

  test('zero state: enrolled-but-nothing-sent yields zeros, never errors (email unconfigured)', async () => {
    prime();
    // Unconfigured transport is the norm in test env; stats must not care.
    vi.spyOn(email, 'isConfigured').mockReturnValue(false);

    queue.push({ rows: [{ id: 9, name: 'Quiet', is_active: true }] });
    queue.push({ rows: [{ step_order: 0, delay_days: 0, subject: 'Hello' }] });
    queue.push({ rows: [{ enrolled: 3, active: 3, completed: 0, stopped: 0, unsubscribed: 0 }] });
    queue.push({ rows: [] }); // no email_sends rows at all
    queue.push({ rows: [] }); // no unsubs

    const res = await request(buildApp())
      .get('/api/sequences/9/stats')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({
      enrolled: 3, active: 3, sent: 0, opened: 0, open_rate: 0, unsub_rate: 0,
    });
    expect(res.body.steps).toEqual([
      { step_order: 0, subject: 'Hello', delay_days: 0, sent: 0, opened: 0, open_rate: 0, unsubscribed: 0 },
    ]);
  });

  test('brand-new sequence with no enrollments at all still returns clean zeros', async () => {
    prime();
    queue.push({ rows: [{ id: 9, name: 'Fresh', is_active: false }] });
    queue.push({ rows: [] }); // no steps yet
    queue.push({ rows: [] }); // aggregate row absent entirely (defensive path)
    queue.push({ rows: [] });
    queue.push({ rows: [] });

    const res = await request(buildApp())
      .get('/api/sequences/9/stats')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({
      enrolled: 0, active: 0, completed: 0, stopped: 0, unsubscribed: 0,
      sent: 0, opened: 0, open_rate: 0, unsub_rate: 0,
    });
    expect(res.body.steps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Org isolation
// ---------------------------------------------------------------------------
describe('GET /api/sequences/:id/stats — org isolation', () => {
  test("another org's sequence 404s from the scoped lookup; no rollup queries run", async () => {
    prime();
    queue.push({ rows: [] }); // scoped sequence lookup misses

    const res = await request(buildApp())
      .get('/api/sequences/42/stats')
      .set('Cookie', authCookie());

    expect(res.status).toBe(404);
    expect(calls.length).toBe(1);
    const [sql, params] = calls[0];
    expect(sql).toMatch(/FROM sequences WHERE id = \$1 AND org_id = \$2/);
    expect(params).toEqual(['42', ORG_ID]);
  });

  test('every rollup query carries the tenancy scope', async () => {
    prime();
    queue.push({ rows: [{ id: 9, name: 'Onboarding', is_active: true }] });
    queue.push({ rows: [] });
    queue.push({ rows: [{ enrolled: 0, active: 0, completed: 0, stopped: 0, unsubscribed: 0 }] });
    queue.push({ rows: [] });
    queue.push({ rows: [] });

    const res = await request(buildApp())
      .get('/api/sequences/9/stats')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(calls.length).toBe(5);

    // Enrollment rollup — org-scoped like every tenant query.
    expect(calls[2][0]).toMatch(/FROM sequence_enrollments/);
    expect(calls[2][0]).toMatch(/org_id = \$2/);
    expect(calls[2][1]).toEqual(['9', ORG_ID]);

    // email_sends rollup — org guard on top of the ownership check
    // (IS NOT DISTINCT FROM covers the no-org user_id-fallback tenancy).
    expect(calls[3][0]).toMatch(/FROM email_sends/);
    expect(calls[3][0]).toMatch(/org_id IS NOT DISTINCT FROM \$2/);
    expect(calls[3][1]).toEqual(['9', ORG_ID]);

    // Unsub-by-step rollup — org-scoped too.
    expect(calls[4][0]).toMatch(/status = 'unsubscribed'/);
    expect(calls[4][1]).toEqual(['9', ORG_ID]);
  });

  test('gate off → 403 before any route SQL', async () => {
    prime({ features: { campaigns_enabled: false } });

    const res = await request(buildApp())
      .get('/api/sequences/9/stats')
      .set('Cookie', authCookie());

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Send-path attribution — the tick tags email_sends with sequence + step order
// ---------------------------------------------------------------------------
describe('processOneEnrollment tags email_sends for attribution', () => {
  test('the email_sends INSERT carries sequence_id + sequence_step_order (order, not id)', async () => {
    vi.spyOn(email, 'isConfigured').mockReturnValue(true);
    vi.spyOn(email, 'sendMail').mockResolvedValue({ ok: true, kind: 'gmail', messageId: 'mid-9' });

    mockPool.query.mockReset();
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 100, org_id: 7, user_id: 4, sequence_id: 9, contact_id: 3,
        current_step: 1, first_name: 'Ada', last_name: 'Lovelace',
        contact_email: 'ada@example.com', sequence_created_by: 4, sequence_name: 'Onboarding',
      }],
    }); // due scan
    mockPool.query.mockResolvedValueOnce({
      rows: [
        // step ids deliberately DON'T equal their order — attribution must use step_order.
        { id: 501, step_order: 0, delay_days: 0, subject: 'One', body_template: 'B1' },
        { id: 777, step_order: 1, delay_days: 3, subject: 'Two', body_template: 'B2' },
      ],
    }); // steps
    mockPool.query.mockResolvedValueOnce({ rows: [] });            // suppression clean
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 100 }] }); // claim won
    mockPool.query.mockResolvedValueOnce({ rows: [] });            // unsub token
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 555 }] }); // email_sends INSERT
    mockPool.query.mockResolvedValueOnce({ rows: [] });            // provider update

    const out = await sequences.processDueEnrollments();
    expect(out).toMatchObject({ sent: 1 });

    const [sendsSql, sendsParams] = mockPool.query.mock.calls[5];
    expect(sendsSql).toMatch(/INSERT INTO email_sends/);
    expect(sendsSql).toMatch(/sequence_id, sequence_step_order/);
    expect(sendsParams[6]).toBe(9); // the enrollment's sequence
    expect(sendsParams[7]).toBe(1); // step ORDER (id was 777) — survives step edits
  });
});
