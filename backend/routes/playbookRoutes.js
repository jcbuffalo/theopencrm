// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Success Playbooks — templated task checklists fired by account lifecycle
// changes (migration 123). Mounted at /api/playbooks behind
// requireFeature('customer_success_enabled') (see index.js) — same gate as the
// rest of the post-sale motion (/api/accounts, /api/retention).
//
// A playbook = a name + a trigger + an ordered list of steps. Two trigger
// kinds (migration 158):
//   * trigger_kind 'lifecycle_stage' (default) — trigger_stage is one of the
//     account lifecycle stages (schemas/companies.LIFECYCLE_STAGES); fires
//     when a company enters that stage, at most once per (playbook, company).
//   * trigger_kind 'deal_stage' — trigger_stage is a stage id on one of the
//     org's pipelines (validated against services/pipelines effective
//     pipelines), optionally filtered to one deal_type via trigger_deal_type;
//     fires when a deal enters that stage, at most once per (playbook, deal).
// Either way services/playbooks.js spawns one task per step (due today +
// offset_days).
//
// Endpoints (all auth-required, all org-scoped via qs(req)):
//   GET    /                    — list playbooks (+ step/run counts)
//   GET    /:id                 — one playbook with its ordered steps
//   POST   /                    — create (optionally with inline steps)   [org admin]
//   PUT    /:id                 — update name / trigger_stage / is_active [org admin]
//   DELETE /:id                 — delete (steps cascade)                  [org admin]
//   POST   /:id/steps           — add a step                              [org admin]
//   PUT    /:id/steps/:stepId   — update a step                           [org admin]
//   DELETE /:id/steps/:stepId   — remove a step                           [org admin]
//
// WRITE GATING: reads are open to every member (the page shows what will
// happen to their accounts); writes are owner/admin only, mirroring
// companyRoutes.isOrgAdmin — users without an org are their own admin.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const { requireFeature } = require('../middleware/featureGate');
const { LIFECYCLE_STAGES } = require('../schemas/companies');
// Deal-stage triggers (migration 158): stage ids validate against the org's
// effective pipeline(s), deal types against the known pipeline rows.
const pipelines = require('../services/pipelines');
const dealStages = require('../utils/dealStages');

const router = express.Router();
router.use(authMiddleware);
// The mount-point gate in index.js runs BEFORE authMiddleware has populated
// req.orgId (so it no-ops for org users); this in-router gate — after auth —
// is the one that actually enforces, mirroring the /:id/lifecycle-stage and
// /service-contracts/renewals pattern.
router.use(requireFeature('customer_success_enabled'));

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// Same shape as companyRoutes.isOrgAdmin: org writes need owner/admin; a user
// with no org is their own admin.
function isOrgAdmin(req) {
  if (!req.orgId) return true;
  return req.orgRole === 'owner' || req.orgRole === 'admin';
}
function requireOrgAdmin(req, res, next) {
  if (!isOrgAdmin(req)) {
    return res.status(403).json({ error: 'Only org owners/admins can manage playbooks' });
  }
  next();
}

function fail(req, res, event, msg, error) {
  if (req.log) req.log.error(event, { error });
  else console.error(`${event}:`, error);
  res.status(500).json({ error: msg });
}

// --- input validation helpers (small enough not to warrant a zod schema file) ---
const TRIGGER_KINDS = ['lifecycle_stage', 'deal_stage'];

function validPlaybookBody(body, { partial = false } = {}) {
  const out = {};
  const { name, trigger_kind, trigger_stage, trigger_deal_type, is_active } = body || {};
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 255) return { error: 'name must be a non-empty string (≤255 chars)' };
    out.name = name.trim();
  } else if (!partial) return { error: 'name is required' };
  if (trigger_kind !== undefined) {
    if (!TRIGGER_KINDS.includes(trigger_kind)) return { error: `trigger_kind must be one of: ${TRIGGER_KINDS.join(', ')}` };
    out.trigger_kind = trigger_kind;
  }
  // Shape-only here; the semantic check (lifecycle allowlist vs. pipeline
  // stage id) needs the org's pipelines — see triggerValidationError.
  if (trigger_stage !== undefined) {
    if (typeof trigger_stage !== 'string' || !trigger_stage.trim() || trigger_stage.trim().length > 64) {
      return { error: 'trigger_stage must be a non-empty string (≤64 chars)' };
    }
    out.trigger_stage = trigger_stage.trim();
  } else if (!partial) return { error: 'trigger_stage is required' };
  if (trigger_deal_type !== undefined) {
    if (trigger_deal_type === null || trigger_deal_type === '') out.trigger_deal_type = null;
    else if (typeof trigger_deal_type !== 'string' || trigger_deal_type.trim().length > 40) {
      return { error: 'trigger_deal_type must be a string (≤40 chars) or null' };
    } else out.trigger_deal_type = trigger_deal_type.trim();
  }
  if (is_active !== undefined) {
    if (typeof is_active !== 'boolean') return { error: 'is_active must be a boolean' };
    out.is_active = is_active;
  }
  return { value: out };
}

