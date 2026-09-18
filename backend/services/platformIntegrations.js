// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Platform Integrations service — in-app storage of platform-level
// third-party credentials (OAuth client id/secret/redirect, webhook tokens,
// etc.). See PLATFORM_INTEGRATIONS_SPEC.md for the full design.
//
// SHAPE
//   One row per integration slug in `platform_integrations`.
//     config            JSONB — non-secret config (client_id, redirect_uri, ...)
//     secret_ciphertext + secret_iv + secret_tag — AES-256-GCM encrypted
//                       secret (e.g. OAuth client_secret). Encryption uses
//                       services/driveTokens (master key
//                       DRIVE_TOKEN_ENCRYPTION_KEY).
//
// CACHE
//   60-second TTL in-memory cache per integration slug. Bust on set/clear.
//   The cache is a Map<integration, { value, expiresAt }> where `value` is
//   { config, hasSecret, configured, updatedAt, updatedByUserId } OR the
//   sentinel `null` for "this slug was looked up and the row does not
//   exist" so a not-configured integration doesn't hit the DB on every
//   OAuth call.
//
//   MULTI-POD CAVEAT: each pod has its own cache. A save on pod A is not
//   visible to pod B for up to 60s (the TTL of B's pre-save cached value).
//   Acceptable for an admin-facing knob — the spec calls out that "saved
//   credentials are picked up within 60s without a redeploy".
//
// SECRET ACCESS POLICY
//   getSecret() decrypts and returns the plaintext. Only the server-side
//   OAuth code (driveOAuth.exchangeCodeForTokens / refreshAccessToken) is
//   permitted to call it. Routes that GET integration metadata return
//   `has_secret: bool` only — never the plaintext. See route file.
//
// MASTER-KEY GATE
//   set() refuses if DRIVE_TOKEN_ENCRYPTION_KEY is not configured — there's
//   no point persisting ciphertext we can't decrypt later. The route
//   surfaces this as a 503 with operator-facing guidance.

const pool = require('../db');
const driveTokens = require('./driveTokens');

// --- Integration registry --------------------------------------------------

