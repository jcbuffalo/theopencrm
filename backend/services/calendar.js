// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Google Calendar integration — thin REST wrapper used by calendarSync + routes.
//
// SCOPE: Loads the active `org_calendar_connections` row for an org, refreshes
// the cached access token against Google's OAuth endpoint when expired, and
// exposes:
//
//   getAccessToken(orgId)                   → valid bearer string
//   loadConnection(orgId)                   → the active connection row (throws if none)
//   listEvents(orgId, { updatedMin, maxResults, calendarId }) → recent/upcoming events
//   insertEvent(orgId, { ...event })        → create an event on the user's calendar
//
// Plus helper:
//
//   isConfigured()                          → async; mirrors calendarOAuth.isConfigured()
//
// We call the Calendar REST API directly over fetch rather than pulling in
// googleapis (mirrors services/driveOAuth's "keep the dep surface small"
// choice). The Calendar v3 events endpoints we need are simple JSON.
//
// GRACEFUL DEGRADATION:
//   If the OAuth client isn't configured, isConfigured() returns false. Routes
//   consume this and return 503 with a "Calendar not configured" message. We
//   never throw at module-load time — mirrors services/gmail.js.
//
// NO PII IN LOGS:
//   We log google_event_id, counts, status — never attendee addresses or event
//   descriptions. The DB rows + audit log are where that data lives.

const logger = require('./logger');
const pool = require('../db');
const calendarOAuth = require('./calendarOAuth');

const API_BASE = 'https://www.googleapis.com/calendar/v3';

// calendarTokens is the encryption seam (re-exports driveTokens today; see
// services/calendarTokens.js for the rationale). Lazy-loaded for the same
// reason as the gmailTokens shim in services/gmail.js.
let _calendarTokens = null;
function calendarTokens() {
  if (_calendarTokens) return _calendarTokens;
  try {
    _calendarTokens = require('./calendarTokens');
  } catch (err) {
    throw new Error('Calendar token service is not available yet. Have you applied migration 115 and shipped services/calendarTokens.js?');
  }
  return _calendarTokens;
}

// Async because calendarOAuth.isConfigured() consults the DB-first
// platform_integrations row.
async function isConfigured() {
  return calendarOAuth.isConfigured();
}

/**
 * Load the org's Calendar connection row, raising if there isn't one.
 * Returns the raw row including ciphertext bytes.
 */
async function loadConnection(orgId) {
  if (!orgId) throw new Error('orgId required');
  const r = await pool.query(
    `SELECT id, org_id, google_user_email, refresh_token_ciphertext,
            refresh_token_iv, refresh_token_tag, access_token,
            access_token_expires_at, scopes, status, last_sync_at
       FROM org_calendar_connections
      WHERE org_id = $1
      LIMIT 1`,
    [orgId]
  );
  if (r.rows.length === 0) {
    const err = new Error('No Calendar connection for this org');
    err.code = 'CALENDAR_NOT_CONNECTED';
    throw err;
  }
  const row = r.rows[0];
  if (row.status !== 'active') {
    const err = new Error(`Calendar connection status is "${row.status}"`);
    err.code = 'CALENDAR_CONNECTION_INACTIVE';
    throw err;
  }
  return row;
}

