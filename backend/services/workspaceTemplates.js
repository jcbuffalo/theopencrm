// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Saved, shareable workspace templates (spec 203, Phase 2; migration 171).
//
// A template's `config` is the SAME raw shape the first-run planner consumes
// ({ pipeline, fields, automations, views } — see onboardingPlanner.js
// buildSystemPrompt for the contract), so:
//   • saving  = snapshot the org's structure into that shape (no AI)
//   • cloning = planner.assemblePlan(config) → validated proposals (no AI),
//               applied by the client through POST /api/ai/actions/apply
// Cloning therefore costs nothing, works for an org with AI switched off, and
// inherits every confirm-first guarantee the builder already has.
//
// Structural only, by construction: snapshotOrg reads definitions, never
// records; sanitizeConfig whitelists keys so a hand-posted config cannot
// smuggle ids, org references, or anything the planner would not accept.

const pool = require('../db');
const pipelines = require('./pipelines');
const chatActions = require('./chatActions');
const dealStages = require('../utils/dealStages');
const planner = require('./onboardingPlanner');
const staticTemplates = require('./onboardingTemplates');

const SLUG_RE = /^[a-z][a-z0-9_-]{1,59}$/;
const CAPS = { stages: 60, fields: 40, automations: 20, views: 10, options: 50 };
const STAGE_KEYS = ['id', 'label', 'desc', 'tone', 'phase', 'is_won', 'is_lost', 'probability'];
const FIELD_KEYS = ['entity', 'name', 'label', 'type', 'options', 'required', 'why'];
const AUTOMATION_KEYS = ['name', 'trigger', 'stage', 'days', 'action', 'title', 'priority', 'why'];
const VIEW_KEYS = ['entity', 'name', 'filters', 'why'];

function slugify(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'template';
}

function pick(obj, keys) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// Whitelist the shape. Everything else the client sent is dropped on the floor.
function sanitizeConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = { pipeline: null, fields: [], automations: [], views: [] };
  if (r.pipeline && typeof r.pipeline === 'object' && Array.isArray(r.pipeline.stages)) {
    out.pipeline = {
      name: typeof r.pipeline.name === 'string' ? r.pipeline.name.trim().slice(0, 40) : '',
      stages: r.pipeline.stages.slice(0, CAPS.stages).map((st) => pick(st, STAGE_KEYS)),
    };
  }
  if (Array.isArray(r.fields)) {
    out.fields = r.fields.slice(0, CAPS.fields).map((f) => {
      const p = pick(f, FIELD_KEYS);
      if (Array.isArray(p.options)) p.options = p.options.filter((o) => typeof o === 'string').slice(0, CAPS.options);
      else delete p.options;
      return p;
    });
  }
  if (Array.isArray(r.automations)) out.automations = r.automations.slice(0, CAPS.automations).map((a) => pick(a, AUTOMATION_KEYS));
  if (Array.isArray(r.views)) {
    out.views = r.views.slice(0, CAPS.views).map((v) => {
      const p = pick(v, VIEW_KEYS);
      p.filters = p.filters && typeof p.filters === 'object' && !Array.isArray(p.filters) ? p.filters : {};
      return p;
    });
  }
  return out;
}

// Pure structural validation for SAVE (no org context — a template must be
// valid on its own). Returns { ok, errors, config } with normalized stages.
function validateConfig(rawConfig) {
  const config = sanitizeConfig(rawConfig);
  const errors = [];
  let stages = null;
  if (config.pipeline) {
    const v = pipelines.validateStages(planner.normalizeStages(config.pipeline.stages), 'generic');
    if (!v.ok) errors.push(...v.errors.map((e) => `pipeline: ${e}`));
    else { stages = v.stages; config.pipeline.stages = v.stages; }
  }
  config.fields.forEach((f, i) => {
    const fields = { entity: f.entity, name: f.name, type: f.type || 'text' };
    if (f.label) fields.label = f.label;
    if (f.options) fields.options = f.options;
    if (typeof f.required === 'boolean') fields.required = f.required;
    const v = chatActions.validateAction({ entity: 'custom_field', op: 'create', fields });
    if (!v.ok) errors.push(`fields[${i}] (${f.name || '?'}): ${v.errors.join('; ')}`);
  });
  const pipelineForResolve = stages ? { stages, is_custom: true } : null;
  config.automations.forEach((a, i) => {
    if (a.trigger === 'deal_stage_is' && pipelineForResolve && !dealStages.resolveStageId(a.stage, pipelineForResolve)) {
      errors.push(`automations[${i}] (${a.name || '?'}): stage "${a.stage}" is not on the template pipeline`);
    }
    if (!['deal_stage_is', 'deal_idle_days'].includes(a.trigger)) errors.push(`automations[${i}]: unsupported trigger "${a.trigger}"`);
    if (!['create_task', 'notify', 'set_hot_flag'].includes(a.action)) errors.push(`automations[${i}]: unsupported action "${a.action}"`);
  });
  config.views.forEach((v, i) => {
    if (v.entity && !/^deals?$/.test(String(v.entity))) errors.push(`views[${i}]: only deals views are supported`);
    if (!v.name || typeof v.name !== 'string') errors.push(`views[${i}]: name is required`);
  });
  const empty = !config.pipeline && !config.fields.length && !config.automations.length && !config.views.length;
  if (empty) errors.push('a template needs at least a pipeline, a field, an automation, or a view');
  return { ok: errors.length === 0, errors, config };
}

