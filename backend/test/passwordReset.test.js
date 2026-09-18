// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Tests for the forgot-password / password-reset flow
// (POST /api/security/password-reset/request + /confirm).
//
// Strategy mirrors auth.test.js: mount the security-flow router on a bare
// Express app, patch the live pg pool's query method so no real DB is
// touched, and drive the endpoints with supertest. The per-IP rate limiters
// are REAL (module-level express-rate-limit instances), so each test sends a
// distinct X-Forwarded-For with `trust proxy = 1` to keep its own budget —
// except the dedicated rate-limit test, which deliberately hammers one IP.

const crypto = require('crypto');

// Patch the live pool instance (db.js exports the pool itself; every route
// shares it, so mutating here propagates). See auth.test.js for why we don't
// use a vi.mock factory.
const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

const audit = require('../services/audit');
audit.record = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

// Patch the email service so we can capture the reset link.
const emailSvc = require('../services/email');
emailSvc.isConfigured = vi.fn(() => true);
emailSvc.sendMail = vi.fn().mockResolvedValue({ ok: true, kind: 'test' });

const express = require('express');
const request = require('supertest');
const bcryptjs = require('bcryptjs');
const securityFlowRoutes = require('../routes/securityFlowRoutes');

function buildApp() {
  const app = express();
  // Trust exactly one proxy hop so tests can vary req.ip via X-Forwarded-For
  // without tripping express-rate-limit's permissive-trust-proxy validation.
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/security', securityFlowRoutes);
  return app;
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Each test gets its own client IP so the shared per-IP limiter state never
// bleeds between tests.
let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `10.99.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

const GENERIC_MESSAGE = 'If that email has an account, a reset link is on the way.';

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  emailSvc.sendMail.mockClear();
  emailSvc.isConfigured.mockClear();
  audit.fromReq.mockClear();
});

// ---------------------------------------------------------------------------
// REQUEST flow
// ---------------------------------------------------------------------------

describe('POST /security/password-reset/request', () => {
  test('400 on missing/garbage email', async () => {
    const res = await request(buildApp())
      .post('/security/password-reset/request')
      .set('X-Forwarded-For', nextIp())
      .send({});
    expect(res.status).toBe(400);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('existing password account: generic 200, token stored HASHED, email carries the raw token', async () => {
    // 1. user lookup
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 42, email: 'alice@example.com', name: 'Alice', password_hash: 'x-bcrypt-x', status: 'active' }],
    });
    // 2. per-account throttle count
    mockPool.query.mockResolvedValueOnce({ rows: [{ n: 0 }] });
    // 3. INSERT token
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .post('/security/password-reset/request')
      .set('X-Forwarded-For', nextIp())
      .send({ email: 'alice@example.com' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: GENERIC_MESSAGE });

    // The INSERT stored a SHA-256 hex digest — never the raw token.
    const insertCall = mockPool.query.mock.calls.find(([sql]) => /INSERT INTO password_reset_tokens/.test(sql));
    expect(insertCall).toBeTruthy();
    const storedHash = insertCall[1][1];
    expect(storedHash).toMatch(/^[0-9a-f]{64}$/);

    // The email link carries the RAW token, whose sha256 matches the stored hash.
    expect(emailSvc.sendMail).toHaveBeenCalledTimes(1);
    const { to, html, subject } = emailSvc.sendMail.mock.calls[0][0];
    expect(to).toBe('alice@example.com');
    expect(subject).toMatch(/Reset your password/);
    const m = html.match(/reset-password\?token=([0-9a-f]{64})/);
    expect(m).toBeTruthy();
    const rawToken = m[1];
    expect(rawToken).not.toBe(storedHash);
    expect(sha256Hex(rawToken)).toBe(storedHash);
  });

  test('unknown email: identical generic 200, no token minted, no email sent', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // user lookup — nobody

    const res = await request(buildApp())
      .post('/security/password-reset/request')
      .set('X-Forwarded-For', nextIp())
      .send({ email: 'nobody@example.com' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: GENERIC_MESSAGE });
    expect(mockPool.query).toHaveBeenCalledTimes(1); // only the lookup
    expect(emailSvc.sendMail).not.toHaveBeenCalled();
  });

  test('google-only account (no password hash): generic 200, "sign in with Google" email, no token', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 7, email: 'goog@example.com', name: 'Goog', password_hash: null, status: 'active' }],
    });

    const res = await request(buildApp())
      .post('/security/password-reset/request')
      .set('X-Forwarded-For', nextIp())
      .send({ email: 'goog@example.com' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: GENERIC_MESSAGE });
    // No throttle count, no INSERT — the only query was the lookup.
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(emailSvc.sendMail).toHaveBeenCalledTimes(1);
    expect(emailSvc.sendMail.mock.calls[0][0].html).toMatch(/Google/);
    expect(emailSvc.sendMail.mock.calls[0][0].html).not.toMatch(/reset-password\?token=/);
  });

  test('inactive account behaves like an unknown one', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 8, email: 'susp@example.com', name: 'S', password_hash: 'hash', status: 'suspended' }],
    });
    const res = await request(buildApp())
      .post('/security/password-reset/request')
      .set('X-Forwarded-For', nextIp())
      .send({ email: 'susp@example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: GENERIC_MESSAGE });
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(emailSvc.sendMail).not.toHaveBeenCalled();
  });

  test('per-account throttle: 3 recent mints → generic 200, no new token, no email', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 42, email: 'alice@example.com', name: 'Alice', password_hash: 'x', status: 'active' }],
    });
    mockPool.query.mockResolvedValueOnce({ rows: [{ n: 3 }] }); // throttle count at cap

    const res = await request(buildApp())
      .post('/security/password-reset/request')
      .set('X-Forwarded-For', nextIp())
      .send({ email: 'alice@example.com' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: GENERIC_MESSAGE });
    expect(mockPool.query).toHaveBeenCalledTimes(2); // lookup + count, no INSERT
    expect(emailSvc.sendMail).not.toHaveBeenCalled();
  });

  test('per-IP rate limit: 6th request from the same IP is 429', async () => {
    const ip = nextIp();
    // All hits resolve as "unknown user" — cheapest path; the limiter counts
    // requests, not outcomes.
    mockPool.query.mockResolvedValue({ rows: [] });
    const app = buildApp();
    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .post('/security/password-reset/request')
        .set('X-Forwarded-For', ip)
        .send({ email: 'nobody@example.com' });
      expect(r.status).toBe(200);
    }
    const blocked = await request(app)
      .post('/security/password-reset/request')
      .set('X-Forwarded-For', ip)
      .send({ email: 'nobody@example.com' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('PASSWORD_RESET_RATE_LIMIT');
  });
});

// ---------------------------------------------------------------------------
// CONFIRM flow
// ---------------------------------------------------------------------------

const RAW_TOKEN = 'a'.repeat(64);

function tokenRow(overrides = {}) {
  return {
    id: 1,
    user_id: 42,
    expires_at: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
    used_at: null,
    password_hash: null, // current user hash; null keeps happy paths cheap
    email: 'alice@example.com',
    ...overrides,
  };
}

describe('POST /security/password-reset/confirm', () => {
  test('400 without token or password', async () => {
    const app = buildApp();
    const ip = nextIp();
    const r1 = await request(app).post('/security/password-reset/confirm')
      .set('X-Forwarded-For', ip).send({ password: 'Something-Str0ng!' });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/security/password-reset/confirm')
      .set('X-Forwarded-For', ip).send({ token: RAW_TOKEN });
    expect(r2.status).toBe(400);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('happy path: sets new hash, records history, consumes + invalidates ALL outstanding tokens, audits password.reset', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [tokenRow()] }); // token lookup
    mockPool.query.mockResolvedValueOnce({ rows: [] });           // history
    mockPool.query.mockResolvedValueOnce({ rows: [] });           // UPDATE users
    mockPool.query.mockResolvedValueOnce({ rows: [] });           // INSERT history
    mockPool.query.mockResolvedValueOnce({ rows: [] });           // UPDATE tokens

    const res = await request(buildApp())
      .post('/security/password-reset/confirm')
      .set('X-Forwarded-For', nextIp())
      .send({ token: RAW_TOKEN, password: 'Brand-New-Secret97!' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // No session cookie — the user signs in themselves (2FA intact).
    expect(String(res.headers['set-cookie'] || '')).not.toMatch(/authToken=/);

    const calls = mockPool.query.mock.calls;
    // Lookup used the SHA-256 of the raw token, not the token itself.
    expect(calls[0][1][0]).toBe(sha256Hex(RAW_TOKEN));

    // New bcrypt hash written for the right user, and it verifies.
    const userUpdate = calls.find(([sql]) => /UPDATE users SET password_hash/.test(sql));
    expect(userUpdate).toBeTruthy();
    const [newHash, userId] = userUpdate[1];
    expect(userId).toBe(42);
    expect(await bcryptjs.compare('Brand-New-Secret97!', newHash)).toBe(true);

    // History row recorded with the same hash.
    const histInsert = calls.find(([sql]) => /INSERT INTO user_password_history/.test(sql));
    expect(histInsert).toBeTruthy();
    expect(histInsert[1]).toEqual([42, newHash]);

    // Blanket invalidation: every outstanding token for the user is consumed.
    const tokenSweep = calls.find(([sql]) => /UPDATE password_reset_tokens SET used_at = NOW\(\) WHERE user_id = \$1 AND used_at IS NULL/.test(sql));
    expect(tokenSweep).toBeTruthy();
    expect(tokenSweep[1]).toEqual([42]);

    // Audit trail.
    const auditCall = audit.fromReq.mock.calls.find(([, f]) => f.event === 'password.reset' && f.success === true);
    expect(auditCall).toBeTruthy();
    expect(auditCall[1].actorUserId).toBe(42);
  });

  test('unknown token → 400 RESET_TOKEN_INVALID', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp())
      .post('/security/password-reset/confirm')
      .set('X-Forwarded-For', nextIp())
      .send({ token: RAW_TOKEN, password: 'Brand-New-Secret97!' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('RESET_TOKEN_INVALID');
  });

  test('expired token → 400 RESET_TOKEN_EXPIRED, nothing written', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [tokenRow({ expires_at: new Date(Date.now() - 60 * 1000).toISOString() })],
    });
    const res = await request(buildApp())
      .post('/security/password-reset/confirm')
      .set('X-Forwarded-For', nextIp())
      .send({ token: RAW_TOKEN, password: 'Brand-New-Secret97!' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('RESET_TOKEN_EXPIRED');
    expect(mockPool.query).toHaveBeenCalledTimes(1); // lookup only
  });

  test('already-used token → 400 RESET_TOKEN_USED, nothing written', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [tokenRow({ used_at: new Date().toISOString() })],
    });
    const res = await request(buildApp())
      .post('/security/password-reset/confirm')
      .set('X-Forwarded-For', nextIp())
      .send({ token: RAW_TOKEN, password: 'Brand-New-Secret97!' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('RESET_TOKEN_USED');
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  test('weak password rejected by the sync policy → 400, no hash written', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [tokenRow()] }); // token lookup
    mockPool.query.mockResolvedValueOnce({ rows: [] });           // history
    const res = await request(buildApp())
      .post('/security/password-reset/confirm')
      .set('X-Forwarded-For', nextIp())
      .send({ token: RAW_TOKEN, password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 10 characters/);
    expect(mockPool.query).toHaveBeenCalledTimes(2); // no UPDATE/INSERT
  });

  test('recently-used password (history reuse) rejected → 400', async () => {
    const reused = 'Reused-Secret97!ab';
    const oldHash = await bcryptjs.hash(reused, 4);
    mockPool.query.mockResolvedValueOnce({ rows: [tokenRow()] });            // token lookup
    mockPool.query.mockResolvedValueOnce({ rows: [{ password_hash: oldHash }] }); // history
    const res = await request(buildApp())
      .post('/security/password-reset/confirm')
      .set('X-Forwarded-For', nextIp())
      .send({ token: RAW_TOKEN, password: reused });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/used recently/);
    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });

  test('reusing the CURRENT password is rejected (current hash prepended to history)', async () => {
    const current = 'Current-Secret97!x';
    const currentHash = await bcryptjs.hash(current, 4);
    mockPool.query.mockResolvedValueOnce({ rows: [tokenRow({ password_hash: currentHash })] });
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // empty history
    const res = await request(buildApp())
      .post('/security/password-reset/confirm')
      .set('X-Forwarded-For', nextIp())
      .send({ token: RAW_TOKEN, password: current });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/used recently/);
  });
});
