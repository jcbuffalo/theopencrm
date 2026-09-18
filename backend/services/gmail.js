// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Gmail integration — thin googleapis wrapper used by gmailSync and routes.
//
// SCOPE: Loads the active `org_gmail_connections` row for an org, refreshes
// the cached access token against Google's OAuth endpoint when expired,
// and exposes:
//
//   getAccessToken(orgId)              → valid bearer string for hand-rolled calls
//   getGmailClient(orgId)              → configured googleapis.gmail({version:'v1'}) client
//   searchThreads(orgId, q, maxResults=25) → users.threads.list({ q, maxResults })
//   getThreadMeta(orgId, threadId)     → users.threads.get(format=metadata)
//   fetchThread(orgId, threadId)       → users.threads.get(format=full) raw payload
//
// Plus helper:
//
//   isConfigured()                     → async; mirrors driveOAuth.isConfigured()
//
// GRACEFUL DEGRADATION:
//   If the OAuth client isn't configured, isConfigured() returns false.
//   Routes consume this and return 503 with a "Gmail not configured"
//   message. We never throw at module-load time — mirrors services/
//   email.js, services/ai.js, services/drive.js.
//
// NO PII IN LOGS:
//   We log gmail_message_id, thread_id, mime_type, sizes — never body
//   text, never participant addresses. Audit log + DB rows are where the
//   PII lives intentionally; logs are not.

const logger = require('./logger');
const pool = require('../db');
const gmailOAuth = require('./gmailOAuth');

// Lazy-loaded googleapis so this module survives an env without the dep
// installed. In normal operation the first call caches it.
let _googleapis = null;
function googleapis() {
  if (_googleapis) return _googleapis;
  try {
    _googleapis = require('googleapis');
  } catch (err) {
    logger.warn('gmail_googleapis_unavailable', { error: err.message });
    throw new Error('googleapis package is not installed');
  }
  return _googleapis;
}

// gmailTokens is the encryption seam (re-exports driveTokens today; see
// services/gmailTokens.js for the rationale). Lazy-loaded for the same
// reason as the driveTokens shim in services/drive.js.
let _gmailTokens = null;
function gmailTokens() {
  if (_gmailTokens) return _gmailTokens;
  try {
    _gmailTokens = require('./gmailTokens');
  } catch (err) {
    throw new Error('Gmail token service is not available yet. Have you applied migration 091 and shipped services/gmailTokens.js?');
  }
  return _gmailTokens;
}

// Async because gmailOAuth.isConfigured() consults the DB-first
// platform_integrations row.
async function isConfigured() {
  return gmailOAuth.isConfigured();
}

/**
 * Load the org's Gmail connection row, raising if there isn't one.
 * Returns the raw row including ciphertext bytes — callers should pass
 * the row to refreshAccessToken if they need an access token.
 */
async function loadConnection(orgId) {
  if (!orgId) throw new Error('orgId required');
  const r = await pool.query(
    `SELECT id, org_id, google_user_email, refresh_token_ciphertext,
            refresh_token_iv, refresh_token_tag, access_token,
            access_token_expires_at, scopes, status
       FROM org_gmail_connections
      WHERE org_id = $1
      LIMIT 1`,
    [orgId]
  );
  if (r.rows.length === 0) {
    const err = new Error('No Gmail connection for this org');
    err.code = 'GMAIL_NOT_CONNECTED';
    throw err;
  }
  const row = r.rows[0];
  if (row.status !== 'active') {
    const err = new Error(`Gmail connection status is "${row.status}"`);
    err.code = 'GMAIL_CONNECTION_INACTIVE';
    throw err;
  }
  return row;
}

/**
 * Returns a valid access token for the org. Refreshes via Google's OAuth
 * token endpoint if the cached access_token is missing or within 60s of
 * expiry. Writes the new access_token + expiry back to the row.
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
  const creds = await gmailOAuth.getCreds();
  if (!creds) {
    const err = new Error('Gmail OAuth client is not configured on the backend');
    err.code = 'GMAIL_NOT_CONFIGURED';
    throw err;
  }
  // Decrypt the refresh token via the shared driveTokens encryption shim.
  const refreshToken = gmailTokens().decrypt({
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
    logger.warn('gmail_token_refresh_network_error', { orgId, error: err.message });
    throw new Error('Network error refreshing Gmail access token');
  }
  if (!res.ok) {
    const text = await res.text();
    logger.warn('gmail_token_refresh_failed', {
      orgId, status: res.status, body: text.slice(0, 300),
    });
    // Persist last_error for operator visibility.
    await pool.query(
      `UPDATE org_gmail_connections
          SET status     = CASE WHEN $2 = 400 THEN 'revoked' ELSE 'error' END,
              last_error = $3,
              updated_at = NOW()
        WHERE org_id = $1`,
      [orgId, res.status, `token_refresh:${res.status}`]
    ).catch(() => {});
    const err = new Error(`Gmail token refresh failed (${res.status})`);
    err.code = res.status === 400 ? 'GMAIL_TOKEN_REVOKED' : 'GMAIL_TOKEN_REFRESH_FAILED';
    throw err;
  }
  const json = await res.json();
  const accessToken = json.access_token;
  const expiresIn   = Number(json.expires_in || 3600);
  const newExpiresAt = new Date(Date.now() + expiresIn * 1000);

  await pool.query(
    `UPDATE org_gmail_connections
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
 * Build a configured googleapis Gmail v1 client for the given org. The
 * returned object has `.users.threads.list / .get`, `.users.messages.list /
 * .get`, etc.
 */
