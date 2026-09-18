// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Microsoft Graph — shared connection + token core.
//
// WHY THIS FILE EXISTS (small deliberate divergence from the Google family):
// Gmail and Google Calendar each own a separate OAuth connection table, so
// services/gmail.js and services/calendar.js each carry their own
// loadConnection/getAccessToken. The Microsoft integration is ONE consent —
// a single org_msgraph_connections row (Mail.Read + Calendars.ReadWrite)
// powers BOTH the Outlook-mail and Outlook-calendar surfaces. Duplicating
// the token-refresh logic into msgraphMail.js and msgraphCalendar.js would
// mean two competing writers of the same row, so the shared core lives here
// and both thin clients sit on top.
//
// Exposes (mirroring the gmail.js/calendar.js core shapes):
//   isConfigured()        → async; mirrors msgraphOAuth.isConfigured()
//   loadConnection(orgId) → the active connection row (throws coded errors)
//   getAccessToken(orgId) → valid bearer string, refreshing when expired
//   apiFetch(orgId, path, opts) → authenticated fetch against Graph v1.0
//
// REFRESH-TOKEN ROTATION (load-bearing divergence from Google):
//   Microsoft may return a NEW refresh_token on every refresh. When it does,
//   getAccessToken re-encrypts and persists the replacement alongside the
//   new access token — dropping it would strand the connection once the old
//   refresh token ages out.
//
// GRACEFUL DEGRADATION:
//   If the OAuth client isn't configured, isConfigured() returns false.
//   Routes consume this and return 503 with a "Microsoft 365 not configured"
//   message. We never throw at module-load time — mirrors services/gmail.js.
//
// NO PII IN LOGS:
//   We log message/event ids, counts, statuses — never subject lines, body
//   text, or participant addresses. The DB rows + audit log are where that
//   data intentionally lives; logs are not.

const logger = require('./logger');
const pool = require('../db');
const msgraphOAuth = require('./msgraphOAuth');

const API_BASE = 'https://graph.microsoft.com/v1.0';

// msgraphTokens is the encryption seam (re-exports driveTokens today; see
// services/msgraphTokens.js for the rationale). Lazy-loaded for the same
// reason as the gmailTokens shim in services/gmail.js.
let _msgraphTokens = null;
function msgraphTokens() {
  if (_msgraphTokens) return _msgraphTokens;
  try {
    _msgraphTokens = require('./msgraphTokens');
  } catch (err) {
    throw new Error('Microsoft token service is not available yet. Have you applied migration 140 and shipped services/msgraphTokens.js?');
  }
  return _msgraphTokens;
}

// Async because msgraphOAuth.isConfigured() consults the DB-first
// platform_integrations row.
async function isConfigured() {
  return msgraphOAuth.isConfigured();
}

/**
 * Load the org's Microsoft connection row, raising if there isn't one.
 * Returns the raw row including ciphertext bytes.
 */
async function loadConnection(orgId) {
  if (!orgId) throw new Error('orgId required');
  const r = await pool.query(
    `SELECT id, org_id, ms_user_email, refresh_token_ciphertext,
            refresh_token_iv, refresh_token_tag, access_token,
            access_token_expires_at, scopes, status,
            last_mail_sync_at, last_calendar_sync_at
       FROM org_msgraph_connections
      WHERE org_id = $1
      LIMIT 1`,
    [orgId]
  );
  if (r.rows.length === 0) {
    const err = new Error('No Microsoft 365 connection for this org');
    err.code = 'MSGRAPH_NOT_CONNECTED';
    throw err;
  }
  const row = r.rows[0];
  if (row.status !== 'active') {
    const err = new Error(`Microsoft 365 connection status is "${row.status}"`);
    err.code = 'MSGRAPH_CONNECTION_INACTIVE';
    throw err;
  }
  return row;
}

/**
 * Returns a valid access token for the org. Refreshes via Microsoft's token
 * endpoint if the cached access_token is missing or within 60s of expiry.
 * Writes the new access_token + expiry — and, when Microsoft rotates it,
 * the re-encrypted replacement refresh token — back to the row.
 */
async function getAccessToken(orgId) {
  const conn = await loadConnection(orgId);
  const now = Date.now();
  const expiresAt = conn.access_token_expires_at
    ? new Date(conn.access_token_expires_at).getTime()
    : 0;

  // 60s skew — refresh proactively rather than racing the expiry.
  if (conn.access_token && expiresAt > now + 60_000) {
    return conn.access_token;
  }

  const refreshToken = msgraphTokens().decrypt({
    ciphertext: conn.refresh_token_ciphertext,
    iv:         conn.refresh_token_iv,
    tag:        conn.refresh_token_tag,
  });

  let refreshed;
  try {
    refreshed = await msgraphOAuth.refreshAccessToken(refreshToken);
  } catch (err) {
    const status = err.statusCode || 0;
    logger.warn('msgraph_token_refresh_failed', { orgId, status, error: err.message });
    // invalid_grant comes back as HTTP 400 — the refresh token was revoked
    // (user removed the app, admin revoked sessions) or rotated away.
    await pool.query(
      `UPDATE org_msgraph_connections
          SET status     = CASE WHEN $2 = 400 THEN 'revoked' ELSE 'error' END,
              last_error = $3,
              updated_at = NOW()
        WHERE org_id = $1`,
      [orgId, status, `token_refresh:${status || 'network'}`]
    ).catch(() => {});
    const out = new Error(`Microsoft token refresh failed (${status || 'network'})`);
    out.code = status === 400 ? 'MSGRAPH_TOKEN_REVOKED' : 'MSGRAPH_TOKEN_REFRESH_FAILED';
    throw out;
  }

  const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000);

  if (refreshed.refresh_token) {
    // Rotation: persist the replacement refresh token (re-encrypted).
    const enc = msgraphTokens().encrypt(refreshed.refresh_token);
    await pool.query(
      `UPDATE org_msgraph_connections
          SET access_token             = $2,
              access_token_expires_at  = $3,
              refresh_token_ciphertext = $4,
              refresh_token_iv         = $5,
              refresh_token_tag        = $6,
              last_error               = NULL,
              updated_at               = NOW()
        WHERE org_id = $1`,
      [orgId, refreshed.access_token, newExpiresAt.toISOString(), enc.ciphertext, enc.iv, enc.tag]
    );
  } else {
    await pool.query(
      `UPDATE org_msgraph_connections
          SET access_token             = $2,
              access_token_expires_at  = $3,
              last_error               = NULL,
              updated_at               = NOW()
        WHERE org_id = $1`,
      [orgId, refreshed.access_token, newExpiresAt.toISOString()]
    );
  }
  return refreshed.access_token;
}

/**
 * Authenticated fetch against the Graph v1.0 REST API. Returns parsed JSON,
 * or throws with a coded error on non-2xx. Mirrors calendar.apiFetch.
 */
async function apiFetch(orgId, path, { method = 'GET', query, body, headers } = {}) {
  const accessToken = await getAccessToken(orgId);
  let url = `${API_BASE}${path}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += `?${qs}`;
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  if (!res.ok) {
    const detail = json?.error?.message || `HTTP ${res.status}`;
    const err = new Error(`Graph API ${method} ${path} failed: ${detail}`);
    err.code = res.status === 401 || res.status === 403 ? 'MSGRAPH_TOKEN_REVOKED' : 'MSGRAPH_API_ERROR';
    err.statusCode = res.status;
    throw err;
  }
  return json;
}

module.exports = {
  isConfigured,
  loadConnection,
  getAccessToken,
  apiFetch,
  API_BASE,
};
