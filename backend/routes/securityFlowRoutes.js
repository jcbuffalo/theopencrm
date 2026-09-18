// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Security flows: email verification + TOTP two-factor auth + password reset.
//
// These endpoints are wired into the app but not enforced by default — set
// EMAIL_VERIFICATION_REQUIRED=true to gate login on verified email, or
// TWO_FACTOR_REQUIRED=true to require 2FA. Each user can opt-in to 2FA from
// /admin/security regardless of the global flag.
//
// LIBRARIES: speakeasy + qrcode are listed in package.json. They are loaded
// lazily here so the server still boots if for some reason they fail to
// install — you'll just get a clear "2FA library not available" error.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { authMiddleware, hashPassword, validatePasswordAsync } = require('../auth');
const pool = require('../db');
const email = require('../services/email');
const audit = require('../services/audit');
const logger = require('../services/logger');
const { passwordResetRequestLimiter, passwordResetConfirmLimiter } = require('../middleware/rateLimits');

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://app.theopencrm.com';
const PRODUCT_NAME = process.env.PRODUCT_NAME || 'The Open CRM';

let speakeasy = null;
let qrcode = null;
try { speakeasy = require('speakeasy'); } catch { /* optional */ }
try { qrcode = require('qrcode'); } catch { /* optional */ }

// ---------------------------------------------------------------------------
// EMAIL VERIFICATION
// ---------------------------------------------------------------------------

router.post('/email/send-verification', authMiddleware, async (req, res) => {
  try {
    const u = await pool.query('SELECT id, email, name, email_verified FROM users WHERE id = $1', [req.userId]);
    if (u.rows.length === 0) return res.status(404).json({ success: false, error: 'User not found' });
    if (u.rows[0].email_verified) return res.json({ success: true, alreadyVerified: true });

    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `UPDATE users SET email_verification_token = $1, email_verification_expires = NOW() + INTERVAL '24 hours', updated_at = NOW() WHERE id = $2`,
      [token, req.userId]
    );

    if (email.isConfigured()) {
      const verifyUrl = `${PUBLIC_BASE_URL}/verify-email?token=${token}`;
      await email.sendMail({
        to: u.rows[0].email,
        subject: 'Verify your email — The Open CRM',
        html: `<p>Hi ${u.rows[0].name || ''},</p><p>Click the link below to confirm your email:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 24 hours.</p>`,
      });
      audit.fromReq(req, { event: 'email.verification.sent' });
      return res.json({ success: true, sent: true });
    }
    audit.fromReq(req, { event: 'email.verification.queued', meta: { reason: 'smtp_not_configured' } });
    res.json({ success: true, sent: false, transport: 'console', note: 'SMTP not configured. Token recorded but no email sent.' });
  } catch (err) {
    logger.error('email_verification_send_failed', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to send verification' });
  }
});

router.post('/email/verify', async (req, res) => {
  // Public endpoint — token from email is enough.
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ success: false, error: 'token required' });
  try {
    const r = await pool.query(
      `UPDATE users SET email_verified = TRUE, email_verification_token = NULL, email_verification_expires = NULL, updated_at = NOW()
       WHERE email_verification_token = $1 AND email_verification_expires > NOW()
       RETURNING id, email`,
      [token]
    );
    if (r.rows.length === 0) return res.status(400).json({ success: false, error: 'Invalid or expired token' });
    audit.fromReq(req, { event: 'email.verified', actorUserId: r.rows[0].id, meta: { email: r.rows[0].email } });
    res.json({ success: true });
  } catch (err) {
    logger.error('email_verification_failed', { error: err.message });
    res.status(500).json({ success: false, error: 'Verification failed' });
  }
});

