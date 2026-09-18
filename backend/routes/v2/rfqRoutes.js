// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// RFQ (Request for Quote) routes — v2 entity from the FlowArchitect domain model.
//
// Endpoints (all auth-required, all org-scoped, all gated by phase2_entities):
//   GET    /                    — list (filters: deal_id, customer_id, vendor_id, status)
//   GET    /:id                 — fetch with line items + versions
//   POST   /                    — create
//   PUT    /:id                 — partial update (COALESCE pattern)
//   DELETE /:id                 — hard delete (cascades to line items + versions)
//   POST   /:id/line-items      — add a line item
//   PUT    /:id/line-items/:lid — update a line item
//   DELETE /:id/line-items/:lid — delete a line item
//   POST   /:id/versions        — snapshot the current state into a new version

const express = require('express');
const { authMiddleware } = require('../../auth');
const pool = require('../../db');
const { requireFeature } = require('../../middleware/featureGate');

const router = express.Router();
router.use(authMiddleware);
router.use(requireFeature('phase2_entities'));

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// ---- LIST ------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { deal_id, customer_id, vendor_id, status } = req.query;
    let q = `SELECT r.*,
                    c.name AS customer_name,
                    v.name AS vendor_name
               FROM rfqs r
          LEFT JOIN companies c ON r.customer_id = c.id
          LEFT JOIN companies v ON r.vendor_id   = v.id
              WHERE r.${sf} = $1`;
    const params = [sv];
    if (deal_id)     { q += ` AND r.deal_id = $${params.length + 1}`;     params.push(deal_id); }
    if (customer_id) { q += ` AND r.customer_id = $${params.length + 1}`; params.push(customer_id); }
    if (vendor_id)   { q += ` AND r.vendor_id = $${params.length + 1}`;   params.push(vendor_id); }
    if (status)      { q += ` AND r.status = $${params.length + 1}`;      params.push(status); }
    q += ' ORDER BY r.created_at DESC';
    const result = await pool.query(q, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    if (req.log) req.log.error('rfq_list_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to list RFQs' });
  }
});

// ---- GET ONE (with line items + versions) ----------------------------------
router.get('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const rfq = await pool.query(
      `SELECT * FROM rfqs WHERE id = $1 AND ${sf} = $2`,
      [req.params.id, sv]
    );
    if (rfq.rows.length === 0) return res.status(404).json({ success: false, error: 'RFQ not found' });

    const [lineItems, versions] = await Promise.all([
      pool.query(`SELECT * FROM rfq_line_items WHERE rfq_id = $1 ORDER BY position, id`, [req.params.id]),
      pool.query(`SELECT id, version_number, notes, created_at FROM rfq_versions WHERE rfq_id = $1 ORDER BY version_number DESC`, [req.params.id]),
    ]);
    res.json({
      success: true,
      data: { ...rfq.rows[0], line_items: lineItems.rows, versions: versions.rows },
    });
  } catch (err) {
    if (req.log) req.log.error('rfq_get_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to fetch RFQ' });
  }
});

// ---- CREATE ----------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    if (!req.orgId) return res.status(400).json({ success: false, error: 'Org context required' });
    const { deal_id, customer_id, vendor_id, status, title, description, external_ref } = req.body;
    const result = await pool.query(
      `INSERT INTO rfqs (org_id, deal_id, customer_id, vendor_id, status, title, description, external_ref, created_by, updated_by)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'draft'), $6, $7, $8, $9, $9)
       RETURNING *`,
      [req.orgId, deal_id || null, customer_id || null, vendor_id || null, status, title, description, external_ref, req.userId]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (req.log) req.log.error('rfq_create_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to create RFQ', detail: err.message });
  }
});

