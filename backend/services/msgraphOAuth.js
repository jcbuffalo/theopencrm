// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Microsoft (Outlook / Microsoft 365) OAuth helper. Mirrors
// services/gmailOAuth.js and services/calendarOAuth.js — same state-token
// flow, same DB-first / env-fallback credential sourcing — adapted for the
// Microsoft identity platform (v2.0 endpoints) and Microsoft Graph scopes.
//
// Primitives the route layer needs:
//   buildAuthUrl({ orgId, userId })   → URL to redirect the user to Microsoft
//   signStateToken({ orgId, userId }) → JWT to round-trip via the state param
//   verifyStateToken(token)           → decode + single-use nonce check
//   exchangeCodeForTokens(code)       → POST to Microsoft's token endpoint
//   refreshAccessToken(refreshToken)  → renew the short-lived access token
//   revokeToken(token)                → documented no-op (see REVOCATION below)
//
// We deliberately don't pull in an SDK (@azure/msal-node) — these calls are
// simple enough that Node 18's global fetch keeps the dep count down, the
// same choice gmailOAuth/calendarOAuth made. services/msgraphClient.js owns
// the actual Graph API calls, also over fetch.
//
// CREDENTIAL SOURCING (mirrors gmailOAuth — PLATFORM_INTEGRATIONS_SPEC.md)
//   getCreds() consults platform_integrations.msgraph FIRST (so a super-
//   admin can rotate creds in-app at /admin/platform-integrations without a
//   redeploy), and falls back to the MICROSOFT_CLIENT_ID / _CLIENT_SECRET /
//   _REDIRECT_URI (+ optional MICROSOFT_TENANT_ID) env vars SECOND for
//   back-compat. The in-app store is the intended path — no Cloud Run
//   env-var changes are needed to light this up. Because the DB source is
//   async, isConfigured / buildAuthUrl / exchangeCodeForTokens /
//   refreshAccessToken are all async. The state-token sign/verify pair
//   stays sync.
//
// SCOPES — Mail.Read + Calendars.ReadWrite + User.Read + offline_access
//   One consent covers both the Outlook-mail and Outlook-calendar surfaces
//   (a single org_msgraph_connections row powers both feature flags).
//     Mail.Read           — read the mailbox (inbound-mail → deal matching)
//     Calendars.ReadWrite — read events + create events from a deal
//     User.Read           — GET /me for the connected account's email only
//     offline_access      — refresh token issuance
//   These are delegated Microsoft Graph permissions that a user can consent
//   to individually (no admin consent required by default, though a tenant
//   admin may have restricted user consent — the error surfaces on the
//   consent page). Publisher verification on the Azure app registration is
//   the Microsoft analogue of Google's OAuth verification: unverified
//   multi-tenant apps show a warning and, since late 2020, users in OTHER
//   tenants cannot consent at all. The feature flags outlook_mail_enabled /
//   outlook_calendar_enabled stay default OFF so a deployment doesn't hand
//   consent pages to users on an unverified app registration.
//
//   ANY future change to broaden these scopes (Mail.ReadWrite, Mail.Send,
//   Calendars.ReadWrite.Shared, ...) MUST go through security review.
//   Treat the constants as load-bearing.
//
// TOKEN ROTATION (divergence from Google — load-bearing)
//   Microsoft refresh tokens ROTATE: the token endpoint may return a NEW
//   refresh_token on every refresh, and the old one eventually stops
//   working (24h for SPAs; longer but not guaranteed for web apps). So
//   refreshAccessToken returns { refresh_token } when Microsoft supplies a
//   replacement, and callers (msgraphClient.getAccessToken) MUST re-encrypt
//   and persist it. Google-family helpers never had to do this.
//
// REVOCATION (divergence from Google)
//   The Microsoft identity platform has no public "revoke this token"
//   endpoint equivalent to Google's /revoke. Revocation happens when the
//   user removes the app at https://myaccount.microsoft.com/ (App
//   permissions) or an admin revokes sessions via Graph. revokeToken() is
//   therefore a documented no-op that resolves successfully — disconnect
//   deletes our stored tokens, which is the strongest action available to
//   us, and the UI copy points users at the Microsoft account portal.
//
// TENANT
//   Multi-tenant by default: the authorize/token endpoints use the
//   `common` tenant unless the operator configures a specific tenant id /
//   domain (config field `tenant`, env MICROSOFT_TENANT_ID). Single-tenant
//   deployments (one company's M365) set their tenant to lock consent to
//   their directory.
//
// STATE TOKEN
//   HS256 JWT signed with JWT_SECRET, 5-minute expiry, single-use nonce —
//   byte-for-byte the gmailOAuth model, including the documented per-pod
//   in-memory nonce-store limitation.
//
// GRACEFUL DEGRADATION
//   isConfigured() returns false when neither the DB row nor the env vars
//   provide a complete (client_id + client_secret + redirect_uri) tuple.
//   Routes 503 with a clear message rather than throwing on every call.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const platformIntegrations = require('./platformIntegrations');

