// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// services/emailVerification.js — the shared helper behind both the signup
// handler (routes/accessRequestRoutes.js) and the unauthenticated resend
// endpoint (routes/authRoutes.js POST /auth/resend-verification).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();

const email = require('../services/email');

const emailVerification = require('../services/emailVerification');

beforeEach(() => {
  mockPool.query.mockReset();
  vi.restoreAllMocks();
});

describe('sendVerificationEmail', () => {
  test('mints a token, persists it, and emails a verify link when configured', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE users SET email_verification_token...
    vi.spyOn(email, 'isConfigured').mockReturnValue(true);
    const sendMail = vi.spyOn(email, 'sendMail').mockResolvedValue({ ok: true, kind: 'sendgrid' });

    const result = await emailVerification.sendVerificationEmail({ id: 42, email: 'ada@example.com', name: 'Ada' });

    expect(result.sent).toBe(true);
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);

    // Token minted + persisted.
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('email_verification_token');
    expect(sql).toContain('email_verification_expires');
    expect(params[0]).toBe(result.token);
    expect(params[1]).toBe(42);

    // Mail sent with a link carrying that same token.
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mailArgs = sendMail.mock.calls[0][0];
    expect(mailArgs.to).toBe('ada@example.com');
    expect(mailArgs.html).toContain(result.token);
    expect(mailArgs.text).toContain(result.token);
  });

  test('still mints/persists the token when email is not configured, but does not send', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    vi.spyOn(email, 'isConfigured').mockReturnValue(false);
    const sendMail = vi.spyOn(email, 'sendMail');

    const result = await emailVerification.sendVerificationEmail({ id: 7, email: 'bob@example.com', name: 'Bob' });

    expect(result.sent).toBe(false);
    expect(result.token).toBeTruthy();
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('a real transport failure is caught and reported, not thrown', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    vi.spyOn(email, 'isConfigured').mockReturnValue(true);
    vi.spyOn(email, 'sendMail').mockRejectedValue(new Error('SMTP 421'));

    const result = await emailVerification.sendVerificationEmail({ id: 8, email: 'carol@example.com', name: 'Carol' });

    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/SMTP 421/);
  });
});

describe('sendWelcomeEmail', () => {
  test('no-ops when email is not configured', async () => {
    vi.spyOn(email, 'isConfigured').mockReturnValue(false);
    const sendMail = vi.spyOn(email, 'sendMail');
    const result = await emailVerification.sendWelcomeEmail({ id: 1, email: 'x@example.com', name: 'X' });
    expect(result.sent).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('active account gets a sign-in link', async () => {
    vi.spyOn(email, 'isConfigured').mockReturnValue(true);
    const sendMail = vi.spyOn(email, 'sendMail').mockResolvedValue({ ok: true, kind: 'gmail' });
    const result = await emailVerification.sendWelcomeEmail({ id: 1, email: 'x@example.com', name: 'Xavier' }, { pendingApproval: false });
    expect(result.sent).toBe(true);
    const mailArgs = sendMail.mock.calls[0][0];
    expect(mailArgs.text).toMatch(/\/login/);
    expect(mailArgs.text).not.toMatch(/admin will review/i);
  });

  test('pending-approval account is told to wait, no sign-in link push', async () => {
    vi.spyOn(email, 'isConfigured').mockReturnValue(true);
    const sendMail = vi.spyOn(email, 'sendMail').mockResolvedValue({ ok: true, kind: 'gmail' });
    const result = await emailVerification.sendWelcomeEmail({ id: 2, email: 'y@example.com', name: 'Yara' }, { pendingApproval: true });
    expect(result.sent).toBe(true);
    const mailArgs = sendMail.mock.calls[0][0];
    expect(mailArgs.text).toMatch(/admin will review/i);
  });
});
