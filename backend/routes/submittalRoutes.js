// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const { validateBody } = require('../middleware/validate');
const { createSchema, updateSchema } = require('../schemas/submittals');

const router = express.Router();
router.use(authMiddleware);

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { deal_id, status } = req.query;
    let query = `SELECT * FROM submittals WHERE ${sf} = $1`;
    const params = [sv];
    if (deal_id) { query += ` AND deal_id = $${params.length + 1}`; params.push(deal_id); }
    if (status)  { query += ` AND status = $${params.length + 1}`;  params.push(status); }
    query += ' ORDER BY version DESC, created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch submittals' });
  }
});

router.post('/', validateBody(createSchema), async (req, res) => {
  try {
    const { deal_id, version, type, status, notes } = req.body;

    // Multi-tenancy: the parent deal must belong to the caller's scope.
    const [sf, sv] = qs(req);
    const dealOwn = await pool.query(`SELECT 1 FROM deals WHERE id = $1 AND ${sf} = $2`, [deal_id, sv]);
    if (dealOwn.rows.length === 0) return res.status(400).json({ error: 'deal_id not found in your organization' });

    let v = version;
    if (!v) {
      const max = await pool.query(`SELECT MAX(version) AS m FROM submittals WHERE deal_id = $1 AND ${sf} = $2`, [deal_id, sv]);
      v = (max.rows[0].m || 0) + 1;
    }

    const result = await pool.query(
      `INSERT INTO submittals (user_id, org_id, deal_id, version, type, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.userId, req.orgId || null, deal_id, v, type || 'drawing', status || 'pending_vendor', notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Submittal create error:', error);
    res.status(500).json({ error: 'Failed to create submittal' });
  }
});

router.put('/:id', validateBody(updateSchema), async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { status, type, notes } = req.body;
    const approvedAt = status === 'approved' ? 'CURRENT_TIMESTAMP' : 'approved_at';

    const result = await pool.query(
      `UPDATE submittals SET status = COALESCE($1, status), type = COALESCE($2, type),
        notes = COALESCE($3, notes), approved_at = ${approvedAt}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 AND ${sf} = $5 RETURNING *`,
      [status, type, notes, req.params.id, sv]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Submittal not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update submittal' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(`DELETE FROM submittals WHERE id = $1 AND ${sf} = $2 RETURNING *`, [req.params.id, sv]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Submittal not found' });
    res.json({ message: 'Submittal deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete submittal' });
  }
});

module.exports = router;
