// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// SCIM 2.0 provisioning bearer tokens — core crypto + DB access.
//
// Modeled on services/apiKeys.js: a distinct, greppable prefix (scim_), only a
// SHA-256 hash persisted (token_hash), plaintext shown to the admin exactly
// once. Kept separate from the JWT session cookie path entirely — see
// middleware/scimAuth.js.
//
// SCOPING
//   Every token is bound to a single org (scim_tokens.org_id). scimAuth sets
//   req.orgId from the token row, so an IdP can only ever provision users into
//   the org that minted its token. Cross-org provisioning is structurally
//   impossible.

const crypto = require('crypto');
const pool = require('../db');

const KEY_PREFIX = 'scim_';
const SECRET_BYTES = 24;        // 48 hex chars → 192 bits
const DISPLAY_HEX_CHARS = 8;    // scim_ + first 8 hex chars = non-secret display id

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

// Mint a fresh token. Returns { fullToken (shown once), tokenPrefix (display),
// tokenHash (persisted + looked up on) }.
function generateToken() {
  const hex = crypto.randomBytes(SECRET_BYTES).toString('hex');
  const fullToken = `${KEY_PREFIX}${hex}`;
  return {
    fullToken,
    tokenPrefix: `${KEY_PREFIX}${hex.slice(0, DISPLAY_HEX_CHARS)}`,
    tokenHash: sha256Hex(fullToken),
  };
}

function looksLikeScimToken(token) {
  return typeof token === 'string' && token.startsWith(KEY_PREFIX);
}

// Pull a candidate SCIM bearer off a request. SCIM clients use the standard
// Authorization: Bearer header. Returns the raw token or null. A Bearer that
// is not a scim_ token returns null so nothing here shadows other schemes.
function extractTokenFromRequest(req) {
  const authz = req.headers && req.headers['authorization'];
  if (typeof authz === 'string') {
    const m = authz.match(/^Bearer\s+(\S+)$/i);
    if (m && m[1].startsWith(KEY_PREFIX)) return m[1].trim();
  }
  return null;
}

// Look up an ACTIVE (non-revoked) token by plaintext. Returns the row or null.
async function findActiveByPlaintext(fullToken) {
  if (!looksLikeScimToken(fullToken)) return null;
  const tokenHash = sha256Hex(fullToken);
  const r = await pool.query(
    `SELECT id, org_id, name, token_prefix, created_by, last_used_at, revoked_at, created_at
       FROM scim_tokens WHERE token_hash = $1`,
    [tokenHash]
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.revoked_at) return null; // soft-deleted → reject
  return row;
}

// Persist a freshly generated token for an org. Returns the created row's
// public metadata (never the plaintext — the caller already holds it).
async function create({ orgId, name, tokenPrefix, tokenHash, userId }) {
  const r = await pool.query(
    `INSERT INTO scim_tokens (org_id, name, token_prefix, token_hash, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     RETURNING id, org_id, name, token_prefix, created_by, created_at, revoked_at, last_used_at`,
    [orgId, name || null, tokenPrefix, tokenHash, userId || null]
  );
  return r.rows[0];
}

async function listByOrg(orgId) {
  const r = await pool.query(
    `SELECT id, org_id, name, token_prefix, created_by, last_used_at, created_at, revoked_at
       FROM scim_tokens WHERE org_id = $1 ORDER BY created_at DESC`,
    [orgId]
  );
  return r.rows;
}

// Soft-revoke. Org-scoped so one org can't revoke another's token.
async function revoke(id, orgId) {
  const r = await pool.query(
    `UPDATE scim_tokens SET revoked_at = NOW()
       WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL
       RETURNING id`,
    [id, orgId]
  );
  return r.rowCount > 0;
}

// Fire-and-forget last_used_at bump. Never throws into the request path.
async function touchLastUsed(id) {
  try {
    await pool.query('UPDATE scim_tokens SET last_used_at = NOW() WHERE id = $1', [id]);
  } catch {
    /* best-effort */
  }
}

module.exports = {
  KEY_PREFIX,
  sha256Hex,
  generateToken,
  looksLikeScimToken,
  extractTokenFromRequest,
  findActiveByPlaintext,
  create,
  listByOrg,
  revoke,
  touchLastUsed,
};
