// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

/**
 * Authentication Routes
 * User registration, login, Google OAuth, JWT management
 *
 * LOGIN_MODE environment variable:
 * - 'google' (default): Only Google OAuth
 * - 'email'           : Only email/password
 * - 'test'            : Only test users (development)
 * - 'both'            : Google OAuth + email/password + test users
 */

const express = require('express');
const router = express.Router();
const bcryptjs = require('bcryptjs');
const speakeasy = (() => { try { return require('speakeasy'); } catch { return null; } })();
const { OAuth2Client } = require('google-auth-library');
const {
  generateToken,
  authMiddleware,
  validatePassword,
  generate2faTempToken,
  verify2faTempToken,
  AUTH_COOKIE_NAME,
  authCookieOptions,
} = require('../auth');
const pool = require('../db');
const audit = require('../services/audit');
const adminNotify = require('../services/adminNotify');
const { ensureSuperAdmin, initialStatusFor, isSeedAdmin, ensureOrgProfile } = require('../services/bootstrapAdmin');
const featureFlags = require('../services/featureFlags');
// Per-org pipeline stages (migration 155) — served on /auth/me as org_pipeline.
const pipelines = require('../services/pipelines');
const { orgHasCustomers } = require('../services/orgHasCustomers');
const { createSelfServeOrg } = require('../services/selfServeOrg');

// ---------------------------------------------------------------------------
// Session-issuing helper. Centralized so /login, /google-signin, /register,
// and /2fa/verify all set the auth cookie + emit the CSRF token identically.
// ---------------------------------------------------------------------------
function issueSession(req, res, user, extras = {}) {
  const token = generateToken(user.id);
  res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions());
  // generateCsrfToken is wired in index.js (app.locals.generateCsrfToken).
  // Falls back to null in unit-test contexts where the CSRF middleware isn't
  // mounted — callers receiving null should re-fetch via /auth/me.
  let csrfToken = null;
  try {
    if (typeof req.app.locals.generateCsrfToken === 'function') {
      csrfToken = req.app.locals.generateCsrfToken(req, res);
    }
  } catch { /* don't fail login if csrf issuance hiccups */ }
  return { csrfToken, ...extras };
}

// Helper — does this user need to ENROLL in 2FA before continuing? Today we
// only force-enroll users with the admin_users.role flag. Future: per-org
// policy ("all users must enable 2FA").
async function adminRequires2faEnrollment(userId) {
  try {
    const r = await pool.query(
      `SELECT u.two_factor_enabled, au.role AS admin_role
         FROM users u
         LEFT JOIN admin_users au ON au.user_id = u.id
        WHERE u.id = $1`,
      [userId]
    );
    if (r.rows.length === 0) return false;
    const row = r.rows[0];
    return !!row.admin_role && !row.two_factor_enabled;
  } catch {
    return false;
  }
}

// Load test auth routes if enabled
const testAuthRoutes = require('./testAuthRoutes');
const LOGIN_MODE = process.env.LOGIN_MODE || 'google';

