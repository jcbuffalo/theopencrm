// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Gmail OAuth helper. Mirrors services/driveOAuth.js — same state-token
// flow, same DB-first / env-fallback credential sourcing — adapted for the
// gmail.readonly scope.
//
// Primitives the route layer needs:
//   buildAuthUrl({ orgId, userId })   → URL to redirect the user to Google
//   signStateToken({ orgId, userId }) → JWT to round-trip via Google's state
//   verifyStateToken(token)           → decode + single-use nonce check
//   exchangeCodeForTokens(code)       → POST to Google's token endpoint
//   refreshAccessToken(refreshToken)  → renew the short-lived access token
//   revokeToken(token)                → tell Google to forget the grant
//
// We deliberately don't pull in `googleapis` here — these calls are simple
// enough that Node 18's global fetch keeps the dep count down. services/
// gmail.js owns the broader googleapis dependency for actual Gmail API
// reads (threads.list, threads.get, etc.).
//
// CREDENTIAL SOURCING (mirrors driveOAuth — PLATFORM_INTEGRATIONS_SPEC.md)
//   getCreds() consults platform_integrations.gmail FIRST (so a super-
//   admin can rotate creds in-app without a redeploy), and falls back to
//   the GOOGLE_GMAIL_CLIENT_ID / _CLIENT_SECRET / _REDIRECT_URI env vars
//   SECOND for back-compat. Because the DB source is async, isConfigured /
//   buildAuthUrl / exchangeCodeForTokens / refreshAccessToken are all
//   async. The state-token sign/verify pair stays sync.
//
// SCOPE — gmail.readonly ONLY
//   We request ONLY https://www.googleapis.com/auth/gmail.readonly. This
//   is one of Google's "restricted" scopes — a production rollout to a
//   general audience requires CASA verification (Tier 2 minimum), which
//   takes 6–12 weeks and runs $4K–$15K through a Google-approved
//   assessor. The feature flag gmail_intel_enabled stays default OFF
//   precisely so a deployment doesn't accidentally hand consent pages to
//   users on an unverified OAuth client (Google's "unverified app"
//   warning page tanks consent rates and trains users to ignore it).
//
//   ANY future change to broaden this scope MUST go through security
//   review — even gmail.metadata is a separate restricted scope. Treat
//   the constant as load-bearing.
//
// STATE TOKEN
//   HS256 JWT signed with JWT_SECRET, 5-minute expiry. Payload carries
//   { org_id, user_id, nonce }. The nonce is a 16-byte hex string we
//   record in a local Set so the same state token can't be replayed
//   within the process lifetime.
//
//   LIMITATION: the seen-nonces set is in-memory per pod. If we ever run
//   multi-pod, a replay across pods within the 5-minute exp window would
//   slip through. For MVP this is acceptable — the JWT signature still
//   prevents forgery, the 5-minute window caps the replay window, and
//   the callback always succeeds-or-fails idempotently against the row
//   in org_gmail_connections (UPSERT on org_id). Phase 2 should move the
//   nonce store to Postgres if cross-pod replay-resistance becomes a
//   stated requirement.
//
// GRACEFUL DEGRADATION
//   isConfigured() returns false when neither the DB row nor the env
//   vars provide a complete (client_id + client_secret + redirect_uri)
//   tuple. Routes 503 with a clear message rather than throwing on
//   every call.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const platformIntegrations = require('./platformIntegrations');

const REQUIRED_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const AUTH_URL     = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL    = 'https://oauth2.googleapis.com/token';
const REVOKE_URL   = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

const STATE_EXPIRY_SECONDS = 5 * 60; // 5 minutes

// In-memory single-use store for state nonces. Bounded — we evict entries
// once their corresponding JWT has expired (5 min) so the set can't grow
// without bound from an attacker hammering /auth/start. The eviction sweep
// piggybacks on verifyStateToken (which inspects expiry anyway).
const seenNonces = new Map(); // nonce → expiresAtMs

