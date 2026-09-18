// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Per-org AI model + effort resolver.
//
// Centralizes how every AI call site decides which Claude model to use and
// (when supported) what extended-thinking budget to enable.
//
// FALLBACK CHAIN
//   model:
//     1. organizations.ai_model              (per-org column)   ← wins when set
//     2. process.env.ANTHROPIC_MODEL         (env fallback)
//     3. DEFAULT_MODEL ('claude-sonnet-4-6') (hardcoded default)
//   effort:
//     1. organizations.ai_effort             (per-org column)   ← wins when set
//     2. DEFAULT_EFFORT ('medium')           (hardcoded default)
//
// Each value is independently validated against an allowlist. A stored value
// outside the allowlist falls back to the default + logs a warn — the AI
// surface never crashes because of a settings hiccup.
//
// effort → extended-thinking budget_tokens mapping:
//   low    → null   (no extended thinking — omit the field on messages.create)
//   medium → 2048
//   high   → 8192
//
// CACHING
//   30s in-process cache keyed by orgId, mirroring services/featureFlags.js so
//   the hot path doesn't query Postgres on every Claude call. bustCache(orgId)
//   is called from the admin PATCH route immediately after a write.

const pool   = require('../db');
const logger = require('./logger');

// Allowlist of valid Claude model ids. `family` is informational — useful for
// surfacing groupings in the admin picker without us having to introspect the
// id at runtime.
const VALID_MODELS = [
  { id: 'claude-opus-4-7',     label: 'Opus 4.7',     family: 'opus'   },
  { id: 'claude-sonnet-4-6',   label: 'Sonnet 4.6',   family: 'sonnet' },
  { id: 'claude-haiku-4-5',    label: 'Haiku 4.5',    family: 'haiku'  },
];

const VALID_EFFORTS = ['low', 'medium', 'high'];

const DEFAULT_MODEL  = 'claude-sonnet-4-6';
const DEFAULT_EFFORT = 'medium';

// Keep the lookup set hot so isValidModel / isValidEffort don't pay an array
// scan on every Claude call.
const VALID_MODEL_IDS = new Set(VALID_MODELS.map(m => m.id));
const VALID_EFFORT_SET = new Set(VALID_EFFORTS);

const TTL_MS = 30_000;
const cache  = new Map(); // orgId → { settings, expiresAt }

function isValidModel(m)  { return typeof m === 'string' && VALID_MODEL_IDS.has(m); }
function isValidEffort(e) { return typeof e === 'string' && VALID_EFFORT_SET.has(e); }

// Resolve the env-var fallback the same way the legacy AI services did. Wrapped
// in a helper because we validate it before trusting it — an out-of-allowlist
// ANTHROPIC_MODEL falls through to DEFAULT_MODEL, same as a bad column value.
function envModel() {
  const e = process.env.ANTHROPIC_MODEL;
  return isValidModel(e) ? e : null;
}

/**
 * Get the effective { model, effort } for an org.
 *
 * Fail-safe: any thrown error (DB outage, weird row shape, etc.) returns
 * defaults and logs a warn. The AI call sites can never blow up because of
 * a settings lookup.
 *
 * @param {number|null} orgId
 * @returns {Promise<{ model: string, effort: string }>}
 */
async function getOrgAiSettings(orgId) {
  // No org context (e.g. boot-time probe, pre-session call) → straight defaults.
  if (!orgId) {
    return { model: envModel() || DEFAULT_MODEL, effort: DEFAULT_EFFORT };
  }

  const cached = cache.get(orgId);
  if (cached && cached.expiresAt > Date.now()) return cached.settings;

  let row;
  try {
    const r = await pool.query(
      'SELECT ai_model, ai_effort FROM organizations WHERE id = $1',
      [orgId]
    );
    row = r.rows[0] || {};
  } catch (err) {
    logger.warn('ai_model_settings_lookup_failed', { orgId, error: err.message });
    // Don't poison the cache on DB error — let the next call retry.
    return { model: envModel() || DEFAULT_MODEL, effort: DEFAULT_EFFORT };
  }

  let model;
  if (row.ai_model && isValidModel(row.ai_model)) {
    model = row.ai_model;
  } else {
    if (row.ai_model) {
      // Stored value exists but isn't in the allowlist. Fall back and warn so
      // operators can see it in the logs and clean up.
      logger.warn('ai_model_invalid_stored_value', { orgId, stored: row.ai_model });
    }
    model = envModel() || DEFAULT_MODEL;
  }

  let effort;
  if (row.ai_effort && isValidEffort(row.ai_effort)) {
    effort = row.ai_effort;
  } else {
    if (row.ai_effort) {
      logger.warn('ai_effort_invalid_stored_value', { orgId, stored: row.ai_effort });
    }
    effort = DEFAULT_EFFORT;
  }

  const settings = { model, effort };
  cache.set(orgId, { settings, expiresAt: Date.now() + TTL_MS });
  return settings;
}

/**
 * Invalidate the cached settings for an org. Called from the admin PATCH
 * route immediately after a write so the next AI call sees the new values.
 */
function bustCache(orgId) {
  if (!orgId) return;
  cache.delete(orgId);
}

/**
 * Map a validated `effort` value to an extended-thinking budget_tokens count.
 * Returns null for `low` (caller should omit the `thinking` field entirely)
 * and null for any unrecognized value (defensive — getOrgAiSettings will
 * normally have validated already).
 *
 *   low    → null
 *   medium → 2048
 *   high   → 8192
 */
function effortToThinkingBudget(effort) {
  switch (effort) {
    case 'low':    return null;
    case 'medium': return 2048;
    case 'high':   return 8192;
    default:       return null;
  }
}

// Test hook: clears the in-process cache. Mirrors the _resetForTests /
// _resetCacheForTests pattern used elsewhere in the codebase (see
// services/driveTokens, services/platformIntegrations).
function _resetCachesForTests() {
  cache.clear();
}

module.exports = {
  VALID_MODELS,
  VALID_EFFORTS,
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
  getOrgAiSettings,
  bustCache,
  effortToThinkingBudget,
  isValidModel,
  isValidEffort,
  _resetCachesForTests,
};
