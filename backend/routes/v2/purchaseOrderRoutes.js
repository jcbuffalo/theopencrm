// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Purchase Order routes — v2 entity. Mirrors the RFQ shape (CRUD + line items
// + version snapshot) but with PO-specific fields (acknowledged_at,
// released_at, the public_id UUID, and the denormalized
// quantity_invoiced / amount_invoiced fields on line items).

const express = require('express');
const { authMiddleware } = require('../../auth');
const pool = require('../../db');
const { requireFeature } = require('../../middleware/featureGate');

const router = express.Router();
router.use(authMiddleware);
router.use(requireFeature('phase2_entities'));

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { deal_id, quote_id, vendor_id, status } = req.query;
    let q = `SELECT po.*, v.name AS vendor_name
               FROM purchase_orders po
          LEFT JOIN companies v ON po.vendor_id = v.id
              WHERE po.${sf} = $1`;
    const params = [sv];
    if (deal_id)   { q += ` AND po.deal_id = $${params.length + 1}`;   params.push(deal_id); }
    if (quote_id)  { q += ` AND po.quote_id = $${params.length + 1}`;  params.push(quote_id); }
    if (vendor_id) { q += ` AND po.vendor_id = $${params.length + 1}`; params.push(vendor_id); }
    if (status)    { q += ` AND po.status = $${params.length + 1}`;    params.push(status); }
    q += ' ORDER BY po.created_at DESC';
    const result = await pool.query(q, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    if (req.log) req.log.error('po_list_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to list purchase orders' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const po = await pool.query(`SELECT * FROM purchase_orders WHERE id = $1 AND ${sf} = $2`, [req.params.id, sv]);
    if (po.rows.length === 0) return res.status(404).json({ success: false, error: 'Purchase order not found' });
    const [lineItems, versions] = await Promise.all([
      pool.query(`SELECT * FROM purchase_order_line_items WHERE purchase_order_id = $1 ORDER BY position, id`, [req.params.id]),
      pool.query(`SELECT id, version_number, notes, created_at FROM purchase_order_versions WHERE purchase_order_id = $1 ORDER BY version_number DESC`, [req.params.id]),
    ]);
    res.json({ success: true, data: { ...po.rows[0], line_items: lineItems.rows, versions: versions.rows } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch purchase order' });
  }
});

router.post('/', async (req, res) => {
  try {
    if (!req.orgId) return res.status(400).json({ success: false, error: 'Org context required' });
    const { deal_id, quote_id, vendor_id, status, po_number, external_ref } = req.body;
    if (!vendor_id) return res.status(400).json({ success: false, error: 'vendor_id is required' });
    const result = await pool.query(
      `INSERT INTO purchase_orders (org_id, deal_id, quote_id, vendor_id, status, po_number, external_ref, created_by, updated_by)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'draft'), $6, $7, $8, $8)
       RETURNING *`,
      [req.orgId, deal_id || null, quote_id || null, vendor_id, status, po_number, external_ref, req.userId]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to create purchase order', detail: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { deal_id, quote_id, vendor_id, status, po_number, external_ref, sent_at, acknowledged_at, released_at } = req.body;
    const result = await pool.query(
      `UPDATE purchase_orders SET
         deal_id         = COALESCE($1, deal_id),
         quote_id        = COALESCE($2, quote_id),
         vendor_id       = COALESCE($3, vendor_id),
         status          = COALESCE($4, status),
         po_number       = COALESCE($5, po_number),
         external_ref    = COALESCE($6, external_ref),
         sent_at         = COALESCE($7, sent_at),
         acknowledged_at = COALESCE($8, acknowledged_at),
         released_at     = COALESCE($9, released_at),
         updated_at      = CURRENT_TIMESTAMP,
         updated_by      = $10,
         entity_version  = entity_version + 1
       WHERE id = $11 AND ${sf} = $12
       RETURNING *`,
      [deal_id, quote_id, vendor_id, status, po_number, external_ref, sent_at, acknowledged_at, released_at, req.userId, req.params.id, sv]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Purchase order not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update purchase order' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(`DELETE FROM purchase_orders WHERE id = $1 AND ${sf} = $2 RETURNING id`, [req.params.id, sv]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Purchase order not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to delete purchase order' });
  }
});

// ---- LINE ITEMS ------------------------------------------------------------
router.post('/:id/line-items', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const own = await pool.query(`SELECT id FROM purchase_orders WHERE id = $1 AND ${sf} = $2`, [req.params.id, sv]);
    if (own.rows.length === 0) return res.status(404).json({ success: false, error: 'Purchase order not found' });
    const { description, quantity, unit_cost, sku, position } = req.body;
    const result = await pool.query(
      `INSERT INTO purchase_order_line_items
         (org_id, purchase_order_id, description, quantity, unit_cost, sku, position, created_by, updated_by)
       VALUES ($1, $2, $3, COALESCE($4, 1), $5, $6, COALESCE($7, 0), $8, $8)
       RETURNING *`,
      [req.orgId, req.params.id, description, quantity, unit_cost, sku, position, req.userId]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to add line item', detail: err.message });
  }
});

router.put('/:id/line-items/:lid', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { description, quantity, unit_cost, sku, position } = req.body;
    const result = await pool.query(
      `UPDATE purchase_order_line_items li SET
         description = COALESCE($1, description),
         quantity    = COALESCE($2, quantity),
         unit_cost   = COALESCE($3, unit_cost),
         sku         = COALESCE($4, sku),
         position    = COALESCE($5, position),
         updated_at  = CURRENT_TIMESTAMP,
         updated_by  = $6,
         entity_version = entity_version + 1
        FROM purchase_orders po
       WHERE li.id = $7 AND li.purchase_order_id = po.id AND li.purchase_order_id = $8 AND po.${sf} = $9
       RETURNING li.*`,
      [description, quantity, unit_cost, sku, position, req.userId, req.params.lid, req.params.id, sv]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Line item not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update line item' });
  }
});

router.delete('/:id/line-items/:lid', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(
      `DELETE FROM purchase_order_line_items li USING purchase_orders po
        WHERE li.id = $1 AND li.purchase_order_id = po.id AND li.purchase_order_id = $2 AND po.${sf} = $3
        RETURNING li.id`,
      [req.params.lid, req.params.id, sv]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Line item not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to delete line item' });
  }
});

// ---- VERSION SNAPSHOT ------------------------------------------------------
router.post('/:id/versions', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const [sf, sv] = qs(req);
    const po = await client.query(`SELECT * FROM purchase_orders WHERE id = $1 AND ${sf} = $2 FOR UPDATE`, [req.params.id, sv]);
    if (po.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Purchase order not found' }); }
    const lineItems = await client.query(
      `SELECT id, description, quantity, unit_cost, sku, position FROM purchase_order_line_items WHERE purchase_order_id = $1 ORDER BY position, id`,
      [req.params.id]
    );
    const nextVersion = (po.rows[0].current_version || 0) + 1;
    const v = await client.query(
      `INSERT INTO purchase_order_versions (org_id, purchase_order_id, version_number, notes, line_items_snapshot, metadata_snapshot, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
       RETURNING *`,
      [req.orgId, req.params.id, nextVersion, req.body.notes || null,
       JSON.stringify(lineItems.rows),
       JSON.stringify({ status: po.rows[0].status, po_number: po.rows[0].po_number, vendor_id: po.rows[0].vendor_id }),
       req.userId]
    );
    await client.query(`UPDATE purchase_orders SET current_version = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2 WHERE id = $3`,
      [nextVersion, req.userId, req.params.id]);
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: v.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: 'Failed to snapshot version', detail: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
