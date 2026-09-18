// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Per-org AI model + effort admin routes.
//
// Mounted at /api/admin/ai-model. Endpoints:
//
//   GET   /  → effective settings + metadata for the picker UI:
//     {
//       model:          string,                — currently resolved model id
//       effort:         string,                — currently resolved effort
//       env_override:   boolean,               — true if process.env.ANTHROPIC_MODEL is set
//       valid_models:   [{id,label,family}],   — allowlist for the dropdown
//       valid_efforts:  ['low','medium','high'],
//       default_model:  string,
//       default_effort: string,
//     }
//
//   PATCH /  → body { model?, effort? }. At least one field required. Each
//     field validated against the allowlist; bad values → 400. Writes the
//     organizations row, busts the in-process cache, audits the change with
//     EVENTS.SETTINGS_AI_MODEL_CHANGED, returns the new effective settings.
//
// AUTH: owner/admin only (mirrors routes/customFieldsRoutes.js#requireOrgAdmin).
// Members and viewers get a 403. No org context → 400.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const aiModel = require('../services/aiModel');
const audit = require('../services/audit');

const router = express.Router();
router.use(authMiddleware);

// Guard: only org owners/admins can read or change AI model settings. Same
// shape as routes/customFieldsRoutes.js#requireOrgAdmin — kept inline rather
// than extracted because the two routes are the only two callers and the
// gate is two lines.
function requireOrgAdmin(req, res, next) {
  if (!req.orgId) return res.status(400).json({ error: 'Org context required' });
  if (req.orgRole !== 'owner' && req.orgRole !== 'admin') {
    return res.status(403).json({ error: 'Only org owners/admins can manage AI model settings' });
  }
  next();
}

router.use(requireOrgAdmin);

// ---------------------------------------------------------------------------
// GET / — current effective settings + picker metadata.
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const settings = await aiModel.getOrgAiSettings(req.orgId);
    res.json({
      model:          settings.model,
      effort:         settings.effort,
      env_override:   !!process.env.ANTHROPIC_MODEL,
      valid_models:   aiModel.VALID_MODELS,
      valid_efforts:  aiModel.VALID_EFFORTS,
      default_model:  aiModel.DEFAULT_MODEL,
      default_effort: aiModel.DEFAULT_EFFORT,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load AI model settings' });
  }
});

// ---------------------------------------------------------------------------
// PATCH / — update model and/or effort.
//
// Body shape:
//   { model?: string, effort?: string }
// At least one of `model` / `effort` must be present. Each, if present,
// validated against the allowlist; bad values → 400 and the entire write
// is rejected (partial writes would surprise the operator).
//
// To "reset to default" the frontend sends `null` for that field — we
// write NULL to the column and the resolver falls back to env / default
// on the next read.
// ---------------------------------------------------------------------------
router.patch('/', async (req, res) => {
  const body = req.body || {};
  const hasModel  = Object.prototype.hasOwnProperty.call(body, 'model');
  const hasEffort = Object.prototype.hasOwnProperty.call(body, 'effort');
  if (!hasModel && !hasEffort) {
    return res.status(400).json({ error: 'Provide at least one of: model, effort' });
  }

  // Validate. `null` is a sentinel that means "clear the column" (reset to
  // env / default) — explicitly allowed for both fields.
  if (hasModel && body.model !== null && !aiModel.isValidModel(body.model)) {
    return res.status(400).json({
      error: `Invalid model. Must be one of: ${aiModel.VALID_MODELS.map(m => m.id).join(', ')}`,
    });
  }
  if (hasEffort && body.effort !== null && !aiModel.isValidEffort(body.effort)) {
    return res.status(400).json({
      error: `Invalid effort. Must be one of: ${aiModel.VALID_EFFORTS.join(', ')}`,
    });
  }

  try {
    // Snapshot the effective settings BEFORE the write so the audit row
    // captures both sides of the change.
    const before = await aiModel.getOrgAiSettings(req.orgId);

    // Build the UPDATE dynamically — only touch columns the request named.
    const sets = [];
    const params = [];
    const touched = [];
    if (hasModel) {
      params.push(body.model === null ? null : body.model);
      sets.push(`ai_model = $${params.length}`);
      touched.push('model');
    }
    if (hasEffort) {
      params.push(body.effort === null ? null : body.effort);
      sets.push(`ai_effort = $${params.length}`);
      touched.push('effort');
    }
    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(req.orgId);
    await pool.query(
      `UPDATE organizations SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params
    );

    // Bust the in-process cache so the very next AI call sees the new values.
    aiModel.bustCache(req.orgId);

    const after = await aiModel.getOrgAiSettings(req.orgId);

    // Best-effort audit. audit.fromReq swallows DB errors internally; we
    // don't let an audit hiccup fail the user-visible PATCH.
    audit.fromReq(req, {
      event: audit.EVENTS.SETTINGS_AI_MODEL_CHANGED,
      targetType: 'organization',
      targetId: req.orgId,
      meta: { before, after, fields: touched },
    });

    res.json({
      model:          after.model,
      effort:         after.effort,
      env_override:   !!process.env.ANTHROPIC_MODEL,
      valid_models:   aiModel.VALID_MODELS,
      valid_efforts:  aiModel.VALID_EFFORTS,
      default_model:  aiModel.DEFAULT_MODEL,
      default_effort: aiModel.DEFAULT_EFFORT,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update AI model settings' });
  }
});

module.exports = router;
