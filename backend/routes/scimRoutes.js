// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// SCIM 2.0 provisioning surface — /scim/v2/*.
//
// Lets an enterprise IdP (Okta / Entra ID / OneLogin) provision and deprovision
// users into an org. Authenticated SOLELY by a scim_ bearer token via
// middleware/scimAuth.js (fails closed, org-scoped) — NOT the session cookie,
// so it is CSRF-exempt (token-auth, no cookies) and never touches the JWT path.
//
// The feature flag gate runs AFTER scimAuth because requireFeature needs
// req.orgId, which scimAuth populates from the token. Result: the SCIM surface
// is inert for any org that hasn't (a) minted a token AND (b) had `sso_enabled`
// turned on.
//
// SCHEMA — we implement the SCIM Users core minimally:
//   userName  ↔  users.email        (the natural key)
//   active    ↔  users.status        ('active' ⇄ true, else false/suspended)
//   name      ↔  users.name          (formatted / given+family collapsed)
// Users provisioned here always get org_role='member' and are scoped to the
// token's org. Cross-org provisioning is structurally impossible (org_id comes
// from the token, never the request body).

const express = require('express');
const pool = require('../db');
const audit = require('../services/audit');
const { requireFeature } = require('../middleware/featureGate');
const { scimAuth, scimError } = require('../middleware/scimAuth');

const router = express.Router();

// SCIM bodies arrive as application/scim+json (some IdPs send application/json).
// Parse both. Mounted on the router so it doesn't affect the rest of the app.
router.use(express.json({ type: ['application/json', 'application/scim+json'], limit: '1mb' }));

// Auth first (sets req.orgId from the token), THEN the feature gate.
router.use(scimAuth);
router.use(requireFeature('sso_enabled'));

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';

// --- mapping helpers -------------------------------------------------------

function scimName(body) {
  const n = body && body.name;
  if (n && typeof n === 'object') {
    const formatted = (n.formatted && String(n.formatted).trim())
      || [n.givenName, n.familyName].filter(Boolean).join(' ').trim();
    if (formatted) return formatted;
  }
  if (body && body.displayName) return String(body.displayName).trim();
  return null;
}

function userToScim(req, row) {
  const active = (row.status || 'active') === 'active';
  const parts = String(row.name || '').trim().split(/\s+/);
  return {
    schemas: [USER_SCHEMA],
    id: String(row.id),
    userName: row.email,
    active,
    name: {
      formatted: row.name || row.email,
      givenName: parts[0] || '',
      familyName: parts.length > 1 ? parts.slice(1).join(' ') : '',
    },
    emails: [{ value: row.email, primary: true, type: 'work' }],
    meta: {
      resourceType: 'User',
      created: row.created_at,
      lastModified: row.updated_at,
      location: `${scimBaseUrl(req)}/Users/${row.id}`,
    },
  };
}

