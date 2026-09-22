// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Developer-platform Personal Access Tokens (API keys) — core logic.
//
// This module owns the cryptography + DB access for API keys. It is kept
// separate from middleware/apiKeyAuth.js (the Express glue) and
// routes/apiKeyRoutes.js (the management REST surface) so the pure functions
// — key generation, hashing, header parsing — are unit-testable without an
// HTTP stack or a real DB.
//
// KEY FORMAT
//   tocrm_<40 hex chars>
//   ^^^^^ distinct, greppable prefix so this scheme never collides with the
//   JWT session cookie. A leaked key is instantly recognizable in logs and can
//   be revoked. The `Authorization: Bearer` JWT fallback was removed from
//   auth.js on 2026-06-30 — API keys deliberately reuse the Bearer header with
//   this prefix instead, and apiKeyAuth is a SEPARATE middleware that never
//   calls verifyToken().
//
// STORAGE
//   Only sha256(fullKey) is persisted (api_keys.key_hash). The plaintext is
//   returned to the creating admin exactly once. key_prefix (tocrm_ + first 8
//   hex chars) is stored in the clear as a non-secret display id.

const crypto = require('crypto');
const pool = require('../db');

// Distinct, human-recognizable scheme prefix. Everything after it is secret.
const KEY_PREFIX = 'tocrm_';

// 20 random bytes → 40 hex chars of entropy. Plenty (160 bits) and keeps the
// token a comfortable length.
const SECRET_BYTES = 20;

// Length of the non-secret display prefix stored in key_prefix, e.g.
// "tocrm_ab12cd34" — the scheme prefix plus the first 8 hex chars.
const DISPLAY_HEX_CHARS = 8;

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

// Generate a fresh key. Returns the plaintext (to hand back to the caller
// ONCE), the display prefix (safe to store/show), and the hash (what we
// persist and later look up on).
function generateKey() {
  const hex = crypto.randomBytes(SECRET_BYTES).toString('hex');
  const fullKey = `${KEY_PREFIX}${hex}`;
  return {
    fullKey,
    keyPrefix: `${KEY_PREFIX}${hex.slice(0, DISPLAY_HEX_CHARS)}`,
    keyHash: sha256Hex(fullKey),
  };
}

// Pull a candidate key off an inbound request. Accepts either:
//   Authorization: Bearer tocrm_...
//   X-API-Key: tocrm_...
// Returns the raw token string, or null if neither carries a tocrm_ key.
// Note: a Bearer header that is NOT a tocrm_ key returns null here so the
// JWT/cookie path is never shadowed (though that path no longer reads Bearer).
function extractKeyFromRequest(req) {
  const xApiKey = req.headers && req.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.startsWith(KEY_PREFIX)) {
    return xApiKey.trim();
  }
  const authz = req.headers && req.headers['authorization'];
  if (typeof authz === 'string') {
    const m = authz.match(/^Bearer\s+(\S+)$/i);
    if (m && m[1].startsWith(KEY_PREFIX)) return m[1].trim();
  }
  return null;
}

function looksLikeApiKey(token) {
  return typeof token === 'string' && token.startsWith(KEY_PREFIX);
}

// Look up an ACTIVE (non-revoked) key by its plaintext. Returns the row or
// null. Does not mutate last_used_at — the caller (middleware) does that
// fire-and-forget so a lookup used purely for validation stays read-only.
async function findActiveByPlaintext(fullKey) {
  if (!looksLikeApiKey(fullKey)) return null;
  const keyHash = sha256Hex(fullKey);
  // The creator's org_role / status ride along: a key acts AS its creator
  // (org-admin keys can manage webhooks and pipelines; a key whose creator
  // was suspended or deleted stops working — checked by the middleware).
  const r = await pool.query(
    `SELECT k.id, k.org_id, k.name, k.key_prefix, k.scopes, k.created_by, k.last_used_at, k.revoked_at, k.created_at,
            u.org_role AS creator_org_role, u.status AS creator_status, u.org_id AS creator_org_id
       FROM api_keys k
       LEFT JOIN users u ON u.id = k.created_by
      WHERE k.key_hash = $1`,
    [keyHash]
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.revoked_at) return null; // soft-deleted — reject
  return row;
}

// Fire-and-forget last_used_at bump. Never throws into the request path.
async function touchLastUsed(id) {
  try {
    await pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [id]);
  } catch {
    /* best-effort — a metering write must never break an authenticated call */
  }
}

module.exports = {
  KEY_PREFIX,
  sha256Hex,
  generateKey,
  extractKeyFromRequest,
  looksLikeApiKey,
  findActiveByPlaintext,
  touchLastUsed,
};
