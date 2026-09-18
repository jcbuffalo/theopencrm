// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Bring-your-own Anthropic key per org (migration 154).
//
// WHAT: an org owner/admin can store their own Anthropic API key. Every AI
// call the org makes then goes out under THAT key (services/ai.js prefers it
// over the deployment-wide ANTHROPIC_API_KEY), Anthropic bills the customer
// directly at list price, and we meter the call with charged_usd_micro = 0
// (billing_mode = 'byo_key'). The pay-as-you-go gate
// (middleware/requireAiBilling.js) lets a BYO org straight through.
//
// STORAGE: same AES-256-GCM (ciphertext, iv, tag) tuple as every other
// in-app secret, encrypted with DRIVE_TOKEN_ENCRYPTION_KEY through
// services/driveTokens.js — we deliberately reuse that helper rather than
// grow a second crypto path. The plaintext never hits a log line, an audit
// row, or an API response; key_last4 is the only fragment the UI ever sees.
//
// CACHE: 30-second in-process cache keyed by orgId (same TTL idiom as
// featureFlags / aiModel / requireAiBilling). getOrgKey sits on the hot path
// of every AI call, so a cache miss costs one indexed SELECT + one decrypt;
// hits are free. setOrgKey / clearOrgKey bust the entry so a change is
// visible on the same pod immediately and on other pods within 30s.
//
// VALIDATION: setOrgKey makes ONE cheap probe call (max_tokens=1) to
// Anthropic before storing. A 401/403 means the key is simply wrong and we
// refuse to store it (storing a dead key would break every AI feature for
// the org). Any other failure (network, 429, 529 overloaded) is recorded as
// last_error but the key is still stored — those responses mean Anthropic
// authenticated it and is merely busy.
//
// TEST BYPASS: vitest runs with NODE_ENV=test and dozens of suites queue
// ordered pool.query responses for callClaude / the billing gate. A new
// SELECT on every AI call would shift those queues and cascade-fail them,
// so getOrgKey is a no-op under test unless ORG_AI_KEYS_IN_TESTS=true (the
// same opt-in pattern as AI_BILLING_REQUIRED_IN_TESTS).

const pool = require('../db');
const logger = require('./logger');
const driveTokens = require('./driveTokens');
const aiModel = require('./aiModel');

const TTL_MS = 30_000;
const cache = new Map(); // orgId → { key: string|null, expiresAt }

const PROVIDER = 'anthropic';
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Anthropic keys are "sk-ant-" + a variant tag + a long base62/_- body. We
// only assert the prefix, a sane length, and the character set — Anthropic
// owns the real format and rotates it; the probe call is the true validator.
const KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,}$/;
const MAX_KEY_LEN = 256;

class OrgAiKeyError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'OrgAiKeyError';
    this.code = code;
    this.status = status;
  }
}

function testBypassActive() {
  return process.env.NODE_ENV === 'test' && process.env.ORG_AI_KEYS_IN_TESTS !== 'true';
}

function normalizeKey(raw) {
  return typeof raw === 'string' ? raw.trim() : '';
}

function isValidKeyFormat(raw) {
  const key = normalizeKey(raw);
  return key.length > 0 && key.length <= MAX_KEY_LEN && KEY_RE.test(key);
}

function last4Of(key) {
  return key.slice(-4);
}

/**
 * Resolve the org's decrypted BYO key, or null when the org has none (or the
 * stored row can't be decrypted — logged, treated as "no key" so AI falls
 * back to the platform key rather than 500ing). Never throws.
 */
async function getOrgKey(orgId) {
  if (!orgId) return null;
  if (testBypassActive()) return null;
  const cached = cache.get(orgId);
  if (cached && cached.expiresAt > Date.now()) return cached.key;
  let key = null;
  try {
    const r = await pool.query(
      `SELECT key_ciphertext, key_iv, key_tag FROM org_ai_keys WHERE org_id = $1 AND provider = $2`,
      [orgId, PROVIDER]
    );
    const row = r.rows[0];
    if (row) {
      key = driveTokens.decrypt({ ciphertext: row.key_ciphertext, iv: row.key_iv, tag: row.key_tag });
    }
  } catch (err) {
    // Wrong master key / tampered row / DB blip: fall back to the platform
    // key rather than taking AI offline. The status endpoint exposes
    // last_error so an admin can re-save the key.
    logger.warn('org_ai_key_resolve_failed', { orgId, error: err.message });
    key = null;
  }
  cache.set(orgId, { key, expiresAt: Date.now() + TTL_MS });
  return key;
}

/**
 * Synchronous "do we already know this org has a key" check for the sync
 * ai.isConfigured(orgId) path. Only consults the in-process cache — a cold
 * cache answers false, and the async resolver is what the actual call uses.
 */
function hasKeyCached(orgId) {
  if (!orgId) return false;
  const cached = cache.get(orgId);
  return !!(cached && cached.expiresAt > Date.now() && cached.key);
}

/**
 * Public-shape status for GET /api/org/ai-key. Never includes the key.
 */