/**
 * Returns a valid access token for the org. Refreshes via Google's OAuth token
 * endpoint if the cached access_token is missing or within 60s of expiry.
 * Writes the new access_token + expiry back to the row.
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
  const creds = await calendarOAuth.getCreds();
  if (!creds) {
    const err = new Error('Calendar OAuth client is not configured on the backend');
    err.code = 'CALENDAR_NOT_CONFIGURED';
    throw err;
  }
  const refreshToken = calendarTokens().decrypt({
    ciphertext: conn.refresh_token_ciphertext,
    iv:         conn.refresh_token_iv,
    tag:        conn.refresh_token_tag,
  });

  const body = new URLSearchParams({
    client_id:     creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: refreshToken,
    grant_type:    'refresh_token',
  });
  let res;
  try {
    res = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (err) {
    logger.warn('calendar_token_refresh_network_error', { orgId, error: err.message });
    throw new Error('Network error refreshing Calendar access token');
  }
  if (!res.ok) {
    const text = await res.text();
    logger.warn('calendar_token_refresh_failed', {
      orgId, status: res.status, body: text.slice(0, 300),
    });
    await pool.query(
      `UPDATE org_calendar_connections
          SET status     = CASE WHEN $2 = 400 THEN 'revoked' ELSE 'error' END,
              last_error = $3,
              updated_at = NOW()
        WHERE org_id = $1`,
      [orgId, res.status, `token_refresh:${res.status}`]
    ).catch(() => {});
    const err = new Error(`Calendar token refresh failed (${res.status})`);
    err.code = res.status === 400 ? 'CALENDAR_TOKEN_REVOKED' : 'CALENDAR_TOKEN_REFRESH_FAILED';
    throw err;
  }
  const json = await res.json();
  const accessToken = json.access_token;
  const expiresIn   = Number(json.expires_in || 3600);
  const newExpiresAt = new Date(Date.now() + expiresIn * 1000);

  await pool.query(
    `UPDATE org_calendar_connections
        SET access_token             = $2,
            access_token_expires_at  = $3,
            last_error               = NULL,
            updated_at               = NOW()
      WHERE org_id = $1`,
    [orgId, accessToken, newExpiresAt.toISOString()]
  );
  return accessToken;
}

/**
 * Authenticated fetch against the Calendar REST API. Returns parsed JSON, or
 * throws with a coded error on non-2xx.
 */
async function apiFetch(orgId, path, { method = 'GET', query, body } = {}) {
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
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  if (!res.ok) {
    const detail = json?.error?.message || `HTTP ${res.status}`;
    const err = new Error(`Calendar API ${method} ${path} failed: ${detail}`);
    err.code = res.status === 401 || res.status === 403 ? 'CALENDAR_TOKEN_REVOKED' : 'CALENDAR_API_ERROR';
    err.statusCode = res.status;
    throw err;
  }
  return json;
}

/**
 * List events on a calendar. Defaults to singleEvents (expands recurring events
 * into instances) ordered by start time. When `updatedMin` is provided we pull
 * only events changed since then — the incremental-sync cursor. Returns the raw
 * Google event objects (calendarSync normalizes them).
 */
async function listEvents(orgId, { updatedMin, timeMin, timeMax, maxResults = 100, calendarId = 'primary' } = {}) {
  const query = {
    singleEvents: 'true',
    orderBy:      'updated', // updatedMin requires orderBy=updated
    maxResults:   String(Math.max(1, Math.min(250, Number(maxResults) || 100))),
    showDeleted:  'false',
  };
  if (updatedMin) query.updatedMin = new Date(updatedMin).toISOString();
  if (timeMin)    query.timeMin    = new Date(timeMin).toISOString();
  if (timeMax)    query.timeMax    = new Date(timeMax).toISOString();
  const path = `/calendars/${encodeURIComponent(calendarId)}/events`;
  const json = await apiFetch(orgId, path, { query });
  return json.items || [];
}

/**
 * Insert an event on the user's calendar. `event` is a Google Calendar event
 * resource (summary/description/start/end/attendees). Returns the created event
 * resource (includes id, htmlLink, hangoutLink).
 */
async function insertEvent(orgId, event, { calendarId = 'primary', sendUpdates = 'all' } = {}) {
  const path = `/calendars/${encodeURIComponent(calendarId)}/events`;
  const json = await apiFetch(orgId, path, {
    method: 'POST',
    query: { sendUpdates },
    body: event,
  });
  return json;
}

module.exports = {
  isConfigured,
  loadConnection,
  getAccessToken,
  listEvents,
  insertEvent,
  apiFetch,
};
