// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Sell-readiness fix 4: NEW self-serve orgs are created with
// limits_tier='free' so the tier caps (services/tierLimits.js) are armed
// from day one. Existing orgs stay NULL (untouched) — no migration backfill.
//
// Covered creation paths:
//   • POST /auth/register        (email+password signup)
//   • POST /api/request-access   (public access-request flow)
// (The Google first-sign-in path uses the identical INSERT; asserting the
// two supertest-reachable paths pins the SQL shape.)

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const adminNotify = require('../services/adminNotify');
adminNotify.send = vi.fn().mockResolvedValue({ ok: true });

const bootstrapAdmin = require('../services/bootstrapAdmin');
bootstrapAdmin.ensureSuperAdmin = vi.fn().mockResolvedValue(null);
bootstrapAdmin.ensureOrgProfile = vi.fn().mockResolvedValue(null);

const audit = require('../services/audit');
audit.record  = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

const emailService = require('../services/email');
emailService.isConfigured = vi.fn(() => false);

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const authRoutes = require('../routes/authRoutes');
const accessRequestRoutes = require('../routes/accessRequestRoutes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/auth', authRoutes);
  app.use('/api/request-access', accessRequestRoutes);
  return app;
}

function findCall(re) {
  return mockPool.query.mock.calls.find(([sql]) => typeof sql === 'string' && re.test(sql));
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

test('POST /auth/register creates the workspace org with limits_tier=free', async () => {
  // 1. existing-user lookup → none
  mockPool.query.mockResolvedValueOnce({ rows: [] });
  // 2. INSERT users
  mockPool.query.mockResolvedValueOnce({
    rows: [{ id: 900, email: 'new@example.com', name: 'New User', status: 'pending_approval' }],
  });
  // 3. INSERT organizations
  mockPool.query.mockResolvedValueOnce({ rows: [{ id: 5000 }] });
  // 4. UPDATE users SET org_id (default mock)

  const res = await request(buildApp())
    .post('/auth/register')
    .send({ name: 'New User', email: 'new@example.com', password: 'Str0ng!Passw0rd' });

  expect([201, 202]).toContain(res.status);
  const orgInsert = findCall(/INSERT INTO organizations/);
  expect(orgInsert).toBeDefined();
  expect(orgInsert[0]).toMatch(/limits_tier/);
  expect(orgInsert[0]).toMatch(/'free'/);
});

test('POST /api/request-access creates the workspace org with limits_tier=free', async () => {
  // 1. existing-user lookup → none
  mockPool.query.mockResolvedValueOnce({ rows: [] });
  // 2. INSERT users
  mockPool.query.mockResolvedValueOnce({
    rows: [{ id: 901, email: 'req@example.com', name: 'Requester', status: 'pending_approval' }],
  });
  // 3. INSERT organizations
  mockPool.query.mockResolvedValueOnce({ rows: [{ id: 5001 }] });

  const res = await request(buildApp())
    .post('/api/request-access')
    .send({ name: 'Requester', email: 'req@example.com', password: 'Str0ng!Passw0rd', company: 'Acme' });

  expect(res.status).toBe(202);
  const orgInsert = findCall(/INSERT INTO organizations/);
  expect(orgInsert).toBeDefined();
  expect(orgInsert[0]).toMatch(/limits_tier/);
  expect(orgInsert[0]).toMatch(/'free'/);
  // Approval-gated deployment: response says pending, not active.
  expect(res.body.pending).toBe(true);
  expect(res.body.active).toBeUndefined();
});

test('POST /api/request-access with OPEN_SIGNUP=true activates immediately and says so', async () => {
  process.env.OPEN_SIGNUP = 'true';
  try {
    // 1. existing-user lookup → none
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // 2. INSERT users
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 902, email: 'open@example.com', name: 'Opener', status: 'active' }],
    });
    // 3. INSERT organizations
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 5002 }] });

    const res = await request(buildApp())
      .post('/api/request-access')
      .send({ name: 'Opener', email: 'open@example.com', password: 'Str0ng!Passw0rd' });

    expect(res.status).toBe(202);
    expect(res.body.active).toBe(true);
    expect(res.body.pending).toBe(false);
    expect(res.body.message).toMatch(/sign in now/i);
    // The user row was inserted with status 'active'.
    const userInsert = findCall(/INSERT INTO users/);
    expect(userInsert[1]).toContain('active');
  } finally {
    delete process.env.OPEN_SIGNUP;
  }
});

test('POST /api/request-access with OPEN_SIGNUP=true gives the SAME response for an existing email (no enumeration)', async () => {
  process.env.OPEN_SIGNUP = 'true';
  try {
    // 1. existing-user lookup → found
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 903, status: 'active' }] });

    const res = await request(buildApp())
      .post('/api/request-access')
      .send({ name: 'Dup', email: 'open@example.com', password: 'Str0ng!Passw0rd' });

    expect(res.status).toBe(202);
    expect(res.body.active).toBe(true);
    expect(res.body.message).toMatch(/sign in now/i);
  } finally {
    delete process.env.OPEN_SIGNUP;
  }
});
