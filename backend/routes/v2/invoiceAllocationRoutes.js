// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Invoice Allocation routes — the cross-table magic that binds invoice line
// items to PO line items, enabling partial-fulfillment accounting.
//
// Endpoints:
//   GET    /                — list (filter by invoice_id or po_line_item_id)
//   POST   /                — create an allocation; updates PO line's
//                              denormalized quantity_invoiced/amount_invoiced
//   PUT    /:id             — update quantity/amount; recomputes PO line totals
//   DELETE /:id             — remove allocation; recomputes PO line totals
//
// The PO line item's quantity_invoiced and amount_invoiced columns are
// denormalized for fast queries ("how much of this PO line is invoiced?")
// — the canonical source is sum(invoice_allocations) for that line. We
// recompute on every write. Done in a transaction so they never drift.

const express = require('express');
const { authMiddleware } = require('../../auth');
const pool = require('../../db');
const { requireFeature } = require('../../middleware/featureGate');

const router = express.Router();
router.use(authMiddleware);
router.use(requireFeature('phase2_entities'));

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// Recompute the denormalized totals on a single PO line item from the sum of
// its allocations. Caller must already be inside a transaction.
async function recomputePoLineTotals(client, poLineItemId) {
  await client.query(
    `UPDATE purchase_order_line_items
        SET quantity_invoiced = COALESCE((SELECT SUM(allocated_quantity) FROM invoice_allocations WHERE purchase_order_line_item_id = $1), 0),
            amount_invoiced   = COALESCE((SELECT SUM(allocated_amount)   FROM invoice_allocations WHERE purchase_order_line_item_id = $1), 0),
            updated_at        = CURRENT_TIMESTAMP,
            entity_version    = entity_version + 1
      WHERE id = $1`,
    [poLineItemId]
  );
}

router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { invoice_id, po_line_item_id } = req.query;
    let q = `SELECT * FROM invoice_allocations WHERE ${sf} = $1`;
    const params = [sv];
    if (invoice_id)       { q += ` AND invoice_id = $${params.length + 1}`;                   params.push(invoice_id); }
    if (po_line_item_id)  { q += ` AND purchase_order_line_item_id = $${params.length + 1}`;  params.push(po_line_item_id); }
    q += ' ORDER BY id';
    const result = await pool.query(q, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to list allocations' });
  }
});

router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    if (!req.orgId) return res.status(400).json({ success: false, error: 'Org context required' });
    const { invoice_id, invoice_line_item_id, purchase_order_line_item_id, allocated_quantity, allocated_amount, notes } = req.body;
    if (!invoice_id || !purchase_order_line_item_id) {
      return res.status(400).json({ success: false, error: 'invoice_id and purchase_order_line_item_id are required' });
    }

    await client.query('BEGIN');
    // Verify both parent records belong to caller's org. Same-org constraint
    // is the only thing standing between a malicious client and pulling other
    // tenants' PO lines into their invoice.
    const own = await client.query(
      `SELECT inv.id AS inv_ok, po_li.id AS po_ok
         FROM invoices inv, purchase_order_line_items po_li
        WHERE inv.id = $1 AND inv.org_id = $2
          AND po_li.id = $3 AND po_li.org_id = $2`,
      [invoice_id, req.orgId, purchase_order_line_item_id]
    );
    if (own.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Invoice or PO line item not found in this org' });
    }

    const result = await client.query(
      `INSERT INTO invoice_allocations
         (org_id, invoice_id, invoice_line_item_id, purchase_order_line_item_id,
          allocated_quantity, allocated_amount, notes, created_by, updated_by)
       VALUES ($1, $2, $3, $4, COALESCE($5, 0), COALESCE($6, 0), $7, $8, $8)
       RETURNING *`,
      [req.orgId, invoice_id, invoice_line_item_id || null, purchase_order_line_item_id,
       allocated_quantity, allocated_amount, notes, req.userId]
    );
    await recomputePoLineTotals(client, purchase_order_line_item_id);
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (req.log) req.log.error('allocation_create_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to create allocation', detail: err.message });
  } finally {
    client.release();
  }
});

router.put('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const [sf, sv] = qs(req);
    const { allocated_quantity, allocated_amount, notes } = req.body;
    const result = await client.query(
      `UPDATE invoice_allocations SET
         allocated_quantity = COALESCE($1, allocated_quantity),
         allocated_amount   = COALESCE($2, allocated_amount),
         notes              = COALESCE($3, notes),
         updated_at         = CURRENT_TIMESTAMP,
         updated_by         = $4,
         entity_version     = entity_version + 1
       WHERE id = $5 AND ${sf} = $6
       RETURNING *`,
      [allocated_quantity, allocated_amount, notes, req.userId, req.params.id, sv]
    );
    if (result.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Allocation not found' }); }
    await recomputePoLineTotals(client, result.rows[0].purchase_order_line_item_id);
    await client.query('COMMIT');
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: 'Failed to update allocation' });
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const [sf, sv] = qs(req);
    const result = await client.query(
      `DELETE FROM invoice_allocations WHERE id = $1 AND ${sf} = $2 RETURNING purchase_order_line_item_id`,
      [req.params.id, sv]
    );
    if (result.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Allocation not found' }); }
    await recomputePoLineTotals(client, result.rows[0].purchase_order_line_item_id);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: 'Failed to delete allocation' });
  } finally {
    client.release();
  }
});

module.exports = router;