function _sweepExpiredNonces(now = Date.now()) {
  for (const [nonce, exp] of seenNonces) {
    if (exp <= now) seenNonces.delete(nonce);
  }
}

// ---------------------------------------------------------------------------
// Credential sourcing — DB-first (platform_integrations.gmail), env fallback.
// ---------------------------------------------------------------------------

/**
 * Resolve the active Gmail OAuth credentials. DB-first, env-fallback.
 * Returns { clientId, clientSecret, redirectUri, source: 'db' | 'env' }
 * on success or `null` if neither source has a complete tuple.
 */
async function getCreds() {
  // DB-first.
  let fromDb;
  try {
    fromDb = await platformIntegrations.getConfig('gmail');
  } catch {
    fromDb = null;
  }
  if (fromDb && fromDb.configured) {
    const secret = await platformIntegrations.getSecret('gmail');
    if (secret) {
      return {
        clientId:     fromDb.config.client_id,
        clientSecret: secret,
        redirectUri:  fromDb.config.redirect_uri,
        source:       'db',
      };
    }
    // Fall through if the row exists but the secret is missing/null — env
    // may still be a viable fallback for that deploy.
  }
  // Env fallback (back-compat with non-DB-configured deployments).
  const envClientId     = process.env.GOOGLE_GMAIL_CLIENT_ID;
  const envClientSecret = process.env.GOOGLE_GMAIL_CLIENT_SECRET;
  const envRedirectUri  = process.env.GOOGLE_GMAIL_REDIRECT_URI;
  if (envClientId && envClientSecret && envRedirectUri) {
    return {
      clientId:     envClientId,
      clientSecret: envClientSecret,
      redirectUri:  envRedirectUri,
      source:       'env',
    };
  }
  return null;
}

/**
 * Async "are we configured to do the OAuth dance?" check.
 */
async function isConfigured() {
  const creds = await getCreds().catch(() => null);
  return !!creds;
}

/**
 * Operator-facing description of what's missing when isConfigured() is
 * false. Returns null when configured.
 */