// Semantic trigger validation (migration 158). Lifecycle playbooks keep the
// historical allowlist; deal_stage playbooks validate the stage against the
// org's effective pipeline for the (optional) trigger_deal_type — or against
// ANY of the org's pipelines when no type filter is set. Returns an error
// string or null.
async function triggerValidationError(req, { trigger_kind, trigger_stage, trigger_deal_type }) {
  const kind = trigger_kind || 'lifecycle_stage';
  if (kind === 'lifecycle_stage') {
    if (trigger_deal_type) return 'trigger_deal_type is only valid for deal_stage playbooks';
    if (!LIFECYCLE_STAGES.includes(trigger_stage)) {
      return `trigger_stage must be one of: ${LIFECYCLE_STAGES.join(', ')}`;
    }
    return null;
  }
  // deal_stage
  let dealType = null;
  if (trigger_deal_type) {
    try {
      dealType = pipelines.normalizeDealType(trigger_deal_type);
    } catch (err) {
      return (err.body && err.body.error) || 'Invalid trigger_deal_type';
    }
    if (dealType !== pipelines.DEFAULT_DEAL_TYPE) {
      const known = await pipelines.listPipelines(req.orgId);
      if (!known.some((p) => p.deal_type === dealType)) {
        return `Unknown trigger_deal_type "${dealType}" — create that pipeline first`;
      }
    }
    const pipeline = await pipelines.getEffectivePipeline(req.orgId, undefined, { dealType });
    if (!dealStages.isValidStage(trigger_stage, pipeline)) {
      return `trigger_stage "${trigger_stage}" is not a stage on the "${dealType}" pipeline`;
    }
    return null;
  }
  // No type filter: the stage must exist on at least one of the org's pipelines.
  const candidates = [pipelines.DEFAULT_DEAL_TYPE];
  const known = await pipelines.listPipelines(req.orgId);
  for (const p of known) if (!candidates.includes(p.deal_type)) candidates.push(p.deal_type);
  for (const t of candidates) {
    const pipeline = await pipelines.getEffectivePipeline(req.orgId, undefined, { dealType: t });
    if (dealStages.isValidStage(trigger_stage, pipeline)) return null;
  }
  return `trigger_stage "${trigger_stage}" is not a stage on any of this workspace's pipelines`;
}

function validStepBody(body) {
  const { title, description, offset_days, sort_order } = body || {};
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 255) {
    return { error: 'title must be a non-empty string (≤255 chars)' };
  }
  const offset = offset_days === undefined || offset_days === null ? 0 : Number(offset_days);
  if (!Number.isInteger(offset) || offset < 0 || offset > 365) {
    return { error: 'offset_days must be an integer between 0 and 365' };
  }
  const order = sort_order === undefined || sort_order === null ? 0 : Number(sort_order);
  if (!Number.isInteger(order)) return { error: 'sort_order must be an integer' };
  return {
    value: {
      title: title.trim(),
      description: typeof description === 'string' && description.trim() ? description.trim() : null,
      offset_days: offset,
      sort_order: order,
    },
  };
}

// Ownership check reused by every step route: the playbook must be in scope.
async function findScopedPlaybook(req, id) {
  const [sf, sv] = qs(req);
  const r = await pool.query(`SELECT * FROM playbooks WHERE id = $1 AND ${sf} = $2`, [id, sv]);
  return r.rows[0] || null;
}

