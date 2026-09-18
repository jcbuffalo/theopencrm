// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Admin → Traffic (GET /api/admin/traffic). Read-only rollups over the
// first-party page_views table (migration 165) for the /admin/traffic page.
//
// SUPER-ADMIN ONLY — same middleware stack as platformIntegrationsRoutes:
// traffic is platform-wide (it includes anonymous marketing visits and every
// tenant's authenticated navigation mixed together), so it is operator data,
// not org-admin data.
//
// What it can and cannot answer, by design (see migration 165):
//   CAN:    page loads per day, top route patterns, top external referrer
//           hosts, authenticated vs anonymous split.
//   CANNOT: unique visitors, per-user or per-org drilldowns, full referrer
//           URLs, query strings. There is no visitor identifier at all.

const express = require('express');
const pool = require('../db');
const { authMiddleware } = require('../auth');
const { adminMiddleware, roleMiddleware } = require('../middleware/adminAuth');

const router = express.Router();

router.use(authMiddleware, adminMiddleware, roleMiddleware('super_admin'));

// GET /api/admin/traffic?days=30 — one payload for the whole page.
router.get('/', async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));

    const [byDay, topPaths, topReferrers, totals] = await Promise.all([
      pool.query(
        `SELECT (created_at AT TIME ZONE 'UTC')::date AS day,
                COUNT(*)::int AS views,
                COUNT(*) FILTER (WHERE is_authenticated)::int AS authenticated,
                COUNT(*) FILTER (WHERE NOT is_authenticated)::int AS anonymous
           FROM page_views
          WHERE created_at >= NOW() - ($1 || ' days')::interval
          GROUP BY 1
          ORDER BY 1 ASC`,
        [days]
      ),
      pool.query(
        `SELECT path, COUNT(*)::int AS views
           FROM page_views
          WHERE created_at >= NOW() - ($1 || ' days')::interval
          GROUP BY path
          ORDER BY views DESC, path ASC
          LIMIT 20`,
        [days]
      ),
      pool.query(
        `SELECT referrer_host, COUNT(*)::int AS views
           FROM page_views
          WHERE created_at >= NOW() - ($1 || ' days')::interval
            AND referrer_host IS NOT NULL
          GROUP BY referrer_host
          ORDER BY views DESC, referrer_host ASC
          LIMIT 20`,
        [days]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS views,
                COUNT(*) FILTER (WHERE is_authenticated)::int AS authenticated,
                COUNT(*) FILTER (WHERE NOT is_authenticated)::int AS anonymous
           FROM page_views
          WHERE created_at >= NOW() - ($1 || ' days')::interval`,
        [days]
      ),
    ]);

    res.json({
      success: true,
      data: {
        days,
        by_day: byDay.rows,
        top_paths: topPaths.rows,
        top_referrers: topReferrers.rows,
        totals: totals.rows[0] || { views: 0, authenticated: 0, anonymous: 0 },
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
