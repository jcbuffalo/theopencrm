// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Per-org custom-field definitions — the extension store for the
// "Claude-authored org customizations" differentiation bet.
//
// HARD INVARIANT (read this before touching anything in here):
//   * These routes NEVER run DDL. They mutate rows in `org_field_definitions`
//     and `*.custom_fields` JSONB only.
//   * Field names must not collide with any column already on the entity's
//     shared schema — RESERVED_COLUMNS[entity] enforces that.
//   * Every write is scoped via qs(req) so an org can't redefine another's
//     fields.
//
// Endpoints (all auth-required, mounted at /api/custom-fields):
//   GET    /?entity=companies       — list this org's defs for one entity
//   GET    /                        — list ALL defs for this org (admin UI)
//   POST   /                        — create a def (owner/admin only)
//   PUT    /:id                     — edit label/options/required/position (owner/admin)
//   DELETE /:id                     — remove a def (owner/admin)
//
// The validators are exported so the AI proposal pipeline (aiRoutes.js
// /propose-customization + /apply-customization) can reuse the exact same
// rules server-side before applying. Drift between AI-proposed schemas and
// hand-edited schemas would be a bug.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const { validateBody } = require('../middleware/validate');
const customFieldSchemas = require('../schemas/customFields');

const router = express.Router();
router.use(authMiddleware);

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// ---------------------------------------------------------------------------
// Reserved columns per entity — names a custom field is FORBIDDEN to use.
// Mirrors the shared-schema column list in the migrations (020/021/023/025
// plus all the additive migrations through 068). Add to this if you ever ALTER
// TABLE one of these entities; otherwise the validator will let a custom field
// shadow a real column and the CRUD writes will silently disagree.
// ---------------------------------------------------------------------------
const RESERVED_COLUMNS = {
  companies: new Set([
    'id', 'user_id', 'org_id', 'name', 'type', 'industry', 'website', 'phone',
    'location', 'employee_count', 'annual_revenue', 'notes', 'status',
    'owner_id', 'first_deal_at', 'last_deal_at', 'external_ref', 'public_id',
    'custom_fields', 'created_at', 'updated_at',
  ]),
  contacts: new Set([
    'id', 'user_id', 'org_id', 'first_name', 'last_name', 'email', 'phone',
    'company_id', 'job_title', 'status', 'tags', 'notes', 'owner_id',
    'external_ref', 'public_id', 'custom_fields', 'created_at', 'updated_at',
  ]),
  deals: new Set([
    'id', 'user_id', 'org_id', 'contact_id', 'company_id', 'customer_id',
    'vendor_id', 'salesman_id', 'vertical', 'title', 'description', 'amount',
    'stage', 'phase', 'expected_close_date', 'closed_date', 'closed_amount',
    'ai_health_score', 'ai_win_probability', 'ai_risk_factors', 'notes', 'tags',
    'hot_flag', 'lost_reason', 'po_number', 'ship_to', 'poc_name', 'poc_email',
    'poc_phone', 'target_ship_date', 'actual_ship_date', 'release_status',
    'hold_reason', 'kanban_position', 'last_activity_at', 'created_by',
    'updated_by', 'entity_version', 'external_ref', 'public_id', 'custom_fields',
    'created_at', 'updated_at', 'probability',
  ]),
  tasks: new Set([
    'id', 'user_id', 'org_id', 'contact_id', 'deal_id', 'title', 'description',
    'due_date', 'status', 'priority', 'assigned_to', 'external_ref',
    'public_id', 'custom_fields', 'created_at', 'updated_at',
  ]),
};

const VALID_ENTITIES = Object.keys(RESERVED_COLUMNS);
const VALID_TYPES    = ['text', 'number', 'date', 'select', 'multiselect', 'boolean'];
const NAME_RE        = /^[a-z][a-z0-9_]{1,59}$/;

