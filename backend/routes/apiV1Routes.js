// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Public developer API — /api/v1/*.
//
// This is the FIRST surface authenticated by an API key instead of the session
// cookie. It proves the middleware/apiKeyAuth.js path end-to-end while keeping
// the blast radius small: read-only list endpoints for deals and contacts.
//
// Auth: apiKeyAuth (router-level) — NOT authMiddleware. A `tocrm_...` key in
// `Authorization: Bearer` or `X-API-Key` is required. The middleware sets
// req.orgId / req.userId so the same qs(req) org-scoping the cookie-auth routes
// use applies unchanged — cross-org access stays structurally impossible.

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { apiKeyAuth, requireScope } = require('../middleware/apiKeyAuth');

// Every /api/v1 route authenticates with an API key and requires the 'read'
// scope (the default scope every key is minted with).
router.use(apiKeyAuth);
router.use(requireScope('read'));

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// A tiny identity endpoint so integrators can verify their key + see its scope.
router.get('/me', (req, res) => {
  res.json({
    success: true,
    api_key: { name: req.apiKey?.name, key_prefix: req.apiKey?.key_prefix, scopes: req.apiKey?.scopes },
    org_id: req.orgId ?? null,
  });
});

// GET /api/v1/deals — read-only list, org-scoped, capped.
router.get('/deals', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const r = await pool.query(
      `SELECT id, title, stage, phase, amount, expected_close_date, created_at, updated_at
         FROM deals WHERE ${sf} = $1 ORDER BY created_at DESC LIMIT $2`,
      [sv, limit]
    );
    res.json({ success: true, deals: r.rows });
  } catch (err) {
    if (req.log) req.log.error('api_v1_deals_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to list deals' });
  }
});

// GET /api/v1/contacts — read-only list, org-scoped, capped.
router.get('/contacts', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const r = await pool.query(
      `SELECT id, first_name, last_name, email, phone, company_id, created_at
         FROM contacts WHERE ${sf} = $1 ORDER BY created_at DESC LIMIT $2`,
      [sv, limit]
    );
    res.json({ success: true, contacts: r.rows });
  } catch (err) {
    if (req.log) req.log.error('api_v1_contacts_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to list contacts' });
  }
});

module.exports = router;
