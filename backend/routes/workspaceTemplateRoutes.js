// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Saved workspace templates (spec 203, Phase 2; migration 171).
//
//   GET    /api/workspace-templates?scope=all|mine|public   summaries (member)
//   GET    /api/workspace-templates/:id                     full template (own or public)
//   POST   /api/workspace-templates                         owner/admin — { source: 'snapshot' } | { config }
//   PUT    /api/workspace-templates/:id                     owner/admin, own only
//   DELETE /api/workspace-templates/:id                     owner/admin, own only
//   POST   /api/workspace-templates/:id/plan                member — template → proposals for THIS org (no AI)
//   POST   /api/workspace-templates/generate-platform       super-admin — (re)build the public gallery from the 12 static templates (AI)
//
//   GET    /api/public/workspace-templates                  unauthenticated gallery summaries (rate-limited)
//
// NOTHING here writes CRM structure. /:id/plan returns proposals; the client
// applies them through POST /api/ai/actions/apply exactly like the builder.

const express = require('express');
const { authMiddleware } = require('../auth');
const { requireOrgAdmin, isSuperAdmin } = require('../middleware/adminAuth');
const templates = require('../services/workspaceTemplates');
const audit = require('../services/audit');

const router = express.Router();
router.use(authMiddleware);

function needOrg(req, res) {
  if (!req.orgId) { res.status(400).json({ error: 'An organization workspace is required.', code: 'ORG_REQUIRED' }); return false; }
  return true;
}
function idParam(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'Invalid template id' }); return null; }
  return id;
}
function sendErr(res, err) {
  if (err && err.status && err.body) return res.status(err.status).json(err.body);
  console.error('workspace-templates error:', err);
  return res.status(500).json({ error: err.message || 'Internal error' });
}

router.get('/', async (req, res) => {
  try {
    if (!needOrg(req, res)) return;
    const scope = ['mine', 'public', 'all'].includes(req.query.scope) ? req.query.scope : 'all';
    res.json({ templates: await templates.listTemplates({ orgId: req.orgId, scope }) });
  } catch (err) { sendErr(res, err); }
});

// Super-admin only: regenerate the platform gallery. Declared before /:id so
// the literal segment is not swallowed by the id route.
router.post('/generate-platform', async (req, res) => {
  try {
    if (!needOrg(req, res)) return;
    if (!(await isSuperAdmin(req.userId))) return res.status(403).json({ error: 'Super-admin only' });
    const only = Array.isArray(req.body?.only) ? req.body.only.map(String) : null;
    const out = await templates.generatePlatformTemplates({ orgId: req.orgId, userId: req.userId, only });
    audit.fromReq(req, { event: audit.EVENTS.AI_ACTION_APPLIED, targetType: 'workspace_template', meta: { op: 'generate_platform', generated: out.generated.map((g) => g.slug), failed: out.failed } });
    res.json({ ok: true, ...out });
  } catch (err) { sendErr(res, err); }
});

router.get('/:id', async (req, res) => {
  try {
    if (!needOrg(req, res)) return;
    const id = idParam(req, res); if (!id) return;
    const row = await templates.getTemplate(id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Template not found' });
    res.json({ template: { ...templates.summarize(row), config: row.config, can_edit: row.org_id === req.orgId } });
  } catch (err) { sendErr(res, err); }
});

router.post('/', requireOrgAdmin, async (req, res) => {
  try {
    if (!needOrg(req, res)) return;
    const body = req.body || {};
    const config = body.source === 'snapshot' ? await templates.snapshotOrg(req.orgId) : body.config;
    const row = await templates.createTemplate({
      orgId: req.orgId,
      userId: req.userId,
      name: body.name,
      tagline: body.tagline,
      vertical: body.vertical,
      description: body.description,
      is_public: body.is_public,
      config,
    });
    audit.fromReq(req, { event: audit.EVENTS.AI_ACTION_APPLIED, targetType: 'workspace_template', targetId: row.id, meta: { op: 'create', source: body.source === 'snapshot' ? 'snapshot' : 'config', is_public: row.is_public } });
    res.status(201).json({ template: { ...templates.summarize(row), config: row.config, can_edit: true } });
  } catch (err) { sendErr(res, err); }
});

router.put('/:id', requireOrgAdmin, async (req, res) => {
  try {
    if (!needOrg(req, res)) return;
    const id = idParam(req, res); if (!id) return;
    const row = await templates.updateTemplate(id, req.orgId, req.body || {});
    if (!row) return res.status(404).json({ error: 'Template not found (or not yours to edit)' });
    audit.fromReq(req, { event: audit.EVENTS.AI_ACTION_APPLIED, targetType: 'workspace_template', targetId: row.id, meta: { op: 'update', fields: Object.keys(req.body || {}) } });
    res.json({ template: { ...templates.summarize(row), config: row.config, can_edit: true } });
  } catch (err) { sendErr(res, err); }
});

router.delete('/:id', requireOrgAdmin, async (req, res) => {
  try {
    if (!needOrg(req, res)) return;
    const id = idParam(req, res); if (!id) return;
    const ok = await templates.deleteTemplate(id, req.orgId);
    if (!ok) return res.status(404).json({ error: 'Template not found (or not yours to delete)' });
    audit.fromReq(req, { event: audit.EVENTS.AI_ACTION_APPLIED, targetType: 'workspace_template', targetId: id, meta: { op: 'delete' } });
    res.json({ ok: true });
  } catch (err) { sendErr(res, err); }
});

// Clone-plan: the template's config → validated proposals for the caller's
// org. Any member may look; can_apply tells the UI who can build.
router.post('/:id/plan', async (req, res) => {
  try {
    if (!needOrg(req, res)) return;
    const id = idParam(req, res); if (!id) return;
    const row = await templates.getTemplate(id, req.orgId);
    if (!row) return res.status(404).json({ error: 'Template not found' });
    const plan = await templates.planFromTemplate(row, { orgId: req.orgId });
    audit.fromReq(req, { event: audit.EVENTS.AI_ACTION_PROPOSED, targetType: 'workspace_template', targetId: row.id, meta: { op: 'plan', proposals: plan.proposals.map((p) => p.kind), skipped: plan.skipped.length } });
    res.json({
      ok: true,
      can_apply: req.orgRole === 'owner' || req.orgRole === 'admin',
      template: templates.summarize(row),
      plan,
    });
  } catch (err) { sendErr(res, err); }
});

// Unauthenticated gallery for the marketing site. Summaries only — never config.
const publicRouter = express.Router();
publicRouter.get('/', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ templates: await templates.listPublicTemplates() });
  } catch (err) { sendErr(res, err); }
});

module.exports = router;
module.exports.publicRouter = publicRouter;
