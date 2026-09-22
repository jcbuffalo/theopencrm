// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Global (not per-org) settings — migration 174. "Platform-scope" feature
// flags are still stored per org in organizations.features, so anything
// that has to be true for the whole deployment at once (e.g. "stop
// provisioning AI trials") lives here. Tiny: get / set with a 30s cache.

const pool = require('../db');

const CACHE_MS = 30 * 1000;
const cache = new Map(); // key → { value, expiresAt }

async function get(key, fallback = null) {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  try {
    const r = await pool.query('SELECT value FROM platform_settings WHERE key = $1', [key]);
    const value = r.rows[0] ? r.rows[0].value : fallback;
    cache.set(key, { value, expiresAt: Date.now() + CACHE_MS });
    return value;
  } catch {
    return fallback; // table missing (pre-174) or DB blip → caller's default
  }
}

async function set(key, value, { userId = null } = {}) {
  await pool.query(
    `INSERT INTO platform_settings (key, value, updated_at, updated_by)
     VALUES ($1, $2::jsonb, NOW(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), userId]
  );
  cache.set(key, { value, expiresAt: Date.now() + CACHE_MS });
  return value;
}

function _clearCache() { cache.clear(); }

module.exports = { get, set, _clearCache };
