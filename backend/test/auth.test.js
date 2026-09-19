// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Smoke tests for the auth surface.
//
// Strategy: mount the auth router on a bare Express app, mock the pg pool
// with vi.mock so no real DB is touched, and drive the endpoints with
// supertest. We exercise the cookie + JWT path end-to-end (mint a token,
// echo it back via /auth/me) so a regression in either generateToken or
// authMiddleware fails the suite.

// describe / test / expect / beforeEach / vi are global (vitest.config.js
// sets `globals: true`). See setup.js for why we don't use the ESM
// `import { vi } from 'vitest'` form.

// ---------------------------------------------------------------------------
// Mocks — these MUST be registered before requiring the route under test.
// vitest hoists vi.mock calls, but we still want the require to come after
// the mock factory so the mock state is what gets installed.
// ---------------------------------------------------------------------------

// db.js does `module.exports = pool` (an actual pg.Pool instance) — vitest's
// CJS mock factory has trouble returning that exact shape (a raw object that
// IS the module, not wrapped in { default }). Instead, we let the real db.js
// load, then overwrite its query/connect methods on the live pool instance.
// All routes/services do `const pool = require('../db')` so they share the
// same instance; mutating it here propagates everywhere.
const realPool = require('../db');
const mockPool = realPool;
// Stub out the network-touching methods.
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

// Same trick — patch the live module exports for downstream services that
// would otherwise issue DB writes during the test.
const adminNotify = require('../services/adminNotify');
adminNotify.send = vi.fn().mockResolvedValue({ ok: true });
adminNotify.shouldFireFailedLoginThreshold = vi.fn().mockResolvedValue(false);

const bootstrapAdmin = require('../services/bootstrapAdmin');
bootstrapAdmin.ensureSuperAdmin = vi.fn().mockResolvedValue(null);
bootstrapAdmin.ensureOrgProfile = vi.fn().mockResolvedValue(null);

const audit = require('../services/audit');
audit.record  = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const bcryptjs = require('bcryptjs');
const authRoutes = require('../routes/authRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/auth', authRoutes);
  return app;
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
});

describe('POST /auth/login', () => {
  test('returns 401 on bad credentials (no user found)', async () => {
    // First query: lookup user by email — returns no rows.
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp())
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'whatever' });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test('returns 401 when password does not match', async () => {
    const hash = await bcryptjs.hash('right-password', 4);
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 1, email: 'a@b.com', name: 'A', password_hash: hash, status: 'active', two_factor_enabled: false }],
    });
    const res = await request(buildApp())
      .post('/auth/login')
      .send({ email: 'a@b.com', password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  test('returns 200 + sets auth cookie on valid creds (no 2FA)', async () => {
    const hash = await bcryptjs.hash('correct-password', 4);
    // login query
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 42, email: 'a@b.com', name: 'Alice', password_hash: hash, status: 'active', two_factor_enabled: false }],
    });
    // adminRequires2faEnrollment query
    mockPool.query.mockResolvedValueOnce({ rows: [{ two_factor_enabled: false, admin_role: null }] });

    const res = await request(buildApp())
      .post('/auth/login')
      .send({ email: 'a@b.com', password: 'correct-password' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // The httpOnly auth cookie should be on the response.
    const setCookie = res.headers['set-cookie'] || [];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie);
    expect(cookieStr).toMatch(new RegExp(AUTH_COOKIE_NAME));
  });

  test('2FA-enabled user receives tempToken instead of session', async () => {
    const hash = await bcryptjs.hash('correct-password', 4);
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 7, email: 'tfa@b.com', name: 'TFA', password_hash: hash, status: 'active', two_factor_enabled: true }],
    });
    const res = await request(buildApp())
      .post('/auth/login')
      .send({ email: 'tfa@b.com', password: 'correct-password' });
    expect(res.status).toBe(200);
    expect(res.body.requires2fa).toBe(true);
    expect(res.body.tempToken).toBeTruthy();
    // No session cookie should have been set on a 2FA challenge.
    const cookieStr = String(res.headers['set-cookie'] || '');
    // generateCsrfToken may set csrfToken cookie — but the *auth* cookie
    // must NOT be set yet.
    expect(cookieStr).not.toMatch(new RegExp(`${AUTH_COOKIE_NAME}=`));
  });
});

