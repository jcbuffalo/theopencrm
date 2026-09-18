// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Per-org SSO (OIDC) connection storage.
//
// One row per org in `sso_connections` (migration 117). The OAuth client
// secret is encrypted at rest via services/driveTokens (AES-256-GCM under the
// master key DRIVE_TOKEN_ENCRYPTION_KEY) — the SAME machinery Drive/QuickBooks
// credentials use. Only the server-side token-exchange path (routes/
// ssoLoginRoutes.js) is permitted to call getClientSecret(); config routes
// return metadata + a has_secret boolean and NEVER echo the plaintext.
//
// The row is INERT until enabled=TRUE. That, plus the org's `sso_enabled`
// feature flag, are both required before any login is accepted.

const pool = require('../db');
const driveTokens = require('./driveTokens');

// Public-shape projection (no secret material).
function rowToPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    slug: row.slug,
    protocol: row.protocol,
    issuer: row.issuer,
    clientId: row.client_id,
    allowedDomain: row.allowed_domain,
    enabled: !!row.enabled,
    hasSecret: !!(row.client_secret_ct),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getByOrg(orgId) {
  if (!orgId) return null;
  const r = await pool.query(
    `SELECT id, org_id, slug, protocol, issuer, client_id, client_secret_ct,
            allowed_domain, enabled, created_by, created_at, updated_at
       FROM sso_connections WHERE org_id = $1`,
    [orgId]
  );
  return rowToPublic(r.rows[0] || null);
}

// Resolve a connection by its public slug. Returns the FULL row shape (still
// no plaintext secret) — used by the pre-auth /start route. Only returns
// enabled connections by default.
async function getBySlug(slug, { enabledOnly = true } = {}) {
  if (!slug || typeof slug !== 'string') return null;
  const r = await pool.query(
    `SELECT id, org_id, slug, protocol, issuer, client_id, client_secret_ct,
            allowed_domain, enabled, created_by, created_at, updated_at
       FROM sso_connections WHERE slug = $1`,
    [slug]
  );
  const row = r.rows[0];
  if (!row) return null;
  if (enabledOnly && !row.enabled) return null;
  return rowToPublic(row);
}

// Resolve an ENABLED connection by an email's domain. Powers the login-page
// "type your work email" discovery. Case-insensitive.
async function getByEmailDomain(domain, { enabledOnly = true } = {}) {
  if (!domain || typeof domain !== 'string') return null;
  const r = await pool.query(
    `SELECT id, org_id, slug, protocol, issuer, client_id, client_secret_ct,
            allowed_domain, enabled, created_by, created_at, updated_at
       FROM sso_connections WHERE LOWER(allowed_domain) = LOWER($1)`,
    [domain.trim()]
  );
  const row = r.rows[0];
  if (!row) return null;
  if (enabledOnly && !row.enabled) return null;
  return rowToPublic(row);
}

/**
 * Decrypt + return the plaintext client secret for an org's connection.
 * Returns null if the row/secret is absent. Throws if the master key is
 * missing (can't decrypt) or the ciphertext is tampered. NEVER call from a
 * route that echoes the result to a client.
 */
async function getClientSecret(orgId) {
  const r = await pool.query(
    `SELECT client_secret_ct, client_secret_iv, client_secret_tag
       FROM sso_connections WHERE org_id = $1`,
    [orgId]
  );
  const row = r.rows[0];
  if (!row || !row.client_secret_ct || !row.client_secret_iv || !row.client_secret_tag) {
    return null;
  }
  if (!driveTokens.isConfigured()) {
    throw new Error('ssoConnections.getClientSecret: master encryption key not configured (DRIVE_TOKEN_ENCRYPTION_KEY)');
  }
  return driveTokens.decrypt({
    ciphertext: row.client_secret_ct,
    iv: row.client_secret_iv,
    tag: row.client_secret_tag,
  });
}

/**
 * Upsert an org's connection.
 *
 * @param {number} orgId
 * @param {object} fields
 * @param {string} [fields.slug]
 * @param {string} [fields.issuer]
 * @param {string} [fields.clientId]
 * @param {string|null|undefined} [fields.clientSecret]
 *        non-empty string → encrypt+store; null → clear; undefined → preserve.
 * @param {string} [fields.allowedDomain]
 * @param {boolean} [fields.enabled]
 * @param {number} [fields.userId] - created_by on first insert
 * @returns {Promise<object>} the public-shape row
 */
