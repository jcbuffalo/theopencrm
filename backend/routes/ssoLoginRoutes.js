// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Enterprise SSO (OIDC) login flow — the PRE-AUTH, public surface.
//
// Mounted at /api/auth/sso (alongside the existing sibling-app handoff in
// ssoRoutes.js). Three endpoints:
//
//   GET /api/auth/sso/resolve?identifier=<email|slug>
//       Discovery for the login page. Maps a work email's domain (or a raw
//       slug) to an ENABLED connection's slug so the browser can redirect to
//       /start. Returns { found, slug } — never any secret.
//
//   GET /api/auth/sso/:slug/start
//       Looks up the enabled connection, confirms the org has the sso_enabled
//       feature flag, runs OIDC discovery, and 302-redirects the browser to
//       the IdP authorize URL with a fresh state + nonce. state+nonce+slug are
//       sealed into a short-lived signed httpOnly cookie (sso_txn) so the
//       callback can verify them.
//
//   GET /api/auth/sso/callback?code=&state=
//       Exchanges the code, RIGOROUSLY verifies the id_token (see
//       services/ssoOidc.verifyIdToken), enforces the allowed email domain,
//       find-or-creates the user IN THAT ORG (org_role='member' for new
//       users), and mints the normal session cookie — then redirects to the
//       app. ANY verification failure rejects without minting a session.
//
// The feature-flag gate is enforced MANUALLY here (per resolved connection)
// rather than via requireFeature middleware, because these routes are pre-auth
// and have no req.orgId until the connection is resolved. Net effect is the
// same default-off guarantee: no enabled connection + flag ⇒ no SSO login.

const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const audit = require('../services/audit');
const featureFlags = require('../services/featureFlags');
const ssoConnections = require('../services/ssoConnections');
const oidc = require('../services/ssoOidc');
const { generateToken, AUTH_COOKIE_NAME, authCookieOptions } = require('../auth');

const router = express.Router();

// --- transaction cookie (state + nonce binding) ----------------------------
const TXN_COOKIE = 'sso_txn';
const TXN_AUDIENCE = 'sso-txn';
const TXN_TTL_SEC = 600; // 10 min — the user has to finish the IdP round-trip

function signTxn(payload) {
  // Reuse JWT_SECRET but scope with a dedicated audience so a txn cookie can
  // never be mistaken for a session token (different audience → authMiddleware
  // ignores it, and verifyTxn only accepts this audience).
  return jwt.sign(payload, requireSecret(), { algorithm: 'HS256', expiresIn: TXN_TTL_SEC, audience: TXN_AUDIENCE });
}
function verifyTxn(token) {
  try {
    return jwt.verify(token, requireSecret(), { algorithms: ['HS256'], audience: TXN_AUDIENCE });
  } catch {
    return null;
  }
}
function requireSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET not set');
  return s;
}
function txnCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  // sameSite 'lax' (not 'none'): the cookie only needs to survive the top-level
  // GET navigation the IdP performs back to /callback, which is first-party to
  // the backend origin. lax is the tighter choice and still works for that.
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/api/auth/sso',
    maxAge: TXN_TTL_SEC * 1000,
  };
}

