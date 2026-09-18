// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const { validateBody } = require('../middleware/validate');
const { createSchema, updateSchema } = require('../schemas/issues');

const router = express.Router();
router.use(authMiddleware);

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { status, urgency, category, related_type, related_id, assigned_to_user_id } = req.query;
    let query = `
      SELECT i.*, u.email AS assigned_to_email, u.name AS assigned_to_name
      FROM issues i
      LEFT JOIN users u ON i.assigned_to_user_id = u.id
      WHERE i.${sf} = $1
    `;
    const params = [sv];
    if (status)              { query += ` AND i.status = $${params.length + 1}`;              params.push(status); }
    if (urgency)             { query += ` AND i.urgency = $${params.length + 1}`;             params.push(urgency); }
    if (category)            { query += ` AND i.category = $${params.length + 1}`;            params.push(category); }
    if (related_type)        { query += ` AND i.related_type = $${params.length + 1}`;        params.push(related_type); }
    if (related_id)          { query += ` AND i.related_id = $${params.length + 1}`;          params.push(related_id); }
    if (assigned_to_user_id) { query += ` AND i.assigned_to_user_id = $${params.length + 1}`; params.push(assigned_to_user_id); }
    query += ` ORDER BY CASE i.urgency WHEN 'red' THEN 1 WHEN 'yellow' THEN 2 ELSE 3 END, i.created_at DESC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Issue fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch issues' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(`SELECT * FROM issues WHERE id = $1 AND ${sf} = $2`, [req.params.id, sv]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Issue not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch issue' });
  }
});

router.post('/', validateBody(createSchema), async (req, res) => {
  try {
    const {
      related_type, related_id, title, description, category, sub_category,
      urgency, financial_impact, blocks_workflow, status, assigned_to_user_id,
    } = req.body;

    // Multi-tenancy: if the issue points at a parent record, that record must
    // live in the caller's scope. related_id is polymorphic on related_type, so
    // we only verify types that map to a known org-scoped table.
    if (related_id != null) {
      const RELATED_TABLES = { deal: 'deals', company: 'companies', contact: 'contacts', quote: 'quotes' };
      const table = RELATED_TABLES[related_type];
      if (table) {
        const [sf, sv] = qs(req);
        const own = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1 AND ${sf} = $2`, [related_id, sv]);
        if (own.rows.length === 0) return res.status(400).json({ error: 'related_id not found in your organization' });
      }
    }

    const result = await pool.query(
      `INSERT INTO issues (user_id, org_id, related_type, related_id, title, description, category, sub_category, urgency, financial_impact, blocks_workflow, status, assigned_to_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [req.userId, req.orgId || null, related_type || null, related_id || null, title, description || null, category || null, sub_category || null, urgency || 'green', financial_impact || null, !!blocks_workflow, status || 'open', assigned_to_user_id || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Issue create error:', error);
    res.status(500).json({ error: 'Failed to create issue' });
  }
});

router.put('/:id', validateBody(updateSchema), async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const {
      title, description, category, sub_category, urgency, financial_impact,
      blocks_workflow, status, assigned_to_user_id, resolution_notes,
    } = req.body;
    const resolvedAt = status === 'resolved' || status === 'bypassed' ? 'CURRENT_TIMESTAMP' : 'resolved_at';

    const result = await pool.query(
      `UPDATE issues SET title = COALESCE($1, title), description = COALESCE($2, description),
        category = COALESCE($3, category), sub_category = COALESCE($4, sub_category),
        urgency = COALESCE($5, urgency), financial_impact = COALESCE($6, financial_impact),
        blocks_workflow = COALESCE($7, blocks_workflow), status = COALESCE($8, status),
        assigned_to_user_id = COALESCE($9, assigned_to_user_id),
        resolution_notes = COALESCE($10, resolution_notes),
        resolved_at = ${resolvedAt}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $11 AND ${sf} = $12 RETURNING *`,
      [title, description, category, sub_category, urgency, financial_impact, blocks_workflow, status, assigned_to_user_id, resolution_notes, req.params.id, sv]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Issue not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update issue' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(`DELETE FROM issues WHERE id = $1 AND ${sf} = $2 RETURNING *`, [req.params.id, sv]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Issue not found' });
    res.json({ message: 'Issue deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete issue' });
  }
});

module.exports = router;
