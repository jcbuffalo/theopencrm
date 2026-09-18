// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Filter helpers — returns dropdown options for the various filter dimensions
// Exhibit A asks for, plus saved-filter CRUD so users can keep their favourite
// views one click away.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const { validateBody } = require('../middleware/validate');
const { saveFilterSchema } = require('../schemas/filters');

const router = express.Router();
router.use(authMiddleware);

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

router.get('/options', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const [verticals, products, classes, sizes, offices, customers, vendors, salesmen] = await Promise.all([
      pool.query(`SELECT DISTINCT vertical FROM deals WHERE ${sf} = $1 AND vertical IS NOT NULL AND vertical <> '' ORDER BY vertical`, [sv]),
      pool.query(`SELECT DISTINCT product FROM deals WHERE ${sf} = $1 AND product IS NOT NULL AND product <> '' ORDER BY product`, [sv]),
      pool.query(`SELECT DISTINCT deal_class FROM deals WHERE ${sf} = $1 AND deal_class IS NOT NULL AND deal_class <> '' ORDER BY deal_class`, [sv]),
      pool.query(`SELECT DISTINCT deal_size FROM deals WHERE ${sf} = $1 AND deal_size IS NOT NULL AND deal_size <> '' ORDER BY deal_size`, [sv]),
      pool.query(`SELECT DISTINCT office_location FROM deals WHERE ${sf} = $1 AND office_location IS NOT NULL AND office_location <> '' ORDER BY office_location`, [sv]),
      pool.query(`SELECT id, name FROM companies WHERE ${sf} = $1 AND type = 'customer' ORDER BY name LIMIT 500`, [sv]),
      pool.query(`SELECT id, name FROM companies WHERE ${sf} = $1 AND type = 'vendor' ORDER BY name LIMIT 500`, [sv]),
      pool.query(`SELECT id, email, name FROM users WHERE ${sf} = $1 ORDER BY name`, [sv]),
    ]);
    res.json({
      verticals:  verticals.rows.map(r => r.vertical),
      products:   products.rows.map(r => r.product),
      classes:    classes.rows.map(r => r.deal_class),
      sizes:      sizes.rows.map(r => r.deal_size),
      offices:    offices.rows.map(r => r.office_location),
      customers:  customers.rows,
      vendors:    vendors.rows,
      salesmen:   salesmen.rows,
      issueCategories: ['logistics', 'technical', 'financial', 'other'],
      issueUrgencies: ['red', 'yellow', 'green'],
      issueImpacts: ['zang', 'customer', 'vendor', 'zang_customer', 'zang_vendor'],
      contactTypes: ['customer', 'vendor', 'end_user', 'partner', 'other'],
      lastActivityWindows: [
        { id: 'never',    label: 'No activity ever',  days: null },
        { id: '30d',      label: '> 30 days',         days: 30 },
        { id: '60d',      label: '> 60 days',         days: 60 },
        { id: '90d',      label: '> 90 days',         days: 90 },
        { id: '180d',     label: '> 180 days',        days: 180 },
      ],
    });
  } catch (error) {
    console.error('Filter options error:', error);
    res.status(500).json({ error: 'Failed to load filter options' });
  }
});

// -------- Saved filters --------
//
// As of migration 073 the canonical storage for these is `saved_views` (the
// new unified table backing the SavedViewsTabs UI). We keep this endpoint
// shape (`/filters/saved`, with `scope` + `filters` field names) so the
// existing DealFilters.js sidebar still works without a frontend rewrite —
// it just reads/writes the same rows the tab strip does, via a different
// projection. `scope` maps to `resource`, `filters` maps to `filter_spec`.

router.get('/saved', async (req, res) => {
  try {
    const { scope = 'deals' } = req.query;
    const r = await pool.query(
      `SELECT id,
              resource AS scope,
              name,
              filter_spec AS filters,
              created_at
         FROM saved_views
        WHERE user_id = $1 AND resource = $2 AND org_id IS NOT DISTINCT FROM $3
        ORDER BY name`,
      [req.userId, scope, req.orgId || null]
    );
    res.json(r.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load saved filters' });
  }
});

router.post('/saved', validateBody(saveFilterSchema), async (req, res) => {
  try {
    const { scope, name, filters } = req.body;
    // zod has already trimmed + truncated name to 80 chars.
    const r = await pool.query(
      `INSERT INTO saved_views (user_id, org_id, resource, name, filter_spec)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id,
                 resource AS scope,
                 name,
                 filter_spec AS filters,
                 created_at`,
      [req.userId, req.orgId || null, scope, name, JSON.stringify(filters)]
    );
    res.status(201).json(r.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to save filter' });
  }
});

router.delete('/saved/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM saved_views WHERE id = $1 AND user_id = $2 AND org_id IS NOT DISTINCT FROM $3 RETURNING id`,
      [req.params.id, req.userId, req.orgId || null]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Filter not found' });
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete saved filter' });
  }
});

module.exports = router;