// ---------------------------------------------------------------------------
// PASSWORD RESET (forgot-password flow)
// ---------------------------------------------------------------------------
// Both endpoints are PUBLIC (the caller has no session — they forgot their
// password) and CSRF-exempt (listed in csrfIgnoredRoutes in index.js, same as
// /email/verify: pre-session POSTs can't carry a CSRF token). Each carries a
// strict per-IP limiter from middleware/rateLimits.js, plus a per-ACCOUNT
// throttle on /request so rotating IPs can't bomb one inbox.
//
// TOKEN HYGIENE: unlike the email-verification token (stored plaintext on the
// users row — a pre-existing pattern), reset tokens are stored as SHA-256
// hashes in password_reset_tokens (migration 163). The raw token only exists
// in the emailed link; a DB leak exposes nothing usable.

const RESET_TOKEN_TTL_MINUTES = 30;
// Max token mints per account per 15 minutes (second rail behind the per-IP
// limiter — see passwordResetRequestLimiter in middleware/rateLimits.js).
const RESET_MAX_PER_ACCOUNT_WINDOW = 3;

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// The ONLY response /request ever returns for a well-formed body — identical
// for existing, missing, throttled, and Google-only accounts, so the API
// can't be used to enumerate who has an account.
const GENERIC_RESET_RESPONSE = Object.freeze({
  success: true,
  message: 'If that email has an account, a reset link is on the way.',
});

router.post('/password-reset/request', passwordResetRequestLimiter, async (req, res) => {
  const rawEmail = req.body?.email;
  if (!rawEmail || typeof rawEmail !== 'string' || !rawEmail.includes('@')) {
    return res.status(400).json({ success: false, error: 'email required' });
  }
  const targetEmail = rawEmail.trim();

  try {
    const u = await pool.query(
      'SELECT id, email, name, password_hash, status FROM users WHERE email = $1',
      [targetEmail]
    );
    const user = u.rows[0];

    // Unknown email, or an account that isn't active (pending / suspended /
    // deleted): say nothing distinguishable, mint nothing.
    if (!user || (user.status && user.status !== 'active')) {
      audit.fromReq(req, { event: 'password.reset.requested', success: false, meta: { reason: 'no_active_account' } });
      return res.json(GENERIC_RESET_RESPONSE);
    }

    // Google-only account (no password hash): a reset link would dead-end at
    // the confirm step, so email "you sign in with Google" instead — better UX
    // than silence, and the API response stays identical (no enumeration).
    if (!user.password_hash) {
      if (email.isConfigured()) {
        await email.sendMail({
          to: user.email,
          subject: `Your ${PRODUCT_NAME} sign-in`,
          html: `<p>Hi ${user.name || ''},</p>
<p>Someone (hopefully you) asked to reset the password for this email on ${PRODUCT_NAME} — but this account signs in with <strong>Google</strong> and has no password to reset.</p>
<p>Just head to <a href="${PUBLIC_BASE_URL}/login">${PUBLIC_BASE_URL}/login</a> and click <em>Continue with Google</em>.</p>
<p>If you didn't request this, you can safely ignore this email.</p>`,
        });
      }
      audit.fromReq(req, { event: 'password.reset.requested', actorUserId: user.id, success: false, meta: { reason: 'google_only_account' } });
      return res.json(GENERIC_RESET_RESPONSE);
    }

    // Per-account throttle: rotating IPs must not let an attacker bomb one
    // inbox. Counts mints, not deliveries, so it also bounds token churn.
    const recent = await pool.query(
      `SELECT COUNT(*)::int AS n FROM password_reset_tokens
        WHERE user_id = $1 AND created_at > NOW() - INTERVAL '15 minutes'`,
      [user.id]
    );
    if (recent.rows[0].n >= RESET_MAX_PER_ACCOUNT_WINDOW) {
      audit.fromReq(req, { event: 'password.reset.requested', actorUserId: user.id, success: false, meta: { reason: 'account_throttled' } });
      return res.json(GENERIC_RESET_RESPONSE);
    }

    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip)
       VALUES ($1, $2, NOW() + INTERVAL '${RESET_TOKEN_TTL_MINUTES} minutes', $3)`,
      [user.id, sha256Hex(token), req.ip || null]
    );

    if (email.isConfigured()) {
      const resetUrl = `${PUBLIC_BASE_URL}/reset-password?token=${token}`;
      await email.sendMail({
        to: user.email,
        subject: `Reset your password — ${PRODUCT_NAME}`,
        html: `<p>Hi ${user.name || ''},</p>
<p>Someone (hopefully you) asked to reset your ${PRODUCT_NAME} password. Click the link below to choose a new one:</p>
<p><a href="${resetUrl}">${resetUrl}</a></p>
<p>This link expires in ${RESET_TOKEN_TTL_MINUTES} minutes and can be used once.</p>
<p>If you didn't request this, you can safely ignore this email — your password is unchanged.</p>`,
      });
      audit.fromReq(req, { event: 'password.reset.requested', actorUserId: user.id, meta: { sent: true } });
    } else {
      // Token is minted but undeliverable — log loudly for the operator; the
      // caller still gets the generic response (no enumeration, no config leak).
      logger.warn('password_reset_email_not_configured', { userId: user.id });
      audit.fromReq(req, { event: 'password.reset.requested', actorUserId: user.id, meta: { sent: false, reason: 'smtp_not_configured' } });
    }

    res.json(GENERIC_RESET_RESPONSE);
  } catch (err) {
    logger.error('password_reset_request_failed', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to process reset request' });
  }
});

