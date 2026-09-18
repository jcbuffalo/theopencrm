// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Org-admin SSO + SCIM configuration API — /api/admin/sso.
//
// AUTH: session cookie (authMiddleware) + org owner/admin only (requireOrgAdmin,
// same shape as adminAiModelRoutes). GATED by requireFeature('sso_enabled') —
// a super-admin flips that flag per org at /admin/feature-flags before an org
// admin can configure anything here. Default-off end to end.
//
// The client secret is WRITE-ONLY over this API: you can set it, but GET never
// returns it (only hasSecret). SCIM token plaintext is returned EXACTLY ONCE at
// creation and never again.

const express = require('express');
const { authMiddleware } = require('../auth');
const { requireFeature } = require('../middleware/featureGate');
const audit = require('../services/audit');
const ssoConnections = require('../services/ssoConnections');
const scimTokens = require('../services/scimTokens');

const router = express.Router();

router.use(authMiddleware);

// Owner/admin gate — mirrors routes/adminAiModelRoutes.js#requireOrgAdmin.
function requireOrgAdmin(req, res, next) {
  if (!req.orgId) return res.status(400).json({ error: 'Org context required' });
  if (req.orgRole !== 'owner' && req.orgRole !== 'admin') {
    return res.status(403).json({ error: 'Only org owners/admins can manage SSO settings' });
  }
  next();
}
router.use(requireOrgAdmin);
router.use(requireFeature('sso_enabled'));

// --- validation helpers ----------------------------------------------------
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/; // 3-40 chars, url-safe
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](-?[a-z0-9])*\.)+[a-z]{2,}$/i;

function validIssuer(v) {
  if (typeof v !== 'string' || !v) return false;
  let u;
  try { u = new URL(v); } catch { return false; }
  return u.protocol === 'https:';
}

// --- GET / — current config (no secrets) + SCIM tokens ---------------------
router.get('/', async (req, res) => {
  try {
    const conn = await ssoConnections.getByOrg(req.orgId);
    const tokens = await scimTokens.listByOrg(req.orgId);
    res.json({
      connection: conn, // null if unconfigured; hasSecret boolean, never the secret
      scimTokens: tokens.map((t) => ({
        id: t.id,
        name: t.name,
        tokenPrefix: t.token_prefix,
        createdAt: t.created_at,
        lastUsedAt: t.last_used_at,
        revokedAt: t.revoked_at,
      })),
      scimBaseUrl: `${(process.env.SSO_CALLBACK_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '')}/scim/v2`,
    });
  } catch (err) {
    if (req.log) req.log.error('sso_admin_get_failed', { error: err });
    res.status(500).json({ error: 'Failed to load SSO settings' });
  }
});

