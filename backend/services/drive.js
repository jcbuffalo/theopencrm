// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Drive Intel — thin googleapis wrapper used by driveSync and the routes.
//
// SCOPE: This module loads the active `org_drive_connections` row for an
// org, refreshes the access token against Google's OAuth endpoint when
// expired, and exposes two operations:
//
//   listFolderFiles(orgId, folderId)      → [{ id, name, mimeType, size, modifiedTime }]
//   downloadFileText(orgId, fileId, mime) → { mimeType, sizeBytes, buffer | text, isGoogleExport }
//
// Plus helpers:
//
//   isConfigured()                        → true iff GOOGLE_DRIVE_CLIENT_ID is set
//   searchFolders(orgId, q)               → folder hits for the picker
//   getFileMeta(orgId, fileId)            → metadata-only (used by the link verifier)
//
// GRACEFUL DEGRADATION:
//   - If GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET are unset,
//     isConfigured() returns false. The routes consume this and return
//     503 with a "Drive not configured" message. We never throw at
//     module-load time — mirrors services/email.js and services/ai.js.
//
// AGENT-1 COORDINATION:
//   - The decryptRefreshToken helper lives in services/driveTokens.js,
//     which Agent 1 ships. This module requires it lazily inside the
//     loader so vitest can stub the file when Agent 1's deliverables
//     have not yet merged.
//
// NO PII IN LOGS:
//   - We log drive_file_id, name, size, mime — never content_text.

const logger = require('./logger');
const pool = require('../db');
const driveOAuth = require('./driveOAuth');

// PLATFORM_INTEGRATIONS_SPEC.md refactor: credentials now come from
// driveOAuth.getCreds(), which consults the platform_integrations DB row
// first and falls back to GOOGLE_DRIVE_* env vars. No more module-load-time
// constants — an in-app save should take effect within the platform-
// integrations cache TTL (60s) without a redeploy.

// Lazy-loaded so the route layer can `require('./drive')` even in dev
// without googleapis installed yet. (Once npm install runs the lazy load
// is a single-line cache after first call.)
let _googleapis = null;
function googleapis() {
  if (_googleapis) return _googleapis;
  try {
    _googleapis = require('googleapis');
  } catch (err) {
    logger.warn('drive_googleapis_unavailable', { error: err.message });
    throw new Error('googleapis package is not installed');
  }
  return _googleapis;
}

// driveTokens.decryptRefreshToken is loaded lazily so this module survives
// the brief window where Agent 1's services/driveTokens.js hasn't merged
// yet. In normal operation the first call caches it.
let _driveTokens = null;
function driveTokens() {
  if (_driveTokens) return _driveTokens;
  try {
    _driveTokens = require('./driveTokens');
  } catch (err) {
    // Surface a clear error rather than a confusing MODULE_NOT_FOUND
    // a few stack frames deep. The routes catch this and return 503.
    throw new Error('Drive token service is not available yet. Have you applied migration 085 and shipped services/driveTokens.js?');
  }
  return _driveTokens;
}

// Async because driveOAuth.isConfigured() consults the DB-first
// platform_integrations row. Callers (route gates) already await this.
async function isConfigured() {
  return driveOAuth.isConfigured();
}

/**
 * Load the org's Drive connection row, raising if there isn't one.
 * Returns the raw row including ciphertext bytes — callers should pass
 * the row to refreshAccessToken if they need an access token.
 */
