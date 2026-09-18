// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Feature flag ("Modules") management — per-org toggles.
//
// Endpoints:
//   GET    /flags              — known flags + the caller's org's effective values
//   GET    /flags/:orgId       — same view for a specific org (super-admin only)
//   PUT    /flags/:orgId/:name — set a flag value (true|false) on an org
//   DELETE /flags/:orgId/:name — unset (revert to the profile default) a flag
//
// Authorization (self-service, Aug 2026): an ORG OWNER or ADMIN (users.org_role)
// can read + toggle their OWN org's `scope: 'org'` flags. Platform super-admins
// (admin_users.role = 'super_admin') can additionally read/write any org and
// are the only callers allowed to touch `scope: 'platform'` flags, which are
// hidden from org admins' listings entirely. See services/featureFlags.js
// KNOWN_FLAGS for the scope attribute.

const express = require('express');
const { authMiddleware } = require('../auth');
const { requireOrgAdmin } = require('../middleware/adminAuth');
const featureFlags = require('../services/featureFlags');

const router = express.Router();
router.use(authMiddleware);
router.use(requireOrgAdmin);

function parseOrgId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function flagView(orgId, includePlatform) {
  const { features, profile } = await featureFlags.getOrgFlagContext(orgId);
  return {
    orgId,
    profile: profile || 'generic',
    flags: featureFlags.describeFlags(features, profile, { includePlatform }),
    groups: featureFlags.FLAG_GROUPS,
  };
}

// Known flags + the caller's org's effective values.
router.get('/flags', async (req, res) => {
  if (!req.orgId) {
    return res.status(400).json({ success: false, error: 'Org context required' });
  }
  try {
    const data = await flagView(req.orgId, !!req.isSuperAdmin);
    res.json({ success: true, data });
  } catch (err) {
    if (req.log) req.log.error('feature_flags_list_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to list flags' });
  }
});

// Super-admin: the same view for any org.
router.get('/flags/:orgId', async (req, res) => {
  const targetOrg = parseOrgId(req.params.orgId);
  if (!targetOrg) return res.status(400).json({ success: false, error: 'Invalid orgId' });
  if (targetOrg !== req.orgId && !req.isSuperAdmin) {
    return res.status(403).json({ success: false, error: 'Super-admin required for cross-org reads' });
  }
  try {
    const data = await flagView(targetOrg, !!req.isSuperAdmin);
    res.json({ success: true, data });
  } catch (err) {
    if (req.log) req.log.error('feature_flags_read_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to fetch flags' });
  }
});

// Shared write guard: own org (or super-admin), known flag, and platform-scope
// flags are super-admin only.
function guardWrite(req, res) {
  const targetOrg = parseOrgId(req.params.orgId);
  if (!targetOrg) {
    res.status(400).json({ success: false, error: 'Invalid orgId' });
    return null;
  }
  if (targetOrg !== req.orgId && !req.isSuperAdmin) {
    res.status(403).json({ success: false, error: 'Super-admin required for cross-org writes' });
    return null;
  }
  const name = String(req.params.name || '');
  if (!featureFlags.getFlag(name)) {
    res.status(400).json({ success: false, error: `Unknown feature flag "${name}"` });
    return null;
  }
  if (featureFlags.isPlatformScoped(name) && !req.isSuperAdmin) {
    res.status(403).json({ success: false, error: 'This flag is platform-scoped and can only be changed by a platform super-admin' });
    return null;
  }
  return { targetOrg, name };
}

// Set a flag on an org.
router.put('/flags/:orgId/:name', async (req, res) => {
  const target = guardWrite(req, res);
  if (!target) return;
  const { value } = req.body || {};
  if (typeof value !== 'boolean') {
    return res.status(400).json({ success: false, error: 'Body must be { value: boolean }' });
  }
  try {
    await featureFlags.setFeature(target.targetOrg, target.name, value);
    res.json({ success: true, data: { orgId: target.targetOrg, flag: target.name, value } });
  } catch (err) {
    if (req.log) req.log.error('feature_flag_set_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to set flag' });
  }
});

// Unset (revert to the profile default).
router.delete('/flags/:orgId/:name', async (req, res) => {
  const target = guardWrite(req, res);
  if (!target) return;
  try {
    await featureFlags.unsetFeature(target.targetOrg, target.name);
    res.json({ success: true, data: { orgId: target.targetOrg, flag: target.name } });
  } catch (err) {
    if (req.log) req.log.error('feature_flag_unset_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to unset flag' });
  }
});

module.exports = router;
