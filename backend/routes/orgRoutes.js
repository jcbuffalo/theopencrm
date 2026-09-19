// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Organizations — the multi-tenancy unit. Every business record (companies,
// deals, quotes, etc.) carries an org_id. This file owns the workspace
// management surface: rename, list members, invite teammates, remove members.
//
// Endpoints (all auth-required, scoped to the user's own org):
//   GET    /                         — { org, members, pendingInvites }
//   PUT    /                         — rename the org
//   POST   /invite                   — create an invite token (32-byte hex, 7-day expiry)
//   DELETE /invites/:id              — cancel a pending invite
//   DELETE /members/:id              — remove a member (sets their org_id = NULL)
//   GET    /email-identity           — outbound From: name / Reply-To (+ effective preview)
//   PUT    /email-identity           — owner/admin: set/clear sender_name, reply_to
//
// The accept-invite flow (where new users redeem the token) lives in a
// separate file: routes/acceptInviteRoutes.js (no auth required there since
// the user doesn't have an account yet).

const express = require('express');
const crypto = require('crypto');
const { authMiddleware } = require('../auth');
const pool = require('../db');
// Tier seat caps (migration 136) — inert unless the org has an explicit
// capped limits_tier; comped/paid/super-admin exempt. See services/tierLimits.js.
const tierLimits = require('../services/tierLimits');
// Outbound sender identity (From: name + Reply-To) — services/senderIdentity.js.
const senderIdentity = require('../services/senderIdentity');
const email = require('../services/email');
const audit = require('../services/audit');
const { requireOrgAdmin } = require('../middleware/adminAuth');

const router = express.Router();
router.use(authMiddleware);

// GET /api/org — current org info + members
router.get('/', async (req, res) => {
  if (!req.orgId) return res.status(404).json({ error: 'No organization found' });

  try {
    const [orgResult, membersResult, invitesResult] = await Promise.all([
      pool.query('SELECT * FROM organizations WHERE id = $1', [req.orgId]),
      pool.query(
        `SELECT u.id, u.name, u.email, u.org_role, u.created_at
         FROM users u WHERE u.org_id = $1 ORDER BY u.created_at ASC`,
        [req.orgId]
      ),
      pool.query(
        `SELECT id, email, role, created_at, expires_at, accepted_at
         FROM org_invites WHERE org_id = $1 AND accepted_at IS NULL AND expires_at > NOW()
         ORDER BY created_at DESC`,
        [req.orgId]
      ),
    ]);

    if (orgResult.rows.length === 0) return res.status(404).json({ error: 'Organization not found' });

    res.json({
      org: orgResult.rows[0],
      members: membersResult.rows,
      pendingInvites: invitesResult.rows,
    });
  } catch (err) {
    console.error('Org fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch organization' });
  }
});