// Graph delegated scopes we request. Mail.Read / Calendars.ReadWrite /
// User.Read resolve against the Graph resource; offline_access and openid
// are OIDC scopes handled by the identity platform itself.
const GRAPH_SCOPES = [
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Calendars.ReadWrite',
  'https://graph.microsoft.com/User.Read',
];
const REQUESTED_SCOPE = [...GRAPH_SCOPES, 'offline_access', 'openid', 'email'].join(' ');

// Short-form names Microsoft echoes back in the token response `scope`
// field (the resource prefix is usually stripped). Validation normalizes
// both forms — see grantedScopesInclude().
const REQUIRED_SHORT_SCOPES = ['mail.read', 'calendars.readwrite'];

const DEFAULT_TENANT = 'common';
const GRAPH_ME_URL = 'https://graph.microsoft.com/v1.0/me';

const STATE_EXPIRY_SECONDS = 5 * 60; // 5 minutes

// In-memory single-use store for state nonces. Bounded — evicted once the
// corresponding JWT has expired. Same model + limitation as gmailOAuth.
const seenNonces = new Map(); // nonce → expiresAtMs

function _sweepExpiredNonces(now = Date.now()) {
  for (const [nonce, exp] of seenNonces) {
    if (exp <= now) seenNonces.delete(nonce);
  }
}

function authorizeUrl(tenant) {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant || DEFAULT_TENANT)}/oauth2/v2.0/authorize`;
}

function tokenUrl(tenant) {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant || DEFAULT_TENANT)}/oauth2/v2.0/token`;
}

/**
 * Normalize a granted-scope string ("Mail.Read Calendars.ReadWrite ..." or
 * "https://graph.microsoft.com/Mail.Read ...") into a Set of lowercase
 * short-form names. Pure — exported for tests.
 */
