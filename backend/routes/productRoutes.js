// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Product catalog — reusable priced line items for the generic light-CPQ quote
// builder. Mounted at /api/products, gated by the `products_enabled` feature
// flag. Fully org-scoped via qs(req).
//
// READS  (list/get): any authenticated member of the org.
// WRITES (create/update/delete): ORG-ADMIN only (owner|admin), mirroring
//   customFieldsRoutes.requireOrgAdmin. Personal (org-less) workspaces own all
//   their own data, so the gate no-ops there.
//
// This catalog is deliberately separate from the bespoke Zang quotes workflow.
// See migration 119_products.sql.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const audit = require('../services/audit');
const salesQuotes = require('../services/salesQuotes');

const router = express.Router();
router.use(authMiddleware);

// Returns [scopeField, scopeValue] for the current request's tenancy.
function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// Catalog-mutation gate. In an org, only owner/admin may edit the shared
// catalog. In a personal (org-less) workspace there's no other tenant to gate
// against and the user owns everything, so we let it through.
function requireCatalogAdmin(req, res, next) {
  if (!req.orgId) return next();
  if (req.orgRole === 'owner' || req.orgRole === 'admin') return next();
  return res.status(403).json({ error: 'Only org owners/admins can manage the product catalog' });
}

// Coerce/clamp a client-sent price to a non-negative 2-dp number.
function cleanPrice(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

// GET / — list catalog. ?active=true filters to active-only.
router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const rows = await salesQuotes.listProducts(
      { sf, sv, activeOnly: req.query.active === 'true' },
      pool,
    );
    res.json(rows);
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// GET /:id — single catalog item.
router.get('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `SELECT * FROM products WHERE id = $1 AND ${sf} = $2`,
      [req.params.id, sv],
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    res.json(r.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// POST / — create a catalog item (org-admin only).
router.post('/', requireCatalogAdmin, async (req, res) => {
  try {
    const { name, sku, description, unit_price, unit, active } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const r = await pool.query(
      `INSERT INTO products (org_id, user_id, name, sku, description, unit_price, unit, active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        req.orgId || null,
        req.userId,
        String(name).trim(),
        sku ? String(sku).trim() : null,
        description ? String(description) : null,
        cleanPrice(unit_price),
        unit ? String(unit).trim() : 'each',
        active === false ? false : true,
        req.userId,
      ],
    );
    const product = r.rows[0];
    audit.fromReq(req, {
      event: audit.EVENTS.PRODUCT_CREATED,
      targetType: 'product',
      targetId: product.id,
      meta: { name: product.name, sku: product.sku },
    });
    res.status(201).json(product);
  } catch (error) {
    console.error('Product create error:', error);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// PUT /:id — update a catalog item (org-admin only).
router.put('/:id', requireCatalogAdmin, async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { name, sku, description, unit_price, unit, active } = req.body || {};
    const r = await pool.query(
      `UPDATE products SET
         name        = COALESCE($1, name),
         sku         = $2,
         description = $3,
         unit_price  = COALESCE($4, unit_price),
         unit        = COALESCE($5, unit),
         active      = COALESCE($6, active),
         updated_at  = CURRENT_TIMESTAMP
       WHERE id = $7 AND ${sf} = $8 RETURNING *`,
      [
        name != null ? String(name).trim() : null,
        sku != null ? String(sku).trim() : null,
        description != null ? String(description) : null,
        unit_price != null ? cleanPrice(unit_price) : null,
        unit != null ? String(unit).trim() : null,
        typeof active === 'boolean' ? active : null,
        req.params.id,
        sv,
      ],
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    res.json(r.rows[0]);
  } catch (error) {
    console.error('Product update error:', error);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// DELETE /:id — remove a catalog item (org-admin only). Quote lines that
// referenced it keep their snapshotted name/price (product_id → NULL via FK).
router.delete('/:id', requireCatalogAdmin, async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `DELETE FROM products WHERE id = $1 AND ${sf} = $2 RETURNING id`,
      [req.params.id, sv],
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    res.json({ message: 'Product deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

module.exports = router;
module.exports.__test__ = { requireCatalogAdmin, cleanPrice };
