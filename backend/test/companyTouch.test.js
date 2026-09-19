// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// POST /api/companies/:id/touch (migration 169) — mirrors
// test/contactCadence.test.js's contact-touch coverage. This is the write
// side the frontend's My Day "gone quiet" account rows call ("Log a touch");
// the read side (routes/myDayRoutes.js quietAccounts, which GREATESTs this
// column against activity-derived last touch) is covered in test/myDay.test.js.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const companyRoutes = require('../routes/companyRoutes');
const featureFlags = require('../services/featureFlags');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 4242;
const ORG_ID = 7;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/companies', companyRoutes);
  return app;
}

function queueAuthRow() {
  mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.query.mockResolvedValue({ rows: [] });
  vi.spyOn(featureFlags, 'hasFeature').mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/companies/:id/touch', () => {
  test('stamps last_touch_at and returns the updated company', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 11, name: 'Acme Co', last_touch_at: new Date().toISOString() }],
    });

    const res = await request(buildApp())
      .post('/api/companies/11/touch')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(11);

    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/SET last_touch_at = NOW\(\)/);
    expect(sql).toMatch(/org_id = \$2/);
    expect(params).toEqual(['11', ORG_ID]);
  });

  test('404s when the id is not visible under the caller scope (cross-org)', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .post('/api/companies/9999/touch')
      .set('Cookie', authCookie());

    expect(res.status).toBe(404);
  });

  test('403s when customer_success_enabled is off for the org', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    queueAuthRow();

    const res = await request(buildApp())
      .post('/api/companies/11/touch')
      .set('Cookie', authCookie());

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
  });
});