router.post('/password-reset/confirm', passwordResetConfirmLimiter, async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ success: false, error: 'token required' });
  }
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ success: false, error: 'password required' });
  }

  try {
    const r = await pool.query(
      `SELECT prt.id, prt.user_id, prt.expires_at, prt.used_at, u.password_hash, u.email
         FROM password_reset_tokens prt
         JOIN users u ON u.id = prt.user_id
        WHERE prt.token_hash = $1`,
      [sha256Hex(token)]
    );
    const row = r.rows[0];
    if (!row) {
      audit.fromReq(req, { event: 'password.reset', success: false, meta: { reason: 'token_unknown' } });
      return res.status(400).json({ success: false, error: 'That reset link is invalid. Request a new one.', code: 'RESET_TOKEN_INVALID' });
    }
    if (row.used_at) {
      audit.fromReq(req, { event: 'password.reset', success: false, actorUserId: row.user_id, meta: { reason: 'token_used' } });
      return res.status(400).json({ success: false, error: 'That reset link has already been used. Request a new one.', code: 'RESET_TOKEN_USED' });
    }
    if (new Date(row.expires_at) <= new Date()) {
      audit.fromReq(req, { event: 'password.reset', success: false, actorUserId: row.user_id, meta: { reason: 'token_expired' } });
      return res.status(400).json({ success: false, error: 'That reset link has expired. Request a new one.', code: 'RESET_TOKEN_EXPIRED' });
    }

    // Full new-password policy: sync policy (length / classes / blocklist),
    // then no-reuse against the current hash + last 5 history rows, then HIBP
    // if enabled — the exact stack /api/me/change-password runs.
    const histRes = await pool.query(
      `SELECT password_hash FROM user_password_history
        WHERE user_id = $1 ORDER BY set_at DESC LIMIT 5`,
      [row.user_id]
    );
    const recentHashes = [row.password_hash, ...histRes.rows.map(h => h.password_hash)].filter(Boolean);
    const pw = await validatePasswordAsync(password, { recentHashes });
    if (!pw.ok) {
      audit.fromReq(req, { event: 'password.reset', success: false, actorUserId: row.user_id, meta: { reason: 'policy_or_reuse_or_hibp' } });
      return res.status(400).json({ success: false, error: pw.error });
    }

    const newHash = await hashPassword(password);
    await pool.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [newHash, row.user_id]
    );
    // Record the new hash so it can't be reused on the next change/reset.
    await pool.query(
      `INSERT INTO user_password_history (user_id, password_hash) VALUES ($1, $2)`,
      [row.user_id, newHash]
    );
    // Single-use: consume THIS token and invalidate every other outstanding
    // reset token for the user in one sweep — a second emailed link must not
    // stay live after the password has already been rotated.
    await pool.query(
      `UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`,
      [row.user_id]
    );

    audit.fromReq(req, { event: 'password.reset', actorUserId: row.user_id, success: true });

    // Deliberately NO auto-login: the caller proved inbox control, not
    // identity — they still walk through /login (and 2FA, if enrolled).
    res.json({ success: true, message: 'Password updated. You can now sign in.' });
  } catch (err) {
    logger.error('password_reset_confirm_failed', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to reset password' });
  }
});