async function getStatus(orgId) {
  const empty = {
    configured: false,
    provider: PROVIDER,
    last4: null,
    last_validated_at: null,
    last_error: null,
    updated_at: null,
    billing_mode: 'platform',
  };
  if (!orgId) return empty;
  const r = await pool.query(
    `SELECT key_last4, last_validated_at, last_error, updated_at
       FROM org_ai_keys WHERE org_id = $1 AND provider = $2`,
    [orgId, PROVIDER]
  );
  const row = r.rows[0];
  if (!row) return empty;
  return {
    configured: true,
    provider: PROVIDER,
    last4: row.key_last4,
    last_validated_at: row.last_validated_at || null,
    last_error: row.last_error || null,
    updated_at: row.updated_at || null,
    billing_mode: 'byo_key',
  };
}

/**
 * One minimal messages call to Anthropic with the candidate key. Returns
 * { ok: true } on 2xx, { ok: false, rejected: true, error } on 401/403 (the
 * key is wrong), or { ok: false, rejected: false, error } for anything else
 * (transient — key may still be fine).
 */
async function validateAnthropicKey(key, model) {
  try {
    const res = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    if (res.ok) return { ok: true };
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error?.message || '';
    } catch { /* non-JSON body: ignore */ }
    const summary = `Anthropic returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
    if (res.status === 401 || res.status === 403) {
      return { ok: false, rejected: true, error: summary };
    }
    return { ok: false, rejected: false, error: summary };
  } catch (err) {
    return { ok: false, rejected: false, error: `Could not reach Anthropic: ${err.message}` };
  }
}

/**
 * Validate + encrypt + upsert the org's key. Throws OrgAiKeyError with a
 * machine-readable code on a bad key so the route can map it to 4xx.
 *
 * @returns {Promise<object>} the same public shape as getStatus()
 */
async function setOrgKey(orgId, rawKey, userId = null, { validate = true } = {}) {
  if (!orgId) throw new OrgAiKeyError('ORG_REQUIRED', 'An organization is required to store an AI key.', 400);
  const key = normalizeKey(rawKey);
  if (!isValidKeyFormat(key)) {
    throw new OrgAiKeyError(
      'INVALID_KEY_FORMAT',
      'That does not look like an Anthropic API key. Keys start with "sk-ant-" — copy it from console.anthropic.com.',
      400
    );
  }
  if (!driveTokens.isConfigured()) {
    // Never persist ciphertext we can't decrypt later.
    throw new OrgAiKeyError(
      'ENCRYPTION_UNAVAILABLE',
      'This deployment cannot store secrets: DRIVE_TOKEN_ENCRYPTION_KEY is not configured on the backend.',
      503
    );
  }

  let lastValidatedAt = null;
  let lastError = null;
  if (validate) {
    const { model } = await aiModel.getOrgAiSettings(orgId);
    const probe = await validateAnthropicKey(key, model);
    if (probe.ok) {
      lastValidatedAt = new Date();
    } else if (probe.rejected) {
      throw new OrgAiKeyError('KEY_REJECTED', `Anthropic rejected this key. ${probe.error}`, 422);
    } else {
      lastError = probe.error;
    }
  }

  const enc = driveTokens.encrypt(key);
  const r = await pool.query(
    `INSERT INTO org_ai_keys
       (org_id, provider, key_ciphertext, key_iv, key_tag, key_last4,
        created_by_user_id, created_at, updated_at, last_validated_at, last_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), $8, $9)
     ON CONFLICT (org_id) DO UPDATE SET
       provider           = EXCLUDED.provider,
       key_ciphertext     = EXCLUDED.key_ciphertext,
       key_iv             = EXCLUDED.key_iv,
       key_tag            = EXCLUDED.key_tag,
       key_last4          = EXCLUDED.key_last4,
       created_by_user_id = EXCLUDED.created_by_user_id,
       updated_at         = NOW(),
       last_validated_at  = EXCLUDED.last_validated_at,
       last_error         = EXCLUDED.last_error
     RETURNING key_last4, last_validated_at, last_error, updated_at`,
    [orgId, PROVIDER, enc.ciphertext, enc.iv, enc.tag, last4Of(key),
     userId || null, lastValidatedAt, lastError]
  );
  bustCache(orgId);
  const row = r.rows[0] || {};
  return {
    configured: true,
    provider: PROVIDER,
    last4: row.key_last4 || last4Of(key),
    last_validated_at: row.last_validated_at || lastValidatedAt,
    last_error: row.last_error || lastError,
    updated_at: row.updated_at || null,
    billing_mode: 'byo_key',
  };
}

/**
 * Remove the org's key. Returns true when a row was deleted.
 */
async function clearOrgKey(orgId) {
  if (!orgId) return false;
  const r = await pool.query(
    `DELETE FROM org_ai_keys WHERE org_id = $1 AND provider = $2`,
    [orgId, PROVIDER]
  );
  bustCache(orgId);
  return (r.rowCount || 0) > 0;
}

function bustCache(orgId) {
  if (orgId == null) {
    cache.clear();
    return;
  }
  cache.delete(orgId);
}

function _resetForTests() {
  cache.clear();
}

module.exports = {
  PROVIDER,
  OrgAiKeyError,
  isValidKeyFormat,
  getOrgKey,
  hasKeyCached,
  getStatus,
  setOrgKey,
  clearOrgKey,
  validateAnthropicKey,
  bustCache,
  _resetForTests,
};