// --- PUT / — upsert the connection -----------------------------------------
// Body: { slug, issuer, clientId, clientSecret?, allowedDomain, enabled }
//   clientSecret: string → set; null → clear; omitted → leave unchanged.
router.put('/', async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};

    if (b.slug !== undefined) {
      const slug = String(b.slug || '').trim().toLowerCase();
      if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'slug must be 3-40 url-safe chars (a-z, 0-9, hyphen)' });
      patch.slug = slug;
    }
    if (b.issuer !== undefined) {
      if (b.issuer && !validIssuer(b.issuer)) return res.status(400).json({ error: 'issuer must be an https:// URL' });
      patch.issuer = b.issuer ? String(b.issuer).trim() : null;
    }
    if (b.clientId !== undefined) {
      patch.clientId = b.clientId ? String(b.clientId).trim() : null;
    }
    if (b.allowedDomain !== undefined) {
      const dom = String(b.allowedDomain || '').trim().toLowerCase();
      if (dom && !DOMAIN_RE.test(dom)) return res.status(400).json({ error: 'allowedDomain must be a bare domain, e.g. acme.com' });
      patch.allowedDomain = dom || null;
    }
    if (b.enabled !== undefined) {
      patch.enabled = !!b.enabled;
    }
    // clientSecret: distinguish omitted (undefined) vs explicit null vs value.
    if (Object.prototype.hasOwnProperty.call(b, 'clientSecret')) {
      if (b.clientSecret === null || b.clientSecret === '') patch.clientSecret = null;
      else if (typeof b.clientSecret === 'string') patch.clientSecret = b.clientSecret;
      else return res.status(400).json({ error: 'clientSecret must be a string, null, or omitted' });
    }

    // Guard: you can only ENABLE a connection that is fully configured.
    if (patch.enabled === true) {
      const current = await ssoConnections.getByOrg(req.orgId);
      const merged = {
        issuer: patch.issuer !== undefined ? patch.issuer : current?.issuer,
        clientId: patch.clientId !== undefined ? patch.clientId : current?.clientId,
        allowedDomain: patch.allowedDomain !== undefined ? patch.allowedDomain : current?.allowedDomain,
        slug: patch.slug !== undefined ? patch.slug : current?.slug,
        hasSecret: Object.prototype.hasOwnProperty.call(patch, 'clientSecret')
          ? patch.clientSecret !== null
          : current?.hasSecret,
      };
      if (!merged.issuer || !merged.clientId || !merged.allowedDomain || !merged.slug || !merged.hasSecret) {
        return res.status(400).json({ error: 'Cannot enable SSO until issuer, clientId, clientSecret, allowedDomain, and slug are all set.' });
      }
    }

    patch.userId = req.userId;

    let conn;
    try {
      conn = await ssoConnections.upsert(req.orgId, patch);
    } catch (e) {
      // Unique-violation on slug (23505) → friendly message.
      if (e && e.code === '23505') return res.status(409).json({ error: 'That slug is already in use by another organization.' });
      throw e;
    }

    audit.fromReq(req, {
      event: 'sso.config.updated',
      targetType: 'organization',
      targetId: req.orgId,
      meta: {
        fields: Object.keys(patch).filter((k) => k !== 'userId'),
        enabled: conn.enabled,
        secretSet: Object.prototype.hasOwnProperty.call(patch, 'clientSecret') && patch.clientSecret !== null,
      },
    });

    res.json({ connection: conn });
  } catch (err) {
    if (req.log) req.log.error('sso_admin_put_failed', { error: err });
    res.status(500).json({ error: 'Failed to save SSO settings', requestId: req.requestId });
  }
});

// --- DELETE / — remove the connection --------------------------------------
router.delete('/', async (req, res) => {
  try {
    const removed = await ssoConnections.remove(req.orgId);
    audit.fromReq(req, { event: 'sso.config.deleted', targetType: 'organization', targetId: req.orgId, meta: { removed } });
    res.json({ success: true, removed });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete SSO settings' });
  }
});

// --- POST /scim-tokens — mint a SCIM bearer (plaintext shown ONCE) ----------
router.post('/scim-tokens', async (req, res) => {
  try {
    const name = req.body && req.body.name ? String(req.body.name).slice(0, 120) : null;
    const { fullToken, tokenPrefix, tokenHash } = scimTokens.generateToken();
    const row = await scimTokens.create({ orgId: req.orgId, name, tokenPrefix, tokenHash, userId: req.userId });
    audit.fromReq(req, {
      event: 'scim.token.created',
      targetType: 'organization',
      targetId: req.orgId,
      meta: { tokenPrefix, name }, // the plaintext / hash are NEVER logged
    });
    res.status(201).json({
      id: row.id,
      name: row.name,
      tokenPrefix,
      // Shown exactly once — the client must copy it now; it's unrecoverable.
      token: fullToken,
      createdAt: row.created_at,
    });
  } catch (err) {
    if (req.log) req.log.error('scim_token_create_failed', { error: err });
    res.status(500).json({ error: 'Failed to create SCIM token' });
  }
});

// --- DELETE /scim-tokens/:id — revoke --------------------------------------
router.delete('/scim-tokens/:id', async (req, res) => {
  try {
    const ok = await scimTokens.revoke(req.params.id, req.orgId);
    if (!ok) return res.status(404).json({ error: 'Token not found or already revoked' });
    audit.fromReq(req, { event: 'scim.token.revoked', targetType: 'organization', targetId: req.orgId, meta: { tokenId: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to revoke SCIM token' });
  }
});

module.exports = router;
