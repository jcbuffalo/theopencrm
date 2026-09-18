// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// First-party pageview beacon (POST /api/metrics/pageview → page_views,
// migration 165). Fire-and-forget from the SPA on every route change
// (frontend/src/components/PageviewBeacon.js).
//
// PROPERTIES:
//   - Auth-OPTIONAL: marketing/login/portal traffic is the interesting part.
//     optionalAuth only decodes the cookie if present; when it does, we stamp
//     is_authenticated + the user's org_id (one PK lookup).
//   - CSRF-exempt (index.js csrfIgnoredRoutes): writes an aggregate counter
//     row, grants nothing to the caller.
//   - Rate-limited: pageviewLimiter 60/15min/IP, mounted in index.js.
//   - NO PII: the client sends { path, referrer_host } only, and the server
//     re-normalizes both through utils/pathNormalizer.js regardless — ids and
//     tokens are masked, query strings dropped, referrers reduced to a bare
//     hostname. No IP, no UA, no visitor id is stored. See migration 165.
//   - Never errors to the client: any failure answers 204 and logs at debug.
//
// MOUNT ORDER: mounted at /api/metrics/pageview BEFORE the
// requireFeature('reports_enabled')-gated /api/metrics router, so beacons work
// for anonymous visitors and for orgs with reports disabled.

const express = require('express');
const pool = require('../db');
const { optionalAuth } = require('../auth');
const { normalizePath, normalizeReferrerHost } = require('../utils/pathNormalizer');

const router = express.Router();

router.post('/', optionalAuth, async (req, res) => {
  try {
    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    const path = normalizePath(b.path);
    if (path) {
      const referrerHost = normalizeReferrerHost(b.referrer_host);
      let orgId = null;
      const isAuthenticated = !!req.userId;
      if (isAuthenticated) {
        const r = await pool.query('SELECT org_id FROM users WHERE id = $1', [req.userId]);
        orgId = r.rows[0]?.org_id ?? null;
      }
      await pool.query(
        `INSERT INTO page_views (org_id, path, referrer_host, is_authenticated)
         VALUES ($1, $2, $3, $4)`,
        [orgId, path, referrerHost, isAuthenticated]
      );
    }
  } catch (err) {
    // Silent by design — analytics must never make noise or break anything.
    req.log?.debug?.('pageview_insert_failed', { error: err.message });
  }
  // Always 204 — the sender is fire-and-forget (sendBeacon / keepalive fetch)
  // and an implausible path is simply dropped, never rejected.
  res.status(204).end();
});

module.exports = router;