// ---------------------------------------------------------------------------
// Static validation of one proposed field definition. Returns null on OK,
// or a string error message. Used by:
//   (a) POST / route — direct admin authoring
//   (b) /api/ai/apply-customization — when applying a Claude proposal
//
// Does NOT hit the DB. Caller is responsible for the "name already exists for
// this org" check (validateAgainstOrg below).
// ---------------------------------------------------------------------------
function validateFieldDefShape({ entity, name, type, options, label, required, position }) {
  if (!VALID_ENTITIES.includes(entity))            return `Invalid entity: ${entity}`;
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return 'name must match /^[a-z][a-z0-9_]{1,59}$/ (lowercase, snake_case, max 60 chars)';
  }
  if (RESERVED_COLUMNS[entity].has(name)) {
    return `Cannot use "${name}" — that column already exists on the ${entity} shared schema.`;
  }
  if (!VALID_TYPES.includes(type))                 return `Invalid type: ${type}. Must be one of ${VALID_TYPES.join(', ')}`;
  if ((type === 'select' || type === 'multiselect')) {
    if (!Array.isArray(options) || options.length === 0) {
      return `${type} fields must declare a non-empty options array`;
    }
    if (!options.every(o => typeof o === 'string' && o.length > 0 && o.length <= 80)) {
      return 'Each option must be a non-empty string ≤ 80 chars';
    }
    if (new Set(options).size !== options.length) {
      return 'Options must be unique';
    }
  }
  if (label != null && (typeof label !== 'string' || label.length > 120)) {
    return 'label must be a string ≤ 120 chars';
  }
  if (required != null && typeof required !== 'boolean') return 'required must be boolean';
  if (position != null && (!Number.isInteger(position) || position < 0 || position > 999)) {
    return 'position must be an integer 0..999';
  }
  return null;
}

// Pull the org's existing definitions for one entity. Used both by the
// validator (to reject name clashes) and by the CRUD endpoints (to know what
// keys are allowed on the custom_fields JSONB blob).
async function loadOrgDefs(orgId, entity) {
  if (!orgId) return [];
  const r = await pool.query(
    `SELECT id, entity, name, label, type, options, required, position
       FROM org_field_definitions
      WHERE org_id = $1 AND entity = $2
      ORDER BY position ASC, name ASC`,
    [orgId, entity]
  );
  return r.rows;
}

// Validates a single custom_fields PAYLOAD (the object an admin attempts to
// write on a company / contact / deal / task). Returns null on OK or a string
// error. Unknown keys → reject. Mistyped values → reject. Missing required →
// reject only on CREATE (PUT/PATCH callers can pass partial objects).
//
// Type coercion is intentionally loose for number/date — UIs send strings.
async function validateCustomFieldsPayload({ orgId, entity, payload, isCreate = false }) {
  if (payload == null) return null;
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return 'custom_fields must be an object';
  }
  const defs = await loadOrgDefs(orgId, entity);
  const byName = new Map(defs.map(d => [d.name, d]));

  for (const key of Object.keys(payload)) {
    const def = byName.get(key);
    if (!def) return `Unknown custom field "${key}" for ${entity}`;
    const val = payload[key];
    if (val === null || val === undefined || val === '') continue;
    switch (def.type) {
      case 'text':
        if (typeof val !== 'string') return `${key} must be a string`;
        if (val.length > 2000) return `${key} too long (max 2000 chars)`;
        break;
      case 'number':
        if (typeof val === 'number') break;
        if (typeof val === 'string' && val.match(/^-?\d+(\.\d+)?$/)) break;
        return `${key} must be a number`;
      case 'date':
        // ISO-8601 date or datetime. Loose check; the DB layer will fail
        // again if it's truly malformed.
        if (typeof val !== 'string' || isNaN(Date.parse(val))) return `${key} must be an ISO date`;
        break;
      case 'boolean':
        if (typeof val !== 'boolean') return `${key} must be true or false`;
        break;
      case 'select':
        if (typeof val !== 'string') return `${key} must be a string`;
        if (!def.options.includes(val)) return `${key} must be one of: ${def.options.join(', ')}`;
        break;
      case 'multiselect':
        if (!Array.isArray(val)) return `${key} must be an array`;
        for (const v of val) {
          if (!def.options.includes(v)) return `${key} contains invalid option "${v}"`;
        }
        break;
      default:
        return `${key} has unknown type ${def.type}`;
    }
  }

  if (isCreate) {
    for (const def of defs) {
      if (def.required) {
        const v = payload[def.name];
        if (v === undefined || v === null || v === '') {
          return `Missing required custom field "${def.name}"`;
        }
      }
    }
  }
  return null;
}

// Guard: only org owners/admins can mutate the schema. Members can still
// READ the defs (they need them to render forms) but not edit them.
function requireOrgAdmin(req, res, next) {
  if (!req.orgId) return res.status(400).json({ error: 'Org context required' });
  if (req.orgRole !== 'owner' && req.orgRole !== 'admin') {
    return res.status(403).json({ error: 'Only org owners/admins can manage custom fields' });
  }
  next();
}

// ---------------------------------------------------------------------------
// GET / — list custom-field definitions
//   ?entity=companies → filter to one entity
//   (no query)        → return all four entities at once (admin page uses this)
// Everyone in the org can read.
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    if (!req.orgId) return res.json([]);
    const { entity } = req.query;
    if (entity) {
      if (!VALID_ENTITIES.includes(entity)) {
        return res.status(400).json({ error: `Invalid entity: ${entity}` });
      }
      const rows = await loadOrgDefs(req.orgId, entity);
      return res.json(rows);
    }
    const r = await pool.query(
      `SELECT id, entity, name, label, type, options, required, position
         FROM org_field_definitions
        WHERE org_id = $1
        ORDER BY entity ASC, position ASC, name ASC`,
      [req.orgId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('list custom fields error:', err);
    res.status(500).json({ error: 'Failed to list custom fields' });
  }
});