// Initialize Google OAuth Client
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
if (!GOOGLE_CLIENT_ID) {
  console.warn('⚠️  WARNING: GOOGLE_CLIENT_ID not set, Google OAuth will not work');
}
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /auth/register
 * Register a new user with email and password
 */
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, error: 'name, email, and password are required' });
    }

    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email format' });
    }

    const pw = validatePassword(password);
    if (!pw.ok) {
      return res.status(400).json({ success: false, error: pw.error });
    }

    // Check if user already exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'User already exists' });
    }

    // Hash password
    const salt = await bcryptjs.genSalt(10);
    const passwordHash = await bcryptjs.hash(password, salt);

    // Self-registration is gated by admin approval unless the email is on the
    // seed-admin allowlist. Pending users can authenticate (their JWT works for
    // /auth/me) but the login endpoint itself blocks them with a 403.
    const initialStatus = initialStatusFor(email);

    const result = await pool.query(
      `INSERT INTO users (email, name, password_hash, status, requested_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())
       RETURNING id, email, name, status`,
      [email, name, passwordHash, initialStatus]
    );

    const newUser = result.rows[0];

    // Auto-create personal workspace org for everyone (also for pending users —
    // when they're approved they'll already have a workspace). Commercial
    // defaults (free-tier caps, AI trial) live in services/selfServeOrg.js.
    const newOrg = await createSelfServeOrg(pool, {
      name: `${newUser.name || newUser.email}'s Workspace`,
      ownerUserId: newUser.id,
      onConflictDoNothing: true,
    });
    if (newOrg) {
      await pool.query('UPDATE users SET org_id = $1, org_role = $2 WHERE id = $3', [newOrg.id, 'owner', newUser.id]);
    }

    // Lazy super-admin bootstrap — first time a seed admin registers.
    await ensureSuperAdmin(newUser.id, newUser.email);
    await ensureOrgProfile(newUser.id, newUser.email);

    audit.fromReq(req, {
      event: audit.EVENTS.AUTH_REGISTER,
      actorUserId: newUser.id,
      meta: { email: newUser.email, status: newUser.status },
    });

    // Fire-and-forget admin notification. Never blocks the response.
    adminNotify.send({
      event: 'signup',
      subject: `[The Open CRM] New signup: ${newUser.name} <${newUser.email}>`,
      html: `<p>A new account has been created on The Open CRM.</p>
             <ul>
               <li><b>Name:</b> ${newUser.name}</li>
               <li><b>Email:</b> ${newUser.email}</li>
               <li><b>Status:</b> ${newUser.status}</li>
             </ul>
             <p>Review the admin dashboard:
             <a href="https://app.theopencrm.com/admin/access-requests">app.theopencrm.com/admin/access-requests</a></p>`,
      text: `New signup: ${newUser.name} <${newUser.email}> — status ${newUser.status}`,
      throttleKey: `signup:${newUser.email}`,
      meta: { userId: newUser.id },
    }).catch(err => {
      if (req.log) req.log.warn('admin_notify_signup_failed', { error: err.message });
    });

    if (newUser.status === 'pending_approval') {
      // Don't issue a token — they can't use the app yet. Frontend should show
      // the pending-approval page.
      return res.status(202).json({
        success: true,
        pending: true,
        message: 'Your account has been created and is awaiting admin approval. You will receive an email when access is granted.',
        user: { id: newUser.id, email: newUser.email, name: newUser.name, status: newUser.status },
      });
    }

    const sessionExtras = issueSession(req, res, newUser);

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      ...sessionExtras,
      user: { id: newUser.id, email: newUser.email, name: newUser.name, status: newUser.status },
    });
  } catch (error) {
    if (req.log) req.log.error('register_failed', { error });
    res.status(500).json({ success: false, error: 'Registration failed', requestId: req.requestId });
  }
});

