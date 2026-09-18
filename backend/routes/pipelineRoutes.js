// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// /api/pipelines — the org's EFFECTIVE pipelines (per-org editable stages,
// migration 155; multiple pipelines per org via deal_type, spec 201 /
// migration 156). Every read/write takes an optional deal_type — a slug in
// ?deal_type= or the body — and operates on THAT pipeline; omitted means the
// org default, exactly as before.
//
//   GET    /      → { ...effectivePipeline, is_custom, deal_counts, can_edit,
//                     tones, max_stages, default_stages,
//                     pipelines: [{ deal_type, name, is_custom, stage_count }] }
//                   (any member; ?deal_type= reads that type's pipeline and
//                   its type-scoped deal counts)
//   PUT    /      → body { stages: [...], moveDealsTo?, name?, deal_type? }
//                   (owner/admin) — a NEW deal_type creates that pipeline
//                   200 { pipeline, moved } · 400 validation · 409 stages_have_deals
//   POST   /reset → body { moveDealsTo?, deal_type? }           (owner/admin)
//                   default: back to the profile default; a type: drop the
//                   type row (its deals fall back to the org default pipeline)
//   DELETE /      → ?deal_type= + body { moveDealsTo?, retype_to? } (owner/admin)
//                   delete a TYPE pipeline and re-type its deals (default:
//                   'default'); 409 while deals exist unresolved
//
// The old per-row CRUD (/:id) is gone — nothing consumed it, and two sources
// of truth for "what are my stages" is exactly the bug this replaces.
//
// Every write is audit-logged (pipeline.updated / pipeline.reset /
// pipeline.deleted) and busts the 30s effective-pipeline cache for the org.

const express = require('express');
const { authMiddleware } = require('../auth');
const { requireOrgAdmin } = require('../middleware/adminAuth');
const { validateBody } = require('../middleware/validate');
const { updateSchema, resetSchema, deleteSchema } = require('../schemas/pipelines');
const pipelines = require('../services/pipelines');
const audit = require('../services/audit');

const router = express.Router();
router.use(authMiddleware);

function canEdit(req) {
  return req.orgRole === 'owner' || req.orgRole === 'admin' || req.isSuperAdmin === true;
}

function sendServiceError(res, err) {
  if (err && err.status && err.body) return res.status(err.status).json(err.body);
  return null;
}

// The deal_type a request addresses: body wins, then ?deal_type=, then the
// default. Validation (slug rules, reserved 'default') happens inside the
// service via normalizeDealType, whose 400 sendServiceError passes through.
function reqDealType(req) {
  const raw = (req.body && req.body.deal_type) ?? req.query.deal_type;
  return raw === undefined || raw === null || raw === '' ? undefined : String(raw);
}

router.get('/', async (req, res) => {
  try {
    const dealType = reqDealType(req);
    const pipeline = await pipelines.getEffectivePipeline(req.orgId, undefined, { dealType });
    const deal_counts = req.orgId ? await pipelines.dealCountsByStage(req.orgId, undefined, dealType) : {};
    const list = await pipelines.listPipelines(req.orgId, pipeline.profile);
    res.json({
      ...pipeline,
      deal_counts,
      can_edit: !!req.orgId && canEdit(req),
      tones: pipelines.TONES,
      max_stages: pipelines.maxStagesFor(pipeline.profile),
      default_stages: pipelines.defaultStagesFor(pipeline.profile),
      pipelines: list,
    });
  } catch (error) {
    if (sendServiceError(res, error)) return;
    if (req.log) req.log.error('pipeline_fetch_failed', { error });
    res.status(500).json({ error: 'Failed to fetch pipeline' });
  }
});

router.put('/', requireOrgAdmin, validateBody(updateSchema), async (req, res) => {
  try {
    if (!req.orgId) return res.status(400).json({ error: 'Org context required' });
    const { stages, moveDealsTo, name } = req.body;
    const dealType = reqDealType(req);
    const result = await pipelines.savePipeline(req.orgId, stages, req.userId, { moveDealsTo, name, dealType });
    audit.fromReq(req, {
      event: 'pipeline.updated',
      targetType: 'pipeline',
      targetId: result.pipeline.id,
      meta: {
        deal_type: result.pipeline.deal_type,
        stage_count: result.pipeline.stages.length,
        stages: result.pipeline.stages.map((st) => st.id),
        moved: result.moved,
      },
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    if (sendServiceError(res, error)) return;
    if (req.log) req.log.error('pipeline_save_failed', { error });
    else console.error('Pipeline save error:', error);
    res.status(500).json({ error: 'Failed to save pipeline' });
  }
});

router.post('/reset', requireOrgAdmin, validateBody(resetSchema), async (req, res) => {
  try {
    if (!req.orgId) return res.status(400).json({ error: 'Org context required' });
    const { moveDealsTo } = req.body || {};
    const dealType = reqDealType(req);
    const result = await pipelines.resetPipeline(req.orgId, req.userId, { moveDealsTo, dealType });
    audit.fromReq(req, {
      event: 'pipeline.reset',
      targetType: 'pipeline',
      targetId: null,
      meta: { profile: result.pipeline.profile, deal_type: dealType || 'default', moved: result.moved },
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    if (sendServiceError(res, error)) return;
    if (req.log) req.log.error('pipeline_reset_failed', { error });
    else console.error('Pipeline reset error:', error);
    res.status(500).json({ error: 'Failed to reset pipeline' });
  }
});

// Delete a TYPE pipeline (spec 201). Its deals are re-typed to retype_to
// (default 'default') with strays re-homed via moveDealsTo; refuses while
// deals exist unresolved. The default pipeline is reset, never deleted.
router.delete('/', requireOrgAdmin, validateBody(deleteSchema), async (req, res) => {
  try {
    if (!req.orgId) return res.status(400).json({ error: 'Org context required' });
    const dealType = reqDealType(req);
    if (!dealType) return res.status(400).json({ error: 'deal_type is required' });
    const { moveDealsTo, retype_to } = req.body || {};
    const result = await pipelines.deleteTypePipeline(req.orgId, dealType, req.userId, { moveDealsTo, retypeTo: retype_to });
    audit.fromReq(req, {
      event: 'pipeline.deleted',
      targetType: 'pipeline',
      targetId: null,
      meta: { deal_type: result.deleted, retyped_to: result.retyped_to, moved: result.moved },
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    if (sendServiceError(res, error)) return;
    if (req.log) req.log.error('pipeline_delete_failed', { error });
    else console.error('Pipeline delete error:', error);
    res.status(500).json({ error: 'Failed to delete pipeline' });
  }
});

module.exports = router;