// Per-integration validation and field whitelisting. New integrations get
// added here as their cards ship (Phase 2: gmail, stripe, teams, zoom).
const INTEGRATIONS = {
  drive: {
    configFields: ['client_id', 'redirect_uri'],
    secretField:  'client_secret',
    validateConfig: (cfg) => {
      if (!cfg || typeof cfg !== 'object') return 'config must be an object';
      if (typeof cfg.client_id !== 'string' || cfg.client_id.length === 0) {
        return 'client_id is required';
      }
      if (!cfg.client_id.endsWith('.apps.googleusercontent.com')) {
        return 'client_id must be a Google OAuth client (.apps.googleusercontent.com)';
      }
      if (typeof cfg.redirect_uri !== 'string' || cfg.redirect_uri.length === 0) {
        return 'redirect_uri is required';
      }
      let parsed;
      try { parsed = new URL(cfg.redirect_uri); }
      catch { return 'redirect_uri must be a valid URL'; }
      if (parsed.protocol !== 'https:') {
        return 'redirect_uri must be https://';
      }
      return null;
    },
  },
  // Gmail integration foundation. Shape is identical to Drive — same
  // Google OAuth client format, same https-only redirect rule. A separate
  // registry entry rather than reusing Drive's row so the two scopes
  // (drive.readonly vs gmail.readonly) can be granted by distinct Google
  // Cloud projects / OAuth clients when the operator wants to keep CASA
  // verification surfaces isolated (Gmail's gmail.readonly is a Google
  // "restricted" scope; Drive's drive.readonly is "sensitive" — different
  // review queues).
  gmail: {
    configFields: ['client_id', 'redirect_uri'],
    secretField:  'client_secret',
    validateConfig: (cfg) => {
      if (!cfg || typeof cfg !== 'object') return 'config must be an object';
      if (typeof cfg.client_id !== 'string' || cfg.client_id.length === 0) {
        return 'client_id is required';
      }
      if (!cfg.client_id.endsWith('.apps.googleusercontent.com')) {
        return 'client_id must be a Google OAuth client (.apps.googleusercontent.com)';
      }
      if (typeof cfg.redirect_uri !== 'string' || cfg.redirect_uri.length === 0) {
        return 'redirect_uri is required';
      }
      let parsed;
      try { parsed = new URL(cfg.redirect_uri); }
      catch { return 'redirect_uri must be a valid URL'; }
      if (parsed.protocol !== 'https:') {
        return 'redirect_uri must be https://';
      }
      return null;
    },
  },
  // Google Calendar integration. Same Google OAuth client shape as Drive /
  // Gmail; a separate registry entry so the calendar.events scope can be
  // granted by a distinct OAuth client from the Drive/Gmail ones when the
  // operator wants scope surfaces isolated. calendar.events is a "sensitive"
  // scope (like drive.readonly) — see services/calendarOAuth.js.
  calendar: {
    configFields: ['client_id', 'redirect_uri'],
    secretField:  'client_secret',
    validateConfig: (cfg) => {
      if (!cfg || typeof cfg !== 'object') return 'config must be an object';
      if (typeof cfg.client_id !== 'string' || cfg.client_id.length === 0) {
        return 'client_id is required';
      }
      if (!cfg.client_id.endsWith('.apps.googleusercontent.com')) {
        return 'client_id must be a Google OAuth client (.apps.googleusercontent.com)';
      }
      if (typeof cfg.redirect_uri !== 'string' || cfg.redirect_uri.length === 0) {
        return 'redirect_uri is required';
      }
      let parsed;
      try { parsed = new URL(cfg.redirect_uri); }
      catch { return 'redirect_uri must be a valid URL'; }
      if (parsed.protocol !== 'https:') {
        return 'redirect_uri must be https://';
      }
      return null;
    },
  },
  // Microsoft (Outlook / Microsoft 365) integration — Azure app registration
  // rather than a Google OAuth client, so the validation diverges: client_id
  // is a GUID (the Azure "Application (client) ID"), and there's an optional
  // `tenant` field ('common' for multi-tenant — the default — or a specific
  // tenant GUID / domain to lock consent to one directory). ONE registry
  // entry covers both the Outlook-mail and Outlook-calendar surfaces because
  // one consent (Mail.Read + Calendars.ReadWrite + offline_access) powers
  // both — see services/msgraphOAuth.js.
  msgraph: {
    configFields: ['client_id', 'redirect_uri', 'tenant'],
    secretField:  'client_secret',
    validateConfig: (cfg) => {
      if (!cfg || typeof cfg !== 'object') return 'config must be an object';
      if (typeof cfg.client_id !== 'string' || cfg.client_id.length === 0) {
        return 'client_id is required';
      }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cfg.client_id)) {
        return 'client_id must be an Azure Application (client) ID — a GUID';
      }
      if (typeof cfg.redirect_uri !== 'string' || cfg.redirect_uri.length === 0) {
        return 'redirect_uri is required';
      }
      let parsed;
      try { parsed = new URL(cfg.redirect_uri); }
      catch { return 'redirect_uri must be a valid URL'; }
      if (parsed.protocol !== 'https:') {
        return 'redirect_uri must be https://';
      }
      if (cfg.tenant !== undefined && cfg.tenant !== null && cfg.tenant !== '') {
        if (typeof cfg.tenant !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,120}$/i.test(cfg.tenant)) {
          return 'tenant must be "common", a tenant GUID, or a verified domain (e.g. contoso.onmicrosoft.com)';
        }
      }
      return null;
    },
  },
};

const INTEGRATION_SLUG_RE = /^[a-z][a-z0-9_]{1,30}$/;

function isKnownIntegration(integration) {
  return Object.prototype.hasOwnProperty.call(INTEGRATIONS, integration);
}

function getIntegrationDef(integration) {
  if (!isKnownIntegration(integration)) {
    throw new Error(`platformIntegrations: unknown integration "${integration}"`);
  }
  return INTEGRATIONS[integration];
}

// --- Cache -----------------------------------------------------------------

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // integration → { value, expiresAt }

function cacheGet(integration) {
  const entry = cache.get(integration);
  if (!entry) return undefined; // "not in cache" — distinct from `null`
  if (entry.expiresAt <= Date.now()) {
    cache.delete(integration);
    return undefined;
  }
  return entry.value; // may be `null` for a known-missing slug
}

