// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// API-key management — /api/keys.
//
// Session-authenticated + org-admin-gated CRUD for the developer-platform
// Personal Access Tokens defined in migration 108. This is the MANAGEMENT
// surface (create / list / revoke a key from the Settings → Developer UI); the
// keys themselves authenticate against a DIFFERENT surface via
// middleware/apiKeyAuth.js.
//
// Endpoints:
//   GET    /api/keys        — list this org's keys (never returns the secret)
//   POST   /api/keys        — mint a key; returns the FULL plaintext ONCE
//   DELETE /api/keys/:id    — revoke (soft delete)
//
// Org-scoped via qs(req); org-admin-gated via requireOrgAdmin (mirrors
// orgActivityRoutes / customFieldsRoutes). Creation + revocation are
// audit-logged (the key value is never written to the audit meta).

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authMiddleware } = require('../auth');
const apiKeys = require('../services/apiKeys');
const audit = require('../services/audit');

router.use(authMiddleware);

// Org-scope helper. Same shape as the canonical qs(req), but the org-less
// fallback scopes on `created_by` — api_keys has no `user_id` column (the
// creating user IS the owner for a personal workspace).
function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['created_by', req.userId]; }

// Managing API keys is a privileged action: a key inherits the org's data
// access, so only owners/admins may mint or revoke them. Members get 403.
function requireOrgAdmin(req, res, next) {
  // Org-less personal workspaces have no roles — the sole user IS the admin.
  if (!req.orgId) return next();
  if (req.orgRole !== 'owner' && req.orgRole !== 'admin') {
    return res.status(403).json({ success: false, error: 'Org owner or admin role required to manage API keys' });
  }
  next();
}

const VALID_SCOPES = ['read', 'write'];

// GET /api/keys — list (metadata only; the secret is unrecoverable by design).
router.get('/', requireOrgAdmin, async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `SELECT id, name, key_prefix, scopes, created_by, last_used_at, revoked_at, created_at
         FROM api_keys
        WHERE ${sf} IS NOT DISTINCT FROM $1
        ORDER BY created_at DESC`,
      [sv]
    );
    res.json({ success: true, keys: r.rows });
  } catch (err) {
    if (req.log) req.log.error('api_keys_list_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to list API keys' });
  }
});

// POST /api/keys — mint a new key. The plaintext is returned in this response
// and NEVER again; the caller must copy it now.
router.post('/', requireOrgAdmin, async (req, res) => {
  try {
    const name = (req.body?.name || '').toString().trim();
    if (!name) return res.status(400).json({ success: false, error: 'A name is required' });
    if (name.length > 120) return res.status(400).json({ success: false, error: 'Name must be 120 characters or fewer' });

    // Scopes: default to read-only. Validate against the allowlist.
    let scopes = Array.isArray(req.body?.scopes) && req.body.scopes.length ? req.body.scopes : ['read'];
    scopes = [...new Set(scopes.map((s) => String(s).toLowerCase()))];
    const bad = scopes.filter((s) => !VALID_SCOPES.includes(s));
    if (bad.length) return res.status(400).json({ success: false, error: `Unknown scope(s): ${bad.join(', ')}` });

    const { fullKey, keyPrefix, keyHash } = apiKeys.generateKey();

    const r = await pool.query(
      `INSERT INTO api_keys (org_id, name, key_prefix, key_hash, scopes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, key_prefix, scopes, created_by, last_used_at, revoked_at, created_at`,
      [req.orgId || null, name, keyPrefix, keyHash, scopes, req.userId || null]
    );
    const row = r.rows[0];

    audit.fromReq(req, {
      event: audit.EVENTS.API_KEY_CREATED,
      targetType: 'api_key',
      targetId: String(row.id),
      meta: { key_id: row.id, key_prefix: keyPrefix, name, scopes },
    });

    // `key` is the ONE-TIME plaintext. `warning` reminds the UI/user it won't
    // be shown again.
    res.status(201).json({
      success: true,
      key: fullKey,
      warning: 'Copy this key now — it will not be shown again.',
      record: row,
    });
  } catch (err) {
    if (req.log) req.log.error('api_key_create_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to create API key' });
  }
});

// DELETE /api/keys/:id — revoke (soft delete). Idempotent-ish: revoking an
// already-revoked key is a no-op success.
router.delete('/:id', requireOrgAdmin, async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `UPDATE api_keys
          SET revoked_at = COALESCE(revoked_at, NOW())
        WHERE id = $1 AND ${sf} IS NOT DISTINCT FROM $2
        RETURNING id, name, key_prefix`,
      [req.params.id, sv]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'API key not found' });
    const row = r.rows[0];

    audit.fromReq(req, {
      event: audit.EVENTS.API_KEY_REVOKED,
      targetType: 'api_key',
      targetId: String(row.id),
      meta: { key_id: row.id, key_prefix: row.key_prefix, name: row.name },
    });

    res.json({ success: true, revoked: row });
  } catch (err) {
    if (req.log) req.log.error('api_key_revoke_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to revoke API key' });
  }
});

module.exports = router;