/**
 * POST /auth/login
 * Login with email and password
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'email and password are required' });
    }

    const result = await pool.query(
      'SELECT id, email, name, password_hash, status, two_factor_enabled, email_verified FROM users WHERE email = $1',
      [email]
    );

    const user = result.rows[0];

    if (!user || !user.password_hash) {
      audit.fromReq(req, { event: audit.EVENTS.AUTH_LOGIN_FAIL, success: false, meta: { email, reason: 'unknown_user_or_no_password' } });
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const passwordValid = await bcryptjs.compare(password, user.password_hash);

    if (!passwordValid) {
      audit.fromReq(req, { event: audit.EVENTS.AUTH_LOGIN_FAIL, success: false, actorUserId: user.id, meta: { email, reason: 'bad_password' } });
      // Only notify when we *cross* the failed-login threshold so we don't
      // spam on every subsequent failure during a brute-force.
      try {
        const fire = await adminNotify.shouldFireFailedLoginThreshold({ email, ip: req.ip, threshold: 5, windowMinutes: 15 });
        if (fire) {
          adminNotify.send({
            event: 'login_failed_threshold',
            subject: `[The Open CRM] 5+ failed login attempts on ${email}`,
            html: `<p>Five or more failed login attempts have occurred for
                   <b>${email}</b> in the last 15 minutes (IP: ${req.ip || 'unknown'}).</p>
                   <p>If this wasn't expected, consider suspending the account
                   or blocking the IP at the load balancer.</p>`,
            text: `5+ failed logins on ${email} in 15min from ${req.ip || 'unknown'}.`,
            throttleKey: `login_failed:${email}:${req.ip || 'na'}`,
            meta: { email, ip: req.ip },
          }).catch(() => {});
        }
      } catch { /* never block the response */ }
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    // Status gate — block pending/rejected/suspended accounts before issuing a token.
    if (user.status === 'pending_approval') {
      audit.fromReq(req, { event: audit.EVENTS.AUTH_LOGIN_FAIL, success: false, actorUserId: user.id, meta: { email, reason: 'pending_approval' } });
      return res.status(403).json({
        success: false, pending: true,
        error: 'Your account is awaiting admin approval. You will receive an email when access is granted.',
      });
    }
    if (user.status === 'rejected') {
      audit.fromReq(req, { event: audit.EVENTS.AUTH_LOGIN_FAIL, success: false, actorUserId: user.id, meta: { email, reason: 'rejected' } });
      return res.status(403).json({ success: false, error: 'Your access request was not approved.' });
    }
    if (user.status === 'suspended') {
      audit.fromReq(req, { event: audit.EVENTS.AUTH_LOGIN_FAIL, success: false, actorUserId: user.id, meta: { email, reason: 'suspended' } });
      return res.status(403).json({ success: false, error: 'Your account is suspended. Contact support.' });
    }

    // Email verification gate: when EMAIL_VERIFICATION_REQUIRED=true the user
    // must have email_verified=TRUE before we issue a session. Migration 078
    // grandfathered every pre-existing user; new password signups are FALSE
    // until they hit /api/security/email/verify with their token.
    if (process.env.EMAIL_VERIFICATION_REQUIRED === 'true' && !user.email_verified) {
      audit.fromReq(req, { event: audit.EVENTS.AUTH_LOGIN_FAIL, success: false, actorUserId: user.id, meta: { email, reason: 'email_not_verified' } });
      return res.status(403).json({
        success: false,
        error: 'Please verify your email address before signing in. Check your inbox for the verification link, or click "Resend verification" below.',
        code: 'EMAIL_NOT_VERIFIED',
        email: user.email,
      });
    }

    // Lazy seed-admin promotion if the email is on the allowlist.
    await ensureSuperAdmin(user.id, user.email);
    await ensureOrgProfile(user.id, user.email);

    // 2FA challenge: password is verified, but if the user has 2FA enabled we
    // do NOT issue the session cookie yet. Instead, mint a short-lived
    // tempToken bound to audience '2fa-pending' and require the user to POST
    // /auth/2fa/verify with their 6-digit code.
    if (user.two_factor_enabled) {
      const tempToken = generate2faTempToken(user.id);
      audit.fromReq(req, { event: audit.EVENTS.LOGIN_2FA_CHALLENGE, actorUserId: user.id, meta: { email, method: 'password' } });
      return res.json({
        success: true,
        requires2fa: true,
        tempToken,
        // Surface enough user info for the UI to confirm "you're signing in as <email>"
        // on the code-entry screen, but NOT the org/role yet — that requires a real session.
        user: { id: user.id, email: user.email, name: user.name },
      });
    }

    // Admin without 2FA → force enrollment. Issue the session (admin still
    // needs to use the app to enroll), but mark the response so the frontend
    // immediately routes them to /security with a banner.
    const requires2faEnrollment = await adminRequires2faEnrollment(user.id);

    const sessionExtras = issueSession(req, res, user);
    audit.fromReq(req, { event: audit.EVENTS.AUTH_LOGIN_SUCCESS, actorUserId: user.id, meta: { email } });

    res.json({
      success: true,
      message: 'Login successful',
      ...sessionExtras,
      requires_2fa_enrollment: requires2faEnrollment,
      user: { id: user.id, email: user.email, name: user.name, status: user.status },
    });
  } catch (error) {
    if (req.log) req.log.error('login_failed', { error });
    res.status(500).json({ success: false, error: 'Login failed', requestId: req.requestId });
  }
});

/**
 * POST /auth/google-signin
 * Google OAuth signin / signup
 */
