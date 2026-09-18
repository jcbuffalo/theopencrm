// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// SSO handoff — let other ACV-owned products (the Workforce / VCI Points & Pay
// app, and any future apps) treat The Open CRM as the identity authority.
//
// Flow:
//   1. User is logged in to the CRM (normal Login.js path — email/password or
//      Google Sign-In doesn't matter; they have a JWT).
//   2. The other app sends them to https://app.theopencrm.com/sso/handoff?return=<their_url>.
//   3. The handoff page (frontend) calls POST /api/auth/sso/mint with the return URL.
//   4. We verify the user, mint a short-lived (5 min) HS256 JWT signed with the
//      shared JWT_SSO_SECRET, and hand it back.
//   5. The frontend redirects the browser to <return>?token=<jwt>.
//   6. The other app verifies the token (same shared secret), JIT-provisions
//      its own user record if needed, and issues its own session token.
//
// SECURITY notes:
//   - JWT_SSO_SECRET is intentionally different from JWT_SECRET. A leak of one
//     should not compromise the other.
//   - return_url is validated against SSO_ALLOWED_RETURN_HOSTS (comma-separated
//     hostnames) to prevent open-redirect.
//   - Tokens expire in 5 minutes — keep the round-trip tight.
//   - iss/aud claims are pinned so a token minted for one consumer can't be
//     replayed against another.

const express = require('express');
const jwt = require('jsonwebtoken');
const { authMiddleware } = require('../auth');
const pool = require('../db');

const router = express.Router();

function getAllowedReturnHosts() {
  const raw = process.env.SSO_ALLOWED_RETURN_HOSTS || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAllowedReturnUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  // HTTPS only for production. Allow localhost over HTTP for dev.
  if (u.protocol !== 'https:' && u.hostname !== 'localhost') return false;
  const allowed = getAllowedReturnHosts();
  return allowed.includes(u.hostname);
}

// POST /api/auth/sso/mint
// Body: { return_url: string, audience?: string }
// Auth: required (CRM JWT)
router.post('/mint', authMiddleware, async (req, res) => {
  try {
    if (!process.env.JWT_SSO_SECRET) {
      return res.status(503).json({
        success: false,
        message: 'SSO is not configured (JWT_SSO_SECRET not set).',
      });
    }

    const { return_url, audience } = req.body || {};
    if (!isAllowedReturnUrl(return_url)) {
      return res.status(400).json({
        success: false,
        message: 'return_url is missing or not on the SSO allowlist.',
      });
    }

    // Look up the canonical user details to bake into the token.
    const result = await pool.query(
      `SELECT id, email, first_name, last_name
       FROM users WHERE id = $1`,
      [req.userId],
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'User not found.' });
    }
    const user = result.rows[0];

    const aud = (typeof audience === 'string' && audience.trim()) || 'workforce';

    const ssoToken = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        firstName: user.first_name || '',
        lastName: user.last_name || '',
      },
      process.env.JWT_SSO_SECRET,
      {
        algorithm: 'HS256',
        expiresIn: '5m',
        issuer: 'theopencrm',
        audience: aud,
      },
    );

    res.json({
      success: true,
      token: ssoToken,
      return_url,
    });
  } catch (err) {
    console.error('SSO mint error:', err);
    res.status(500).json({ success: false, message: 'Failed to mint SSO token.' });
  }
});

module.exports = router;
