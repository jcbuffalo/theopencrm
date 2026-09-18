// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Win-back board — churn detail + /winback route tests (migration 127).
//
// Two surfaces under test, both against a mocked pg pool (each pool.query call
// resolves the next queued response, in the order the route issues them):
//
//   1. PATCH /companies/:id/lifecycle-stage — entering churned stamps
//      churned_at + optional allowlisted churned_reason; leaving churned
//      clears both; a reason outside CHURN_REASONS 400s before any UPDATE.
//   2. /winback — list is org-scoped and churned-only; reengage is
//      owner/admin-gated, creates the outreach task, and only moves the
//      account to an allowlisted early-lifecycle stage.
//
// Query order (valid requests):
//   every route: 1. authMiddleware — SELECT org_id, org_role, status FROM users
//   PATCH lifecycle-stage: 2. UPDATE companies ... RETURNING *
//   GET /winback:          2. SELECT ... WHERE lifecycle_stage = 'churned'
//   POST reengage:         2. SELECT company (scope+state) 3. INSERT task
//                          4. UPDATE companies (only when moveToStage given)

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const companyRoutes = require('../routes/companyRoutes');
const winbackRoutes = require('../routes/winbackRoutes');
const featureFlags = require('../services/featureFlags');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/companies', companyRoutes);
  // Production mounts /api/winback behind requireFeature('customer_success_enabled');
  // the gate itself is covered by the lifecycle-stage gate tests, so the router
  // mounts bare here and we exercise its own auth + role gates.
  app.use('/winback', winbackRoutes);
  return app;
}

const USER_ID = 4242;
const ORG_ID = 7;
const COMPANY_ID = 99;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

// authMiddleware row for a member vs. an org admin.
const AUTH_MEMBER = { rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] };
const AUTH_ADMIN  = { rows: [{ org_id: ORG_ID, org_role: 'admin',  status: 'active' }] };

beforeEach(() => {
  mockPool.query.mockReset();
  // The lifecycle-stage route is gated in-router; default the flag ON.
  vi.spyOn(featureFlags, 'hasFeature').mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// Churn detail on the lifecycle transition.
// ---------------------------------------------------------------------------
describe('PATCH /companies/:id/lifecycle-stage — churn detail', () => {
  test('moving to churned stamps churned_at and threads the allowlisted reason', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: COMPANY_ID, lifecycle_stage: 'churned', churned_reason: 'price', churned_at: '2026-07-13T00:00:00Z' }],
    });

    const res = await request(buildApp())
      .patch(`/companies/${COMPANY_ID}/lifecycle-stage`)
      .set('Cookie', authCookie())
      .send({ lifecycle_stage: 'churned', churned_reason: 'price' });

    expect(res.status).toBe(200);
    expect(res.body.churned_reason).toBe('price');

    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/churned_at = CASE WHEN \$4::boolean THEN COALESCE\(churned_at, CURRENT_TIMESTAMP\)/);
    expect(params).toEqual(['churned', String(COMPANY_ID), ORG_ID, true, 'price']);
  });

  test('moving AWAY from churned clears churned_at / churned_reason (isChurn=false)', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: COMPANY_ID, lifecycle_stage: 'prospect', churned_reason: null, churned_at: null }],
    });

    const res = await request(buildApp())
      .patch(`/companies/${COMPANY_ID}/lifecycle-stage`)
      .set('Cookie', authCookie())
      .send({ lifecycle_stage: 'prospect' });

    expect(res.status).toBe(200);
    const [sql, params] = mockPool.query.mock.calls[1];
    // isChurn=false → both CASE branches write NULL.
    expect(sql).toMatch(/churned_reason = CASE WHEN \$4::boolean/);
    expect(params).toEqual(['prospect', String(COMPANY_ID), ORG_ID, false, null]);
  });

  test('rejects a churned_reason outside the allowlist with 400 (no UPDATE issued)', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);

    const res = await request(buildApp())
      .patch(`/companies/${COMPANY_ID}/lifecycle-stage`)
      .set('Cookie', authCookie())
      .send({ lifecycle_stage: 'churned', churned_reason: 'they hated us' });

    expect(res.status).toBe(400);
    expect(mockPool.query).toHaveBeenCalledTimes(1); // auth only
  });

  test('rejects churned_reason on a non-churn transition with 400', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);

    const res = await request(buildApp())
      .patch(`/companies/${COMPANY_ID}/lifecycle-stage`)
      .set('Cookie', authCookie())
      .send({ lifecycle_stage: 'active', churned_reason: 'price' });

    expect(res.status).toBe(400);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// GET /winback — the churned-account board.
