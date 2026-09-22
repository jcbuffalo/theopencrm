// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Authentication utilities
// JWT token generation, bcrypt password hashing, password-policy enforcement.
//
// LIABILITY: Operators are responsible for setting JWT_SECRET to a strong,
// unique value, rotating it periodically, and storing it in a secret-management
// system. The defaults provided here are placeholders only and MUST be
// overridden in any environment that handles real data. See /LICENSE.

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('./db');
const { checkPasswordPwned } = require('./services/hibp');

// ============================================================================
// PASSWORD POLICY
// ============================================================================
// Minimum: 10 chars, must contain at least 3 of {lowercase, uppercase, digit, symbol}.
// Not OWASP-perfect — operators handling regulated data should add HIBP/breach
// checks and a password-history table. This is the floor, not the ceiling.

const PASSWORD_MIN_LENGTH = 10;

function validatePassword(password) {
  if (typeof password !== 'string') {
    return { ok: false, error: 'Password must be a string' };
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` };
  }
  if (password.length > 200) {
    return { ok: false, error: 'Password must be 200 characters or fewer' };
  }
  const classes = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^a-zA-Z0-9]/.test(password),
  ].filter(Boolean).length;
  if (classes < 3) {
    return { ok: false, error: 'Password must include at least 3 of: lowercase, uppercase, digit, symbol' };
  }
  // Common weak patterns
  const lower = password.toLowerCase();
  if (['password', 'qwerty', '123456', 'letmein', 'welcome'].some(s => lower.includes(s))) {
    return { ok: false, error: 'Password contains a commonly-guessed sequence' };
  }
  return { ok: true };
}

/**
 * Async password validator. Layers two stronger checks on top of the
 * registration-time sync policy:
 *
 *   1. No-reuse: every plaintext is bcrypt-compared against `opts.recentHashes`
 *      (the caller is responsible for fetching the last N rows from the
 *      `user_password_history` table created in migration 065). If any match,
 *      the new password is rejected.
 *
 *   2. Breach lookup: if HIBP_ENABLED=true in the environment, the plaintext
 *      is checked against the HIBP corpus via the k-anonymity API in
 *      services/hibp.js. A non-zero hit count rejects the password.
 *
 * The sync policy (length, character classes, common-pattern blocklist) is
 * still enforced first — we short-circuit before bcrypt/HIBP so a hopelessly
 * weak password doesn't burn a network round trip.
 *
 * @param {string} plaintext - the candidate new password.
 * @param {{ recentHashes?: string[] }} [opts]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function validatePasswordAsync(plaintext, opts = {}) {
  const basic = validatePassword(plaintext);
  if (!basic.ok) return basic;

  const recentHashes = Array.isArray(opts.recentHashes) ? opts.recentHashes : [];
  for (const hash of recentHashes) {
    if (typeof hash !== 'string' || hash.length === 0) continue;
    // bcrypt.compare is intentionally slow; recentHashes is short (~5) so the
    // total cost stays comfortably under 1.5s on the cost-12 hashes we issue.
    // eslint-disable-next-line no-await-in-loop
    const matches = await bcrypt.compare(plaintext, hash);
    if (matches) {
      return { ok: false, error: 'Password was used recently. Pick something new.' };
    }
  }

  if (process.env.HIBP_ENABLED === 'true') {
    const count = await checkPasswordPwned(plaintext);
    if (count > 0) {
      return {
        ok: false,
        error: `This password has appeared in ${count} known data breaches. Pick something different.`,
      };
    }
  }

  return { ok: true };
}

// ============================================================================
// PASSWORD HASHING
// ============================================================================

// Cost factor 12 ≈ 250ms/hash on modern hardware — strong enough to make
// offline brute-force expensive without making login feel sluggish.
const BCRYPT_COST = 12;

async function hashPassword(password) {
  const salt = await bcrypt.genSalt(BCRYPT_COST);
  return bcrypt.hash(password, salt);
}

async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// ============================================================================
// JWT TOKEN MANAGEMENT
// ============================================================================
// Algorithm pinned to HS256 on both sign and verify. Without `algorithms` on
// verify, an attacker can submit a token with `alg: none` or coerce the
// verifier into treating an asymmetric public key as an HMAC secret
// (CVE-2015-9235 family). Pinning is a defense even though we only ever sign
// with HS256 ourselves.
const JWT_ALGORITHM = 'HS256';

function requireSecret(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`${name} is not set — refusing to sign/verify tokens. Boot-time env validation should have caught this.`);
  }
  return v;
}

function generateToken(userId, expiresIn = '24h') {
  return jwt.sign(
    { userId },
    requireSecret('JWT_SECRET'),
    { expiresIn, algorithm: JWT_ALGORITHM }
  );
}

function generateRefreshToken(userId, expiresIn = '7d') {
  return jwt.sign(
    { userId },
    requireSecret('JWT_REFRESH_SECRET'),
    { expiresIn, algorithm: JWT_ALGORITHM }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, requireSecret('JWT_SECRET'), { algorithms: [JWT_ALGORITHM] });
  } catch (error) {
    return null;
  }
}

function verifyRefreshToken(token) {
  try {
    return jwt.verify(token, requireSecret('JWT_REFRESH_SECRET'), { algorithms: [JWT_ALGORITHM] });
  } catch (error) {
    return null;
  }
}

// ----------------------------------------------------------------------------
// 2FA tempToken — issued after password / Google verification succeeds but
// BEFORE the user completes the TOTP challenge. Signed with a dedicated secret
// (JWT_2FA_SECRET) and carries the audience claim '2fa-pending' so the regular
// authMiddleware will reject it (different secret + different audience). The
// real session JWT is only minted by /auth/2fa/verify after the 6-digit code
// is validated. Short expiry (5 minutes) bounds the window for replay if the
// tempToken somehow leaks.
// ----------------------------------------------------------------------------
const TWO_FA_AUDIENCE = '2fa-pending';
const TWO_FA_TEMP_EXPIRY = '5m';

function generate2faTempToken(userId) {
  return jwt.sign(
    { userId, purpose: 'pre-2fa' },
    requireSecret('JWT_2FA_SECRET'),
    { expiresIn: TWO_FA_TEMP_EXPIRY, algorithm: JWT_ALGORITHM, audience: TWO_FA_AUDIENCE }
  );
}

function verify2faTempToken(token) {
  try {
    return jwt.verify(token, requireSecret('JWT_2FA_SECRET'), {
      algorithms: [JWT_ALGORITHM],
      audience: TWO_FA_AUDIENCE,
    });
  } catch (error) {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Cookie config for the httpOnly auth cookie. Centralized so login, google-
// signin, 2FA-verify and logout all use identical attributes — a mismatch (e.g.
// path '/' on set, path '/api' on clear) would leave a zombie cookie behind.
// ----------------------------------------------------------------------------
const AUTH_COOKIE_NAME = 'authToken';
const AUTH_COOKIE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — matches generateToken default

function authCookieOptions() {
  // Cross-site cookie semantics:
  // - In production, the frontend (app.theopencrm.com) and backend (*.run.app)
  //   are on different registrable domains, so the cookie has to travel
  //   cross-site. That requires sameSite='none' AND secure=true. Once a
  //   custom subdomain (api.theopencrm.com) is mapped to the backend, this
  //   can move back to 'lax' for the marginal CSRF defense-in-depth.
  // - In dev / non-production we keep 'lax' — both apps run on localhost so
  //   there's no cross-site issue, and 'lax' works without HTTPS.
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
    maxAge: AUTH_COOKIE_MAX_AGE_MS,
  };
}

// ============================================================================
// MIDDLEWARE
// ============================================================================

// Token lookup: the httpOnly cookie 'authToken' is the sole session transport
// (set by /auth/login, /auth/google-signin, /auth/2fa/verify). The canonical
// source since 2026-05.
//
// The transitional `Authorization: Bearer` fallback was removed on
// 2026-06-30 per its scheduled sunset (see SECURITY_REVIEW.md auth-hardening
// section). The frontend is fully cookie-based and no first-party client sends
// Bearer, so nothing depends on it. `source` is retained on the return shape
// for callers that discriminate on it, but is now always 'cookie' or null.
function extractToken(req) {
  if (req.cookies && req.cookies[AUTH_COOKIE_NAME]) {
    return { token: req.cookies[AUTH_COOKIE_NAME], source: 'cookie' };
  }
  return { token: null, source: null };
}

async function authMiddleware(req, res, next) {
  // Idempotency: if a prefix-mounted call already established req.userId
  // (e.g. `app.use('/api/ai', authMiddleware, ...)` + a per-route
  // `router.get(..., authMiddleware, ...)` for back-compat), skip the
  // second round-trip. Without this, mounting auth at the prefix to feed
  // requireAiBilling would double the DB query per AI request.
  if (req.userId) {
    return next();
  }

  const { token } = extractToken(req);

  // API-key fallback (spec 206): no session cookie but a tocrm_ key in the
  // Authorization / X-API-Key header → the key authenticates this request on
  // the same org-scoped route, with the scope + route guardrails in
  // middleware/apiKeyAuth.js. A cookie session always wins when both exist.
  if (!token) {
    const { hasApiKey, resolveApiKey } = require('./middleware/apiKeyAuth');
    if (hasApiKey(req)) {
      const out = await resolveApiKey(req);
      if (!out.ok) return res.status(out.status).json(out.body);
      return next();
    }
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const decoded = verifyToken(token);

  if (!decoded) {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }

  req.userId = decoded.userId;

  try {
    const r = await pool.query('SELECT org_id, org_role, status FROM users WHERE id = $1', [decoded.userId]);
    const row = r.rows[0];
    if (!row) {
      // Token is valid but the user no longer exists (deleted after the token
      // was issued). Fail closed.
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    // Status re-check. Login only ever mints tokens for 'active' users, but an
    // admin can suspend/reject an account AFTER a token was issued. Without this
    // the stale token stays fully usable (including writes) until it expires.
    // NULL is treated as active (legacy rows; migration 043 backfilled these).
    if (row.status && row.status !== 'active') {
      return res.status(403).json({ success: false, message: 'Account is not active.', code: 'ACCOUNT_NOT_ACTIVE' });
    }
    req.orgId = row.org_id ?? null;
    req.orgRole = row.org_role ?? 'member';
  } catch {
    // DB hiccup: preserve the prior fail-open behavior for org context rather
    // than turning a transient DB error into a site-wide auth outage. The status
    // gate can't run here, but tokens are only minted for active users so the
    // exposure is limited to the rare DB-error window.
    req.orgId = null;
    req.orgRole = null;
  }

  next();
}

function optionalAuth(req, res, next) {
  const { token } = extractToken(req);

  if (!token) {
    req.userId = null;
    return next();
  }

  const decoded = verifyToken(token);

  if (decoded) {
    req.userId = decoded.userId;
  } else {
    req.userId = null;
  }

  next();
}

module.exports = {
  hashPassword,
  comparePassword,
  generateToken,
  generateRefreshToken,
  verifyToken,
  verifyRefreshToken,
  generate2faTempToken,
  verify2faTempToken,
  authMiddleware,
  optionalAuth,
  extractToken,
  validatePassword,
  validatePasswordAsync,
  PASSWORD_MIN_LENGTH,
  AUTH_COOKIE_NAME,
  AUTH_COOKIE_MAX_AGE_MS,
  authCookieOptions,
  TWO_FA_AUDIENCE,
};
