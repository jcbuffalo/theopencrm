// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
// Outbound webhooks (spec 206 part 3). Top-level require so test suites can vi.mock it.
const webhookDispatcher = require('../services/webhookDispatcher');
const notificationDispatcher = require('../services/notificationDispatcher');
const { validateBody } = require('../middleware/validate');
const { createSchema, updateSchema } = require('../schemas/activities');

const router = express.Router();
router.use(authMiddleware);

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { type, contact_id, deal_id, limit = 50 } = req.query;
    let query = `SELECT * FROM activities WHERE ${sf} = $1`;
    const params = [sv];

    if (type)       { query += ` AND type = $${params.length + 1}`;       params.push(type); }
    if (contact_id) { query += ` AND contact_id = $${params.length + 1}`; params.push(contact_id); }
    if (deal_id)    { query += ` AND deal_id = $${params.length + 1}`;    params.push(deal_id); }

    query += ` ORDER BY activity_date DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch activities' });
  }
});

router.get('/contact/:contact_id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(
      `SELECT * FROM activities WHERE contact_id = $1 AND ${sf} = $2 ORDER BY activity_date DESC`,
      [req.params.contact_id, sv]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch activities' });
  }
});

router.get('/deal/:deal_id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(
      `SELECT * FROM activities WHERE deal_id = $1 AND ${sf} = $2 ORDER BY activity_date DESC`,
      [req.params.deal_id, sv]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch activities' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(`SELECT * FROM activities WHERE id = $1 AND ${sf} = $2`, [req.params.id, sv]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Activity not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

router.post('/', validateBody(createSchema), async (req, res) => {
  try {
    const { type, title, contact_id, deal_id, activity_date, description, duration_minutes, outcome, notes } = req.body;

    // Multi-tenancy: an activity may only be linked to a contact / deal in scope.
    const [sf, sv] = qs(req);
    if (contact_id != null) {
      const own = await pool.query(`SELECT 1 FROM contacts WHERE id = $1 AND ${sf} = $2`, [contact_id, sv]);
      if (own.rows.length === 0) return res.status(400).json({ error: 'contact_id not found in your organization' });
    }
    if (deal_id != null) {
      const own = await pool.query(`SELECT 1 FROM deals WHERE id = $1 AND ${sf} = $2`, [deal_id, sv]);
      if (own.rows.length === 0) return res.status(400).json({ error: 'deal_id not found in your organization' });
    }

    const result = await pool.query(
      `INSERT INTO activities (user_id, org_id, type, title, contact_id, deal_id, activity_date, description, duration_minutes, outcome, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [req.userId, req.orgId || null, type, title, contact_id || null, deal_id || null, activity_date, description || null, duration_minutes || null, outcome || null, notes || null]
    );

    const created = result.rows[0];

    // Relationship cadence (migration 125): logging an activity against a
    // contact counts as a "touch", so stamp contacts.last_touch_at. Strictly
    // best-effort + fire-and-forget — a failure here must never break activity
    // creation. The contact was already verified in-scope above, but we still
    // scope the UPDATE via [sf, sv] so this can never write across orgs.
    if (created.contact_id) {
      try {
        const touch = pool.query(
          `UPDATE contacts SET last_touch_at = NOW(), updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND ${sf} = $2`,
          [created.contact_id, sv]
        );
        if (touch && typeof touch.catch === 'function') {
          touch.catch(err => console.warn('contact_touch_stamp_failed', err && err.message ? err.message : err));
        }
      } catch (err) {
        console.warn('contact_touch_stamp_failed', err && err.message ? err.message : err);
      }
    }

    // Fire-and-forget notification to the deal owner when someone else logs
    // activity on their deal. Canonical owner is deals.user_id — matches what
    // notificationDispatcher.notifyDealActivity reads (`d.user_id AS owner_id`).
    // salesman_id exists on the schema too (migration 036) but it's a Zang-
    // specific manufacturer's-rep attribution field, not the system-of-record
    // owner; using user_id keeps us aligned with the dispatcher's own query.
    if (created.deal_id) {
      pool.query('SELECT user_id FROM deals WHERE id = $1', [created.deal_id])
        .then(d => {
          const ownerId = d.rows[0] && d.rows[0].user_id;
          if (ownerId && Number(ownerId) !== Number(req.userId)) {
            notificationDispatcher.notifyDealActivity(created.deal_id, created.id)
              .catch(err => console.warn('notify_deal_activity_failed', err && err.message ? err.message : err));
          }
        })
        .catch(err => console.warn('notify_deal_activity_owner_lookup_failed', err && err.message ? err.message : err));
    }

    // Outbound webhook (spec 206 part 3) — best-effort.
    if (req.orgId && created) {
      webhookDispatcher.dispatch(req.orgId, 'activity.logged', {
        id: created.id, type: created.type || created.activity_type, subject: created.subject,
        deal_id: created.deal_id, contact_id: created.contact_id, activity_date: created.activity_date,
      });
    }
    res.status(201).json(created);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create activity' });
  }
});

router.put('/:id', validateBody(updateSchema), async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { type, title, contact_id, deal_id, activity_date, description, duration_minutes, outcome, notes } = req.body;

    const result = await pool.query(
      `UPDATE activities SET type = COALESCE($1, type), title = COALESCE($2, title),
       contact_id = COALESCE($3, contact_id), deal_id = COALESCE($4, deal_id),
       activity_date = COALESCE($5, activity_date), description = COALESCE($6, description),
       duration_minutes = COALESCE($7, duration_minutes), outcome = COALESCE($8, outcome),
       notes = COALESCE($9, notes), updated_at = CURRENT_TIMESTAMP
       WHERE id = $10 AND ${sf} = $11 RETURNING *`,
      [type, title, contact_id, deal_id, activity_date, description, duration_minutes, outcome, notes, req.params.id, sv]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Activity not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update activity' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(`DELETE FROM activities WHERE id = $1 AND ${sf} = $2 RETURNING *`, [req.params.id, sv]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Activity not found' });
    res.json({ message: 'Activity deleted', activity: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete activity' });
  }
});

module.exports = router;
