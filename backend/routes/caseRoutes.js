// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Support Cases (CS-5) — customer-facing service tickets. Migration 134.
//
// Shape mirrors issueRoutes.js (the closest existing resource); differences
// are deliberate:
//   • status / priority are STRICT allowlists (schemas/cases.js zod enums) —
//     cases is a new table with no legacy free-text rows to grandfather in.
//   • resolved_at is server-managed: entering resolved/closed stamps it
//     (COALESCE keeps the original stamp on a resolved → closed move);
//     reopening (→ open/pending) clears it. Clients can never write it.
//   • company_id / contact_id are verified in-scope on every write, so a case
//     can never point at another org's records.
//
// Org-scoping: every query filters via qs(req) → [sf, sv]. Feature-gated at
// the index.js mount (requireFeature('customer_success_enabled')), same as
// /api/accounts — cases are part of the post-sale customer-success motion.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const { validateBody } = require('../middleware/validate');
const { createSchema, updateSchema } = require('../schemas/cases');
const { ownerValidationError } = require('../services/recordOwnership');
const notificationDispatcher = require('../services/notificationDispatcher');
// Plugin trigger engine (migration 164) — fire-and-forget post-commit dispatch.
const pluginEvents = require('../services/pluginEvents');

const router = express.Router();
router.use(authMiddleware);

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// Both FK columns live on org-scoped tables; verify ownership before any
// INSERT/UPDATE threads them in. Returns an error string or null.
async function verifyLinksInScope(req, { company_id, contact_id }) {
  const [sf, sv] = qs(req);
  if (company_id != null) {
    const r = await pool.query(`SELECT 1 FROM companies WHERE id = $1 AND ${sf} = $2`, [company_id, sv]);
    if (r.rows.length === 0) return 'company_id not found in your organization';
  }
  if (contact_id != null) {
    const r = await pool.query(`SELECT 1 FROM contacts WHERE id = $1 AND ${sf} = $2`, [contact_id, sv]);
    if (r.rows.length === 0) return 'contact_id not found in your organization';
  }
  return null;
}

