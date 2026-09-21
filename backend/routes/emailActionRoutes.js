// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// One-click actions from notification emails (spec 204).
//
//   GET  /api/email-actions/:token        → what the link would do (no mutation)
//   POST /api/email-actions/:token/apply  → do it (single-use)
//
// SESSION-LESS BY DESIGN: the token is the credential (see
// services/emailActions.js — sha256-stored, 7-day, single-use, org/user
// scope from the row). No cookie, no CSRF (the mount is in index.js's
// csrfIgnoredRoutes; a forged cross-site POST would still need a valid
// unguessable token). The SPA page /act/:token calls these; the email link
// itself is a GET to that page, so mail scanners never trigger the apply.
//
// Rate-limited at the mount (per IP) like the other public token surfaces.

const express = require('express');
const emailActions = require('../services/emailActions');

const router = express.Router();

router.get('/:token', async (req, res) => {
  try {
    const out = await emailActions.describe(req.params.token);
    res.status(out.ok ? 200 : out.status || 400).json(out);
  } catch (err) {
    if (req.log) req.log.error('email_action_describe_failed', { error: err });
    else console.error('email action describe error:', err.message);
    res.status(500).json({ ok: false, message: 'Something went wrong.' });
  }
});

router.post('/:token/apply', async (req, res) => {
  try {
    const out = await emailActions.apply(req.params.token);
    if (out.ok && req.log) req.log.info('email_action_applied', { action: out.action, entityType: out.entity_type, entityId: out.entity_id });
    res.status(out.ok ? 200 : out.status || 400).json(out);
  } catch (err) {
    if (req.log) req.log.error('email_action_apply_failed', { error: err });
    else console.error('email action apply error:', err.message);
    res.status(500).json({ ok: false, message: 'Something went wrong.' });
  }
});

module.exports = router;