// ---------------------------------------------------------------------------
// GET / — list, newest first, with step + run counts for the list cards.
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `SELECT p.*,
              (SELECT COUNT(*)::int FROM playbook_steps s WHERE s.playbook_id = p.id) AS step_count,
              (SELECT COUNT(*)::int FROM playbook_runs  x WHERE x.playbook_id = p.id) AS run_count
         FROM playbooks p
        WHERE p.${sf} = $1
        ORDER BY p.created_at DESC, p.id DESC`,
      [sv]
    );
    res.json({ playbooks: r.rows, stages: LIFECYCLE_STAGES });
  } catch (error) {
    fail(req, res, 'playbooks_list_failed', 'Failed to list playbooks', error);
  }
});

// ---------------------------------------------------------------------------
// GET /:id — one playbook with its ordered steps.
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const playbook = await findScopedPlaybook(req, req.params.id);
    if (!playbook) return res.status(404).json({ error: 'Playbook not found' });
    const steps = await pool.query(
      `SELECT * FROM playbook_steps WHERE playbook_id = $1 ORDER BY sort_order ASC, id ASC`,
      [playbook.id]
    );
    res.json({ ...playbook, steps: steps.rows });
  } catch (error) {
    fail(req, res, 'playbook_get_failed', 'Failed to fetch playbook', error);
  }
});

