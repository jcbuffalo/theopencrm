// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Customer appreciation queue (SOW §4.5c.ii).
//
// Endpoints (all auth-required, all org-scoped):
//   GET    /                       — list (filters: status, customer_id)
//   POST   /                       — queue a new appreciation item (manual entry)
//   PUT    /:id                    — update status, notes, gift_type, scheduled_for
//   POST   /:id/complete           — mark sent
//   DELETE /:id                    — remove
//
// Auto-population: an automation rule (in services/automation.js) can push
// items into this queue based on criteria (project completed, milestone hit,
// dormant customer recovered). For now the rule is a stub — operators add
// items manually via the UI.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');

const router = express.Router();
router.use(authMiddleware);

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { status, customer_id } = req.query;
    let query = `
      SELECT aq.*, c.name AS customer_name, ct.first_name, ct.last_name, d.title AS deal_title
      FROM appreciation_queue aq
      LEFT JOIN companies c ON aq.customer_id = c.id
      LEFT JOIN contacts ct ON aq.contact_id = ct.id
      LEFT JOIN deals d ON aq.deal_id = d.id
      WHERE aq.${sf} = $1
    `;
    const params = [sv];
    if (status)      { query += ` AND aq.status = $${params.length + 1}`;      params.push(status); }
    if (customer_id) { query += ` AND aq.customer_id = $${params.length + 1}`; params.push(customer_id); }
    query += ` ORDER BY aq.scheduled_for NULLS LAST, aq.created_at DESC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load appreciation queue' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { customer_id, contact_id, deal_id, reason, gift_type, notes, scheduled_for } = req.body;
    const result = await pool.query(
      `INSERT INTO appreciation_queue (user_id, org_id, customer_id, contact_id, deal_id, reason, gift_type, notes, scheduled_for)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.userId, req.orgId || null, customer_id || null, contact_id || null, deal_id || null,
       reason || 'manual', gift_type || null, notes || null, scheduled_for || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to queue appreciation item' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { status, gift_type, notes, scheduled_for, reason } = req.body;
    const result = await pool.query(
      `UPDATE appreciation_queue SET
         status = COALESCE($1, status), gift_type = COALESCE($2, gift_type),
         notes = COALESCE($3, notes), scheduled_for = COALESCE($4, scheduled_for),
         reason = COALESCE($5, reason), updated_at = NOW()
       WHERE id = $6 AND ${sf} = $7 RETURNING *`,
      [status, gift_type, notes, scheduled_for, reason, req.params.id, sv]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update' });
  }
});

router.post('/:id/complete', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(
      `UPDATE appreciation_queue SET status = 'sent', completed_at = NOW(), completed_by = $1, updated_at = NOW()
       WHERE id = $2 AND ${sf} = $3 RETURNING *`,
      [req.userId, req.params.id, sv]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to mark complete' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(`DELETE FROM appreciation_queue WHERE id = $1 AND ${sf} = $2 RETURNING id`, [req.params.id, sv]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

module.exports = router;
