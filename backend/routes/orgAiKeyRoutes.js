// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Bring-your-own Anthropic key — /api/org/ai-key (migration 154).
//
// Endpoints (auth required; scoped to the caller's own org):
//   GET    /   — { configured, last4, last_validated_at, last_error, billing_mode }
//                any org member may read (the Usage page shows members a
//                one-line "your org uses its own key" note)
//   PUT    /   — { key } → validates format, probes Anthropic once, encrypts,
//                upserts. Owner/admin only. Returns the GET shape.
//   DELETE /   — removes the key; the org drops back to pay-as-you-go.
//                Owner/admin only.
//
// The plaintext key is never echoed back, never logged, and never written
// to the audit log — only key_last4 (see services/orgAiKeys.js).
//
// PUT is rate-limited per user (10 / 15 min): each save makes a live probe
// call to Anthropic, and a runaway client shouldn't be able to turn that
// into a key-guessing loop against Anthropic's auth endpoint.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { authMiddleware } = require('../auth');
const orgAiKeys = require('../services/orgAiKeys');
const audit = require('../services/audit');

const router = express.Router();
router.use(authMiddleware);

const setKeyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => (req.userId != null ? `user:${req.userId}` : `ip:${ipKeyGenerator(req, res)}`),
  message: { error: 'Too many key-save attempts. Try again in 15 minutes.', code: 'RATE_LIMITED' },
});

function requireOrg(req, res) {
  if (!req.orgId) {
    res.status(400).json({ error: 'A bring-your-own AI key is stored per organization. Create or join an org first.', code: 'ORG_REQUIRED' });
    return false;
  }
  return true;
}

function requireOrgAdmin(req, res) {
  if (req.orgRole !== 'owner' && req.orgRole !== 'admin') {
    res.status(403).json({ error: 'Only org owners and admins can change the AI key.', code: 'ADMIN_REQUIRED' });
    return false;
  }
  return true;
}

// GET /api/org/ai-key
router.get('/', async (req, res) => {
  if (!requireOrg(req, res)) return;
  try {
    const status = await orgAiKeys.getStatus(req.orgId);
    res.json({ ...status, can_manage: req.orgRole === 'owner' || req.orgRole === 'admin' });
  } catch (err) {
    if (req.log) req.log.error('org_ai_key_status_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to read AI key status' });
  }
});

// PUT /api/org/ai-key  { key }
router.put('/', setKeyLimiter, async (req, res) => {
  if (!requireOrg(req, res)) return;
  if (!requireOrgAdmin(req, res)) return;
  const key = typeof req.body?.key === 'string' ? req.body.key : '';
  try {
    const status = await orgAiKeys.setOrgKey(req.orgId, key, req.userId);
    audit.fromReq(req, {
      event: audit.EVENTS.ORG_AI_KEY_SET,
      targetType: 'org',
      targetId: req.orgId,
      meta: {
        provider: status.provider,
        key_last4: status.last4,
        validated: !!status.last_validated_at,
        last_error: status.last_error || null,
      },
    });
    res.json({ ...status, can_manage: true });
  } catch (err) {
    if (err instanceof orgAiKeys.OrgAiKeyError) {
      return res.status(err.status || 400).json({ error: err.message, code: err.code });
    }
    if (req.log) req.log.error('org_ai_key_set_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to save AI key' });
  }
});

// DELETE /api/org/ai-key
router.delete('/', async (req, res) => {
  if (!requireOrg(req, res)) return;
  if (!requireOrgAdmin(req, res)) return;
  try {
    const removed = await orgAiKeys.clearOrgKey(req.orgId);
    if (removed) {
      audit.fromReq(req, {
        event: audit.EVENTS.ORG_AI_KEY_CLEARED,
        targetType: 'org',
        targetId: req.orgId,
        meta: { provider: orgAiKeys.PROVIDER },
      });
    }
    const status = await orgAiKeys.getStatus(req.orgId);
    res.json({ ...status, can_manage: true, removed });
  } catch (err) {
    if (req.log) req.log.error('org_ai_key_clear_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to remove AI key' });
  }
});

module.exports = router;
