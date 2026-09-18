// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Server-side Terms acceptance (migration 157, sell-readiness fix 7):
//   GET  /api/me/accept-terms — current version + whether the caller accepted
//   POST /api/me/accept-terms — records acceptance (idempotent per version)

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const audit = require('../services/audit');
audit.record  = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const meRoutes = require('../routes/meRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 7100;
const ORG_ID  = 31;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/me', meRoutes);
  return app;
}

function queueAuthRow() {
  mockPool.query.mockResolvedValueOnce({
    rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }],
  });
}

function findCall(re) {
  return mockPool.query.mock.calls.find(([sql]) => typeof sql === 'string' && re.test(sql));
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  audit.fromReq.mockClear();
});

test('GET /accept-terms — not yet accepted', async () => {
  queueAuthRow();
  mockPool.query.mockResolvedValueOnce({ rows: [] }); // no acceptance row
  const res = await request(buildApp())
    .get('/api/me/accept-terms')
    .set('Cookie', authCookie());
  expect(res.status).toBe(200);
  expect(res.body.accepted).toBe(false);
  expect(res.body.accepted_at).toBeNull();
  expect(typeof res.body.version).toBe('string');
  expect(res.body.version.length).toBeGreaterThan(0);
});

test('GET /accept-terms — already accepted the current version', async () => {
  queueAuthRow();
  const acceptedAt = new Date('2026-06-01T12:00:00Z').toISOString();
  mockPool.query.mockResolvedValueOnce({
    rows: [{ version: '2026-05-01', accepted_at: acceptedAt }],
  });
  const res = await request(buildApp())
    .get('/api/me/accept-terms')
    .set('Cookie', authCookie());
  expect(res.status).toBe(200);
  expect(res.body.accepted).toBe(true);
  expect(res.body.accepted_at).toBe(acceptedAt);
});

test('POST /accept-terms records the acceptance with user, org and version', async () => {
  queueAuthRow();
  mockPool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // INSERT
  const res = await request(buildApp())
    .post('/api/me/accept-terms')
    .set('Cookie', authCookie())
    .send({});
  expect(res.status).toBe(200);
  expect(res.body.accepted).toBe(true);
  const insert = findCall(/INSERT INTO terms_acceptances/);
  expect(insert).toBeDefined();
  expect(insert[0]).toMatch(/ON CONFLICT \(user_id, version\) DO NOTHING/);
  expect(insert[1][0]).toBe(USER_ID);
  expect(insert[1][1]).toBe(ORG_ID);
  expect(insert[1][2]).toBe(res.body.version);
  expect(audit.fromReq).toHaveBeenCalled();
});

test('POST /accept-terms is idempotent (duplicate insert is a no-op success)', async () => {
  queueAuthRow();
  mockPool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // conflict → no-op
  const res = await request(buildApp())
    .post('/api/me/accept-terms')
    .set('Cookie', authCookie())
    .send({});
  expect(res.status).toBe(200);
  expect(res.body.accepted).toBe(true);
});
