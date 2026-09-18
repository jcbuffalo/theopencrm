// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

const express = require('express');
const pool = require('../db');
const { optionalAuth, validatePassword } = require('../auth');

const router = express.Router();

// GET /api/invites/:token — get invite info (public, for the accept invite page)
router.get('/:token', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT i.id, i.email, i.role, i.expires_at, i.accepted_at, o.name AS org_name
       FROM org_invites i
       JOIN organizations o ON i.org_id = o.id
       WHERE i.token = $1`,
      [req.params.token]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Invite not found or expired' });

    const invite = result.rows[0];
    if (invite.accepted_at) return res.status(400).json({ error: 'Invite already accepted' });
    if (new Date(invite.expires_at) < new Date()) return res.status(400).json({ error: 'Invite has expired' });

    res.json({ invite });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch invite' });
  }
});

// POST /api/invites/:token/accept — accept invite.
//
// optionalAuth populates req.userId when the caller already has a valid session
// cookie (it never rejects, so brand-new invitees still reach the handler).
//
// SECURITY: if the invited email already belongs to an existing user, we must
// NOT mint a session for that user on the strength of the token alone — the
// inviter controls both the email and the token, so that would be a cross-tenant
// account takeover. An existing user must prove they are that account (already
// signed in as it) before we attach them to the org. Only the brand-new-account
// branch creates credentials and authenticates.
router.post('/:token/accept', optionalAuth, async (req, res) => {
  const { name, password } = req.body;

  try {
    const result = await pool.query(
      `SELECT i.*, o.id AS org_id, o.name AS org_name
       FROM org_invites i
       JOIN organizations o ON i.org_id = o.id
       WHERE i.token = $1 AND i.accepted_at IS NULL AND i.expires_at > NOW()`,
      [req.params.token]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Invite not found, expired, or already used' });

    const invite = result.rows[0];

    const existingUser = await pool.query('SELECT id, name, email FROM users WHERE email = $1', [invite.email]);
    const isExistingUser = existingUser.rows.length > 0;

    let user;
    let issueSession;

    if (isExistingUser) {
      // The email already has an account. Require the caller to already be
      // authenticated AS that account — no credential check means no session.
      if (!req.userId || req.userId !== existingUser.rows[0].id) {
        return res.status(401).json({
          error: 'This email already has an account. Please sign in first, then open the invite link to join the workspace.',
          requiresLogin: true,
        });
      }
      user = existingUser.rows[0];
      issueSession = false; // caller is already authenticated as this user
    } else {
      if (!name || !password) return res.status(400).json({ error: 'Name and password required for new account' });
      const pw = validatePassword(password);
      if (!pw.ok) return res.status(400).json({ error: pw.error || 'Password does not meet the required policy' });

      const bcrypt = require('bcryptjs');
      const hash = await bcrypt.hash(password, 12);
      const created = await pool.query(
        `INSERT INTO users (email, name, password_hash, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id, name, email`,
        [invite.email, name, hash]
      );
      user = created.rows[0];
      issueSession = true; // brand-new account we just created — safe to authenticate
    }

    // Join the org
    await pool.query(
      'UPDATE users SET org_id = $1, org_role = $2 WHERE id = $3',
      [invite.org_id, invite.role, user.id]
    );

    // Mark invite accepted
    await pool.query('UPDATE org_invites SET accepted_at = NOW() WHERE id = $1', [invite.id]);

    // Only mint a session for a brand-new account. An existing user is already
    // authenticated as themselves; we never issue a cookie on their behalf here.
    let csrfToken = null;
    if (issueSession) {
      const { generateToken, AUTH_COOKIE_NAME, authCookieOptions } = require('../auth');
      const token = generateToken(user.id);
      res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions());
      try {
        if (typeof req.app.locals.generateCsrfToken === 'function') {
          csrfToken = req.app.locals.generateCsrfToken(req, res);
        }
      } catch { /* csrf middleware missing in test harness — ignore */ }
    }

    res.json({
      success: true,
      message: `Welcome to ${invite.org_name}!`,
      csrfToken,
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (err) {
    console.error('Accept invite error:', err);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

module.exports = router;