describe('GET /auth/me', () => {
  test('returns 401 without a cookie', async () => {
    const res = await request(buildApp()).get('/auth/me');
    expect(res.status).toBe(401);
  });

  test('returns 200 + user row with a valid cookie', async () => {
    const token = generateToken(99);
    // authMiddleware queries users for org_id/role
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: 1, org_role: 'member' }] });
    // /me main projection
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 99, email: 'me@b.com', name: 'Me', status: 'active', org_id: 1, org_role: 'member',
        notification_preferences: {}, notification_email: null, notification_phone: null,
        org_profile: 'generic', org_name: 'Workspace', org_branding: {}, org_tier: 'free',
        admin_role: null, admin_permissions: null,
      }],
    });

    const res = await request(buildApp())
      .get('/auth/me')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${token}`]);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.id).toBe(99);
    expect(res.body.user.email).toBe('me@b.com');
  });

  test('includes an effective org_features map (stored flags merged over defaults)', async () => {
    const token = generateToken(98);
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: 5150, org_role: 'member' }] });
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 98, email: 'flags@b.com', name: 'Flags', status: 'active', org_id: 5150, org_role: 'member',
        notification_preferences: {}, notification_email: null, notification_phone: null,
        org_profile: 'generic', org_name: 'Workspace', org_branding: {}, org_tier: 'free',
        admin_role: null, admin_permissions: null,
      }],
    });
    // featureFlags.getFeatures → SELECT features FROM organizations
    mockPool.query.mockResolvedValueOnce({ rows: [{ features: { leads_enabled: false, plugins_enabled: true } }] });

    const res = await request(buildApp())
      .get('/auth/me')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${token}`]);
    expect(res.status).toBe(200);
    const f = res.body.user.org_features;
    expect(f).toBeTruthy();
    expect(f.leads_enabled).toBe(false);      // explicit off wins
    expect(f.plugins_enabled).toBe(true);     // explicit on wins over default-off
    expect(f.reports_enabled).toBe(true);     // untouched → registered default
    expect(f.quickbooks_enabled).toBe(false); // untouched → registered default
    // No has_customers row was queued → unknown → null (frontend shows everything).
    expect(res.body.user.org_has_customers).toBeNull();
  });

  test('reports org_has_customers from one org-scoped EXISTS query (Wave 3 nav gating)', async () => {
    const token = generateToken(97);
    const calls = [];
    mockPool.query.mockImplementation(async (sql, params) => {
      const s = String(sql);
      calls.push({ s, params });
      if (/FROM users u/i.test(s)) {
        return { rows: [{
          id: 97, email: 'nav@b.com', name: 'Nav', status: 'active', org_id: 6000, org_role: 'owner',
          notification_preferences: {}, notification_email: null, notification_phone: null,
          org_profile: 'generic', org_name: 'Workspace', org_branding: {}, org_tier: 'free',
          admin_role: null, admin_permissions: null,
        }] };
      }
      if (/FROM users WHERE id/i.test(s)) return { rows: [{ org_id: 6000, org_role: 'owner', status: 'active' }] };
      if (/AS has_customers/i.test(s)) return { rows: [{ has_customers: false }] };
      return { rows: [] };
    });

    const res = await request(buildApp())
      .get('/auth/me')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=${token}`]);
    expect(res.status).toBe(200);
    expect(res.body.user.org_has_customers).toBe(false);
    const hc = calls.find((c) => /AS has_customers/i.test(c.s));
    expect(hc.params).toEqual([6000]);
    // Both signals are checked: a non-prospect company OR a won deal (legacy
    // stage ids, closed_date, or a custom pipeline's is_won stage).
    expect(hc.s).toMatch(/lifecycle_stage, 'prospect'\) <> 'prospect'/);
    expect(hc.s).toMatch(/closed_date IS NOT NULL/);
    expect(hc.s).toMatch(/is_won/);
  });
});

describe('POST /auth/2fa/verify — happy path', () => {
  test('tempToken + correct recovery code mints a session cookie', async () => {
    const { generate2faTempToken } = require('../auth');
    const userId = 555;
    const tempToken = generate2faTempToken(userId);

    // Lookup user with 2FA state. We use a recovery code rather than mocking
    // speakeasy because the recovery-code path is a plain string match.
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: userId, email: 'r@b.com', name: 'R', status: 'active',
        two_factor_secret: 'IRRELEVANT',
        two_factor_recovery_codes: ['MY-RECOVERY-CODE'],
      }],
    });
    // UPDATE users SET two_factor_recovery_codes = $1 ...
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .post('/auth/2fa/verify')
      .send({ tempToken, code: 'MY-RECOVERY-CODE' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.usedRecoveryCode).toBe(true);
    const cookieStr = String(res.headers['set-cookie'] || '');
    expect(cookieStr).toMatch(new RegExp(`${AUTH_COOKIE_NAME}=`));
  });
});