// The org's current structure → template config (raw planner shape). Reads
// DEFINITIONS only. Shared deal views only; automations only in the planner's
// vocabulary (date-offset rules reference org-specific fields and are left out).
async function snapshotOrg(orgId) {
  const pipeline = await pipelines.getEffectivePipeline(orgId);
  const stages = pipeline.stages.map((st) => pick(st, STAGE_KEYS));
  const [fieldsRes, rulesRes, viewsRes] = await Promise.all([
    pool.query(
      `SELECT entity, name, label, type, options, required FROM org_field_definitions
        WHERE org_id = $1 AND entity IN ('deals', 'companies', 'contacts')
        ORDER BY entity, position ASC, name ASC`,
      [orgId]
    ),
    pool.query(
      `SELECT name, trigger, conditions, action FROM automation_rules
        WHERE org_id = $1 AND enabled = TRUE AND trigger IN ('deal_stage_is', 'deal_idle_days')
        ORDER BY id ASC`,
      [orgId]
    ),
    pool.query(
      `SELECT name, filter_spec FROM saved_views
        WHERE org_id = $1 AND is_shared = TRUE AND resource = 'deals'
        ORDER BY id ASC`,
      [orgId]
    ),
  ]);
  const fields = fieldsRes.rows.map((r) => {
    const f = { entity: r.entity, name: r.name, type: r.type };
    if (r.label && r.label !== r.name) f.label = r.label;
    if (Array.isArray(r.options) && r.options.length) f.options = r.options;
    if (r.required) f.required = true;
    return f;
  });
  const automations = rulesRes.rows.map((r) => {
    const c = r.conditions || {};
    const act = r.action || {};
    const a = { name: r.name, trigger: r.trigger, action: act.type };
    if (r.trigger === 'deal_stage_is') a.stage = c.stage;
    if (r.trigger === 'deal_idle_days') a.days = Number(c.days);
    if (act.title) a.title = act.title;
    if (act.priority) a.priority = act.priority;
    return a;
  });
  const views = viewsRes.rows.map((r) => ({ entity: 'deals', name: r.name, filters: r.filter_spec || {} }));
  return { pipeline: { name: pipeline.name, stages }, fields, automations, views };
}

// Compact, config-free summary for cards and the public gallery.
function summarize(row) {
  const c = row.config || {};
  return {
    id: row.id,
    org_id: row.org_id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    vertical: row.vertical,
    description: row.description,
    is_public: row.is_public,
    is_platform: row.org_id === null,
    use_count: row.use_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
    stages: c.pipeline && Array.isArray(c.pipeline.stages) ? c.pipeline.stages.map((st) => st.label) : [],
    pipeline_name: c.pipeline ? c.pipeline.name : null,
    field_labels: Array.isArray(c.fields) ? c.fields.map((f) => f.label || f.name) : [],
    automation_count: Array.isArray(c.automations) ? c.automations.length : 0,
    view_count: Array.isArray(c.views) ? c.views.length : 0,
  };
}

const COLS = 'id, org_id, created_by, slug, name, tagline, vertical, description, config, is_public, use_count, created_at, updated_at';

// scope: 'mine' | 'public' | 'all' (default). Visibility = own org OR public.
async function listTemplates({ orgId, scope = 'all' }) {
  let where;
  const params = [];
  if (scope === 'mine') { where = 'org_id = $1'; params.push(orgId); }
  else if (scope === 'public') { where = 'is_public = TRUE'; }
  else { where = '(org_id = $1 OR is_public = TRUE)'; params.push(orgId); }
  const r = await pool.query(`SELECT ${COLS} FROM workspace_templates WHERE ${where} ORDER BY (org_id IS NULL) DESC, use_count DESC, name ASC`, params);
  return r.rows.map(summarize);
}

async function listPublicTemplates() {
  const r = await pool.query(`SELECT ${COLS} FROM workspace_templates WHERE is_public = TRUE ORDER BY (org_id IS NULL) DESC, use_count DESC, name ASC`);
  return r.rows.map(summarize);
}

