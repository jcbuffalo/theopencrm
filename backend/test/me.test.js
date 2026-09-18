// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Smoke tests for /api/me/* — exercises the zod schemas via real HTTP.
//
// We mount meRoutes against a tiny Express app (no CSRF, no rate limiters
// other than the route-local changePasswordLimiter — which has a 5/15min
// cap, plenty of headroom for the test suite). The pg pool is fully mocked.

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

// db.js exports a single pg.Pool instance via `module.exports = pool`. Rather
// than fight vitest's CJS-mock interop, we patch the live instance's methods.
// All requirers share that instance, so the override is global within the
// worker.
const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

// Patch the audit + adminNotify modules' live exports so they don't issue
// pool.query (which would otherwise consume our queued mockResolvedValueOnce
// responses and shift the order off). vi.mock's CJS interop is unreliable
// for `module.exports = { ... }` patterns; mutating the exported object is
// the lowest-friction shim.
const audit = require('../services/audit');
audit.record  = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();
const adminNotify = require('../services/adminNotify');
adminNotify.send = vi.fn().mockResolvedValue({ ok: true });
adminNotify.shouldFireFailedLoginThreshold = vi.fn().mockResolvedValue(false);

// HIBP off — we don't want the test suite hitting the public k-anonymity
// API. Default validatePasswordAsync still enforces the sync policy.
process.env.HIBP_ENABLED = 'false';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const meRoutes = require('../routes/meRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/me', meRoutes);
  return app;
}

const USER_ID = 12345;
function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

beforeEach(() => {
  mockPool.query.mockReset();
});

describe('PUT /me — profile update', () => {
  test('rejects when email is not a valid email shape', async () => {
    // authMiddleware org lookup
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: 1, org_role: 'member' }] });
    const res = await request(buildApp())
      .put('/me')
      .set('Cookie', authCookie())
      .send({ notification_email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    // zod error shape sets `error` and `fields[]`.
    expect(Array.isArray(res.body.fields)).toBe(true);
    expect(res.body.fields.length).toBeGreaterThan(0);
  });

  test('rejects empty body (no editable fields)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: 1, org_role: 'member' }] });
    const res = await request(buildApp())
      .put('/me')
      .set('Cookie', authCookie())
      .send({});
    expect(res.status).toBe(400);
  });

  test('accepts valid name update and returns the refreshed user row', async () => {
    // authMiddleware
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: 1, org_role: 'member' }] });
    // UPDATE users
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // fetchUserRow projection
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: USER_ID, email: 'me@b.com', name: 'New Name', status: 'active',
        org_id: 1, org_role: 'member', notification_preferences: {},
        notification_email: null, notification_phone: null,
        org_profile: 'generic', org_name: 'Org', org_branding: {}, org_tier: 'free',
        admin_role: null, admin_permissions: null,
      }],
    });

    const res = await request(buildApp())
      .put('/me')
      .set('Cookie', authCookie())
      .send({ name: 'New Name' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.name).toBe('New Name');
  });
});

describe('POST /me/change-password', () => {
  test('rejects when the new password is below the 10-char minimum (zod gate)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: 1, org_role: 'member' }] });
    const res = await request(buildApp())
      .post('/me/change-password')
      .set('Cookie', authCookie())
      .send({ currentPassword: 'whatever', newPassword: 'short' });
    // The zod schema sets a 10-char min on newPassword — should 400 with
    // a `fields` array describing the failed path.
    expect(res.status).toBe(400);
    expect(res.body.fields).toBeDefined();
    expect(res.body.fields.some(f => f.path === 'newPassword')).toBe(true);
  });

  test('rejects when current==new (zod refine)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: 1, org_role: 'member' }] });
    const res = await request(buildApp())
      .post('/me/change-password')
      .set('Cookie', authCookie())
      .send({ currentPassword: 'Same-Password-1!', newPassword: 'Same-Password-1!' });
    expect(res.status).toBe(400);
  });

  test('rejects with 400 when policy/HIBP rejects (post-bcrypt path)', async () => {
    const bcryptjs = require('bcryptjs');
    const hash = await bcryptjs.hash('Old-Password-1!', 4);
    // authMiddleware
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: 1, org_role: 'member' }] });
    // SELECT password_hash
    mockPool.query.mockResolvedValueOnce({ rows: [{ password_hash: hash }] });
    // SELECT password history (none)
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    // 'Password123!' is in the common-pattern blocklist (contains 'password').
    const res = await request(buildApp())
      .post('/me/change-password')
      .set('Cookie', authCookie())
      .send({ currentPassword: 'Old-Password-1!', newPassword: 'Password123!' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/common/i);
  });
});
