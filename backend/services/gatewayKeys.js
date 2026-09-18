// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// AI Gateway keys — core logic (spec 202).
//
// Owns the cryptography + lookup for the ocrm_gw_* keys that authenticate a
// self-hosted instance against POST /api/gateway/v1/messages. Kept separate
// from routes/gatewayRoutes.js (the proxy) and the management endpoints in
// routes/billingRoutes.js so key generation / hashing / lookup are
// unit-testable without an HTTP stack — same split as services/apiKeys.js
// vs routes/apiKeyRoutes.js.
//
// KEY FORMAT
//   ocrm_gw_<43 base64url chars>   (32 random bytes → 43 chars, 256 bits)
//   Distinct, greppable prefix: a leaked gateway key is instantly
//   recognizable in logs and never collides with tocrm_ PATs or the JWT
//   cookie path.
//
// STORAGE
//   Only sha256(fullKey) is persisted (ai_gateway_keys.key_hash, migration
//   168). The plaintext is returned to the minting admin exactly once.
//
// CACHING
//   30s in-process positive cache keyed by key_hash, mirroring the other
//   hot-path caches (featureFlags, requireAiBilling, aiModel). Spec 202's
//   acceptance is "revoking the key 401s within 30s (cache TTL)"; the
//   revoke endpoint additionally calls bustCache so the same pod rejects
//   immediately.

const crypto = require('crypto');
const pool = require('../db');

const KEY_PREFIX = 'ocrm_gw_';
const SECRET_BYTES = 32; // → 43 base64url chars, 256 bits of entropy
const DISPLAY_CHARS = 8; // key_prefix stores scheme prefix + first 8 secret chars

const TTL_MS = 30_000;
const cache = new Map(); // keyHash → { row, expiresAt }

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Mint a fresh key. The plaintext is handed back ONCE; only the hash is stored. */
function generateKey() {
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  const fullKey = `${KEY_PREFIX}${secret}`;
  return {
    fullKey,
    keyPrefix: `${KEY_PREFIX}${secret.slice(0, DISPLAY_CHARS)}`,
    keyHash: sha256Hex(fullKey),
  };
}

function looksLikeGatewayKey(token) {
  return typeof token === 'string' && token.startsWith(KEY_PREFIX);
}

/**
 * Pull a candidate gateway key off an inbound request. Accepts either:
 *   Authorization: Bearer ocrm_gw_...     (spec 202's documented scheme)
 *   x-api-key: ocrm_gw_...                (what the Anthropic SDK / our own
 *                                          services/ai.js client sends when
 *                                          the key is wired in as an apiKey)
 * Returns the raw token string, or null.
 */
function extractKeyFromRequest(req) {
  const authz = req.headers && req.headers['authorization'];
  if (typeof authz === 'string') {
    const m = authz.match(/^Bearer\s+(\S+)$/i);
    if (m && looksLikeGatewayKey(m[1])) return m[1].trim();
  }
  const xApiKey = req.headers && req.headers['x-api-key'];
  if (typeof xApiKey === 'string' && looksLikeGatewayKey(xApiKey)) {
    return xApiKey.trim();
  }
  return null;
}

/**
 * Look up an ACTIVE gateway key by its plaintext. Returns the row
 * ({ id, org_id, label, key_prefix, status }) or null. Positive results are
 * cached for 30s; misses and revoked keys are never cached (a just-minted
 * key must work on first try, and a 401 costs one indexed SELECT).
 */
async function findActiveByPlaintext(fullKey) {
  if (!looksLikeGatewayKey(fullKey)) return null;
  const keyHash = sha256Hex(fullKey);

  const cached = cache.get(keyHash);
  if (cached && cached.expiresAt > Date.now()) return cached.row;

  const r = await pool.query(
    `SELECT id, org_id, label, key_prefix, status
       FROM ai_gateway_keys
      WHERE key_hash = $1`,
    [keyHash]
  );
  const row = r.rows[0];
  if (!row || row.status !== 'active') return null;
  cache.set(keyHash, { row, expiresAt: Date.now() + TTL_MS });
  return row;
}

/**
 * Fire-and-forget usage stamp: last_used_at + requests_count. Never throws
 * into the request path — a metering hiccup must not break a proxied call.
 */
async function touchUsage(id) {
  try {
    await pool.query(
      `UPDATE ai_gateway_keys
          SET last_used_at = NOW(), requests_count = requests_count + 1
        WHERE id = $1`,
      [id]
    );
  } catch {
    /* best-effort */
  }
}

/** Invalidate cached lookups. Called on revoke; no arg clears everything. */
function bustCache(keyHash = null) {
  if (keyHash == null) {
    cache.clear();
    return;
  }
  cache.delete(keyHash);
}

function _resetCachesForTests() {
  cache.clear();
}

module.exports = {
  KEY_PREFIX,
  sha256Hex,
  generateKey,
  looksLikeGatewayKey,
  extractKeyFromRequest,
  findActiveByPlaintext,
  touchUsage,
  bustCache,
  _resetCachesForTests,
};