router.post('/google-signin', async (req, res) => {
  try {
    if (!googleClient) {
      // Return 503 (Service Unavailable) rather than 500 — this is configuration,
      // not a runtime crash. Frontend can show a clearer message.
      return res.status(503).json({
        success: false,
        error: 'Google sign-in is not configured on this server',
        code: 'GOOGLE_OAUTH_NOT_CONFIGURED',
        hint: 'Operator: set GOOGLE_CLIENT_ID env var on the backend',
        requestId: req.requestId,
      });
    }

    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ success: false, error: 'idToken is required', code: 'MISSING_ID_TOKEN' });
    }

    // Verify Google ID token
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: GOOGLE_CLIENT_ID,
      });
      // Defense-in-depth: google-auth-library already checks the issuer, but
      // we re-verify it here so a future SDK regression can't silently accept
      // tokens minted by a non-Google IdP that happens to have our audience.
      const iss = ticket.getPayload()?.iss;
      if (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') {
        throw new Error(`Untrusted issuer: ${iss}`);
      }
      payload = ticket.getPayload();
    } catch (tokenError) {
      if (req.log) req.log.warn('google_token_invalid', { error: tokenError.message });
      return res.status(401).json({
        success: false,
        error: 'Google token verification failed',
        code: 'INVALID_GOOGLE_TOKEN',
        detail: tokenError.message,
        requestId: req.requestId,
      });
    }

    // Extract user info from Google payload
    const googleEmail = payload.email;
    const googleName = payload.name || payload.email.split('@')[0];
    const googlePicture = payload.picture;

    let userResult = await pool.query(
      'SELECT id, email, name, status, two_factor_enabled FROM users WHERE email = $1',
      [googleEmail]
    );

    let user = userResult.rows[0];

    if (!user) {
      // First-time Google sign-in. Seed admins go straight to active; everyone
      // else lands in pending_approval and must be reviewed by an admin.
      // email_verified=TRUE because Google has already verified the email
      // belongs to this user — no need for the separate verification round.
      const initialStatus = initialStatusFor(googleEmail);
      const createResult = await pool.query(
        `INSERT INTO users (email, name, password_hash, status, email_verified, requested_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, TRUE, NOW(), NOW(), NOW())
         RETURNING id, email, name, status, two_factor_enabled`,
        [googleEmail, googleName, null, initialStatus]
      );
      user = createResult.rows[0];

      const newOrg = await createSelfServeOrg(pool, { name: `${googleName}'s Workspace`, ownerUserId: user.id });
      if (newOrg) {
        await pool.query('UPDATE users SET org_id = $1, org_role = $2 WHERE id = $3', [newOrg.id, 'owner', user.id]);
      }
    }

    await ensureSuperAdmin(user.id, user.email);
    await ensureOrgProfile(user.id, user.email);

    if (user.status === 'pending_approval') {
      audit.fromReq(req, { event: audit.EVENTS.AUTH_LOGIN_FAIL, success: false, actorUserId: user.id, meta: { email: googleEmail, reason: 'pending_approval' } });
      return res.status(403).json({
        success: false, pending: true,
        error: 'Your account is awaiting admin approval. You will receive an email when access is granted.',
      });
    }
    if (user.status === 'rejected') {
      return res.status(403).json({ success: false, error: 'Your access request was not approved.' });
    }
    if (user.status === 'suspended') {
      return res.status(403).json({ success: false, error: 'Your account is suspended. Contact support.' });
    }

    // 2FA challenge after successful Google verification. Same shape as the
    // email/password path so the frontend can branch on `requires2fa` without
    // caring which method triggered it.
    if (user.two_factor_enabled) {
      const tempToken = generate2faTempToken(user.id);
      audit.fromReq(req, { event: audit.EVENTS.LOGIN_2FA_CHALLENGE, actorUserId: user.id, meta: { email: googleEmail, method: 'google' } });
      return res.json({
        success: true,
        requires2fa: true,
        tempToken,
        user: { id: user.id, email: user.email, name: user.name, picture: googlePicture },
      });
    }

    const requires2faEnrollment = await adminRequires2faEnrollment(user.id);
    const sessionExtras = issueSession(req, res, user);

    audit.fromReq(req, { event: audit.EVENTS.AUTH_GOOGLE_SIGNIN, actorUserId: user.id, meta: { email: googleEmail } });

    res.json({
      success: true,
      message: 'Google signin successful',
      ...sessionExtras,
      requires_2fa_enrollment: requires2faEnrollment,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: googlePicture,
      },
    });
  } catch (error) {
    if (req.log) req.log.error('google_signin_failed', { error });
    res.status(500).json({
      success: false,
      error: 'Google signin failed',
      code: 'GOOGLE_SIGNIN_FAILED',
      detail: error.message,
      requestId: req.requestId,
    });
  }
});

