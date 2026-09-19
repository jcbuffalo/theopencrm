// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// POST /api/request-access — the public signup handler.
//
// Covers the P0 fix (2026-09-18 usability review): password signup used to
// insert email_verified=FALSE and never mint an `email_verification_token` or
// send mail, so EMAIL_VERIFICATION_REQUIRED=true deployments (prod) stranded
// every new password signup at first login with nothing to click.
//
// Mocking follows test/auth.test.js: mutate methods on the already-required
// live pool/service singletons rather than vi.mock-ing them, and mock the
// PUBLIC form rate limiter out (vi.mock, BEFORE requiring the route) so ten+
// assertions in this file don't trip its per-IP cap.

vi.mock('../middleware/rateLimits', async () => {
  const actual = await vi.importActual('../middleware/rateLimits');
  return { ...actual, publicFormLimiter: (req, res, next) => next() };
});

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();

const audit = require('../services/audit');
audit.fromReq = vi.fn();

const email = require('../services/email');
email.isConfigured = vi.fn().mockReturnValue(false); // short-circuits notifyAdminsOfNewRequest

const emailVerification = require('../services/emailVerification');
emailVerification.sendVerificationEmail = vi.fn().mockResolvedValue({ sent: true, token: 'tok' });
emailVerification.sendWelcomeEmail = vi.fn().mockResolvedValue({ sent: true });

const express = require('express');
const request = require('supertest');
const accessRequestRoutes = require('../routes/accessRequestRoutes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/request-access', accessRequestRoutes);
  return app;
}

const STRONG_PASSWORD = 'Tx7$mb-vQp9k!';

function body(overrides = {}) {
  return { name: 'Ada Lovelace', email: 'ada@example.com', password: STRONG_PASSWORD, ...overrides };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  mockPool.query.mockReset();
  audit.fromReq.mockClear();
  emailVerification.sendVerificationEmail.mockClear();
  emailVerification.sendWelcomeEmail.mockClear();
});

afterEach(() => {
  process.env.OPEN_SIGNUP = ORIGINAL_ENV.OPEN_SIGNUP;
  process.env.EMAIL_VERIFICATION_REQUIRED = ORIGINAL_ENV.EMAIL_VERIFICATION_REQUIRED;
});

describe('POST /api/request-access — open signup + email verification', () => {
  test('EMAIL_VERIFICATION_REQUIRED=true: mints/sends the verification email and says "check your inbox"', async () => {
    process.env.OPEN_SIGNUP = 'true';
    process.env.EMAIL_VERIFICATION_REQUIRED = 'true';
    mockPool.query
      .mockResolvedValueOnce({ rows: [] })                                     // dup-email check → none
      .mockResolvedValueOnce({ rows: [{ id: 1, email: 'ada@example.com', name: 'Ada Lovelace', status: 'active' }] }) // INSERT users
      .mockResolvedValueOnce({ rows: [{ id: 9 }] })                             // INSERT organizations
      .mockResolvedValueOnce({ rows: [] });                                    // UPDATE users org_id/org_role

    const res = await request(buildApp()).post('/api/request-access').send(body());

    expect(res.status).toBe(202);
    expect(res.body.active).toBe(true);
    expect(res.body.verification_required).toBe(true);
    expect(res.body.message).toMatch(/check your inbox/i);

    // The signup handler calls sendVerificationEmail synchronously (its
    // result is a fire-and-forget promise, but the call itself happens
    // before the response is sent) with the freshly-created user row.
    expect(emailVerification.sendVerificationEmail).toHaveBeenCalledTimes(1);
    const [calledWith] = emailVerification.sendVerificationEmail.mock.calls[0];
    expect(calledWith.id).toBe(1);
    expect(calledWith.email).toBe('ada@example.com');

    // A welcome email is sent either way.
    expect(emailVerification.sendWelcomeEmail).toHaveBeenCalledTimes(1);
  });

  test('EMAIL_VERIFICATION_REQUIRED unset: no verification email, "sign in now" message', async () => {
    process.env.OPEN_SIGNUP = 'true';
    delete process.env.EMAIL_VERIFICATION_REQUIRED;
    mockPool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 2, email: 'bob@example.com', name: 'Bob', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ id: 10 }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp()).post('/api/request-access').send(body({ name: 'Bob', email: 'bob@example.com' }));

    expect(res.status).toBe(202);
    expect(res.body.active).toBe(true);
    expect(res.body.verification_required).toBe(false);
    expect(res.body.message).toMatch(/sign in now/i);

    expect(emailVerification.sendVerificationEmail).not.toHaveBeenCalled();
    // Welcome email still goes out — the account can sign in immediately.
    expect(emailVerification.sendWelcomeEmail).toHaveBeenCalledTimes(1);
    const [, opts] = emailVerification.sendWelcomeEmail.mock.calls[0];
    expect(opts.pendingApproval).toBe(false);
  });

  test('OPEN_SIGNUP unset: pending_approval — no verification email even if the flag is on', async () => {
    delete process.env.OPEN_SIGNUP;
    process.env.EMAIL_VERIFICATION_REQUIRED = 'true';
    mockPool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 3, email: 'carol@example.com', name: 'Carol', status: 'pending_approval' }] })
      .mockResolvedValueOnce({ rows: [{ id: 11 }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp()).post('/api/request-access').send(body({ name: 'Carol', email: 'carol@example.com' }));

    expect(res.status).toBe(202);
    expect(res.body.pending).toBe(true);
    expect(res.body.active).toBeUndefined();
    // pending_approval accounts can't sign in yet regardless of the
    // verification flag — nothing to click yet either.
    expect(emailVerification.sendVerificationEmail).not.toHaveBeenCalled();
    expect(emailVerification.sendWelcomeEmail).toHaveBeenCalledTimes(1);
    const [, opts] = emailVerification.sendWelcomeEmail.mock.calls[0];
    expect(opts.pendingApproval).toBe(true);
  });

  test('duplicate email returns the generic response and never touches email services', async () => {
    process.env.OPEN_SIGNUP = 'true';
    process.env.EMAIL_VERIFICATION_REQUIRED = 'true';
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1, status: 'active' }] }); // dup-email check → hit

    const res = await request(buildApp()).post('/api/request-access').send(body());

    expect(res.status).toBe(202);
    expect(res.body.verification_required).toBe(true); // same generic response shape either way
    expect(emailVerification.sendVerificationEmail).not.toHaveBeenCalled();
    expect(emailVerification.sendWelcomeEmail).not.toHaveBeenCalled();
    expect(mockPool.query).toHaveBeenCalledTimes(1); // no INSERT
  });

  test('weak password is rejected before any DB work', async () => {
    const res = await request(buildApp()).post('/api/request-access').send(body({ password: 'short' }));
    expect(res.status).toBe(400);
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(emailVerification.sendVerificationEmail).not.toHaveBeenCalled();
  });
});