async function configError() {
  const creds = await getCreds().catch(() => null);
  if (creds) return null;
  const missing = [];
  if (!process.env.GOOGLE_GMAIL_CLIENT_ID)     missing.push('GOOGLE_GMAIL_CLIENT_ID');
  if (!process.env.GOOGLE_GMAIL_CLIENT_SECRET) missing.push('GOOGLE_GMAIL_CLIENT_SECRET');
  if (!process.env.GOOGLE_GMAIL_REDIRECT_URI)  missing.push('GOOGLE_GMAIL_REDIRECT_URI');
  if (missing.length === 0) {
    return 'Gmail OAuth not configured. Save credentials at /admin/platform-integrations or set GOOGLE_GMAIL_* env vars.';
  }
  return `Gmail OAuth not configured. Save credentials at /admin/platform-integrations, or set env: ${missing.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// State token (sync — does not depend on creds)
// ---------------------------------------------------------------------------

function signStateToken({ orgId, userId }) {
  if (!orgId || !userId) {
    throw new Error('signStateToken: orgId and userId are required');
  }
  if (!process.env.JWT_SECRET) {
    throw new Error('signStateToken: JWT_SECRET is not set');
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  const token = jwt.sign(
    { org_id: orgId, user_id: userId, nonce },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: STATE_EXPIRY_SECONDS }
  );
  seenNonces.set(nonce, Date.now() + STATE_EXPIRY_SECONDS * 1000);
  return token;
}

function verifyStateToken(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('verifyStateToken: token is required');
  }
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    throw new Error(`verifyStateToken: ${err.message}`);
  }
  if (!decoded || !decoded.nonce || !decoded.org_id || !decoded.user_id) {
    throw new Error('verifyStateToken: payload is missing required fields');
  }
  _sweepExpiredNonces();
  if (!seenNonces.has(decoded.nonce)) {
    throw new Error('verifyStateToken: nonce not recognized (expired, replayed, or minted on another pod)');
  }
  seenNonces.delete(decoded.nonce);
  return {
    org_id: decoded.org_id,
    user_id: decoded.user_id,
    nonce: decoded.nonce,
  };
}

// ---------------------------------------------------------------------------
// OAuth dance — async, requires creds
// ---------------------------------------------------------------------------

async function buildAuthUrl({ orgId, userId }) {
  const creds = await getCreds();
  if (!creds) {
    throw new Error(await configError());
  }
  const state = signStateToken({ orgId, userId });
  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: creds.redirectUri,
    response_type: 'code',
    scope: REQUIRED_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const creds = await getCreds();
  if (!creds) {
    throw new Error(await configError());
  }
  if (!code) throw new Error('exchangeCodeForTokens: code is required');
  const body = new URLSearchParams({
    code,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri: creds.redirectUri,
    grant_type: 'authorization_code',
  });
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const detail = payload.error_description || payload.error || `HTTP ${resp.status}`;
    throw new Error(`Google token exchange failed: ${detail}`);
  }
  if (!payload.access_token) {
    throw new Error('Google token exchange returned no access_token');
  }
  if (!payload.refresh_token) {
    throw new Error('Google token exchange returned no refresh_token. Try disconnecting and reconnecting; if it persists, the user may need to revoke at https://myaccount.google.com/permissions.');
  }
  // Validate the granted scope includes gmail.readonly. Google may return
  // a space-separated list; accept as long as gmail.readonly is in there.
  const grantedScopes = (payload.scope || '').split(/\s+/).filter(Boolean);
  if (!grantedScopes.includes(REQUIRED_SCOPE)) {
    throw new Error(`Granted scopes do not include ${REQUIRED_SCOPE}. Got: ${grantedScopes.join(', ') || '(none)'}`);
  }
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_in: Number(payload.expires_in) || 3600,
    scopes: grantedScopes,
    id_token: payload.id_token || null,
    token_type: payload.token_type || 'Bearer',
  };
}

async function refreshAccessToken(refreshToken) {
  const creds = await getCreds();
  if (!creds) {
    throw new Error(await configError());
  }
  if (!refreshToken) throw new Error('refreshAccessToken: refreshToken is required');
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    grant_type: 'refresh_token',
  });
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const detail = payload.error_description || payload.error || `HTTP ${resp.status}`;
    throw new Error(`Google token refresh failed: ${detail}`);
  }
  if (!payload.access_token) {
    throw new Error('Google token refresh returned no access_token');
  }
  return {
    access_token: payload.access_token,
    expires_in: Number(payload.expires_in) || 3600,
    scope: payload.scope || null,
  };
}

async function revokeToken(token) {
  if (!token) throw new Error('revokeToken: token is required');
  const body = new URLSearchParams({ token });
  const resp = await fetch(REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (resp.ok) return { ok: true, alreadyRevoked: false };
  if (resp.status === 400) {
    const payload = await resp.json().catch(() => ({}));
    if (payload?.error === 'invalid_token') {
      return { ok: true, alreadyRevoked: true };
    }
  }
  const errText = await resp.text().catch(() => '');
  throw new Error(`Google token revoke failed (HTTP ${resp.status}): ${errText}`);
}

async function fetchUserEmail(accessToken) {
  try {
    const resp = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return null;
    const payload = await resp.json().catch(() => ({}));
    return payload.email || null;
  } catch {
    return null;
  }
}

// Test-only: clear the seen-nonces set so a test can mint + verify cleanly
// without cross-test pollution. Not part of the production surface.
function _resetForTests() {
  seenNonces.clear();
}

module.exports = {
  getCreds,
  isConfigured,
  configError,
  buildAuthUrl,
  signStateToken,
  verifyStateToken,
  exchangeCodeForTokens,
  refreshAccessToken,
  revokeToken,
  fetchUserEmail,
  REQUIRED_SCOPE,
  STATE_EXPIRY_SECONDS,
  _resetForTests,
};