function frontendBase() {
  const raw = process.env.FRONTEND_URL || 'https://app.theopencrm.com';
  return raw.split(',')[0].trim().replace(/\/+$/, '');
}
function callbackUrl(req) {
  const base = process.env.SSO_CALLBACK_BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/+$/, '')}/api/auth/sso/callback`;
}
function redirectToLoginError(res, code) {
  return res.redirect(`${frontendBase()}/login?sso_error=${encodeURIComponent(code)}`);
}

// Confirm the org actually has SSO switched on. Default-off: any falsey flag
// (including no org context) rejects.
async function ssoEnabledForOrg(orgId) {
  try {
    return await featureFlags.hasFeature(orgId, 'sso_enabled');
  } catch {
    return false;
  }
}

// --- GET /resolve ----------------------------------------------------------
router.get('/resolve', async (req, res) => {
  try {
    const identifier = String(req.query.identifier || '').trim();
    if (!identifier) return res.status(400).json({ found: false, error: 'identifier required' });

    let conn = null;
    if (identifier.includes('@')) {
      const domain = oidc.domainOfEmail(identifier);
      if (domain) conn = await ssoConnections.getByEmailDomain(domain, { enabledOnly: true });
    } else {
      conn = await ssoConnections.getBySlug(identifier, { enabledOnly: true });
    }
    if (!conn) return res.json({ found: false });
    if (!(await ssoEnabledForOrg(conn.orgId))) return res.json({ found: false });
    return res.json({ found: true, slug: conn.slug });
  } catch (err) {
    if (req.log) req.log.error('sso_resolve_failed', { error: err });
    return res.status(500).json({ found: false, error: 'resolve failed' });
  }
});

// --- GET /:slug/start ------------------------------------------------------
router.get('/:slug/start', async (req, res) => {
  try {
    const conn = await ssoConnections.getBySlug(req.params.slug, { enabledOnly: true });
    if (!conn) return redirectToLoginError(res, 'unknown_or_disabled');
    if (!(await ssoEnabledForOrg(conn.orgId))) return redirectToLoginError(res, 'sso_not_enabled');
    if (!conn.issuer || !conn.clientId || !conn.hasSecret || !conn.allowedDomain) {
      return redirectToLoginError(res, 'sso_incomplete_config');
    }

    // OIDC discovery → authorize endpoint.
    const disc = await oidc.fetchDiscovery(conn.issuer);
    if (!disc.authorization_endpoint) return redirectToLoginError(res, 'sso_no_authorize_endpoint');

    const state = oidc.randomToken();
    const nonce = oidc.randomToken();
    const redirectUri = callbackUrl(req);

    const authorizeUrl = oidc.buildAuthorizeUrl({
      authorizationEndpoint: disc.authorization_endpoint,
      clientId: conn.clientId,
      redirectUri,
      state,
      nonce,
    });

    // Seal state+nonce+slug+redirectUri into the txn cookie. redirectUri is
    // pinned so the token exchange uses the byte-identical value OIDC requires.
    res.cookie(TXN_COOKIE, signTxn({ slug: conn.slug, state, nonce, redirectUri }), txnCookieOptions());
    return res.redirect(authorizeUrl);
  } catch (err) {
    if (req.log) req.log.error('sso_start_failed', { error: err.message, code: err.code });
    return redirectToLoginError(res, 'sso_start_failed');
  }
});

// --- GET /callback ---------------------------------------------------------
router.get('/callback', async (req, res) => {
  try {
    // The IdP may return an error (user cancelled, consent denied, etc.).
    if (req.query.error) {
      return redirectToLoginError(res, 'idp_error');
    }

    const txnRaw = req.cookies && req.cookies[TXN_COOKIE];
    const txn = verifyTxn(txnRaw);
    // Always clear the txn cookie — it's single-use.
    res.clearCookie(TXN_COOKIE, { path: txnCookieOptions().path, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    if (!txn) return redirectToLoginError(res, 'sso_state_expired');

    const { code, state } = req.query;
    if (!code || !state) return redirectToLoginError(res, 'sso_missing_code');
    // CSRF/replay defense: state param MUST match the sealed one.
    if (String(state) !== String(txn.state)) return redirectToLoginError(res, 'sso_state_mismatch');

    const conn = await ssoConnections.getBySlug(txn.slug, { enabledOnly: true });
    if (!conn) return redirectToLoginError(res, 'unknown_or_disabled');
    if (!(await ssoEnabledForOrg(conn.orgId))) return redirectToLoginError(res, 'sso_not_enabled');

    // Fetch discovery + JWKS + the client secret (server-side only).
    const disc = await oidc.fetchDiscovery(conn.issuer);
    if (!disc.token_endpoint || !disc.jwks_uri) return redirectToLoginError(res, 'sso_discovery_incomplete');

    const clientSecret = await ssoConnections.getClientSecret(conn.orgId);
    if (!clientSecret) return redirectToLoginError(res, 'sso_no_client_secret');

    const tokens = await oidc.exchangeCode({
      tokenEndpoint: disc.token_endpoint,
      code: String(code),
      clientId: conn.clientId,
      clientSecret,
      redirectUri: txn.redirectUri,
    });

    const jwks = await oidc.fetchJwks(disc.jwks_uri);

    // *** THE GATE *** — verify signature, iss, aud, exp, nonce.
    const claims = oidc.verifyIdToken(tokens.id_token, {
      jwks,
      issuer: conn.issuer,
      clientId: conn.clientId,
      nonce: txn.nonce,
    });

    // Enforce the org's allowed email domain against the VERIFIED email.
    const email = oidc.enforceDomain(claims.email, conn.allowedDomain);

    // Find-or-create the user in THIS org, then mint a session.
    const user = await findOrCreateUser({ email, claims, orgId: conn.orgId });
    if (user.blocked) {
      audit.fromReq(req, { event: 'sso.login.fail', orgId: conn.orgId, success: false, meta: { email, reason: user.reason } });
      return redirectToLoginError(res, user.reason || 'sso_login_blocked');
    }

    const token = generateToken(user.id);
    res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions());
    audit.record({
      event: 'sso.login.success',
      actorUserId: user.id,
      orgId: conn.orgId,
      ip: req.ip,
      userAgent: req.headers?.['user-agent'] || null,
      requestId: req.requestId || null,
      meta: { email, provisioned: user.provisioned },
    });

    // Land on the app root; AuthContext will fetch /auth/me + a CSRF token.
    return res.redirect(`${frontendBase()}/`);
  } catch (err) {
    // SsoError (verification/domain) and any transport error land here. Never
    // leak which check failed — a single generic error code.
    const code = err && err.code && String(err.code).startsWith('SSO_') ? 'sso_verification_failed' : 'sso_callback_failed';
    if (req.log) req.log.warn('sso_callback_rejected', { error: err.message, code: err.code });
    return redirectToLoginError(res, code);
  }
});

// Find-or-create the SSO user, scoped to the connection's org.
//
// Rules (fail-safe):
//   - No user with this email      → create in org, org_role='member', active.
//   - User exists in THIS org      → sign in (unless suspended/rejected).
//   - User exists with NO org      → adopt into org as member (personal→SSO).
//   - User exists in a DIFFERENT org → BLOCK. SSO must not move a user between
//     tenants or let one org's IdP mint a session for another org's user.
async function findOrCreateUser({ email, claims, orgId }) {
  const existing = await pool.query(
    'SELECT id, org_id, status FROM users WHERE LOWER(email) = LOWER($1)',
    [email]
  );

  if (existing.rows.length === 0) {
    const name = (claims.name && String(claims.name).trim())
      || [claims.given_name, claims.family_name].filter(Boolean).join(' ').trim()
      || email.split('@')[0];
    const r = await pool.query(
      `INSERT INTO users (email, name, status, org_id, org_role, email_verified, created_at, updated_at)
       VALUES ($1, $2, 'active', $3, 'member', TRUE, NOW(), NOW())
       RETURNING id`,
      [email, name, orgId]
    );
    return { id: r.rows[0].id, provisioned: true };
  }

  const row = existing.rows[0];
  if (row.org_id && Number(row.org_id) !== Number(orgId)) {
    return { blocked: true, reason: 'sso_user_other_org' };
  }
  if (row.status && row.status !== 'active') {
    return { blocked: true, reason: 'account_not_active' };
  }
  if (!row.org_id) {
    await pool.query(
      `UPDATE users SET org_id = $1, org_role = COALESCE(org_role, 'member'), email_verified = TRUE, updated_at = NOW()
         WHERE id = $2`,
      [orgId, row.id]
    );
  }
  return { id: row.id, provisioned: false };
}

module.exports = router;