// ---- UPDATE ----------------------------------------------------------------
router.put('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { deal_id, customer_id, vendor_id, status, title, description, external_ref, sent_at, responded_at } = req.body;
    const result = await pool.query(
      `UPDATE rfqs SET
         deal_id      = COALESCE($1, deal_id),
         customer_id  = COALESCE($2, customer_id),
         vendor_id    = COALESCE($3, vendor_id),
         status       = COALESCE($4, status),
         title        = COALESCE($5, title),
         description  = COALESCE($6, description),
         external_ref = COALESCE($7, external_ref),
         sent_at      = COALESCE($8, sent_at),
         responded_at = COALESCE($9, responded_at),
         updated_at   = CURRENT_TIMESTAMP,
         updated_by   = $10,
         entity_version = entity_version + 1
       WHERE id = $11 AND ${sf} = $12
       RETURNING *`,
      [deal_id, customer_id, vendor_id, status, title, description, external_ref, sent_at, responded_at, req.userId, req.params.id, sv]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'RFQ not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (req.log) req.log.error('rfq_update_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to update RFQ' });
  }
});

// ---- DELETE ----------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(`DELETE FROM rfqs WHERE id = $1 AND ${sf} = $2 RETURNING id`, [req.params.id, sv]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'RFQ not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to delete RFQ' });
  }
});

// ---- LINE ITEMS ------------------------------------------------------------
router.post('/:id/line-items', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    // Verify the RFQ belongs to caller's org first.
    const own = await pool.query(`SELECT id FROM rfqs WHERE id = $1 AND ${sf} = $2`, [req.params.id, sv]);
    if (own.rows.length === 0) return res.status(404).json({ success: false, error: 'RFQ not found' });

    const { description, quantity, notes, position } = req.body;
    const result = await pool.query(
      `INSERT INTO rfq_line_items (org_id, rfq_id, description, quantity, notes, position, created_by, updated_by)
       VALUES ($1, $2, $3, COALESCE($4, 1), $5, COALESCE($6, 0), $7, $7)
       RETURNING *`,
      [req.orgId, req.params.id, description, quantity, notes, position, req.userId]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to add line item', detail: err.message });
  }
});

router.put('/:id/line-items/:lid', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { description, quantity, notes, position } = req.body;
    const result = await pool.query(
      `UPDATE rfq_line_items li SET
         description = COALESCE($1, description),
         quantity    = COALESCE($2, quantity),
         notes       = COALESCE($3, notes),
         position    = COALESCE($4, position),
         updated_at  = CURRENT_TIMESTAMP,
         updated_by  = $5,
         entity_version = entity_version + 1
        FROM rfqs r
       WHERE li.id = $6 AND li.rfq_id = r.id AND li.rfq_id = $7 AND r.${sf} = $8
       RETURNING li.*`,
      [description, quantity, notes, position, req.userId, req.params.lid, req.params.id, sv]
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
      `DELETE FROM rfq_line_items li USING rfqs r
        WHERE li.id = $1 AND li.rfq_id = r.id AND li.rfq_id = $2 AND r.${sf} = $3
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
// Captures the current line items + metadata into a new immutable version row.
router.post('/:id/versions', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const [sf, sv] = qs(req);
    const rfq = await client.query(`SELECT * FROM rfqs WHERE id = $1 AND ${sf} = $2 FOR UPDATE`, [req.params.id, sv]);
    if (rfq.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'RFQ not found' });
    }
    const lineItems = await client.query(
      `SELECT id, description, quantity, notes, position FROM rfq_line_items WHERE rfq_id = $1 ORDER BY position, id`,
      [req.params.id]
    );
    const nextVersion = (rfq.rows[0].current_version || 0) + 1;
    const v = await client.query(
      `INSERT INTO rfq_versions (org_id, rfq_id, version_number, notes, line_items_snapshot, metadata_snapshot, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
       RETURNING *`,
      [req.orgId, req.params.id, nextVersion, req.body.notes || null,
       JSON.stringify(lineItems.rows),
       JSON.stringify({ status: rfq.rows[0].status, title: rfq.rows[0].title, description: rfq.rows[0].description }),
       req.userId]
    );
    await client.query(`UPDATE rfqs SET current_version = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2 WHERE id = $3`,
      [nextVersion, req.userId, req.params.id]);
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: v.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (req.log) req.log.error('rfq_version_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to snapshot version', detail: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
