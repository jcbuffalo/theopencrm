// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Invoice routes — v2 entity. Same shape as RFQ + PO (CRUD + line items +
// version snapshot). Includes total_amount, due_date, paid_at, public_id UUID,
// and quickbooks_id for the QB integration handoff.

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
    const { deal_id, customer_id, status } = req.query;
    let q = `SELECT inv.*, c.name AS customer_name
               FROM invoices inv
          LEFT JOIN companies c ON inv.customer_id = c.id
              WHERE inv.${sf} = $1`;
    const params = [sv];
    if (deal_id)     { q += ` AND inv.deal_id = $${params.length + 1}`;     params.push(deal_id); }
    if (customer_id) { q += ` AND inv.customer_id = $${params.length + 1}`; params.push(customer_id); }
    if (status)      { q += ` AND inv.status = $${params.length + 1}`;      params.push(status); }
    q += ' ORDER BY inv.created_at DESC';
    const result = await pool.query(q, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to list invoices' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const inv = await pool.query(`SELECT * FROM invoices WHERE id = $1 AND ${sf} = $2`, [req.params.id, sv]);
    if (inv.rows.length === 0) return res.status(404).json({ success: false, error: 'Invoice not found' });
    const [lineItems, versions, allocations] = await Promise.all([
      pool.query(`SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position, id`, [req.params.id]),
      pool.query(`SELECT id, version_number, notes, created_at FROM invoice_versions WHERE invoice_id = $1 ORDER BY version_number DESC`, [req.params.id]),
      pool.query(`SELECT * FROM invoice_allocations WHERE invoice_id = $1 ORDER BY id`, [req.params.id]),
    ]);
    res.json({ success: true, data: { ...inv.rows[0], line_items: lineItems.rows, versions: versions.rows, allocations: allocations.rows } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch invoice' });
  }
});

router.post('/', async (req, res) => {
  try {
    if (!req.orgId) return res.status(400).json({ success: false, error: 'Org context required' });
    const { deal_id, customer_id, status, invoice_number, external_ref, total_amount, due_date } = req.body;
    const result = await pool.query(
      `INSERT INTO invoices (org_id, deal_id, customer_id, status, invoice_number, external_ref, total_amount, due_date, created_by, updated_by)
       VALUES ($1, $2, $3, COALESCE($4, 'draft'), $5, $6, $7, $8, $9, $9)
       RETURNING *`,
      [req.orgId, deal_id || null, customer_id || null, status, invoice_number, external_ref, total_amount, due_date, req.userId]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to create invoice', detail: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { deal_id, customer_id, status, invoice_number, external_ref, total_amount, due_date, paid_at, quickbooks_id } = req.body;
    const result = await pool.query(
      `UPDATE invoices SET
         deal_id        = COALESCE($1, deal_id),
         customer_id    = COALESCE($2, customer_id),
         status         = COALESCE($3, status),
         invoice_number = COALESCE($4, invoice_number),
         external_ref   = COALESCE($5, external_ref),
         total_amount   = COALESCE($6, total_amount),
         due_date       = COALESCE($7, due_date),
         paid_at        = COALESCE($8, paid_at),
         quickbooks_id  = COALESCE($9, quickbooks_id),
         updated_at     = CURRENT_TIMESTAMP,
         updated_by     = $10,
         entity_version = entity_version + 1
       WHERE id = $11 AND ${sf} = $12
       RETURNING *`,
      [deal_id, customer_id, status, invoice_number, external_ref, total_amount, due_date, paid_at, quickbooks_id, req.userId, req.params.id, sv]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Invoice not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update invoice' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(`DELETE FROM invoices WHERE id = $1 AND ${sf} = $2 RETURNING id`, [req.params.id, sv]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Invoice not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to delete invoice' });
  }
});

// ---- LINE ITEMS ------------------------------------------------------------
router.post('/:id/line-items', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const own = await pool.query(`SELECT id FROM invoices WHERE id = $1 AND ${sf} = $2`, [req.params.id, sv]);
    if (own.rows.length === 0) return res.status(404).json({ success: false, error: 'Invoice not found' });
    const { description, quantity, unit_price, position } = req.body;
    const result = await pool.query(
      `INSERT INTO invoice_line_items (org_id, invoice_id, description, quantity, unit_price, position, created_by, updated_by)
       VALUES ($1, $2, $3, COALESCE($4, 1), $5, COALESCE($6, 0), $7, $7)
       RETURNING *`,
      [req.orgId, req.params.id, description, quantity, unit_price, position, req.userId]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to add line item', detail: err.message });
  }
});

router.put('/:id/line-items/:lid', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { description, quantity, unit_price, position } = req.body;
    const result = await pool.query(
      `UPDATE invoice_line_items li SET
         description = COALESCE($1, description),
         quantity    = COALESCE($2, quantity),
         unit_price  = COALESCE($3, unit_price),
         position    = COALESCE($4, position),
         updated_at  = CURRENT_TIMESTAMP,
         updated_by  = $5,
         entity_version = entity_version + 1
        FROM invoices inv
       WHERE li.id = $6 AND li.invoice_id = inv.id AND li.invoice_id = $7 AND inv.${sf} = $8
       RETURNING li.*`,
      [description, quantity, unit_price, position, req.userId, req.params.lid, req.params.id, sv]
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
      `DELETE FROM invoice_line_items li USING invoices inv
        WHERE li.id = $1 AND li.invoice_id = inv.id AND li.invoice_id = $2 AND inv.${sf} = $3
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
    const inv = await client.query(`SELECT * FROM invoices WHERE id = $1 AND ${sf} = $2 FOR UPDATE`, [req.params.id, sv]);
    if (inv.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, error: 'Invoice not found' }); }
    const lineItems = await client.query(
      `SELECT id, description, quantity, unit_price, amount, position FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position, id`,
      [req.params.id]
    );
    const nextVersion = (inv.rows[0].current_version || 0) + 1;
    const v = await client.query(
      `INSERT INTO invoice_versions (org_id, invoice_id, version_number, notes, line_items_snapshot, metadata_snapshot, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
       RETURNING *`,
      [req.orgId, req.params.id, nextVersion, req.body.notes || null,
       JSON.stringify(lineItems.rows),
       JSON.stringify({ status: inv.rows[0].status, total_amount: inv.rows[0].total_amount, customer_id: inv.rows[0].customer_id }),
       req.userId]
    );
    await client.query(`UPDATE invoices SET current_version = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2 WHERE id = $3`,
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