// GET / — org-scoped list. Filters: status, company_id, priority. Sorted for
// triage: open work first, most severe first, tightest SLA first.
router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { status, company_id, priority } = req.query;
    let query = `
      SELECT cs.*, co.name AS company_name,
             ct.first_name AS contact_first_name, ct.last_name AS contact_last_name
      FROM cases cs
      LEFT JOIN companies co ON cs.company_id = co.id
      LEFT JOIN contacts  ct ON cs.contact_id = ct.id
      WHERE cs.${sf} = $1
    `;
    const params = [sv];
    if (status)     { query += ` AND cs.status = $${params.length + 1}`;     params.push(status); }
    if (company_id) { query += ` AND cs.company_id = $${params.length + 1}`; params.push(company_id); }
    if (priority)   { query += ` AND cs.priority = $${params.length + 1}`;   params.push(priority); }
    query += `
      ORDER BY (cs.status IN ('resolved', 'closed')),
               CASE cs.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
               cs.sla_due_at ASC NULLS LAST,
               cs.created_at DESC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Case fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch cases' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(`SELECT * FROM cases WHERE id = $1 AND ${sf} = $2`, [req.params.id, sv]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Case not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch case' });
  }
});

router.post('/', validateBody(createSchema), async (req, res) => {
  try {
    const {
      subject, description, status, priority, company_id, contact_id,
      owner_user_id, sla_due_at,
    } = req.body;

    const scopeError = await verifyLinksInScope(req, { company_id, contact_id });
    if (scopeError) return res.status(400).json({ error: scopeError });

    const ownerErr = await ownerValidationError(req, owner_user_id);
    if (ownerErr) return res.status(400).json({ error: ownerErr });

    // Rare but legal: a case created directly in a terminal state (e.g. logged
    // retroactively) gets its resolved_at stamped at birth.
    const effectiveStatus = status || 'open';
    const bornResolved = effectiveStatus === 'resolved' || effectiveStatus === 'closed';

    const result = await pool.query(
      `INSERT INTO cases (user_id, org_id, company_id, contact_id, subject, description,
                          status, priority, owner_user_id, sla_due_at, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${bornResolved ? 'CURRENT_TIMESTAMP' : 'NULL'})
       RETURNING *`,
      [req.userId, req.orgId || null, company_id || null, contact_id || null,
       subject, description || null, effectiveStatus, priority || 'normal',
       owner_user_id || null, sla_due_at || null]
    );

    // Fire-and-forget: tell the assigned owner (when it isn't the creator).
    // A notification failure must NEVER break the create.
    const createdCase = result.rows[0];
    if (createdCase.owner_user_id && Number(createdCase.owner_user_id) !== Number(req.userId)) {
      notificationDispatcher.notifyCaseAssigned(createdCase.id, req.userId)
        .catch(err => console.warn('notify_case_assigned_failed', err && err.message ? err.message : err));
    }

    // Plugin trigger (migration 164) — post-commit, fire-and-forget, deduped
    // per case id. (Portal-submitted cases go through the public portal route
    // and do not emit.)
    if (req.orgId) {
      pluginEvents.emit(req.orgId, 'case.created', {
        id: createdCase.id,
        subject: createdCase.subject,
        status: createdCase.status,
        priority: createdCase.priority,
        company_id: createdCase.company_id,
        contact_id: createdCase.contact_id,
      });
    }

    res.status(201).json(createdCase);
  } catch (error) {
    console.error('Case create error:', error);
    res.status(500).json({ error: 'Failed to create case' });
  }
});

router.put('/:id', validateBody(updateSchema), async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const {
      subject, description, status, priority, company_id, contact_id,
      owner_user_id, sla_due_at,
    } = req.body;

    const scopeError = await verifyLinksInScope(req, { company_id, contact_id });
    if (scopeError) return res.status(400).json({ error: scopeError });

    const ownerErr = await ownerValidationError(req, owner_user_id);
    if (ownerErr) return res.status(400).json({ error: ownerErr });

    // resolved_at transitions (status values are zod-allowlisted — these are
    // fixed SQL fragments keyed off a closed set, never client text):
    //   → resolved/closed : stamp once (COALESCE keeps the first stamp)
    //   → open/pending    : reopen — clear the stamp
    //   status omitted    : leave untouched
    let resolvedAtExpr = 'resolved_at';
    if (status === 'resolved' || status === 'closed') resolvedAtExpr = 'COALESCE(resolved_at, CURRENT_TIMESTAMP)';
    else if (status === 'open' || status === 'pending') resolvedAtExpr = 'NULL';

    // The self-join FROM subquery snapshots the PRE-update status/owner in
    // the same statement (UPDATE ... FROM reads the old row version), so the
    // notification fan-out below can detect real transitions without a
    // second round-trip. prev_* never reaches the client (destructured off).
    const result = await pool.query(
      `UPDATE cases SET
         subject = COALESCE($1, subject),
         description = COALESCE($2, description),
         status = COALESCE($3, status),
         priority = COALESCE($4, priority),
         company_id = COALESCE($5, company_id),
         contact_id = COALESCE($6, contact_id),
         owner_user_id = COALESCE($7, owner_user_id),
         sla_due_at = COALESCE($8, sla_due_at),
         resolved_at = ${resolvedAtExpr},
         updated_at = CURRENT_TIMESTAMP
       FROM (SELECT id AS prev_id, status AS prev_status, owner_user_id AS prev_owner
               FROM cases WHERE id = $9) AS old
       WHERE cases.id = old.prev_id AND cases.${sf} = $10
       RETURNING cases.*, old.prev_status, old.prev_owner`,
      [subject, description, status, priority, company_id, contact_id,
       owner_user_id, sla_due_at, req.params.id, sv]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Case not found' });

    const { prev_status: prevStatus, prev_owner: prevOwner, ...updatedCase } = result.rows[0];

    // Fire-and-forget fan-out on REAL transitions only — best-effort, a
    // notification failure must NEVER break the update.
    if (updatedCase.owner_user_id
        && Number(updatedCase.owner_user_id) !== Number(prevOwner)
        && Number(updatedCase.owner_user_id) !== Number(req.userId)) {
      notificationDispatcher.notifyCaseAssigned(updatedCase.id, req.userId)
        .catch(err => console.warn('notify_case_assigned_failed', err && err.message ? err.message : err));
    }
    if (prevStatus && updatedCase.status !== prevStatus) {
      notificationDispatcher.notifyCaseStatusChanged(updatedCase.id, req.userId, prevStatus)
        .catch(err => console.warn('notify_case_status_changed_failed', err && err.message ? err.message : err));
    }

    res.json(updatedCase);
  } catch (error) {
    console.error('Case update error:', error);
    res.status(500).json({ error: 'Failed to update case' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(`DELETE FROM cases WHERE id = $1 AND ${sf} = $2 RETURNING *`, [req.params.id, sv]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Case not found' });
    res.json({ message: 'Case deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete case' });
  }
});

module.exports = router;