function normalizeScopes(scopeString) {
  const out = new Set();
  for (const raw of String(scopeString || '').split(/\s+/).filter(Boolean)) {
    const short = raw.replace(/^https:\/\/graph\.microsoft\.com\//i, '');
    out.add(short.toLowerCase());
  }
  return out;
}

/**
 * True when every required Graph scope is present in the granted-scope
 * string (either short or fully-qualified form). Pure — exported for tests.
 */
function grantedScopesInclude(scopeString) {
  const granted = normalizeScopes(scopeString);
  return REQUIRED_SHORT_SCOPES.every((s) => granted.has(s));
}

// ---------------------------------------------------------------------------
// Credential sourcing — DB-first (platform_integrations.msgraph), env fallback.
// ---------------------------------------------------------------------------

/**
 * Resolve the active Microsoft OAuth credentials. DB-first, env-fallback.
 * Returns { clientId, clientSecret, redirectUri, tenant, source: 'db'|'env' }
 * on success or `null` if neither source has a complete tuple.
 */
async function getCreds() {
  // DB-first.
  let fromDb;
  try {
    fromDb = await platformIntegrations.getConfig('msgraph');
  } catch {
    fromDb = null;
  }
  if (fromDb && fromDb.configured) {
    const secret = await platformIntegrations.getSecret('msgraph');
    if (secret) {
      return {
        clientId:     fromDb.config.client_id,
        clientSecret: secret,
        redirectUri:  fromDb.config.redirect_uri,
        tenant:       fromDb.config.tenant || DEFAULT_TENANT,
        source:       'db',
      };
    }
    // Fall through if the row exists but the secret is missing/null — env
    // may still be a viable fallback for that deploy.
  }
  // Env fallback (back-compat shape; the in-app store is the primary path).
  const envClientId     = process.env.MICROSOFT_CLIENT_ID;
  const envClientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const envRedirectUri  = process.env.MICROSOFT_REDIRECT_URI;
  if (envClientId && envClientSecret && envRedirectUri) {
    return {
      clientId:     envClientId,
      clientSecret: envClientSecret,
      redirectUri:  envRedirectUri,
      tenant:       process.env.MICROSOFT_TENANT_ID || DEFAULT_TENANT,
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
  return 'Microsoft 365 OAuth not configured. Save the app registration (client id / secret / redirect URI) under "Microsoft 365 (Outlook)" at /admin/platform-integrations.';
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
    client_id:     creds.clientId,
    redirect_uri:  creds.redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope:         REQUESTED_SCOPE,
    // Force account selection so a user with several M365 identities
    // connects the intended one (Microsoft's analogue of prompt=consent —
    // offline_access already guarantees a refresh token on first consent).
    prompt:        'select_account',
    state,
  });
  return `${authorizeUrl(creds.tenant)}?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const creds = await getCreds();
  if (!creds) {
    throw new Error(await configError());
  }
  if (!code) throw new Error('exchangeCodeForTokens: code is required');
  const body = new URLSearchParams({
    code,
    client_id:     creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri:  creds.redirectUri,
    grant_type:    'authorization_code',
    scope:         REQUESTED_SCOPE,
  });
  const resp = await fetch(tokenUrl(creds.tenant), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const detail = payload.error_description || payload.error || `HTTP ${resp.status}`;
    throw new Error(`Microsoft token exchange failed: ${detail}`);
  }
  if (!payload.access_token) {
    throw new Error('Microsoft token exchange returned no access_token');
  }
  if (!payload.refresh_token) {
    throw new Error('Microsoft token exchange returned no refresh_token. Confirm offline_access is in the requested scopes and the app registration allows it, then try reconnecting.');
  }
  // Validate the granted scopes cover both Graph surfaces. Microsoft echoes
  // scopes back in short form ("Mail.Read Calendars.ReadWrite ...").
  if (!grantedScopesInclude(payload.scope)) {
    const got = String(payload.scope || '').trim() || '(none)';
    throw new Error(`Granted scopes do not include Mail.Read + Calendars.ReadWrite. Got: ${got}`);
  }
  return {
    access_token:  payload.access_token,
    refresh_token: payload.refresh_token,
    expires_in:    Number(payload.expires_in) || 3600,
    scopes:        String(payload.scope || '').split(/\s+/).filter(Boolean),
    id_token:      payload.id_token || null,
    token_type:    payload.token_type || 'Bearer',
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
    client_id:     creds.clientId,
    client_secret: creds.clientSecret,
    grant_type:    'refresh_token',
    scope:         REQUESTED_SCOPE,
  });
  const resp = await fetch(tokenUrl(creds.tenant), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const detail = payload.error_description || payload.error || `HTTP ${resp.status}`;
    const err = new Error(`Microsoft token refresh failed: ${detail}`);
    err.statusCode = resp.status;
    throw err;
  }
  if (!payload.access_token) {
    throw new Error('Microsoft token refresh returned no access_token');
  }
  return {
    access_token:  payload.access_token,
    expires_in:    Number(payload.expires_in) || 3600,
    // ROTATION: Microsoft may issue a replacement refresh token. Callers
    // MUST persist it when present (msgraphClient.getAccessToken does).
    refresh_token: payload.refresh_token || null,
    scope:         payload.scope || null,
  };
}

/**
 * Documented no-op (see REVOCATION in the header). Resolves with the same
 * shape gmailOAuth.revokeToken returns so callers stay symmetric.
 */
async function revokeToken(_token) {
  return {
    ok: true,
    alreadyRevoked: false,
    note: 'Microsoft identity platform has no public token-revocation endpoint; stored tokens are deleted locally. Users can revoke app access at https://myaccount.microsoft.com/.',
  };
}

/**
 * Resolve the connected account's email via Graph /me. Returns null on any
 * failure (the caller stores '' and the connection still works).
 */
async function fetchUserEmail(accessToken) {
  try {
    const resp = await fetch(GRAPH_ME_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return null;
    const payload = await resp.json().catch(() => ({}));
    return payload.mail || payload.userPrincipalName || null;
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
  normalizeScopes,
  grantedScopesInclude,
  GRAPH_SCOPES,
  REQUESTED_SCOPE,
  REQUIRED_SHORT_SCOPES,
  DEFAULT_TENANT,
  STATE_EXPIRY_SECONDS,
  _resetForTests,
};