// ---------------------------------------------------------------------------
// TWO-FACTOR (TOTP)
// ---------------------------------------------------------------------------

router.get('/2fa/status', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT two_factor_enabled FROM users WHERE id = $1', [req.userId]);
    res.json({
      success: true,
      enabled: !!r.rows[0]?.two_factor_enabled,
      libraryAvailable: !!speakeasy && !!qrcode,
    });
  } catch (err) {
    logger.error('2fa_status_failed', { error: err.message });
    res.status(500).json({ success: false, error: '2FA status check failed' });
  }
});

router.post('/2fa/enroll', authMiddleware, async (req, res) => {
  if (!speakeasy || !qrcode) {
    return res.status(503).json({ success: false, error: '2FA library not installed on this server (speakeasy + qrcode required).' });
  }
  try {
    const u = await pool.query('SELECT email FROM users WHERE id = $1', [req.userId]);
    if (u.rows.length === 0) return res.status(404).json({ success: false, error: 'User not found' });

    const secret = speakeasy.generateSecret({
      name: `The Open CRM (${u.rows[0].email})`,
      issuer: 'The Open CRM',
      length: 20,
    });
    await pool.query(
      `UPDATE users SET two_factor_secret = $1, updated_at = NOW() WHERE id = $2`,
      [secret.base32, req.userId]
    );
    const otpauthUrl = secret.otpauth_url;
    const dataUrl = await qrcode.toDataURL(otpauthUrl);
    audit.fromReq(req, { event: '2fa.enroll_started' });
    res.json({ success: true, secret: secret.base32, otpauthUrl, qrDataUrl: dataUrl });
  } catch (err) {
    logger.error('2fa_enroll_failed', { error: err.message });
    res.status(500).json({ success: false, error: '2FA enrollment failed' });
  }
});

router.post('/2fa/verify-enroll', authMiddleware, async (req, res) => {
  if (!speakeasy) return res.status(503).json({ success: false, error: '2FA library not installed' });
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ success: false, error: 'code required' });
  try {
    const u = await pool.query('SELECT two_factor_secret FROM users WHERE id = $1', [req.userId]);
    if (!u.rows[0]?.two_factor_secret) return res.status(400).json({ success: false, error: 'No enrollment in progress' });

    const ok = speakeasy.totp.verify({
      secret: u.rows[0].two_factor_secret, encoding: 'base32',
      token: String(code).trim(), window: 1,
    });
    if (!ok) return res.status(400).json({ success: false, error: 'Invalid code' });

    // Generate 8 recovery codes (single-use; user is told to save them).
    const recovery = Array.from({ length: 8 }, () => crypto.randomBytes(4).toString('hex'));
    await pool.query(
      `UPDATE users SET two_factor_enabled = TRUE, two_factor_recovery_codes = $1, updated_at = NOW() WHERE id = $2`,
      [recovery, req.userId]
    );
    audit.fromReq(req, { event: '2fa.enabled' });
    res.json({ success: true, recoveryCodes: recovery });
  } catch (err) {
    logger.error('2fa_verify_enroll_failed', { error: err.message });
    res.status(500).json({ success: false, error: '2FA verification failed' });
  }
});

router.post('/2fa/disable', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      `UPDATE users SET two_factor_enabled = FALSE, two_factor_secret = NULL, two_factor_recovery_codes = NULL, updated_at = NOW() WHERE id = $1`,
      [req.userId]
    );
    audit.fromReq(req, { event: '2fa.disabled' });
    res.json({ success: true });
  } catch (err) {
    logger.error('2fa_disable_failed', { error: err.message });
    res.status(500).json({ success: false, error: '2FA disable failed' });
  }
});

module.exports = router;
