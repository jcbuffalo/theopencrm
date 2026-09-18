// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const { validateBody } = require('../middleware/validate');
const { createSchema, updateSchema } = require('../schemas/changeOrders');

const router = express.Router();
router.use(authMiddleware);

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { deal_id } = req.query;
    let query = `SELECT * FROM change_orders WHERE ${sf} = $1`;
    const params = [sv];
    if (deal_id) { query += ` AND deal_id = $${params.length + 1}`; params.push(deal_id); }
    query += ' ORDER BY number DESC, created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch change orders' });
  }
});

router.post('/', validateBody(createSchema), async (req, res) => {
  try {
    const { deal_id, description, amount_delta, status } = req.body;

    // Multi-tenancy: the parent deal must belong to the caller's scope.
    const [sf, sv] = qs(req);
    const dealOwn = await pool.query(`SELECT 1 FROM deals WHERE id = $1 AND ${sf} = $2`, [deal_id, sv]);
    if (dealOwn.rows.length === 0) return res.status(400).json({ error: 'deal_id not found in your organization' });

    const max = await pool.query(`SELECT MAX(number) AS m FROM change_orders WHERE deal_id = $1 AND ${sf} = $2`, [deal_id, sv]);
    const number = (max.rows[0].m || 0) + 1;

    const result = await pool.query(
      `INSERT INTO change_orders (user_id, org_id, deal_id, number, description, amount_delta, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.userId, req.orgId || null, deal_id, number, description || null, amount_delta || null, status || 'pending']
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create change order' });
  }
});

router.put('/:id', validateBody(updateSchema), async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { description, amount_delta, status } = req.body;
    const approvedAt = status === 'approved' ? 'CURRENT_TIMESTAMP' : 'approved_at';

    const result = await pool.query(
      `UPDATE change_orders SET description = COALESCE($1, description),
        amount_delta = COALESCE($2, amount_delta), status = COALESCE($3, status),
        approved_at = ${approvedAt}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 AND ${sf} = $5 RETURNING *`,
      [description, amount_delta, status, req.params.id, sv]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Change order not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update change order' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(`DELETE FROM change_orders WHERE id = $1 AND ${sf} = $2 RETURNING *`, [req.params.id, sv]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Change order not found' });
    res.json({ message: 'Change order deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete change order' });
  }
});

module.exports = router;
