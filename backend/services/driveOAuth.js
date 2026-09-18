// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Google Drive OAuth helper. Implements the four primitives the route layer
// needs:
//
//   buildAuthUrl({ orgId, userId })   → URL to redirect the user to Google
//   signStateToken({ orgId, userId }) → JWT to round-trip via Google's state
//   verifyStateToken(token)           → decode + single-use nonce check
//   exchangeCodeForTokens(code)       → POST to Google's token endpoint
//   refreshAccessToken(refreshToken)  → renew the short-lived access token
//   revokeRefreshToken(token)         → tell Google to forget the grant
//
// We deliberately don't pull in `googleapis` — these calls are simple enough
// that Node 18's global fetch keeps the dep count down for Phase 1. Agent 2
// (services/drive.js) owns the broader googleapis dependency for actual
// Drive file ops.
//
// CREDENTIAL SOURCING (Platform Integrations refactor — PLATFORM_INTEGRATIONS_SPEC.md)
//   getCreds() is the single chokepoint for "what client id/secret/redirect
//   should I use?". It tries the platform_integrations DB row FIRST (so a
//   super-admin can rotate creds in-app without a redeploy), and falls
//   back to the GOOGLE_DRIVE_* env vars SECOND (so existing prod
//   deployments keep working).
//
//   Because the DB source is async, isConfigured / buildAuthUrl /
//   exchangeCodeForTokens / refreshAccessToken are all async. The state-
//   token sign/verify pair is still sync — those don't need creds.
//
// SCOPE
//   We request ONLY drive.readonly. Any future need for a write scope MUST
//   be reviewed in security review — read-only is what we promise in the
//   user-facing copy and the Google verification submission.
//
// STATE TOKEN
//   HS256 JWT signed with JWT_SECRET, 5-minute expiry. Payload carries
//   { org_id, user_id, nonce }. The nonce is a 16-byte hex string we record
//   in a local Set so the same state token can't be replayed within the
//   process lifetime.
//
//   LIMITATION: the seen-nonces set is in-memory per pod. If we ever run
//   multi-pod, a replay across pods within the 5-minute exp window would
//   slip through. For MVP this is acceptable — the JWT signature still
//   prevents forgery, the 5-minute window caps the replay window, and the
//   callback always succeeds-or-fails idempotently against the row in
//   org_drive_connections (UPSERT on org_id). Phase 2 should move the
//   nonce store to Postgres if cross-pod replay-resistance becomes a
//   stated requirement.
//
// GRACEFUL DEGRADATION
//   isConfigured() returns false when neither the DB row nor the env vars
//   provide a complete (client_id + client_secret + redirect_uri) tuple.
//   Routes 503 with a clear message rather than throwing on every call.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const platformIntegrations = require('./platformIntegrations');

const REQUIRED_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

const AUTH_URL    = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL   = 'https://oauth2.googleapis.com/token';
const REVOKE_URL  = 'https://oauth2.googleapis.com/revoke';
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
// Credential sourcing — DB-first (platform_integrations), env-var fallback.
// ---------------------------------------------------------------------------

/**
 * Resolve the active Drive OAuth credentials. DB-first, env-fallback.
 * Returns { clientId, clientSecret, redirectUri, source: 'db' | 'env' }
 * on success or `null` if neither source has a complete tuple.
 *
 * Errors thrown by getSecret (e.g. master key not configured) bubble — the
 * caller should treat that as a 503 / "reconnect Drive" condition.
 */