async function loadConnection(orgId) {
  if (!orgId) throw new Error('orgId required');
  const r = await pool.query(
    `SELECT id, org_id, google_user_email, refresh_token_ciphertext,
            refresh_token_iv, refresh_token_tag, access_token,
            access_token_expires_at, scopes, status
       FROM org_drive_connections
      WHERE org_id = $1
      LIMIT 1`,
    [orgId]
  );
  if (r.rows.length === 0) {
    const err = new Error('No Drive connection for this org');
    err.code = 'DRIVE_NOT_CONNECTED';
    throw err;
  }
  const row = r.rows[0];
  if (row.status !== 'active') {
    const err = new Error(`Drive connection status is "${row.status}"`);
    err.code = 'DRIVE_CONNECTION_INACTIVE';
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
  // DB-first creds via driveOAuth.getCreds (platform_integrations table,
  // env-var fallback). See PLATFORM_INTEGRATIONS_SPEC.md.
  const creds = await driveOAuth.getCreds();
  if (!creds) {
    const err = new Error('Drive OAuth client is not configured on the backend');
    err.code = 'DRIVE_NOT_CONFIGURED';
    throw err;
  }
  // Decrypt the refresh token via Agent 1's helper.
  const refreshToken = driveTokens().decryptRefreshToken({
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
    logger.warn('drive_token_refresh_network_error', { orgId, error: err.message });
    throw new Error('Network error refreshing Drive access token');
  }
  if (!res.ok) {
    const text = await res.text();
    logger.warn('drive_token_refresh_failed', {
      orgId, status: res.status, body: text.slice(0, 300),
    });
    // Persist last_error for operator visibility.
    await pool.query(
      `UPDATE org_drive_connections
          SET status     = CASE WHEN $2 = 400 THEN 'revoked' ELSE 'error' END,
              last_error = $3,
              updated_at = NOW()
        WHERE org_id = $1`,
      [orgId, res.status, `token_refresh:${res.status}`]
    ).catch(() => {});
    const err = new Error(`Drive token refresh failed (${res.status})`);
    err.code = res.status === 400 ? 'DRIVE_TOKEN_REVOKED' : 'DRIVE_TOKEN_REFRESH_FAILED';
    throw err;
  }
  const json = await res.json();
  const accessToken = json.access_token;
  const expiresIn   = Number(json.expires_in || 3600);
  const newExpiresAt = new Date(Date.now() + expiresIn * 1000);

  await pool.query(
    `UPDATE org_drive_connections
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
 * Build a configured googleapis Drive client for the given org. The
 * returned object has the `.files.list` / `.files.get` / `.files.export`
 * methods used elsewhere in this file.
 */
async function getDriveClient(orgId) {
  const { google } = googleapis();
  const accessToken = await getAccessToken(orgId);
  const creds = await driveOAuth.getCreds();
  // accessToken already minted — but if creds vanished between mint and
  // here (extremely narrow race), googleapis's OAuth2 constructor still
  // accepts undefined client id/secret and uses only the access token for
  // bearer auth on file ops. Pass them when we have them for the unlikely
  // case the SDK needs to refresh again internally.
  const auth = new google.auth.OAuth2(creds?.clientId, creds?.clientSecret);
  auth.setCredentials({ access_token: accessToken });
  return google.drive({ version: 'v3', auth });
}

/**
 * List every non-trashed file directly inside `folderId`. Returns an
 * array of { id, name, mimeType, size, modifiedTime }. Pages through
 * results so large folders are handled.
 */
async function listFolderFiles(orgId, folderId) {
  const drive = await getDriveClient(orgId);
  const out = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: false,
      includeItemsFromAllDrives: false,
    });
    for (const f of res.data.files || []) out.push(f);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  logger.info('drive_folder_listed', { orgId, folderId, count: out.length });
  return out;
}

/**
 * Folder-search proxy for the picker. Returns up to 25 hits.
 */
async function searchFolders(orgId, query) {
  const drive = await getDriveClient(orgId);
  // Escape single quotes in the user-supplied search term to prevent
  // breaking the q expression. Drive doesn't accept parameterized
  // queries, so manual escape is the only option.
  const safe = String(query || '').replace(/'/g, "\\'").slice(0, 200);
  const q = safe
    ? `mimeType = 'application/vnd.google-apps.folder' and trashed = false and name contains '${safe}'`
    : `mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const res = await drive.files.list({
    q,
    fields: 'files(id, name, modifiedTime, webViewLink, parents)',
    pageSize: 25,
    orderBy: 'modifiedTime desc',
  });
  return res.data.files || [];
}

/**
 * Fetch a single file's metadata (used by the folder-link verifier and
 * other "does the user actually have access" probes).
 */
async function getFileMeta(orgId, fileId) {
  const drive = await getDriveClient(orgId);
  const res = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, size, modifiedTime, webViewLink',
  });
  return res.data;
}

/**
 * Download the raw bytes (for binary files) or the exported text body
 * (for Google-native docs). Returns { mimeType, sizeBytes, buffer?, text?,
 * isGoogleExport }.
 *
 * For Google Docs / Sheets / Slides we ask the API to export as text/plain
 * — far cheaper than downloading the native format and parsing it. For
 * everything else we get the raw bytes and let driveExtract.js decide.
 */
async function downloadFileText(orgId, fileId, mimeType) {
  const drive = await getDriveClient(orgId);
  const isGoogleDoc =
    mimeType === 'application/vnd.google-apps.document' ||
    mimeType === 'application/vnd.google-apps.spreadsheet' ||
    mimeType === 'application/vnd.google-apps.presentation';

  if (isGoogleDoc) {
    const res = await drive.files.export(
      { fileId, mimeType: 'text/plain' },
      { responseType: 'text' }
    );
    const text = typeof res.data === 'string' ? res.data : String(res.data || '');
    return {
      mimeType: 'text/plain',
      sizeBytes: Buffer.byteLength(text, 'utf8'),
      text,
      isGoogleExport: true,
    };
  }
  // Otherwise download as binary. responseType=arraybuffer gives us a
  // Buffer-compatible result we can hand to pdf-parse / mammoth.
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  const buffer = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data);
  return {
    mimeType,
    sizeBytes: buffer.length,
    buffer,
    isGoogleExport: false,
  };
}

module.exports = {
  isConfigured,
  loadConnection,
  getAccessToken,
  getDriveClient,
  listFolderFiles,
  searchFolders,
  getFileMeta,
  downloadFileText,
};