// Own-org or public. Returns the full row (with config) or null.
async function getTemplate(id, orgId) {
  const r = await pool.query(
    `SELECT ${COLS} FROM workspace_templates WHERE id = $1 AND (org_id = $2 OR is_public = TRUE)`,
    [id, orgId]
  );
  return r.rows[0] || null;
}

async function uniqueSlug(orgId, base) {
  let slug = slugify(base);
  for (let i = 2; i < 50; i++) {
    const r = await pool.query(
      `SELECT 1 FROM workspace_templates WHERE COALESCE(org_id, 0) = COALESCE($1::int, 0) AND slug = $2`,
      [orgId, slug]
    );
    if (r.rows.length === 0) return slug;
    slug = `${slugify(base).slice(0, 55)}_${i}`;
  }
  return `${slugify(base).slice(0, 40)}_${Date.now().toString(36)}`;
}

function fail(status, error, code) {
  return Object.assign(new Error(error), { status, body: { error, code } });
}

// { name, tagline?, vertical?, description?, is_public?, config } — config is
// validated structurally. Throws fail(400) on invalid input.
async function createTemplate({ orgId, userId, name, tagline, vertical, description, is_public, config }) {
  const n = typeof name === 'string' ? name.trim().slice(0, 120) : '';
  if (!n) throw fail(400, 'name is required', 'INVALID_TEMPLATE');
  const v = validateConfig(config);
  if (!v.ok) throw Object.assign(fail(400, 'Template configuration is invalid', 'INVALID_TEMPLATE'), { body: { error: 'Template configuration is invalid', code: 'INVALID_TEMPLATE', validation_errors: v.errors } });
  const slug = await uniqueSlug(orgId, n);
  const r = await pool.query(
    `INSERT INTO workspace_templates (org_id, created_by, slug, name, tagline, vertical, description, config, is_public)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) RETURNING ${COLS}`,
    [orgId, userId, slug, n,
      typeof tagline === 'string' ? tagline.trim().slice(0, 200) || null : null,
      typeof vertical === 'string' ? vertical.trim().slice(0, 60) || null : null,
      typeof description === 'string' ? description.trim().slice(0, 4000) || null : null,
      JSON.stringify(v.config), is_public === true]
  );
  return r.rows[0];
}

// Own templates only. Patch any of name/tagline/vertical/description/is_public/config.
async function updateTemplate(id, orgId, patch) {
  const sets = [];
  const params = [];
  const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (patch.name !== undefined) {
    const n = typeof patch.name === 'string' ? patch.name.trim().slice(0, 120) : '';
    if (!n) throw fail(400, 'name cannot be empty', 'INVALID_TEMPLATE');
    add('name', n);
  }
  if (patch.tagline !== undefined) add('tagline', typeof patch.tagline === 'string' ? patch.tagline.trim().slice(0, 200) || null : null);
  if (patch.vertical !== undefined) add('vertical', typeof patch.vertical === 'string' ? patch.vertical.trim().slice(0, 60) || null : null);
  if (patch.description !== undefined) add('description', typeof patch.description === 'string' ? patch.description.trim().slice(0, 4000) || null : null);
  if (patch.is_public !== undefined) add('is_public', patch.is_public === true);
  if (patch.config !== undefined) {
    const v = validateConfig(patch.config);
    if (!v.ok) throw Object.assign(fail(400, 'Template configuration is invalid', 'INVALID_TEMPLATE'), { body: { error: 'Template configuration is invalid', code: 'INVALID_TEMPLATE', validation_errors: v.errors } });
    add('config', JSON.stringify(v.config));
    sets[sets.length - 1] = `config = $${params.length}::jsonb`;
  }
  if (!sets.length) throw fail(400, 'nothing to update', 'INVALID_TEMPLATE');
  params.push(id, orgId);
  const r = await pool.query(
    `UPDATE workspace_templates SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length - 1} AND org_id = $${params.length} RETURNING ${COLS}`,
    params
  );
  return r.rows[0] || null;
}

async function deleteTemplate(id, orgId) {
  const r = await pool.query(`DELETE FROM workspace_templates WHERE id = $1 AND org_id = $2 RETURNING id`, [id, orgId]);
  return r.rows.length > 0;
}

// Template → proposals for THIS org. Deterministic, no AI. The narrative
// names the template; every piece goes through the planner's validators
// against the caller's current workspace (dupes skipped, stages resolved).
async function planFromTemplate(template, { orgId }) {
  const ctx = await planner.loadContext(orgId);
  const raw = {
    ...sanitizeConfig(template.config),
    narrative: `Start from "${template.name}"${template.tagline ? ` — ${template.tagline}` : ''}. Untick anything you don't want; nothing changes until you build it.`,
  };
  const plan = await planner.assemblePlan({ orgId, raw, ctx });
  pool.query(`UPDATE workspace_templates SET use_count = use_count + 1 WHERE id = $1`, [template.id]).catch(() => {});
  return plan;
}