// POST /api/org/invite — invite a user by email
router.post('/invite', async (req, res) => {
  if (!req.orgId) return res.status(404).json({ error: 'No organization found' });
  if (req.orgRole !== 'owner') return res.status(403).json({ error: 'Only org owners can invite members' });

  const { email, role = 'member' } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  // --- Tier seat cap (inert-by-default) -----------------------------------
  // 402s ONLY when the org is explicitly on a capped limits_tier, is neither
  // comped nor paid, the caller isn't a super-admin, AND active members +
  // pending invites already meet the cap. Fails OPEN on any internal error.
  const seatGate = await tierLimits.seatLimitGate(req);
  if (seatGate) return res.status(seatGate.statusCode).json(seatGate.body);
  // -------------------------------------------------------------------------

  try {
    // Check if user already in org
    const existing = await pool.query('SELECT id FROM users WHERE email = $1 AND org_id = $2', [email, req.orgId]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'User is already in this organization' });

    // Cancel any existing pending invite for this email+org
    await pool.query('DELETE FROM org_invites WHERE org_id = $1 AND email = $2 AND accepted_at IS NULL', [req.orgId, email]);

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const result = await pool.query(
      `INSERT INTO org_invites (org_id, invited_by_user_id, email, role, token, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.orgId, req.userId, email, role, token, expiresAt]
    );

    res.status(201).json({
      invite: result.rows[0],
      inviteUrl: `${process.env.FRONTEND_URL || 'https://app.theopencrm.com'}/accept-invite/${token}`,
    });
  } catch (err) {
    console.error('Invite error:', err);
    res.status(500).json({ error: 'Failed to create invite' });
  }
});

// DELETE /api/org/invites/:id — cancel invite
router.delete('/invites/:id', async (req, res) => {
  if (req.orgRole !== 'owner') return res.status(403).json({ error: 'Only owners can cancel invites' });

  try {
    const result = await pool.query(
      'DELETE FROM org_invites WHERE id = $1 AND org_id = $2 RETURNING *',
      [req.params.id, req.orgId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Invite not found' });
    res.json({ message: 'Invite cancelled' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel invite' });
  }
});

// DELETE /api/org/members/:id — remove a member
router.delete('/members/:id', async (req, res) => {
  if (req.orgRole !== 'owner') return res.status(403).json({ error: 'Only owners can remove members' });
  if (String(req.params.id) === String(req.userId)) return res.status(400).json({ error: 'Cannot remove yourself' });

  try {
    const result = await pool.query(
      'UPDATE users SET org_id = NULL, org_role = NULL WHERE id = $1 AND org_id = $2 RETURNING id, email, name',
      [req.params.id, req.orgId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Member not found in this org' });
    res.json({ message: 'Member removed', user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// ---------------------------------------------------------------------------
// Outbound sender identity (Settings → Workspace → "Outbound email").
//
//   GET /api/org/email-identity — any member: stored sender_name / reply_to
//       plus the EFFECTIVE From: header preview and whether a transport exists.
//   PUT /api/org/email-identity { sender_name?, reply_to? } — org owner/admin
//       (requireOrgAdmin). Either key null/'' clears. Stored on
//       organizations.branding.email (services/senderIdentity.js). Audited.
// ---------------------------------------------------------------------------
router.get('/email-identity', async (req, res) => {
  if (!req.orgId) return res.status(404).json({ error: 'No organization found' });
  try {
    const identity = await senderIdentity.getSenderIdentity(req.orgId);
    res.json({
      sender_name: identity.sender_name,
      reply_to: identity.reply_to,
      effective: {
        from: email.fromHeader({ fromName: identity.fromName, verbatim: identity.fromNameIsCustom }),
        reply_to: identity.replyTo || null,
      },
      email_configured: email.isConfigured(),
      transport: email.transportKind(),
    });
  } catch (err) {
    if (req.log) req.log.error('org_email_identity_get_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to load sender identity' });
  }
});

router.put('/email-identity', requireOrgAdmin, async (req, res) => {
  if (!req.orgId) return res.status(404).json({ error: 'No organization found' });
  const norm = senderIdentity.normalizeInput(req.body);
  if (norm.error) return res.status(400).json({ error: norm.error });
  try {
    const identity = await senderIdentity.saveSenderIdentity(req.orgId, norm.value);
    if (!identity) return res.status(404).json({ error: 'Organization not found' });
    audit.fromReq(req, {
      event: audit.EVENTS.ORG_EMAIL_IDENTITY_UPDATED,
      targetType: 'organization',
      targetId: String(req.orgId),
      meta: { fields: Object.keys(norm.value) },
    });
    res.json({
      sender_name: identity.sender_name,
      reply_to: identity.reply_to,
      effective: {
        from: email.fromHeader({ fromName: identity.fromName, verbatim: identity.fromNameIsCustom }),
        reply_to: identity.replyTo || null,
      },
      email_configured: email.isConfigured(),
      transport: email.transportKind(),
    });
  } catch (err) {
    if (req.log) req.log.error('org_email_identity_put_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to save sender identity' });
  }
});

// PUT /api/org — update org settings (name, profile, branding).
//
// Org owners (or super admins) only. Each field optional; only the provided
// keys are updated. `branding` is a JSONB merge so partial updates don't
// clobber other branding keys.
router.put('/', async (req, res) => {
  if (req.orgRole !== 'owner') return res.status(403).json({ error: 'Only owners can update org settings' });

  const { name, profile, branding } = req.body || {};

  // Validate profile value if provided
  const VALID_PROFILES = ['generic', 'zang', 'jcp'];
  if (profile !== undefined && !VALID_PROFILES.includes(profile)) {
    return res.status(400).json({
      error: `Invalid profile. Must be one of: ${VALID_PROFILES.join(', ')}`,
    });
  }
  if (branding !== undefined && (typeof branding !== 'object' || branding === null || Array.isArray(branding))) {
    return res.status(400).json({ error: 'branding must be a JSON object' });
  }

  try {
    // Build a dynamic UPDATE with COALESCE so unspecified fields are left alone.
    // branding uses jsonb concat (||) so partial updates merge keys rather
    // than replacing the whole object.
    const result = await pool.query(
      `UPDATE organizations
          SET name     = COALESCE($1, name),
              profile  = COALESCE($2, profile),
              branding = CASE WHEN $3::jsonb IS NOT NULL
                              THEN COALESCE(branding, '{}'::jsonb) || $3::jsonb
                              ELSE branding END,
              updated_at = NOW()
        WHERE id = $4
        RETURNING *`,
      [
        name?.trim() || null,
        profile || null,
        branding ? JSON.stringify(branding) : null,
        req.orgId,
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Organization not found' });
    res.json(result.rows[0]);
  } catch (err) {
    if (req.log) req.log.error('org_update_failed', { error: err.message });
    res.status(500).json({ error: 'Failed to update org' });
  }
});

module.exports = router;