function cacheSet(integration, value) {
  cache.set(integration, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function cacheBust(integration) {
  cache.delete(integration);
}

// --- Row → public shape ----------------------------------------------------

function rowToPublic(row) {
  if (!row) return null;
  return {
    integration:        row.integration,
    config:             row.config || {},
    hasSecret:          !!row.has_secret,
    configured:         !!row.has_secret && row.config && Object.keys(row.config).length > 0,
    updatedAt:          row.updated_at,
    updatedByUserId:    row.updated_by_user_id,
  };
}

// --- Public API ------------------------------------------------------------

/**
 * Fetch the public-shape view of an integration's row. Cached for 60s.
 * Returns `null` if no row exists. Throws on unknown integration slug
 * (caller should validate the slug upstream).
 */
async function getConfig(integration) {
  if (!isKnownIntegration(integration)) {
    throw new Error(`platformIntegrations.getConfig: unknown integration "${integration}"`);
  }
  const cached = cacheGet(integration);
  if (cached !== undefined) return cached;
  const r = await pool.query(
    `SELECT integration, config, has_secret, updated_at, updated_by_user_id
       FROM platform_integrations
      WHERE integration = $1`,
    [integration]
  );
  const value = rowToPublic(r.rows[0] || null);
  cacheSet(integration, value);
  return value;
}

/**
 * Decrypt + return the plaintext secret for an integration. Returns `null`
 * if no row, no ciphertext, or any column is missing. Throws on decryption
 * failure (wrong/missing master key, tampered ciphertext) — the caller
 * (OAuth code) must surface that as a config/reconnect error.
 *
 * NEVER call this from a route handler that would echo the value to the
 * client. The only legitimate consumer is server-side OAuth code minting
 * tokens against the third-party provider.
 */
async function getSecret(integration) {
  if (!isKnownIntegration(integration)) {
    throw new Error(`platformIntegrations.getSecret: unknown integration "${integration}"`);
  }
  const r = await pool.query(
    `SELECT secret_ciphertext, secret_iv, secret_tag
       FROM platform_integrations
      WHERE integration = $1`,
    [integration]
  );
  const row = r.rows[0];
  if (!row || !row.secret_ciphertext || !row.secret_iv || !row.secret_tag) {
    return null;
  }
  if (!driveTokens.isConfigured()) {
    // Master key isn't loaded — we couldn't possibly decrypt. Surface this
    // as a clear operator-facing error rather than the cryptic
    // "Unsupported state or unable to authenticate data" Node throws.
    throw new Error(`platformIntegrations.getSecret: master encryption key not configured — set DRIVE_TOKEN_ENCRYPTION_KEY before reading platform credentials`);
  }
  // Buffers come straight from `bytea` columns; pg returns them as Buffer.
  return driveTokens.decrypt({
    ciphertext: row.secret_ciphertext,
    iv: row.secret_iv,
    tag: row.secret_tag,
  });
}

/**
 * Upsert an integration row.
 *
 * Body:
 *   { config: {...}, secret: string | null | undefined, userId: number }
 *
 * Semantics for `secret`:
 *   - non-empty string → encrypt and store (overwriting any prior secret)
 *   - explicit `null`  → wipe the encrypted-secret columns, keep config
 *   - `undefined`      → leave the secret columns untouched (config-only update)
 *
 * Returns the new public-shape row.
 *
 * Throws (with an operator-facing message) when:
 *   - integration slug is unknown
 *   - config fails the integration's validateConfig()
 *   - `secret` is the empty string ('' is not a meaningful secret — callers
 *     should send `null` to clear)
 *   - DRIVE_TOKEN_ENCRYPTION_KEY is unset and a secret was provided
 */
async function set(integration, { config, secret, userId } = {}) {
  if (!isKnownIntegration(integration)) {
    throw new Error(`platformIntegrations.set: unknown integration "${integration}"`);
  }
  const def = getIntegrationDef(integration);

  // Validate the config payload against the integration's schema.
  const validationError = def.validateConfig(config);
  if (validationError) {
    throw new Error(`platformIntegrations.set: ${validationError}`);
  }

  // Strip config to the whitelisted fields so a caller can't smuggle
  // arbitrary keys into the JSONB column.
  const cleanConfig = {};
  for (const field of def.configFields) {
    if (Object.prototype.hasOwnProperty.call(config, field)) {
      cleanConfig[field] = config[field];
    }
  }

  // Secret handling. `undefined` → no-op on the secret columns;
  // `null`      → clear them; non-empty string → encrypt and store.
  let secretOp;
  if (secret === undefined) {
    secretOp = 'preserve';
  } else if (secret === null) {
    secretOp = 'clear';
  } else if (typeof secret === 'string' && secret.length > 0) {
    secretOp = 'replace';
  } else {
    // Empty string or non-string non-null — refuse rather than silently
    // doing the wrong thing.
    throw new Error('platformIntegrations.set: secret must be a non-empty string, null (to clear), or omitted');
  }

  if (secretOp === 'replace' && !driveTokens.isConfigured()) {
    // Don't persist ciphertext we can't ever decrypt.
    throw new Error('platformIntegrations.set: Master encryption key not configured — set DRIVE_TOKEN_ENCRYPTION_KEY before storing platform credentials in-app.');
  }

  let enc = null;
  if (secretOp === 'replace') {
    enc = driveTokens.encrypt(secret);
  }

  // Upsert. We use three separate INSERT/UPDATE shapes (preserve / clear /
  // replace) because PostgreSQL doesn't have a clean "leave column alone if
  // you didn't list it" syntax on UPSERT — the conflict-update branch has
  // to enumerate every column. Three small queries beats a SQL string with
  // conditional column lists.
  let row;
  if (secretOp === 'preserve') {
    const r = await pool.query(
      `INSERT INTO platform_integrations (integration, config, updated_by_user_id, updated_at)
            VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (integration) DO UPDATE SET
            config = EXCLUDED.config,
            updated_by_user_id = EXCLUDED.updated_by_user_id,
            updated_at = NOW()
        RETURNING integration, config, has_secret, updated_at, updated_by_user_id`,
      [integration, JSON.stringify(cleanConfig), userId || null]
    );
    row = r.rows[0];
  } else if (secretOp === 'clear') {
    const r = await pool.query(
      `INSERT INTO platform_integrations (integration, config, secret_ciphertext, secret_iv, secret_tag, updated_by_user_id, updated_at)
            VALUES ($1, $2::jsonb, NULL, NULL, NULL, $3, NOW())
       ON CONFLICT (integration) DO UPDATE SET
            config = EXCLUDED.config,
            secret_ciphertext = NULL,
            secret_iv = NULL,
            secret_tag = NULL,
            updated_by_user_id = EXCLUDED.updated_by_user_id,
            updated_at = NOW()
        RETURNING integration, config, has_secret, updated_at, updated_by_user_id`,
      [integration, JSON.stringify(cleanConfig), userId || null]
    );
    row = r.rows[0];
  } else { // replace
    const r = await pool.query(
      `INSERT INTO platform_integrations (integration, config, secret_ciphertext, secret_iv, secret_tag, updated_by_user_id, updated_at)
            VALUES ($1, $2::jsonb, $3, $4, $5, $6, NOW())
       ON CONFLICT (integration) DO UPDATE SET
            config = EXCLUDED.config,
            secret_ciphertext = EXCLUDED.secret_ciphertext,
            secret_iv = EXCLUDED.secret_iv,
            secret_tag = EXCLUDED.secret_tag,
            updated_by_user_id = EXCLUDED.updated_by_user_id,
            updated_at = NOW()
        RETURNING integration, config, has_secret, updated_at, updated_by_user_id`,
      [integration, JSON.stringify(cleanConfig), enc.ciphertext, enc.iv, enc.tag, userId || null]
    );
    row = r.rows[0];
  }

  cacheBust(integration);
  return rowToPublic(row);
}

/**
 * Delete the row entirely. Returns `true` if a row was deleted, `false` if
 * the row didn't exist.
 */
async function clear(integration, { userId: _userId } = {}) {
  if (!isKnownIntegration(integration)) {
    throw new Error(`platformIntegrations.clear: unknown integration "${integration}"`);
  }
  // The userId is recorded by the audit log at the route layer, not here —
  // the service stays focused on storage. We accept it in the signature to
  // mirror set() and so a future "soft-delete with updated_by" path doesn't
  // require a signature change.
  const r = await pool.query(
    `DELETE FROM platform_integrations WHERE integration = $1 RETURNING integration`,
    [integration]
  );
  cacheBust(integration);
  return r.rowCount > 0;
}

/**
 * Synchronous "is this integration's row fully populated" check via cache.
 * Returns false when:
 *   - the slug is not in the cache (we haven't looked it up yet — caller
 *     should await getConfig() first)
 *   - the cached value is `null` (row doesn't exist)
 *   - the row exists but has no secret
 *
 * Intended for hot paths that have already warmed the cache via an async
 * getConfig() call earlier in the request — they can fall through to the
 * env-var source without a DB round-trip.
 */
function isConfigured(integration) {
  if (!isKnownIntegration(integration)) return false;
  const cached = cacheGet(integration);
  if (cached === undefined) return false;
  if (cached === null) return false;
  return !!cached.configured;
}

/**
 * List every known integration with its public-shape row (or `null` if no
 * row exists). Used by GET /api/admin/platform-integrations to render the
 * super-admin page.
 */
async function listAll() {
  const out = [];
  for (const integration of Object.keys(INTEGRATIONS)) {
    // eslint-disable-next-line no-await-in-loop
    const v = await getConfig(integration);
    out.push({ integration, value: v });
  }
  return out;
}

// Test-only: reset the cache so encrypt/decrypt round-trip and cache-
// invalidation tests don't bleed across tests. Not part of the production
// surface.
function _resetCacheForTests() {
  cache.clear();
}

module.exports = {
  getConfig,
  getSecret,
  set,
  clear,
  isConfigured,
  listAll,
  // Exposed for routes + tests:
  isKnownIntegration,
  INTEGRATION_SLUG_RE,
  INTEGRATIONS,
  _resetCacheForTests,
};
