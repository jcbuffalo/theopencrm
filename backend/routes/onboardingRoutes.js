// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// First-run workspace builder — "describe how your business sells" (spec 203).
//
//   GET  /api/onboarding/templates   starting templates (no AI call, any member)
//   POST /api/onboarding/plan        { description?, template_id? } → a bundle
//                                    of confirm-first proposals (AI call)
//
// /plan sits behind the same gates as /api/ai (AI billing verdict + the
// ai_features_enabled module flag) but is mounted separately so the template
// list stays reachable for an org whose AI is not (yet) enabled — the picker
// can still render and explain what happens next.
//
// NOTHING here writes. The frontend applies each returned proposal through
// POST /api/ai/actions/apply — the one existing writer — in the order given.
// Any member may ask for a plan (it is a read); only an owner/admin can apply
// the pipeline / field / automation pieces, and the response says so
// (can_apply) so the UI can route a member to their admin instead of letting
// them hit a wall of 403s.

const express = require('express');
const { authMiddleware } = require('../auth');
const { requireAiBilling } = require('../middleware/requireAiBilling');
const { requireFeature } = require('../middleware/featureGate');
const planner = require('../services/onboardingPlanner');
const templates = require('../services/onboardingTemplates');
const audit = require('../services/audit');

const router = express.Router();

router.get('/templates', authMiddleware, (req, res) => {
  res.json({ templates: templates.listTemplates() });
});

router.post('/plan', authMiddleware, requireAiBilling(), requireFeature('ai_features_enabled'), async (req, res) => {
  try {
    if (!req.orgId) {
      return res.status(400).json({ error: 'An organization workspace is required.', code: 'ORG_REQUIRED' });
    }
    const body = req.body || {};
    let description = typeof body.description === 'string' ? body.description.trim() : '';
    let template = null;
    if (body.template_id !== undefined && body.template_id !== null && body.template_id !== '') {
      template = templates.getTemplate(String(body.template_id));
      if (!template) return res.status(400).json({ error: 'Unknown template_id', code: 'UNKNOWN_TEMPLATE' });
      // A template is a pre-written description; anything the user added is
      // appended so "start from X, but we also…" is one plan, not two.
      description = description ? `${template.description}\n\nAlso: ${description}` : template.description;
    }
    const descErr = planner.validateDescription(description);
    if (descErr) return res.status(400).json({ error: descErr, code: 'INVALID_DESCRIPTION' });

    // Profile is resolved from the org row inside the planner (via
    // pipelines.getEffectivePipeline) — authMiddleware does not carry it.
    const out = await planner.planWorkspace({ orgId: req.orgId, userId: req.userId, description });
    if (!out.ok) return res.status(out.status || 502).json({ error: out.error, code: out.code });

    const canApply = req.orgRole === 'owner' || req.orgRole === 'admin';
    audit.fromReq(req, {
      event: audit.EVENTS.AI_ACTION_PROPOSED,
      targetType: 'workspace_plan',
      meta: {
        template_id: template ? template.id : null,
        proposals: out.plan.proposals.map((p) => p.kind),
        skipped: out.plan.skipped.length,
      },
    });
    res.json({
      ok: true,
      can_apply: canApply,
      template_id: template ? template.id : null,
      plan: out.plan,
    });
  } catch (err) {
    console.error('onboarding plan error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
