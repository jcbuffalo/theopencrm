// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Relationship Segments — saved, dynamic cohorts of companies/contacts plus
// confirm-first bulk actions over their CURRENT members.
//
// The criteria JSON is never trusted here: every read/write path routes it
// through services/segments.js, whose strict (entity, field, op) allowlist +
// full parameterization is the single JSON→SQL gate. Anything the allowlist
// rejects surfaces as CriteriaError → 400.
//
// Endpoints (all auth-required, all org-scoped via qs(req)):
//   GET    /schema        — the criteria allowlist + bulk verbs (drives the builder UI)
//   POST   /preview       — count + sample for UNSAVED criteria (live builder preview)
//   GET    /              — list this tenant's segments
//   GET    /:id           — fetch one
//   POST   /              — create (criteria must compile)
//   PUT    /:id           — update (merged row must compile)
//   DELETE /:id           — delete
//   GET    /:id/members   — evaluate members, paginated/capped
//   POST   /:id/bulk      — run an allowlisted bulk action (org owner/admin only)
//
// Gating: index.js mounts this router behind requireFeature — but that
// mount-point gate runs BEFORE authMiddleware has populated req.orgId, so it
// falls through for everyone (see middleware/featureGate.js). The
// authoritative gate is therefore the in-router `router.use(requireFeature)`
// AFTER authMiddleware below.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const { requireFeature } = require('../middleware/featureGate');
const { segmentQueryLimiter, segmentBulkLimiter } = require('../middleware/rateLimits');
const segments = require('../services/segments');
const audit = require('../services/audit');

const router = express.Router();
router.use(authMiddleware);
router.use(requireFeature('customer_success_enabled'));

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// Bulk writes are privileged (they can rewrite hundreds of rows in one call),
// so they follow the same owner/admin gate as company merges. Users without
// an org are their own admin.
function isOrgAdmin(req) {
  if (!req.orgId) return true;
  return req.orgRole === 'owner' || req.orgRole === 'admin';
}

function scopeOf(req) {
  const [scopeField, scopeValue] = qs(req);
  return { scopeField, scopeValue, userId: req.userId, orgId: req.orgId || null };
}

// Map service errors: CriteriaError (allowlist rejection / bad values) → 400,
// everything else → 500 with the request-correlated log line.
function handleError(req, res, error, logKey, fallback) {
  if (error instanceof segments.CriteriaError) {
    return res.status(400).json({ error: error.message });
  }
  if (req.log) req.log.error(logKey, { error });
  else console.error(`${logKey}:`, error);
  return res.status(500).json({ error: fallback });
}

function parseId(req) {
  const id = parseInt(req.params.id, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Validate + normalize the create/update payload pieces that aren't criteria.
function validateName(name) {
  if (typeof name !== 'string' || name.trim() === '' || name.trim().length > 120) return null;
  return name.trim();
}

async function fetchSegment(req) {
  const id = parseId(req);
  if (!id) return null;
  const [sf, sv] = qs(req);
  const result = await pool.query(`SELECT * FROM segments WHERE id = $1 AND ${sf} = $2`, [id, sv]);
  return result.rows[0] || null;
}

// GET /schema — the machine-readable allowlist (fields+ops per entity type,
// bulk verbs, member cap). The builder UI renders from this so frontend and
// backend can't drift.
router.get('/schema', (req, res) => {
  res.json({
    entity_types: segments.ENTITY_TYPES,
    fields: segments.describeAllowlist(),
    bulk_actions: segments.BULK_ACTIONS,
    cadence_overdue_days: segments.CADENCE_OVERDUE_DAYS,
    max_member_limit: segments.MAX_MEMBER_LIMIT,
  });
});

// POST /preview { entity_type, criteria } — live member count (+ small sample)
// for criteria that haven't been saved yet. Powers the builder's "N companies
// match" readout. Compile errors → 400 with the allowlist message.
router.post('/preview', segmentQueryLimiter, async (req, res) => {
  try {
    const { entity_type, criteria } = req.body || {};
    const draft = { entity_type, criteria: criteria || [] };
    const scope = scopeOf(req);
    const total = await segments.count(scope, draft);
    const sample = await segments.evaluate(scope, draft, { limit: 10 });
    res.json({ count: total, sample });
  } catch (error) {
    handleError(req, res, error, 'segment_preview_failed', 'Failed to preview segment');
  }
});

// GET / — this tenant's segments, newest first.
router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(
      `SELECT * FROM segments WHERE ${sf} = $1 ORDER BY created_at DESC`, [sv]
    );
    res.json(result.rows);
  } catch (error) {
    handleError(req, res, error, 'segment_list_failed', 'Failed to list segments');
  }
});