async function getGmailClient(orgId) {
  const { google } = googleapis();
  const accessToken = await getAccessToken(orgId);
  const creds = await gmailOAuth.getCreds();
  const auth = new google.auth.OAuth2(creds?.clientId, creds?.clientSecret);
  auth.setCredentials({ access_token: accessToken });
  return google.gmail({ version: 'v1', auth });
}

/**
 * Search the user's Gmail for threads matching `q` (the same query
 * grammar the Gmail search box accepts). Returns up to `maxResults`
 * thread stubs with subject/snippet/participants — the picker UI shape.
 *
 * Gmail's users.threads.list returns only { id, snippet, historyId } for
 * each hit — no subject, no participants. So we follow the list with a
 * users.threads.get(format='metadata') per hit to pick those out of the
 * top message's headers. We cap maxResults at 25 by default so this fan-
 * out stays bounded.
 */
async function searchThreads(orgId, q, maxResults = 25) {
  const gmail = await getGmailClient(orgId);
  const cap = Math.max(1, Math.min(50, Number(maxResults) || 25));
  const listRes = await gmail.users.threads.list({
    userId: 'me',
    q: String(q || '').slice(0, 500),
    maxResults: cap,
  });
  const stubs = listRes.data.threads || [];
  if (stubs.length === 0) return [];

  // Per-hit metadata fetch. Bounded to `cap` and run in parallel — Gmail's
  // per-user-per-second quota (250 units) tolerates this for picker use.
  const detailed = await Promise.all(
    stubs.map(async (s) => {
      try {
        const meta = await gmail.users.threads.get({
          userId: 'me',
          id: s.id,
          format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'To', 'Cc', 'Date'],
        });
        const messages = meta.data.messages || [];
        const headersOf = (msg) => {
          const out = {};
          for (const h of (msg.payload?.headers || [])) {
            out[String(h.name || '').toLowerCase()] = h.value || '';
          }
          return out;
        };
        const firstHeaders = messages[0] ? headersOf(messages[0]) : {};
        const participants = new Set();
        for (const m of messages) {
          const h = headersOf(m);
          for (const field of ['from', 'to', 'cc']) {
            const raw = h[field];
            if (!raw) continue;
            for (const addr of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
              participants.add(addr);
            }
          }
        }
        const lastMsg = messages[messages.length - 1];
        const lastDate = lastMsg?.internalDate
          ? new Date(Number(lastMsg.internalDate)).toISOString()
          : null;
        return {
          gmail_thread_id: s.id,
          subject:         firstHeaders.subject || '(no subject)',
          snippet:         s.snippet || meta.data.snippet || '',
          participants:    Array.from(participants),
          message_count:   messages.length,
          last_message_at: lastDate,
        };
      } catch (err) {
        logger.warn('gmail_thread_meta_failed', {
          orgId, thread_id: s.id, error: err.message,
        });
        return null;
      }
    })
  );
  return detailed.filter(Boolean);
}

/**
 * Lightweight metadata fetch for a single thread (used when linking — we
 * persist subject / participants / message_count without paying for the
 * full payload).
 */
async function getThreadMeta(orgId, threadId) {
  const gmail = await getGmailClient(orgId);
  const meta = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'metadata',
    metadataHeaders: ['Subject', 'From', 'To', 'Cc', 'Date'],
  });
  const messages = meta.data.messages || [];
  const headersOf = (msg) => {
    const out = {};
    for (const h of (msg.payload?.headers || [])) {
      out[String(h.name || '').toLowerCase()] = h.value || '';
    }
    return out;
  };
  const firstHeaders = messages[0] ? headersOf(messages[0]) : {};
  const participants = new Set();
  for (const m of messages) {
    const h = headersOf(m);
    for (const field of ['from', 'to', 'cc']) {
      const raw = h[field];
      if (!raw) continue;
      for (const addr of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
        participants.add(addr);
      }
    }
  }
  const lastMsg = messages[messages.length - 1];
  const lastDate = lastMsg?.internalDate
    ? new Date(Number(lastMsg.internalDate))
    : null;
  return {
    gmail_thread_id: threadId,
    subject:         firstHeaders.subject || '(no subject)',
    participants:    Array.from(participants),
    message_count:   messages.length,
    last_message_at: lastDate ? lastDate.toISOString() : null,
  };
}

/**
 * Fetch a thread with full message payloads. The full payload is what
 * gmailExtract.js needs to walk the MIME tree and pick text/plain or
 * text/html bodies. Returns the raw users.threads.get response.data.
 */
async function fetchThread(orgId, threadId) {
  const gmail = await getGmailClient(orgId);
  const res = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'full',
  });
  return res.data;
}

module.exports = {
  isConfigured,
  loadConnection,
  getAccessToken,
  getGmailClient,
  searchThreads,
  getThreadMeta,
  fetchThread,
};