// ---------------------------------------------------------------------------
// POST / — create a new field definition. Owner/admin only.
// Body: { entity, name, label?, type, options?, required?, position? }
// ---------------------------------------------------------------------------
router.post('/', requireOrgAdmin, validateBody(customFieldSchemas.createSchema), async (req, res) => {
  try {
    const { entity, name, label, type, options, required, position } = req.body;
    // zod has enforced surface-level shape (entity/type enums, name regex,
    // length caps). validateFieldDefShape still runs as the source-of-truth
    // because it also checks RESERVED_COLUMNS and the options-uniqueness rule
    // — those depend on context that zod can't express in a pure schema.
    const shapeErr = validateFieldDefShape({ entity, name, type, options, label, required, position });
    if (shapeErr) return res.status(400).json({ error: shapeErr });

    const existing = await pool.query(
      `SELECT id FROM org_field_definitions WHERE org_id = $1 AND entity = $2 AND name = $3`,
      [req.orgId, entity, name]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: `Field "${name}" already exists on ${entity} for this org` });
    }

    const r = await pool.query(
      `INSERT INTO org_field_definitions
         (org_id, entity, name, label, type, options, required, position, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       RETURNING *`,
      [
        req.orgId, entity, name, label || name, type,
        JSON.stringify(options || []),
        !!required,
        Number.isInteger(position) ? position : 0,
        req.userId,
      ]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('create custom field error:', err);
    res.status(500).json({ error: 'Failed to create custom field' });
  }
});

// ---------------------------------------------------------------------------
// PUT /:id — modify label / options / required / position of an existing def.
// Cannot rename or change type — those are destructive ops that would orphan
// existing JSONB data. To change a name or type, delete and re-create.
// ---------------------------------------------------------------------------
router.put('/:id', requireOrgAdmin, validateBody(customFieldSchemas.updateSchema), async (req, res) => {
  try {
    const { label, options, required, position } = req.body;
    // zod has gated surface shape; validateFieldDefShape below still runs the
    // merged-state validation (options-uniqueness against the existing def).

    const cur = await pool.query(
      `SELECT * FROM org_field_definitions WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Custom field not found' });
    const def = cur.rows[0];

    // Re-validate the merged shape so options changes still type-check.
    const shapeErr = validateFieldDefShape({
      entity:  def.entity,
      name:    def.name,
      type:    def.type,
      options: options ?? def.options,
      label:   label ?? def.label,
      required: required ?? def.required,
      position: position ?? def.position,
    });
    if (shapeErr) return res.status(400).json({ error: shapeErr });

    const r = await pool.query(
      `UPDATE org_field_definitions
          SET label    = COALESCE($1, label),
              options  = COALESCE($2::jsonb, options),
              required = COALESCE($3, required),
              position = COALESCE($4, position),
              updated_at = NOW()
        WHERE id = $5 AND org_id = $6
        RETURNING *`,
      [
        label ?? null,
        options !== undefined ? JSON.stringify(options) : null,
        required ?? null,
        position ?? null,
        req.params.id, req.orgId,
      ]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('update custom field error:', err);
    res.status(500).json({ error: 'Failed to update custom field' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /:id — drop the definition. NOTE: this does NOT scrub the JSONB
// values from existing rows. They become orphaned keys that the UI will
// simply stop rendering. We keep them so an accidental delete + re-create
// of the same name doesn't lose data. To purge, call /scrub (TODO future).
// ---------------------------------------------------------------------------
router.delete('/:id', requireOrgAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM org_field_definitions WHERE id = $1 AND org_id = $2 RETURNING *`,
      [req.params.id, req.orgId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Custom field not found' });
    res.json({ message: 'Custom field deleted', field: r.rows[0] });
  } catch (err) {
    console.error('delete custom field error:', err);
    res.status(500).json({ error: 'Failed to delete custom field' });
  }
});

module.exports = router;
module.exports.RESERVED_COLUMNS         = RESERVED_COLUMNS;
module.exports.VALID_ENTITIES           = VALID_ENTITIES;
module.exports.VALID_TYPES              = VALID_TYPES;
module.exports.validateFieldDefShape    = validateFieldDefShape;
module.exports.loadOrgDefs              = loadOrgDefs;
module.exports.validateCustomFieldsPayload = validateCustomFieldsPayload;