// ---------------------------------------------------------------------------
// POST / — create. Accepts optional inline `steps: [{title, description,
// offset_days, sort_order}]` so the editor can save a whole playbook in one
// call. Steps insert in array order when sort_order is omitted.
// ---------------------------------------------------------------------------
router.post('/', requireOrgAdmin, async (req, res) => {
  const parsed = validPlaybookBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { name, trigger_stage, is_active } = parsed.value;
  const trigger_kind = parsed.value.trigger_kind || 'lifecycle_stage';
  const trigger_deal_type = parsed.value.trigger_deal_type ?? null;

  const steps = Array.isArray(req.body?.steps) ? req.body.steps : [];
  const parsedSteps = [];
  for (let i = 0; i < steps.length; i++) {
    const s = validStepBody({ sort_order: i, ...steps[i] });
    if (s.error) return res.status(400).json({ error: `steps[${i}]: ${s.error}` });
    parsedSteps.push(s.value);
  }

  try {
    const trigErr = await triggerValidationError(req, { trigger_kind, trigger_stage, trigger_deal_type });
    if (trigErr) return res.status(400).json({ error: trigErr });
  } catch (error) {
    return fail(req, res, 'playbook_trigger_validate_failed', 'Failed to validate playbook trigger', error);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = await client.query(
      `INSERT INTO playbooks (user_id, org_id, name, trigger_kind, trigger_stage, trigger_deal_type, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.userId, req.orgId || null, name, trigger_kind, trigger_stage, trigger_deal_type, is_active !== undefined ? is_active : true]
    );
    const playbook = created.rows[0];
    const insertedSteps = [];
    for (const s of parsedSteps) {
      const row = await client.query(
        `INSERT INTO playbook_steps (playbook_id, org_id, title, description, offset_days, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [playbook.id, req.orgId || null, s.title, s.description, s.offset_days, s.sort_order]
      );
      insertedSteps.push(row.rows[0]);
    }
    await client.query('COMMIT');
    res.status(201).json({ ...playbook, steps: insertedSteps });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    fail(req, res, 'playbook_create_failed', 'Failed to create playbook', error);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// PUT /:id — partial update of name / trigger_stage / is_active.
// ---------------------------------------------------------------------------
router.put('/:id', requireOrgAdmin, async (req, res) => {
  const parsed = validPlaybookBody(req.body, { partial: true });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { name, is_active } = parsed.value;
  try {
    const [sf, sv] = qs(req);

    // When the PUT touches any trigger field, merge with the stored row and
    // re-validate the resulting (kind, stage, deal_type) triple as a whole —
    // a partial update can't leave the trigger in an inconsistent state.
    const touchesTrigger = parsed.value.trigger_kind !== undefined
      || parsed.value.trigger_stage !== undefined
      || parsed.value.trigger_deal_type !== undefined;
    let mergedKind = null;
    let mergedStage = null;
    let mergedType = null;
    if (touchesTrigger) {
      const existing = await findScopedPlaybook(req, req.params.id);
      if (!existing) return res.status(404).json({ error: 'Playbook not found' });
      mergedKind = parsed.value.trigger_kind ?? existing.trigger_kind ?? 'lifecycle_stage';
      mergedStage = parsed.value.trigger_stage ?? existing.trigger_stage;
      mergedType = parsed.value.trigger_deal_type !== undefined
        ? parsed.value.trigger_deal_type
        : (existing.trigger_deal_type ?? null);
      // Switching back to a lifecycle trigger drops any stale deal_type filter.
      if (mergedKind === 'lifecycle_stage') mergedType = null;
      const trigErr = await triggerValidationError(req, {
        trigger_kind: mergedKind, trigger_stage: mergedStage, trigger_deal_type: mergedType,
      });
      if (trigErr) return res.status(400).json({ error: trigErr });
    }

    const r = await pool.query(
      `UPDATE playbooks SET
         name              = COALESCE($1, name),
         trigger_kind      = CASE WHEN $2::boolean THEN $3 ELSE trigger_kind END,
         trigger_stage     = CASE WHEN $2::boolean THEN $4 ELSE trigger_stage END,
         trigger_deal_type = CASE WHEN $2::boolean THEN $5 ELSE trigger_deal_type END,
         is_active         = COALESCE($6, is_active),
         updated_at        = CURRENT_TIMESTAMP
       WHERE id = $7 AND ${sf} = $8 RETURNING *`,
      [name ?? null, touchesTrigger, mergedKind, mergedStage, mergedType, is_active ?? null, req.params.id, sv]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Playbook not found' });
    res.json(r.rows[0]);
  } catch (error) {
    fail(req, res, 'playbook_update_failed', 'Failed to update playbook', error);
  }
});

// ---------------------------------------------------------------------------
// DELETE /:id — delete; steps + runs cascade via FK.
// ---------------------------------------------------------------------------
router.delete('/:id', requireOrgAdmin, async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `DELETE FROM playbooks WHERE id = $1 AND ${sf} = $2 RETURNING *`,
      [req.params.id, sv]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Playbook not found' });
    res.json({ message: 'Playbook deleted', playbook: r.rows[0] });
  } catch (error) {
    fail(req, res, 'playbook_delete_failed', 'Failed to delete playbook', error);
  }
});

// ---------------------------------------------------------------------------
// POST /:id/steps — add a step to a scoped playbook.
// ---------------------------------------------------------------------------
router.post('/:id/steps', requireOrgAdmin, async (req, res) => {
  const parsed = validStepBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const playbook = await findScopedPlaybook(req, req.params.id);
    if (!playbook) return res.status(404).json({ error: 'Playbook not found' });
    const s = parsed.value;
    const r = await pool.query(
      `INSERT INTO playbook_steps (playbook_id, org_id, title, description, offset_days, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [playbook.id, req.orgId || null, s.title, s.description, s.offset_days, s.sort_order]
    );
    res.status(201).json(r.rows[0]);
  } catch (error) {
    fail(req, res, 'playbook_step_create_failed', 'Failed to add step', error);
  }
});

// ---------------------------------------------------------------------------
// PUT /:id/steps/:stepId — update a step (title/description/offset/sort).
// ---------------------------------------------------------------------------
router.put('/:id/steps/:stepId', requireOrgAdmin, async (req, res) => {
  const parsed = validStepBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const playbook = await findScopedPlaybook(req, req.params.id);
    if (!playbook) return res.status(404).json({ error: 'Playbook not found' });
    const s = parsed.value;
    const r = await pool.query(
      `UPDATE playbook_steps SET title = $1, description = $2, offset_days = $3, sort_order = $4
       WHERE id = $5 AND playbook_id = $6 RETURNING *`,
      [s.title, s.description, s.offset_days, s.sort_order, req.params.stepId, playbook.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Step not found' });
    res.json(r.rows[0]);
  } catch (error) {
    fail(req, res, 'playbook_step_update_failed', 'Failed to update step', error);
  }
});

// ---------------------------------------------------------------------------
// DELETE /:id/steps/:stepId — remove a step.
// ---------------------------------------------------------------------------
router.delete('/:id/steps/:stepId', requireOrgAdmin, async (req, res) => {
  try {
    const playbook = await findScopedPlaybook(req, req.params.id);
    if (!playbook) return res.status(404).json({ error: 'Playbook not found' });
    const r = await pool.query(
      `DELETE FROM playbook_steps WHERE id = $1 AND playbook_id = $2 RETURNING *`,
      [req.params.stepId, playbook.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Step not found' });
    res.json({ message: 'Step deleted', step: r.rows[0] });
  } catch (error) {
    fail(req, res, 'playbook_step_delete_failed', 'Failed to delete step', error);
  }
});

module.exports = router;
