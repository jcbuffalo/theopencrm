// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Account lifecycle stage — PATCH /api/companies/:id/lifecycle-stage tests.
//
// We mount companyRoutes against a tiny Express app. The lifecycle-stage route
// is gated in-router by requireFeature('customer_success_enabled'), so we stub
// featureFlags.hasFeature per test. The pg pool is fully mocked: each pool.query
// call resolves the next queued response, in the order the route issues them.
//
// Query order for a valid PATCH :
//   1. authMiddleware — SELECT org_id, org_role, status FROM users
//   2. UPDATE companies SET lifecycle_stage ... RETURNING *
//
// Covered: allowlist validation (400 on a bogus stage — no UPDATE issued),
// org-scoped success (200 with the updated row), and 404 when the id isn't in
// the caller's scope (UPDATE matches zero rows).

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const companyRoutes = require('../routes/companyRoutes');
const featureFlags = require('../services/featureFlags');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/companies', companyRoutes);
  return app;
}

const USER_ID = 4242;
const ORG_ID = 7;
const COMPANY_ID = 99;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

beforeEach(() => {
  mockPool.query.mockReset();
  // The route is gated; default the flag ON so the happy paths run.
  vi.spyOn(featureFlags, 'hasFeature').mockResolvedValue(true);
});

describe('PATCH /companies/:id/lifecycle-stage', () => {
  test('updates lifecycle_stage to an allowlisted value (org-scoped)', async () => {
    // 1. authMiddleware — user belongs to ORG_ID, active.
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
    // 2. UPDATE — returns the updated row.
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: COMPANY_ID, name: 'Acme Co', type: 'customer', lifecycle_stage: 'onboarding' }],
    });

    const res = await request(buildApp())
      .patch(`/companies/${COMPANY_ID}/lifecycle-stage`)
      .set('Cookie', authCookie())
      .send({ lifecycle_stage: 'onboarding' });

    expect(res.status).toBe(200);
    expect(res.body.lifecycle_stage).toBe('onboarding');

    // The UPDATE is org-scoped: value + id + scope value are threaded through.
    // Params 4/5 are the churn-detail pair (migration 127): a non-churn move
    // clears churned_at/churned_reason (isChurn=false, reason=null).
    const updateCall = mockPool.query.mock.calls[1];
    expect(updateCall[0]).toMatch(/UPDATE companies SET lifecycle_stage/);
    expect(updateCall[1]).toEqual(['onboarding', String(COMPANY_ID), ORG_ID, false, null]);
  });

  test('rejects a value outside the allowlist with 400 (no UPDATE issued)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });

    const res = await request(buildApp())
      .patch(`/companies/${COMPANY_ID}/lifecycle-stage`)
      .set('Cookie', authCookie())
      .send({ lifecycle_stage: 'super_active' });

    expect(res.status).toBe(400);
    // Only the authMiddleware query ran — the handler bailed before the UPDATE.
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  test('returns 404 when the company is not in the caller org', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
    // UPDATE matches zero rows (out-of-scope or missing id).
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .patch(`/companies/${COMPANY_ID}/lifecycle-stage`)
      .set('Cookie', authCookie())
      .send({ lifecycle_stage: 'active' });

    expect(res.status).toBe(404);
  });

  test('returns 403 when customer_success_enabled is off for the org', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });

    const res = await request(buildApp())
      .patch(`/companies/${COMPANY_ID}/lifecycle-stage`)
      .set('Cookie', authCookie())
      .send({ lifecycle_stage: 'active' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
  });
});