/**
 * GET /auth/csrf
 *
 * Mint a fresh CSRF token (and refresh the signed-secret cookie). The
 * frontend AuthContext calls this on mount because the cookie csrf-csrf
 * sets contains a HASHED secret, NOT the raw token the client needs to
 * echo. After a page reload, the in-memory `csrfTokenMemo` is gone and
 * the client needs a way to obtain a fresh raw token without going
 * through a full login.
 *
 * CSRF-exempt by design (no side effects beyond rotating the token).
 */
router.get('/csrf', (req, res) => {
  let csrfToken = null;
  try {
    if (typeof req.app.locals.generateCsrfToken === 'function') {
      csrfToken = req.app.locals.generateCsrfToken(req, res);
    }
  } catch { /* swallow, return null below */ }
  if (!csrfToken) {
    return res.status(503).json({ success: false, error: 'CSRF middleware not available' });
  }
  res.json({ success: true, csrfToken });
});

/**
 * POST /auth/resend-verification
 *
 * Unauthenticated re-send for the email verification token. Used by Login.js
 * when the user hits the EMAIL_NOT_VERIFIED gate and clicks "Resend".
 *
 * We mint a fresh token (24h expiry, same as the original send path) and
 * email it. To avoid email enumeration we ALWAYS return success: true
 * regardless of whether the address exists. If SMTP isn't configured we still
 * stamp the token so an operator can read it out of the DB.
 *
 * Body: { email: string }
 */
router.post('/resend-verification', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, error: 'email required' });
    }
    const emailVerification = require('../services/emailVerification');
    const u = await pool.query(
      'SELECT id, email, name, email_verified FROM users WHERE LOWER(email) = $1',
      [email]
    );
    // Always success-shape to prevent enumeration.
    if (u.rows.length === 0 || u.rows[0].email_verified) {
      return res.json({ success: true });
    }
    const userRow = u.rows[0];
    // Shared with the signup handler (routes/accessRequestRoutes.js) so the
    // token-minting + mail shape can never drift between the two call sites.
    // sendVerificationEmail catches its own send errors internally (only a
    // real DB failure on the mint would throw here), so this stays awaited
    // the same way the original inline mint used to be.
    await emailVerification.sendVerificationEmail(userRow);
    audit.fromReq(req, { event: 'email.verification.resend', actorUserId: userRow.id, meta: { email } });
    res.json({ success: true });
  } catch (err) {
    if (req.log) req.log.error('resend_verification_failed', { error: err });
    // Still success-shape to avoid enumeration.
    res.json({ success: true });
  }
});

/**
 * POST /auth/logout
 * Clears the auth cookie + csrf cookie. Idempotent — works even without a
 * valid session (so a stale tab can self-clean). authMiddleware would 401
 * here if the cookie's already gone, which is the wrong UX, so we don't gate.
 */
router.post('/logout', (req, res) => {
  // Match the attributes of authCookieOptions so the browser actually clears
  // the cookie (path + sameSite + secure all have to align with the set).
  // The csrf cookies are now also sameSite=none in prod (mirror of authCookie
  // for the cross-site Cloud Run topology — fixed in commit 2dc3493). Without
  // matching attributes the browser refuses the clear and the stale cookie
  // hangs around until expiry.
  const opts = authCookieOptions();
  const isProd = process.env.NODE_ENV === 'production';
  const csrfClearOpts = { path: '/', sameSite: isProd ? 'none' : 'lax', secure: isProd };
  res.clearCookie(AUTH_COOKIE_NAME, { path: opts.path, sameSite: opts.sameSite, secure: opts.secure });
  res.clearCookie('csrfToken', csrfClearOpts);
  // csrf-csrf's internal secret cookie. Cleared so the next login starts fresh.
  res.clearCookie('__Host-psifi.x-csrf-token', csrfClearOpts);
  audit.fromReq(req, { event: audit.EVENTS.AUTH_LOGOUT });
  res.json({ success: true, message: 'Logout successful' });
});

/**
 * POST /auth/2fa/verify
 * Completes the login flow when 2FA is enabled. Accepts the short-lived
 * tempToken from the previous /auth/login or /auth/google-signin call, plus
 * the 6-digit TOTP code (or one of the user's 8 recovery codes). On success,
 * issues the real session cookie + CSRF token.
 *
 * No authMiddleware: the tempToken IS the auth for this endpoint. It's
 * audience-scoped to '2fa-pending' so even if someone tried to pass a regular
 * session JWT here, it'd be rejected.
 */