router.get('/:id', async (req, res) => {
  try {
    const segment = await fetchSegment(req);
    if (!segment) return res.status(404).json({ error: 'Segment not found' });
    res.json(segment);
  } catch (error) {
    handleError(req, res, error, 'segment_get_failed', 'Failed to fetch segment');
  }
});

// POST / — create. The criteria must compile against the allowlist BEFORE the
// row is written, so the table never holds criteria we can't evaluate.
router.post('/', async (req, res) => {
  try {
    const { name, entity_type, criteria } = req.body || {};
    const cleanName = validateName(name);
    if (!cleanName) return res.status(400).json({ error: 'name is required (max 120 chars)' });
    const cleanCriteria = criteria || [];
    // Compile-validate (throws CriteriaError → 400). Also validates entity_type.
    segments.compileCriteria(entity_type, qs(req)[0], cleanCriteria);

    const result = await pool.query(
      `INSERT INTO segments (user_id, org_id, name, entity_type, criteria, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING *`,
      [req.userId, req.orgId || null, cleanName, entity_type, JSON.stringify(cleanCriteria), req.userId]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    handleError(req, res, error, 'segment_create_failed', 'Failed to create segment');
  }
});

// PUT /:id — update name and/or criteria. entity_type is intentionally
// immutable after create (criteria semantics are per-entity; changing it under
// a saved segment would silently invalidate every row).
router.put('/:id', async (req, res) => {
  try {
    const segment = await fetchSegment(req);
    if (!segment) return res.status(404).json({ error: 'Segment not found' });

    const { name, criteria } = req.body || {};
    let cleanName = segment.name;
    if (name !== undefined) {
      cleanName = validateName(name);
      if (!cleanName) return res.status(400).json({ error: 'name must be a non-empty string (max 120 chars)' });
    }
    const nextCriteria = criteria !== undefined ? criteria : segment.criteria;
    segments.compileCriteria(segment.entity_type, qs(req)[0], nextCriteria);

    const [sf, sv] = qs(req);
    const result = await pool.query(
      `UPDATE segments SET name = $1, criteria = $2::jsonb, updated_at = CURRENT_TIMESTAMP
        WHERE id = $3 AND ${sf} = $4 RETURNING *`,
      [cleanName, JSON.stringify(nextCriteria), segment.id, sv]
    );
    res.json(result.rows[0]);
  } catch (error) {
    handleError(req, res, error, 'segment_update_failed', 'Failed to update segment');
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = parseId(req);
    if (!id) return res.status(404).json({ error: 'Segment not found' });
    const [sf, sv] = qs(req);
    const result = await pool.query(
      `DELETE FROM segments WHERE id = $1 AND ${sf} = $2 RETURNING id`, [id, sv]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Segment not found' });
    res.json({ message: 'Segment deleted' });
  } catch (error) {
    handleError(req, res, error, 'segment_delete_failed', 'Failed to delete segment');
  }
});

// GET /:id/members?limit=&offset= — the segment's current members. Paginated
// and capped (MAX_MEMBER_LIMIT) so a broad segment can't dump the whole table.
router.get('/:id/members', segmentQueryLimiter, async (req, res) => {
  try {
    const segment = await fetchSegment(req);
    if (!segment) return res.status(404).json({ error: 'Segment not found' });
    const scope = scopeOf(req);
    const total = await segments.count(scope, segment);
    const members = await segments.evaluate(scope, segment, {
      limit: req.query.limit, offset: req.query.offset,
    });
    res.json({ total, members, entity_type: segment.entity_type });
  } catch (error) {
    handleError(req, res, error, 'segment_members_failed', 'Failed to evaluate segment members');
  }
});

// POST /:id/bulk { action, params } — run an allowlisted bulk action over the
// segment's CURRENT members. Owner/admin only; membership is re-evaluated at
// write time inside one org-scoped statement. Returns the affected-row count
// the confirm dialog promised.
router.post('/:id/bulk', segmentBulkLimiter, async (req, res) => {
  if (!isOrgAdmin(req)) {
    return res.status(403).json({ error: 'Only org owners/admins can run bulk actions' });
  }
  try {
    const segment = await fetchSegment(req);
    if (!segment) return res.status(404).json({ error: 'Segment not found' });

    const { action, params } = req.body || {};
    const { affected } = await segments.runBulkAction(scopeOf(req), segment, action, params || {});

    // Fire-and-forget audit trail — a bulk write over N rows should be
    // reconstructable later (who / which segment / which verb / how many).
    audit.fromReq(req, {
      event: 'segment.bulk_action',
      targetType: 'segment',
      targetId: String(segment.id),
      meta: { action, entity_type: segment.entity_type, affected },
    });

    res.json({ action, affected });
  } catch (error) {
    handleError(req, res, error, 'segment_bulk_failed', 'Failed to run bulk action');
  }
});

module.exports = router;
