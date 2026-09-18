// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// CS-3 — service-contract renewals rollup happy-path smoke test.
//
// We mount serviceContractRoutes against a tiny Express app. The /renewals
// endpoint is gated in-router by requireFeature('customer_success_enabled'),
// so we stub featureFlags.hasFeature per test (true = enabled). The pg pool is
// fully mocked: each pool.query call resolves the next queued response, in the
// order the route issues them.
//
// Query order for GET /service-contracts/renewals :
//   1. authMiddleware — SELECT org_id, org_role, status FROM users
//   2. byStage   — counts + summed annual_value grouped by renewal_stage
//   3. forecast  — same shape, contracts ending within 90 days

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const serviceContractRoutes = require('../routes/serviceContractRoutes');
const featureFlags = require('../services/featureFlags');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/service-contracts', serviceContractRoutes);
  return app;
}

const USER_ID = 4242;
const ORG_ID = 7;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

beforeEach(() => {
  mockPool.query.mockReset();
  // /renewals is gated; default the flag ON so the happy paths run.
  vi.spyOn(featureFlags, 'hasFeature').mockResolvedValue(true);
});

describe('GET /service-contracts/renewals', () => {
  test('returns per-stage counts/value, totals, and a 90-day forecast', async () => {
    // 1. authMiddleware — user belongs to ORG_ID, active.
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
    // 2. byStage — two stages populated.
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { renewal_stage: 'upcoming', count: 3, annual_value: 30000 },
        { renewal_stage: 'at_risk', count: 1, annual_value: 12000 },
      ],
    });
    // 3. forecast — one contract ending within 90 days.
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { renewal_stage: 'at_risk', count: 1, annual_value: 12000 },
      ],
    });

    const res = await request(buildApp())
      .get('/service-contracts/renewals')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);

    // All four stages present (zero-filled where missing).
    expect(res.body.stages.upcoming).toEqual({ count: 3, annual_value: 30000 });
    expect(res.body.stages.at_risk).toEqual({ count: 1, annual_value: 12000 });
    expect(res.body.stages.renewed).toEqual({ count: 0, annual_value: 0 });
    expect(res.body.stages.churned).toEqual({ count: 0, annual_value: 0 });

    // Totals across stages.
    expect(res.body.total_count).toBe(4);
    expect(res.body.total_annual_value).toBe(42000);

    // 90-day forecast.
    expect(res.body.forecast_90d.total_count).toBe(1);
    expect(res.body.forecast_90d.total_annual_value).toBe(12000);
    expect(res.body.forecast_90d.stages.at_risk).toEqual({ count: 1, annual_value: 12000 });
    expect(res.body.forecast_90d.stages.upcoming).toEqual({ count: 0, annual_value: 0 });
  });

  test('returns 403 when customer_success_enabled is off for the org', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    // authMiddleware — user belongs to ORG_ID, active.
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });

    const res = await request(buildApp())
      .get('/service-contracts/renewals')
      .set('Cookie', authCookie());

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
  });
});