function scimBaseUrl(req) {
  const base = process.env.SSO_CALLBACK_BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/+$/, '')}/scim/v2`;
}

// Parse a `userName eq "value"` filter. We support only this equality form —
// the one Okta/Entra use for reconciliation. Returns the value or null.
function parseUserNameFilter(filter) {
  if (typeof filter !== 'string') return null;
  const m = filter.match(/userName\s+eq\s+"([^"]+)"/i);
  return m ? m[1] : null;
}

// --- GET /Users (list + filter) --------------------------------------------
router.get('/Users', async (req, res) => {
  try {
    const userName = parseUserNameFilter(req.query.filter);
    const startIndex = Math.max(1, parseInt(req.query.startIndex, 10) || 1);
    const count = Math.min(200, Math.max(0, parseInt(req.query.count, 10) || 100));

    const params = [req.orgId];
    let where = 'org_id = $1';
    if (userName) {
      params.push(userName.toLowerCase());
      where += ` AND LOWER(email) = $${params.length}`;
    }

    const totalR = await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE ${where}`, params);
    const total = totalR.rows[0].n;

    params.push(count, startIndex - 1);
    const r = await pool.query(
      `SELECT id, email, name, status, created_at, updated_at
         FROM users WHERE ${where}
        ORDER BY id
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return res.type('application/scim+json').json({
      schemas: [LIST_SCHEMA],
      totalResults: total,
      startIndex,
      itemsPerPage: r.rows.length,
      Resources: r.rows.map((row) => userToScim(req, row)),
    });
  } catch (err) {
    if (req.log) req.log.error('scim_list_failed', { error: err });
    return scimError(res, 500, 'Failed to list users.');
  }
});

// --- GET /Users/:id --------------------------------------------------------
router.get('/Users/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, email, name, status, created_at, updated_at
         FROM users WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (r.rows.length === 0) return scimError(res, 404, 'User not found.');
    return res.type('application/scim+json').json(userToScim(req, r.rows[0]));
  } catch (err) {
    return scimError(res, 500, 'Failed to fetch user.');
  }
});

// --- POST /Users (provision) -----------------------------------------------
router.post('/Users', async (req, res) => {
  try {
    const body = req.body || {};
    const email = String(body.userName || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return scimError(res, 400, 'userName (email) is required.', 'invalidValue');
    }
    const name = scimName(body) || email.split('@')[0];
    // active defaults to true on create unless the IdP explicitly sends false.
    const active = body.active === undefined ? true : !!body.active;
    const status = active ? 'active' : 'suspended';

    // email is globally UNIQUE in users. If it already exists, this is a
    // conflict — whether the row is in this org (already provisioned) or
    // another (can't be hijacked). Both surface as 409 per SCIM.
    const existing = await pool.query('SELECT id, org_id FROM users WHERE LOWER(email) = $1', [email]);
    if (existing.rows.length > 0) {
      return scimError(res, 409, 'User already exists.', 'uniqueness');
    }

    const r = await pool.query(
      `INSERT INTO users (email, name, status, org_id, org_role, email_verified, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'member', TRUE, NOW(), NOW())
       RETURNING id, email, name, status, created_at, updated_at`,
      [email, name, status, req.orgId]
    );
    const row = r.rows[0];

    audit.fromReq(req, {
      event: 'scim.user.provisioned',
      targetType: 'user',
      targetId: row.id,
      meta: { email, org_id: req.orgId, active, via: 'scim', scimTokenId: req.scimTokenId },
    });

    return res.status(201).type('application/scim+json').json(userToScim(req, row));
  } catch (err) {
    if (req.log) req.log.error('scim_create_failed', { error: err });
    return scimError(res, 500, 'Failed to create user.');
  }
});

// Shared update applier for PUT/PATCH — sets name and/or active/status.
async function applyUpdate(req, res, { name, active }) {
  const sets = [];
  const params = [];
  if (name !== undefined && name !== null) {
    params.push(name);
    sets.push(`name = $${params.length}`);
  }
  if (active !== undefined) {
    params.push(active ? 'active' : 'suspended');
    sets.push(`status = $${params.length}`);
  }
  if (sets.length === 0) {
    // Nothing to change — return the current representation.
    const cur = await pool.query(
      `SELECT id, email, name, status, created_at, updated_at FROM users WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (cur.rows.length === 0) return scimError(res, 404, 'User not found.');
    return res.type('application/scim+json').json(userToScim(req, cur.rows[0]));
  }
  sets.push('updated_at = NOW()');
  params.push(req.params.id, req.orgId);
  const r = await pool.query(
    `UPDATE users SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND org_id = $${params.length}
       RETURNING id, email, name, status, created_at, updated_at`,
    params
  );
  if (r.rows.length === 0) return scimError(res, 404, 'User not found.');

  audit.fromReq(req, {
    event: 'scim.user.updated',
    targetType: 'user',
    targetId: r.rows[0].id,
    meta: { active, via: 'scim', scimTokenId: req.scimTokenId },
  });
  return res.type('application/scim+json').json(userToScim(req, r.rows[0]));
}

// --- PUT /Users/:id (replace) ----------------------------------------------
router.put('/Users/:id', async (req, res) => {
  try {
    const body = req.body || {};
    const active = body.active === undefined ? undefined : !!body.active;
    const name = scimName(body);
    return await applyUpdate(req, res, { name, active });
  } catch (err) {
    if (req.log) req.log.error('scim_put_failed', { error: err });
    return scimError(res, 500, 'Failed to update user.');
  }
});

// --- PATCH /Users/:id (partial — primarily active toggling) ----------------
router.patch('/Users/:id', async (req, res) => {
  try {
    const body = req.body || {};
    const ops = Array.isArray(body.Operations) ? body.Operations : [];
    let active;
    let name;
    for (const op of ops) {
      const verb = String(op.op || '').toLowerCase();
      if (verb !== 'replace' && verb !== 'add') continue;
      // Two shapes: { path: 'active', value: false } OR { value: { active: false } }.
      const path = op.path ? String(op.path).toLowerCase() : null;
      if (path === 'active') {
        active = (op.value === true || op.value === 'true');
      } else if (path === 'name.formatted' || path === 'displayname') {
        name = op.value != null ? String(op.value) : name;
      } else if (!path && op.value && typeof op.value === 'object') {
        if ('active' in op.value) active = (op.value.active === true || op.value.active === 'true');
        const n = scimName(op.value);
        if (n) name = n;
      }
    }
    return await applyUpdate(req, res, { name, active });
  } catch (err) {
    if (req.log) req.log.error('scim_patch_failed', { error: err });
    return scimError(res, 500, 'Failed to patch user.');
  }
});

// --- DELETE /Users/:id (deprovision → deactivate) --------------------------
// SCIM DELETE means "remove from the app". We soft-deactivate (status =
// 'suspended') rather than hard-delete so the user's CRM-authored data + audit
// trail survive and the account can be re-activated on re-provision. The next
// authMiddleware status re-check then blocks any lingering session.
router.delete('/Users/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE users SET status = 'suspended', updated_at = NOW()
         WHERE id = $1 AND org_id = $2
         RETURNING id, email`,
      [req.params.id, req.orgId]
    );
    if (r.rows.length === 0) return scimError(res, 404, 'User not found.');
    audit.fromReq(req, {
      event: 'scim.user.deprovisioned',
      targetType: 'user',
      targetId: r.rows[0].id,
      meta: { email: r.rows[0].email, via: 'scim', scimTokenId: req.scimTokenId },
    });
    return res.status(204).end();
  } catch (err) {
    if (req.log) req.log.error('scim_delete_failed', { error: err });
    return scimError(res, 500, 'Failed to deprovision user.');
  }
});

module.exports = router;