router.post('/2fa/verify', async (req, res) => {
  try {
    const { tempToken, code } = req.body || {};
    if (!tempToken || !code) {
      return res.status(400).json({ success: false, error: 'tempToken and code are required' });
    }

    const decoded = verify2faTempToken(tempToken);
    if (!decoded || !decoded.userId) {
      audit.fromReq(req, { event: audit.EVENTS.LOGIN_2FA_FAIL, success: false, meta: { reason: 'bad_temp_token' } });
      return res.status(401).json({ success: false, error: 'Invalid or expired challenge. Sign in again.' });
    }

    const r = await pool.query(
      `SELECT id, email, name, status, two_factor_secret, two_factor_recovery_codes
         FROM users WHERE id = $1`,
      [decoded.userId]
    );
    const user = r.rows[0];
    if (!user || !user.two_factor_secret) {
      audit.fromReq(req, { event: audit.EVENTS.LOGIN_2FA_FAIL, success: false, actorUserId: decoded.userId, meta: { reason: 'no_2fa_state' } });
      return res.status(401).json({ success: false, error: 'Two-factor not configured for this account.' });
    }

    const trimmed = String(code).trim();
    let verified = false;
    let usedRecovery = false;

    if (speakeasy) {
      verified = speakeasy.totp.verify({
        secret: user.two_factor_secret,
        encoding: 'base32',
        token: trimmed,
        window: 1, // 30s before/after — clock-skew tolerance
      });
    }

    // Recovery-code fallback. Codes are stored as TEXT[] in
    // users.two_factor_recovery_codes (migration 045). Single-use: we splice
    // the matched code out on consumption.
    if (!verified && Array.isArray(user.two_factor_recovery_codes)) {
      const idx = user.two_factor_recovery_codes.indexOf(trimmed);
      if (idx !== -1) {
        const remaining = [...user.two_factor_recovery_codes];
        remaining.splice(idx, 1);
        await pool.query(
          `UPDATE users SET two_factor_recovery_codes = $1, updated_at = NOW() WHERE id = $2`,
          [remaining, user.id]
        );
        verified = true;
        usedRecovery = true;
      }
    }

    if (!verified) {
      audit.fromReq(req, { event: audit.EVENTS.LOGIN_2FA_FAIL, success: false, actorUserId: user.id, meta: { email: user.email, reason: 'bad_code' } });
      return res.status(401).json({ success: false, error: 'Invalid code' });
    }

    // Re-check status — a user could have been suspended between the password
    // step and the 2FA step (5-min window is small but possible).
    if (user.status === 'rejected' || user.status === 'suspended' || user.status === 'pending_approval') {
      return res.status(403).json({ success: false, error: 'Account not active.' });
    }

    const sessionExtras = issueSession(req, res, user);
    audit.fromReq(req, { event: audit.EVENTS.LOGIN_2FA_SUCCESS, actorUserId: user.id, meta: { email: user.email, usedRecovery } });

    res.json({
      success: true,
      message: 'Login successful',
      ...sessionExtras,
      usedRecoveryCode: usedRecovery,
      user: { id: user.id, email: user.email, name: user.name, status: user.status },
    });
  } catch (err) {
    if (req.log) req.log.error('2fa_verify_failed', { error: err.message });
    res.status(500).json({ success: false, error: '2FA verification failed', requestId: req.requestId });
  }
});

// Effective per-org feature map for the nav / capability UI: every KNOWN_FLAG
// resolved to its effective boolean (explicit org setting wins, else the flag's
// registered default) — the same computation hasFeature() and the admin flags
// UI use. Never throws: if the lookup fails we fall back to defaults so /auth/me
// (the session probe) keeps working. The frontend treats a missing map as
// "everything on".
async function effectiveOrgFeatures(orgId) {
  let stored = {};
  try {
    stored = orgId ? (await featureFlags.getFeatures(orgId)) || {} : {};
  } catch {
    stored = {};
  }
  const out = {};
  for (const f of featureFlags.KNOWN_FLAGS) {
    out[f.name] = Object.prototype.hasOwnProperty.call(stored, f.name)
      ? Boolean(stored[f.name])
      : Boolean(f.defaultValue);
  }
  return out;
}