// Super-admin: turn the 12 static "describe" templates into platform-authored
// public config templates (org_id NULL) by running the planner's draft step
// once per template. Idempotent on slug (= static id): re-running refreshes
// the config. Returns { generated: [...], failed: [{ id, error }] }.
async function generatePlatformTemplates({ orgId, userId, only = null }) {
  const ctx = await planner.loadContext(orgId);
  const generated = [];
  const failed = [];
  for (const t of staticTemplates.TEMPLATES) {
    if (only && !only.includes(t.id)) continue;
    const drafted = await planner.draftRaw({ orgId, userId, description: t.description, ctx });
    if (!drafted.ok) { failed.push({ id: t.id, error: drafted.error }); continue; }
    const v = validateConfig(drafted.raw);
    if (!v.ok) { failed.push({ id: t.id, error: v.errors.join('; ') }); continue; }
    const r = await pool.query(
      `INSERT INTO workspace_templates (org_id, created_by, slug, name, tagline, vertical, description, config, is_public)
       VALUES (NULL, $1, $2, $3, $4, $5, $6, $7::jsonb, TRUE)
       ON CONFLICT ((COALESCE(org_id, 0)), slug) DO UPDATE
         SET name = EXCLUDED.name, tagline = EXCLUDED.tagline, vertical = EXCLUDED.vertical,
             description = EXCLUDED.description, config = EXCLUDED.config, is_public = TRUE, updated_at = NOW()
       RETURNING ${COLS}`,
      [userId, t.id, t.name, t.tagline, t.id, t.description, JSON.stringify(v.config)]
    );
    generated.push(summarize(r.rows[0]));
  }
  return { generated, failed };
}

// Boot-time seed of the starter gallery from backend/data/
// platformWorkspaceTemplates.json — reviewed, hand-curated configs checked
// into the repo, so the gallery exists on every deployment without an AI call
// or a super-admin click. Idempotent upsert by slug (org_id NULL); the file
// is the source of truth, so a super-admin "regenerate" via the API is
// overwritten on the next boot by design. Never throws — a bad file logs and
// the app still starts.
const PLATFORM_FILE = require('path').join(__dirname, '..', 'data', 'platformWorkspaceTemplates.json');

function loadPlatformFile(file = PLATFORM_FILE) {
  const raw = JSON.parse(require('fs').readFileSync(file, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('platform templates file must be an array');
  return raw;
}

async function seedPlatformTemplates({ file = PLATFORM_FILE, log = console } = {}) {
  let entries;
  try { entries = loadPlatformFile(file); } catch (err) {
    log.error(`workspace-templates seed: cannot read ${file}: ${err.message}`);
    return { seeded: 0, failed: [] };
  }
  let seeded = 0;
  const failed = [];
  for (const t of entries) {
    const slug = typeof t.slug === 'string' && SLUG_RE.test(t.slug) ? t.slug : null;
    if (!slug) { failed.push({ slug: t.slug, error: 'invalid slug' }); continue; }
    const v = validateConfig(t.config);
    if (!v.ok) { failed.push({ slug, error: v.errors.join('; ') }); continue; }
    try {
      await pool.query(
        `INSERT INTO workspace_templates (org_id, created_by, slug, name, tagline, vertical, description, config, is_public)
         VALUES (NULL, NULL, $1, $2, $3, $4, $5, $6::jsonb, TRUE)
         ON CONFLICT ((COALESCE(org_id, 0)), slug) DO UPDATE
           SET name = EXCLUDED.name, tagline = EXCLUDED.tagline, vertical = EXCLUDED.vertical,
               description = EXCLUDED.description, config = EXCLUDED.config, is_public = TRUE,
               updated_at = CASE WHEN workspace_templates.config IS DISTINCT FROM EXCLUDED.config THEN NOW() ELSE workspace_templates.updated_at END`,
        [slug, String(t.name || slug).slice(0, 120), t.tagline ? String(t.tagline).slice(0, 200) : null,
          t.vertical ? String(t.vertical).slice(0, 60) : null, t.description ? String(t.description).slice(0, 4000) : null,
          JSON.stringify(v.config)]
      );
      seeded++;
    } catch (err) {
      failed.push({ slug, error: err.message });
    }
  }
  if (failed.length) log.warn(`workspace-templates seed: ${seeded} ok, ${failed.length} failed: ${failed.map((f) => `${f.slug} (${f.error})`).join('; ')}`);
  else log.log(`✅ Starter workspace templates seeded (${seeded})`);
  return { seeded, failed };
}

module.exports = {
  sanitizeConfig,
  validateConfig,
  loadPlatformFile,
  seedPlatformTemplates,
  PLATFORM_FILE,
  snapshotOrg,
  summarize,
  listTemplates,
  listPublicTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  planFromTemplate,
  generatePlatformTemplates,
  SLUG_RE,
};