async function getCreds() {
  // DB-first.
  let fromDb;
  try {
    fromDb = await platformIntegrations.getConfig('drive');
  } catch {
    // Service-level "unknown integration" shouldn't happen — `drive` is
    // registered. Defensive null + fall through to env.
    fromDb = null;
  }
  if (fromDb && fromDb.configured) {
    const secret = await platformIntegrations.getSecret('drive');
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
  // Env fallback (back-compat with existing prod deployments).
  const envClientId     = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const envClientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  const envRedirectUri  = process.env.GOOGLE_DRIVE_REDIRECT_URI;
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
 * Async "are we configured to do the OAuth dance?" check. Consults DB then
 * env. Used by route gates and by buildAuthUrl / exchangeCodeForTokens /
 * refreshAccessToken before they touch Google.
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
  // Neither source produced a complete tuple. Report on env-var status
  // since the in-app source is silent unless explicitly saved.
  const missing = [];
  if (!process.env.GOOGLE_DRIVE_CLIENT_ID)     missing.push('GOOGLE_DRIVE_CLIENT_ID');
  if (!process.env.GOOGLE_DRIVE_CLIENT_SECRET) missing.push('GOOGLE_DRIVE_CLIENT_SECRET');
  if (!process.env.GOOGLE_DRIVE_REDIRECT_URI)  missing.push('GOOGLE_DRIVE_REDIRECT_URI');
  if (missing.length === 0) {
    // Defensive: shouldn't reach here unless the DB read threw and env is
    // partial. Report the generic message rather than misleading the
    // operator about env vars.
    return 'Drive OAuth not configured. Save credentials at /admin/platform-integrations or set GOOGLE_DRIVE_* env vars.';
  }
  return `Drive OAuth not configured. Save credentials at /admin/platform-integrations, or set env: ${missing.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// State token (sync — does not depend on creds)
// ---------------------------------------------------------------------------

/**
 * Sign a JWT carrying { org_id, user_id, nonce } and 5-minute exp. The nonce
 * is unique per call and pre-recorded in seenNonces with its expiry so a
 * second redemption is rejected by verifyStateToken.
 */
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
  // Pre-register the nonce as "minted but unredeemed" with the same expiry
  // as the JWT exp claim. verifyStateToken consumes it.
  seenNonces.set(nonce, Date.now() + STATE_EXPIRY_SECONDS * 1000);
  return token;
}

/**
 * Verify a state JWT and consume its nonce. Returns the decoded payload
 * { org_id, user_id, nonce } on success. Throws on bad signature, expired
 * token, or replay.
 */
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
    // Either never minted by this pod (replay across pods), already
    // redeemed, or expired and swept. All three present as "invalid state"
    // to the user — we don't distinguish in the error to avoid leaking
    // which case applies.
    throw new Error('verifyStateToken: nonce not recognized (expired, replayed, or minted on another pod)');
  }
  // Single-use: drop it from the set so a replay is rejected.
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

/**
 * Build the Google OAuth consent URL. Caller is responsible for sending the
 * user to it (302 redirect or open in a popup). access_type=offline gets us
 * a refresh_token; prompt=consent forces the consent screen even on
 * re-authorizing so we always receive a refresh_token (Google omits it on
 * subsequent consents otherwise).
 */
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

/**
 * POST authorization code to Google's token endpoint. Returns the raw token
 * payload — { access_token, refresh_token, expires_in, scope, token_type,
 * id_token? } — for the caller to decide what to store.
 *
 * Pulled out of the route handler so tests can mock fetch in one place.
 */
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
    // This happens when a user previously consented and Google's "remember
    // my consent" is on. We force prompt=consent in buildAuthUrl precisely
    // to avoid this — if it still happens, treat it as a hard error so we
    // don't persist a connection with no way to refresh.
    throw new Error('Google token exchange returned no refresh_token. Try disconnecting and reconnecting; if it persists, the user may need to revoke at https://myaccount.google.com/permissions.');
  }
  // Validate the granted scope includes drive.readonly. Google may return a
  // space-separated list of scopes in the `scope` field; we accept the
  // connection as long as drive.readonly is in there.
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

/**
 * Use a refresh token to mint a fresh access token. Returns
 * { access_token, expires_in, scope }. Used by services/drive.js when an
 * existing connection's cached access token is expired.
 */
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

/**
 * Tell Google to revoke a token (refresh or access). Google's revoke endpoint
 * is idempotent at the protocol level but returns 400 for already-revoked
 * tokens; we treat that as success since the desired end-state is reached.
 */
async function revokeToken(token) {
  if (!token) throw new Error('revokeToken: token is required');
  const body = new URLSearchParams({ token });
  const resp = await fetch(REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (resp.ok) return { ok: true, alreadyRevoked: false };
  // Google returns 400 with { error: 'invalid_token' } when the token has
  // already been revoked. We don't want that to surface as a failure to the
  // user; the row is being deleted regardless.
  if (resp.status === 400) {
    const payload = await resp.json().catch(() => ({}));
    if (payload?.error === 'invalid_token') {
      return { ok: true, alreadyRevoked: true };
    }
  }
  const errText = await resp.text().catch(() => '');
  throw new Error(`Google token revoke failed (HTTP ${resp.status}): ${errText}`);
}

/**
 * Optional: look up the email address of the user whose access token we just
 * minted. Used at OAuth callback to populate google_user_email. Best-effort —
 * we fall back to a null email rather than failing the whole callback.
 */
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