/**
 * GET /auth/me
 * Get current user info
 */
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.name, u.status, u.org_id, u.org_role,
              u.notification_preferences, u.notification_email, u.notification_phone,
              o.profile AS org_profile, o.name AS org_name, o.branding AS org_branding,
              o.tier AS org_tier,
              au.role AS admin_role, au.permissions AS admin_permissions
       FROM users u
       LEFT JOIN organizations o ON o.id = u.org_id
       LEFT JOIN admin_users au ON au.user_id = u.id
       WHERE u.id = $1`,
      [req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const u = result.rows[0];
    const org_features = await effectiveOrgFeatures(u.org_id);
    // The org's effective pipeline (custom stages or profile default,
    // services/pipelines.js) so the Kanban/forms have their stages at boot.
    // null on any failure — the frontend falls back to GET /api/pipelines
    // and then to the profile default. Since spec 201 the org may run
    // MULTIPLE pipelines keyed by deal_type: org_pipelines maps every type
    // that exists ('default' + each type row) to its effective pipeline;
    // org_pipeline stays the default one for back-compat.
    let org_pipeline = null;
    let org_pipelines = null;
    try {
      const profile = u.org_profile || 'generic';
      org_pipeline = await pipelines.getEffectivePipeline(u.org_id, profile);
      org_pipelines = { default: org_pipeline };
      if (u.org_id) {
        for (const p of await pipelines.listPipelines(u.org_id, profile)) {
          if (p.deal_type !== 'default') {
            org_pipelines[p.deal_type] = await pipelines.getEffectivePipeline(u.org_id, profile, { dealType: p.deal_type });
          }
        }
      }
    } catch { org_pipeline = null; org_pipelines = null; }
    // Post-sale nav gating (Wave 3): cached per org in services/orgHasCustomers
    // so the 3-way EXISTS does not run on every /auth/me. null = unknown =
    // the frontend shows everything.
    const org_has_customers = await orgHasCustomers(u.org_id);
    res.json({
      success: true,
      user: {
        id: u.id,
        email: u.email,
        name: u.name,
        status: u.status,
        org_id: u.org_id,
        org_role: u.org_role,
        org_profile: u.org_profile || 'generic',
        org_name: u.org_name,
        org_branding: u.org_branding || {},
        org_tier: u.org_tier || 'free',
        org_features,
        org_pipeline,
        org_pipelines,
        org_has_customers,
        notification_preferences: u.notification_preferences || {},
        notification_email: u.notification_email || null,
        notification_phone: u.notification_phone || null,
        is_admin: !!u.admin_role,
        admin_role: u.admin_role,
        admin_permissions: u.admin_permissions || [],
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch user' });
  }
});

/**
 * POST /auth/login-options
 * Get available login methods for current environment
 */
router.get('/login-options', (req, res) => {
  const methods = [];

  if (['google', 'both'].includes(LOGIN_MODE)) {
    methods.push({
      type: 'google',
      name: 'Google OAuth',
      endpoint: '/auth/google-signin',
      configured: !!process.env.GOOGLE_CLIENT_ID,
    });
  }

  if (['email', 'both'].includes(LOGIN_MODE)) {
    methods.push({
      type: 'email',
      name: 'Email/Password',
      endpoint: '/auth/login',
      configured: true,
    });
  }

  if (['test', 'both'].includes(LOGIN_MODE)) {
    methods.push({
      type: 'test',
      name: 'Test Login (Development)',
      endpoint: '/auth/test-login',
      configured: true,
      isDevelopment: true,
    });
  }

  res.json({
    success: true,
    loginMode: LOGIN_MODE,
    availableMethods: methods,
  });
});

// ============================================================================
// Conditionally mount test auth routes
// ============================================================================

if (['test', 'both'].includes(LOGIN_MODE) && process.env.NODE_ENV !== 'production') {
  router.use(testAuthRoutes);
  console.log('✅ Test auth routes enabled');
} else if (['test', 'both'].includes(LOGIN_MODE)) {
  // Fail safe: hardcoded-credential test login must NEVER be reachable in
  // production, even if LOGIN_MODE is misconfigured there. NODE_ENV is the
  // backstop so a single stray env var can't open an auth bypass.
  console.warn(`⚠️  LOGIN_MODE=${LOGIN_MODE} requests test auth, but NODE_ENV=production — test login routes DISABLED.`);
} else {
  console.log(`ℹ️  Test auth routes disabled (LOGIN_MODE=${LOGIN_MODE})`);
}

module.exports = router;
