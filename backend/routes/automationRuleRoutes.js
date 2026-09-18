// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// User-defined automation rules — org-admin CRUD + run-now.
//
// Mounted at /api/automation-rules, gated by requireFeature('automation_enabled')
// at the mount point (same flag as the built-in engine at /api/automation).
// ORG-ADMIN-ONLY (org_role = 'owner' | 'admin'); regular members get 403.
//
// Every query is org-scoped via the standard qs(req) [scopeField, scopeValue]
// pattern. Rule JSON is validated by the zod schemas in
// schemas/automationRules.js — the same schemas the engine re-checks at
// evaluation time (defence in depth).
//
// Endpoints:
//   GET    /                 — list this org's rules
//   POST   /                 — create a rule
//   PUT    /:id              — full-replace update
//   PATCH  /:id/enabled      — toggle enabled
//   DELETE /:id              — delete
//   POST   /:id/run          — evaluate this one rule immediately (run-now)

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authMiddleware } = require('../auth');
const { validateBody } = require('../middleware/validate');
const automation = require('../services/automation');
const ruleSchemas = require('../schemas/automationRules');

router.use(authMiddleware);

// Org-admin gate — mirrors orgActivityRoutes.requireOrgAdmin. Distinct from the
// platform admin_users table: any owner/admin of THE ORG can manage their own
// workspace's automation rules.
function requireOrgAdmin(req, res, next) {
  if (!req.orgId) {
    return res.status(400).json({ success: false, error: 'Org context required to manage automation rules' });
  }
  if (req.orgRole !== 'owner' && req.orgRole !== 'admin') {
    return res.status(403).json({ success: false, error: 'Org admin role required' });
  }
  next();
}
router.use(requireOrgAdmin);

// Standard org-scope helper.
function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// custom_date_offset rules (CMN §1.3) reference an org custom field by name;
// the field must exist for the rule's entity AND be a date field — zod can't
// check the DB, so POST/PUT run this after schema validation. The evaluator's
// scan re-applies the same constraint via a JOIN, so a field later retyped or
// deleted silently stops matching instead of misfiring.
async function dateFieldValidationError(req, body) {
  if (body.trigger !== 'custom_date_offset') return null;
  const { entity, field_name } = body.conditions || {};
  const r = await pool.query(
    `SELECT type FROM org_field_definitions WHERE org_id = $1 AND entity = $2 AND name = $3`,
    [req.orgId, entity, field_name]
  );
  if (r.rows.length === 0) {
    return `No custom field named "${field_name}" exists on ${entity} — create it under Settings → Custom fields first`;
  }
  if (r.rows[0].type !== 'date') {
    return `Custom field "${field_name}" on ${entity} is type "${r.rows[0].type}" — custom_date_offset rules need a date field`;
  }
  return null;
}

// Serialize a stored row for the client (conditions/action are already JSONB
// objects from pg).
function shapeRule(row) {
  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    trigger: row.trigger,
    conditions: row.conditions || {},
    action: row.action || {},
    enabled: row.enabled,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

// List this org's rules.
router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `SELECT id, org_id, name, trigger, conditions, action, enabled, created_by, created_at
       FROM automation_rules WHERE ${sf} = $1 ORDER BY created_at DESC, id DESC`,
      [sv]
    );
    res.json({ success: true, rules: r.rows.map(shapeRule), triggers: ruleSchemas.TRIGGERS, actions: ruleSchemas.ACTIONS });
  } catch (err) {
    if (req.log) req.log.error('automation_rules_list_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to list automation rules' });
  }
});

// Create a rule.
router.post('/', validateBody(ruleSchemas.createSchema), async (req, res) => {
  try {
    const { name, trigger, conditions, action, enabled } = req.body;
    const fieldErr = await dateFieldValidationError(req, req.body);
    if (fieldErr) return res.status(400).json({ success: false, error: fieldErr });
    const r = await pool.query(
      `INSERT INTO automation_rules (org_id, name, trigger, conditions, action, enabled, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
       RETURNING id, org_id, name, trigger, conditions, action, enabled, created_by, created_at`,
      [req.orgId, name, trigger, JSON.stringify(conditions || {}), JSON.stringify(action), enabled !== false, req.userId]
    );
    res.status(201).json({ success: true, rule: shapeRule(r.rows[0]) });
  } catch (err) {
    if (req.log) req.log.error('automation_rule_create_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to create automation rule' });
  }
});

// Full-replace update.
router.put('/:id', validateBody(ruleSchemas.updateSchema), async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { name, trigger, conditions, action, enabled } = req.body;
    const fieldErr = await dateFieldValidationError(req, req.body);
    if (fieldErr) return res.status(400).json({ success: false, error: fieldErr });
    const r = await pool.query(
      `UPDATE automation_rules
          SET name = $1, trigger = $2, conditions = $3::jsonb, action = $4::jsonb, enabled = $5
        WHERE id = $6 AND ${sf} = $7
        RETURNING id, org_id, name, trigger, conditions, action, enabled, created_by, created_at`,
      [name, trigger, JSON.stringify(conditions || {}), JSON.stringify(action), enabled !== false, req.params.id, sv]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Rule not found' });
    res.json({ success: true, rule: shapeRule(r.rows[0]) });
  } catch (err) {
    if (req.log) req.log.error('automation_rule_update_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to update automation rule' });
  }
});

// Toggle enabled (for the UI switch).
router.patch('/:id/enabled', validateBody(ruleSchemas.toggleSchema), async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `UPDATE automation_rules SET enabled = $1 WHERE id = $2 AND ${sf} = $3
        RETURNING id, org_id, name, trigger, conditions, action, enabled, created_by, created_at`,
      [req.body.enabled, req.params.id, sv]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Rule not found' });
    res.json({ success: true, rule: shapeRule(r.rows[0]) });
  } catch (err) {
    if (req.log) req.log.error('automation_rule_toggle_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to toggle automation rule' });
  }
});

// Delete.
router.delete('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `DELETE FROM automation_rules WHERE id = $1 AND ${sf} = $2 RETURNING id`,
      [req.params.id, sv]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Rule not found' });
    res.json({ success: true, deleted: r.rows[0].id });
  } catch (err) {
    if (req.log) req.log.error('automation_rule_delete_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to delete automation rule' });
  }
});

// Run-now: evaluate exactly this one rule immediately. Loads the rule org-scoped
// so a caller can only run their own org's rules, then defers to the engine's
// evaluator (which enforces org-scoping again in every scan).
router.post('/:id/run', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `SELECT id, org_id, name, trigger, conditions, action, enabled, created_by
       FROM automation_rules WHERE id = $1 AND ${sf} = $2`,
      [req.params.id, sv]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Rule not found' });
    const result = await automation.evaluateUserRule(r.rows[0]);
    res.json({ success: true, result });
  } catch (err) {
    if (req.log) req.log.error('automation_rule_run_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to run automation rule' });
  }
});

module.exports = router;
