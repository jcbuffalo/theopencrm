// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Accounts home rollup — GET /api/accounts smoke test.
//
// We mount accountRoutes against a tiny Express app (no feature gate — the gate
// is exercised at the index.js mount, not here, mirroring account-360.test.js).
// The pg pool is fully mocked: each pool.query call resolves the next queued
// response, in the order the route issues them.
//
// Query order for GET / :
//   1. authMiddleware — SELECT org_id, org_role, status FROM users
//   2. accounts rollup — the single N+1-free LATERAL join query
//
// The test asserts: org-scoping (scope value threaded into the query), the
// health-band join, last-touch + next-renewal passthrough, derived day-counts,
// and the "gone quiet" / "renewing soon" cadence rollups.

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const accountRoutes = require('../routes/accountRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/accounts', accountRoutes);
  return app;
}

const USER_ID = 4242;
const ORG_ID = 7;
const DAY_MS = 86400000;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function daysAgoISO(n) {
  return new Date(Date.now() - n * DAY_MS).toISOString();
}
function daysAheadDate(n) {
  return new Date(Date.now() + n * DAY_MS).toISOString().slice(0, 10);
}

beforeEach(() => {
  mockPool.query.mockReset();
});

describe('GET /accounts', () => {
  test('returns accounts with health band, last-touch, next-renewal, and cadence rollups', async () => {
    // 1. authMiddleware — user belongs to ORG_ID, active.
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
    // 2. accounts rollup — three accounts exercising each cadence bucket.
    mockPool.query.mockResolvedValueOnce({
      rows: [
        // Healthy, touched 5 days ago, renewal in ~20 days.
        {
          id: 1, name: 'Acme Co', industry: 'Manufacturing', website: null, location: null,
          type: 'customer', status: 'active', lifecycle_stage: 'active', owner_id: null, created_at: daysAgoISO(200),
          health_band: 'green', health_score: 88, health_computed_at: daysAgoISO(1),
          last_touch: daysAgoISO(5), next_renewal_date: daysAheadDate(20),
        },
        // Never touched, no renewal — gone quiet in every bucket.
        {
          id: 2, name: 'Bravo LLC', industry: null, website: null, location: null,
          type: 'customer', status: 'active', lifecycle_stage: 'prospect', owner_id: null, created_at: daysAgoISO(10),
          health_band: null, health_score: null, health_computed_at: null,
          last_touch: null, next_renewal_date: null,
        },
        // Touched 65 days ago (quiet 30/60 but not 90), renewal in ~75 days.
        {
          id: 3, name: 'Cirrus Inc', industry: 'SaaS', website: null, location: null,
          type: 'customer', status: 'active', lifecycle_stage: 'at_risk', owner_id: null, created_at: daysAgoISO(400),
          health_band: 'yellow', health_score: 55, health_computed_at: daysAgoISO(1),
          last_touch: daysAgoISO(65), next_renewal_date: daysAheadDate(75),
        },
      ],
    });

    const res = await request(buildApp())
      .get('/accounts')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);

    // Org-scoping: the rollup query is parameterized on the org scope value.
    const rollupCall = mockPool.query.mock.calls[1];
    expect(rollupCall[1]).toEqual([ORG_ID]);
    // And it really is the health/last-touch/renewal join (not a bare select).
    expect(rollupCall[0]).toMatch(/account_health_snapshots/);
    expect(rollupCall[0]).toMatch(/type = 'customer'/);

    // Accounts passthrough + derived fields.
    expect(res.body.accounts).toHaveLength(3);
    const acme = res.body.accounts.find((a) => a.id === 1);
    expect(acme.health_band).toBe('green');
    expect(acme.health_score).toBe(88);
    expect(acme.days_since_last_touch).toBe(5);
    expect(acme.gone_quiet).toBe(false);
    expect(acme.days_to_next_renewal).toBeGreaterThanOrEqual(19);
    expect(acme.days_to_next_renewal).toBeLessThanOrEqual(21);

    const bravo = res.body.accounts.find((a) => a.id === 2);
    expect(bravo.health_band).toBe(null);
    expect(bravo.days_since_last_touch).toBe(null);
    expect(bravo.gone_quiet).toBe(true);
    expect(bravo.lifecycle_stage).toBe('prospect');

    const cirrus = res.body.accounts.find((a) => a.id === 3);
    expect(cirrus.days_since_last_touch).toBe(65);
    expect(cirrus.gone_quiet).toBe(true);

    // Cadence rollups (nested/cumulative buckets).
    // gone_quiet: Bravo (never) in all; Cirrus (65) in 30+60; Acme (5) in none.
    expect(res.body.summary.gone_quiet).toEqual({ d30: 2, d60: 2, d90: 1 });
    // renewing_soon: Acme (~20) in all; Cirrus (~75) in 90 only; Bravo none.
    expect(res.body.summary.renewing_soon).toEqual({ d30: 1, d60: 1, d90: 2 });
    expect(res.body.summary.total).toBe(3);
  });

  test('returns an empty roster + zeroed rollups when the org has no accounts', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .get('/accounts')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.accounts).toEqual([]);
    expect(res.body.summary).toEqual({
      total: 0,
      gone_quiet: { d30: 0, d60: 0, d90: 0 },
      renewing_soon: { d30: 0, d60: 0, d90: 0 },
    });
  });
});