async function upsert(orgId, fields = {}) {
  if (!orgId) throw new Error('ssoConnections.upsert: orgId required');

  const {
    slug, issuer, clientId, clientSecret, allowedDomain, enabled, userId,
  } = fields;

  // Secret handling mirrors platformIntegrations.set().
  let secretOp;
  if (clientSecret === undefined) secretOp = 'preserve';
  else if (clientSecret === null) secretOp = 'clear';
  else if (typeof clientSecret === 'string' && clientSecret.length > 0) secretOp = 'replace';
  else throw new Error('ssoConnections.upsert: clientSecret must be a non-empty string, null, or omitted');

  if (secretOp === 'replace' && !driveTokens.isConfigured()) {
    throw new Error('ssoConnections.upsert: Master encryption key not configured — set DRIVE_TOKEN_ENCRYPTION_KEY before storing an SSO client secret.');
  }

  let enc = null;
  if (secretOp === 'replace') enc = driveTokens.encrypt(clientSecret);

  // Does a row already exist? Determines INSERT vs UPDATE and lets us leave
  // untouched columns alone on preserve.
  const existing = await pool.query('SELECT id FROM sso_connections WHERE org_id = $1', [orgId]);

  if (existing.rows.length === 0) {
    // Insert. On a fresh insert, a preserved (undefined) secret means "no
    // secret yet" — the columns default to NULL.
    const r = await pool.query(
      `INSERT INTO sso_connections
         (org_id, slug, protocol, issuer, client_id,
          client_secret_ct, client_secret_iv, client_secret_tag,
          allowed_domain, enabled, created_by, created_at, updated_at)
       VALUES ($1, $2, 'oidc', $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
       RETURNING id, org_id, slug, protocol, issuer, client_id, client_secret_ct,
                 allowed_domain, enabled, created_by, created_at, updated_at`,
      [
        orgId,
        slug || null,
        issuer || null,
        clientId || null,
        enc ? enc.ciphertext : null,
        enc ? enc.iv : null,
        enc ? enc.tag : null,
        allowedDomain || null,
        enabled === undefined ? false : !!enabled,
        userId || null,
      ]
    );
    return rowToPublic(r.rows[0]);
  }

  // Update — build a dynamic SET touching only provided columns, plus the
  // secret columns per secretOp.
  const sets = [];
  const params = [];
  const push = (frag, val) => { params.push(val); sets.push(`${frag} = $${params.length}`); };

  if (slug !== undefined) push('slug', slug || null);
  if (issuer !== undefined) push('issuer', issuer || null);
  if (clientId !== undefined) push('client_id', clientId || null);
  if (allowedDomain !== undefined) push('allowed_domain', allowedDomain || null);
  if (enabled !== undefined) push('enabled', !!enabled);

  if (secretOp === 'clear') {
    sets.push('client_secret_ct = NULL', 'client_secret_iv = NULL', 'client_secret_tag = NULL');
  } else if (secretOp === 'replace') {
    push('client_secret_ct', enc.ciphertext);
    push('client_secret_iv', enc.iv);
    push('client_secret_tag', enc.tag);
  }

  sets.push('updated_at = NOW()');
  params.push(orgId);

  const r = await pool.query(
    `UPDATE sso_connections SET ${sets.join(', ')} WHERE org_id = $${params.length}
       RETURNING id, org_id, slug, protocol, issuer, client_id, client_secret_ct,
                 allowed_domain, enabled, created_by, created_at, updated_at`,
    params
  );
  return rowToPublic(r.rows[0]);
}

async function remove(orgId) {
  const r = await pool.query('DELETE FROM sso_connections WHERE org_id = $1 RETURNING id', [orgId]);
  return r.rowCount > 0;
}

module.exports = {
  rowToPublic,
  getByOrg,
  getBySlug,
  getByEmailDomain,
  getClientSecret,
  upsert,
  remove,
};