// ---------------------------------------------------------------------------
describe('GET /winback', () => {
  test('lists churned companies, org-scoped, most recent churn first', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 2, name: 'Fresh Churn', churned_reason: 'competitor', churned_at: '2026-07-01', days_since_churn: 12 },
        { id: 1, name: 'Old Churn', churned_reason: null, churned_at: '2026-01-01', days_since_churn: 193 },
      ],
    });

    const res = await request(buildApp())
      .get('/winback')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.companies).toHaveLength(2);
    expect(res.body.companies[0].name).toBe('Fresh Churn');

    // Org isolation: the only bound param is the caller's org id, and the SQL
    // hard-filters to churned rows ordered by churned_at.
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/WHERE org_id = \$1 AND lifecycle_stage = 'churned'/);
    expect(sql).toMatch(/ORDER BY churned_at DESC NULLS LAST/);
    expect(params).toEqual([ORG_ID]);
  });

  test('falls back to user_id scope for users without an org', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: null, org_role: null, status: 'active' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .get('/winback')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/WHERE user_id = \$1/);
    expect(params).toEqual([USER_ID]);
  });
});

// ---------------------------------------------------------------------------
// GET /winback/summary — light stats.
// ---------------------------------------------------------------------------
describe('GET /winback/summary', () => {
  test('returns churned totals org-scoped', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);
    mockPool.query.mockResolvedValueOnce({ rows: [{ churned_total: 5, churned_90d: 2 }] });

    const res = await request(buildApp())
      .get('/winback/summary')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ churned_total: 5, churned_90d: 2 });
    expect(mockPool.query.mock.calls[1][1]).toEqual([ORG_ID]);
  });
});

// ---------------------------------------------------------------------------
// POST /winback/:companyId/reengage — the win-back motion.
// ---------------------------------------------------------------------------
describe('POST /winback/:companyId/reengage', () => {
  const CHURNED_COMPANY = {
    rows: [{ id: COMPANY_ID, name: 'Acme Co', lifecycle_stage: 'churned', churned_reason: 'price', churned_at: '2026-06-01T00:00:00Z' }],
  };

  test('creates a win-back task; account stays churned by default (no UPDATE)', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_ADMIN);
    mockPool.query.mockResolvedValueOnce(CHURNED_COMPANY);
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 555, title: 'Win-back outreach — Acme Co', status: 'open', priority: 'high' }],
    });

    const res = await request(buildApp())
      .post(`/winback/${COMPANY_ID}/reengage`)
      .set('Cookie', authCookie())
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.task.title).toBe('Win-back outreach — Acme Co');
    expect(res.body.company.lifecycle_stage).toBe('churned'); // untouched

    // Exactly 3 queries: auth, scope/state SELECT, task INSERT — no stage move.
    expect(mockPool.query).toHaveBeenCalledTimes(3);
    const [insertSql, insertParams] = mockPool.query.mock.calls[2];
    expect(insertSql).toMatch(/INSERT INTO tasks/);
    expect(insertSql).toMatch(/interval '3 days'/);
    expect(insertParams[0]).toBe(USER_ID);
    expect(insertParams[1]).toBe(ORG_ID);
    expect(insertParams[2]).toBe('Win-back outreach — Acme Co');
    expect(insertParams[3]).toMatch(/Churn reason: price/);
  });

  test('moveToStage=prospect also moves the account and clears churn detail', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_ADMIN);
    mockPool.query.mockResolvedValueOnce(CHURNED_COMPANY);
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 556, title: 'Win-back outreach — Acme Co' }] });
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: COMPANY_ID, name: 'Acme Co', lifecycle_stage: 'prospect', churned_reason: null, churned_at: null }],
    });

    const res = await request(buildApp())
      .post(`/winback/${COMPANY_ID}/reengage`)
      .set('Cookie', authCookie())
      .send({ moveToStage: 'prospect' });

    expect(res.status).toBe(201);
    expect(res.body.company.lifecycle_stage).toBe('prospect');

    const [updSql, updParams] = mockPool.query.mock.calls[3];
    expect(updSql).toMatch(/churned_at = NULL, churned_reason = NULL/);
    expect(updParams).toEqual(['prospect', COMPANY_ID, ORG_ID]);
  });

  test('rejects a moveToStage outside prospect/onboarding with 400 (no writes)', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_ADMIN);

    const res = await request(buildApp())
      .post(`/winback/${COMPANY_ID}/reengage`)
      .set('Cookie', authCookie())
      .send({ moveToStage: 'active' });

    expect(res.status).toBe(400);
    expect(mockPool.query).toHaveBeenCalledTimes(1); // auth only
  });

  test('403s for a plain org member (owner/admin gate)', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);

    const res = await request(buildApp())
      .post(`/winback/${COMPANY_ID}/reengage`)
      .set('Cookie', authCookie())
      .send({});

    expect(res.status).toBe(403);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  test('404s when the company is not in the caller org', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_ADMIN);
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // scope SELECT misses

    const res = await request(buildApp())
      .post(`/winback/${COMPANY_ID}/reengage`)
      .set('Cookie', authCookie())
      .send({});

    expect(res.status).toBe(404);
  });

  test('409s when the company is not churned', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_ADMIN);
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: COMPANY_ID, name: 'Acme Co', lifecycle_stage: 'active' }],
    });

    const res = await request(buildApp())
      .post(`/winback/${COMPANY_ID}/reengage`)
      .set('Cookie', authCookie())
      .send({});

    expect(res.status).toBe(409);
    expect(mockPool.query).toHaveBeenCalledTimes(2); // no task INSERT
  });
});
