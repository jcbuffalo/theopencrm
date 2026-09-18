// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Per-org editable pipeline stages (wave 2, workstream G).
//
// THE MODEL
//   An org has exactly one EFFECTIVE pipeline PER DEAL TYPE (spec 201,
//   migration 156). Every deal carries a `deal_type` (default 'default');
//   resolution for a type falls through:
//     • the type's own `pipelines` row (deal_type = '<type>'), then
//     • the org's default `pipelines` row (is_default = TRUE, deal_type NULL,
//       migration 155) when it has edited its stages, then
//     • the PROFILE DEFAULT below — byte-for-byte the stage set
//       frontend/src/stages.js / zangStages.js renders today.
//   So nothing changes for an existing org until someone saves an edit, and
//   nothing changes for deal types until someone creates a second pipeline.
//   Deal-type slugs are lowercase (DEAL_TYPE_RE), max 40; 'default' is
//   reserved for the main pipeline.
//
//   A stage is { id, label, desc, tone, phase, is_won, is_lost, probability }.
//     id          stable slug, written to deals.stage (case-sensitive)
//     tone        a palette name the frontend maps to Tailwind classes
//     phase       'pre_sale' | 'post_sale' | 'post_ship' | null — only
//                 meaningful for zang; feeds deals.phase via phaseForStage
//     is_won / is_lost  terminal-outcome flags (reports, overdue filters)
//     probability optional 0..100
//
// SAFETY RULES enforced by savePipeline / resetPipeline:
//   • unique slugs, at least one won + one lost stage, labels <= 40 chars,
//     a stage cap (15, or the profile default + 5 for the big Zang set)
//   • deals are NEVER orphaned: any deal whose stage is not on the new
//     pipeline must be given a destination via `moveDealsTo` (a slug for all,
//     or a { fromSlug: toSlug } map) and is moved in the SAME transaction
//   • the effective pipeline is cached 30s per org; every write busts it
//
// Callers: routes/pipelineRoutes.js (GET/PUT/reset), routes/authRoutes.js
// (/auth/me → org_pipeline), utils/dealStages.js + routes/dealRoutes.js +
// routes/importRoutes.js (stage validation), routes/aiRoutes.js
// (propose_update_pipeline + its apply branch).

const pool = require('../db');
const { phaseForStage } = require('../utils/dealStages');

const CACHE_TTL_MS = 30 * 1000;
const MAX_STAGES = 15;
const MAX_LABEL = 40;
const MAX_DESC = 120;
const SLUG_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
// Deal-type slugs (spec 201): SLUG_RE, but lowercase-only. 'default' is the
// reserved name of the main pipeline (deals default to it; its pipeline row
// is the migration-155 is_default row, deal_type NULL).
const DEAL_TYPE_RE = /^[a-z][a-z0-9_]{0,39}$/;
const DEFAULT_DEAL_TYPE = 'default';
const VALID_PHASES = ['pre_sale', 'post_sale', 'post_ship'];
const PHASE_LABELS = { pre_sale: 'Pre-Sale', post_sale: 'Post-Sale', post_ship: 'Post-Shipment' };

// Palette names. The frontend (stages.js toneClasses) owns the Tailwind
// mapping; the backend only validates membership.
const TONES = ['slate', 'gray', 'stone', 'red', 'orange', 'amber', 'yellow', 'emerald', 'green', 'cyan', 'blue', 'indigo', 'violet', 'purple', 'rose'];

// ---------------------------------------------------------------------------
// Profile defaults — MUST mirror frontend/src/stages.js + zangStages.js
// (ids, labels, order, colors). The frontend keeps rendering its own copy
// for non-custom orgs; this copy is what validation and the editor's
// "start from default" read.
// ---------------------------------------------------------------------------
function s(id, label, desc, tone, extra = {}) {
  return { id, label, desc, tone, phase: null, is_won: false, is_lost: false, probability: null, ...extra };
}

const GENERIC_DEFAULT = [
  s('lead',        'Lead',        'New opportunity',        'slate'),
  s('qualified',   'Qualified',   'Worth pursuing',         'blue'),
  s('proposal',    'Proposal',    'Quote / proposal sent',  'cyan'),
  s('negotiation', 'Negotiation', 'Active back-and-forth',  'yellow'),
  s('closed_won',  'Closed Won',  'Won the deal',           'green',  { is_won: true }),
  s('closed_lost', 'Closed Lost', 'Did not win',            'red',    { is_lost: true }),
];

const JCP_DEFAULT = [
  s('LEAD',        'Lead',        'Heard about me / I heard about them', 'slate'),
  s('INTRO',       'Intro',       'First conversation',                  'indigo'),
  s('SCOPING',     'Scoping',     'Defining the project + fit',          'cyan'),
  s('PITCH',       'Pitch',       'Proposal / scope sent',               'amber'),
  s('ENGAGED',     'Engaged',     'Verbal yes, work starting',           'violet'),
  s('CLOSED_WON',  'Delivered',   'Project landed / live',               'emerald', { is_won: true }),
  s('CLOSED_LOST', 'Parked / No', 'Not now or not a fit',                'rose',    { is_lost: true }),
];

const P = { phase: 'pre_sale' }, Q = { phase: 'post_sale' }, R = { phase: 'post_ship' };
const ZANG_DEFAULT = [
  s('TRIAGE',           'Triage',           'Qualifying the opportunity',    'slate',  P),
  s('VENDOR_QUOTING',   'Vendor Quoting',   'Waiting for vendor quote',      'blue',   P),
  s('CUSTOMER_QUOTING', 'Customer Quoting', 'Building branded quote',        'cyan',   P),
  s('FOLLOW_UP',        'Follow Up',        'Awaiting customer PO',          'yellow', P),
  s('NO_FOLLOW_UP',     'No Follow-Up',     'Outside follow-up criteria',    'stone',  P),
  s('NO_QUOTE',         'No Quote',         'Outside Zang scope',            'stone',  P),
  s('COLD',             'Cold',             'Customer went dark',            'stone',  P),
  s('LOST',             'Lost',             'Awarded elsewhere',             'red',    { ...P, is_lost: true }),
  s('NOT_PROCESSED',    'Not Processed',    'PO received, not yet processed', 'orange', Q),
  s('PROCESSED',        'Processed',        'No vendor PO needed',           'orange', Q),
  s('ORDACK',           'Order Ack',        'Awaiting vendor acknowledgement', 'yellow', Q),
  s('VAP',              'Vendor Approval',  'Waiting on vendor drawings',    'yellow', Q),
  s('CAP',              'Customer Approval', 'Waiting on customer approval', 'yellow', Q),
  s('RELACK',           'Release Ack',      'Vendor to ack release',         'yellow', Q),
  s('MONITOR',          'Monitor',          'Watching order status',         'blue',   Q),
  s('COORDINATE',       'Coordinate',       'Ship within 30 days',           'blue',   Q),
  s('WHSE',             'Warehouse',        'In warehouse',                  'purple', Q),
  s('TBI',              'To Be Invoiced',   'Awaiting invoice trigger',      'emerald', Q),
  s('COMM_WATCH',       'Commission Watch', 'Awaiting commission',           'emerald', Q),
  s('INVOICED',         'Invoiced',         'Customer billed',               'green',  Q),
  s('CLOSED_PAID',      'Closed (Paid)',    'Customer has paid',             'green',  { ...Q, is_won: true }),
  s('CLOSED',           'Closed',           'No billable, completed',        'green',  { ...Q, is_won: true }),
  s('CANCELLED',        'Cancelled',        'Order was cancelled',           'red',    { ...Q, is_lost: true }),
  s('SERVICE',          'Service',          'Service contract',              'gray',   R),
  s('CLOSEOUTS',        'Closeouts',        'Vendor closeout docs',          'gray',   R),
  s('CUSTOMER_EXPERIENCE', 'Customer Experience', 'Surveys, gifts',          'gray',   R),
  s('WARRANTY',         'Warranty',         'Warranty transfers',            'gray',   R),
  s('MARKETING',        'Marketing',        'Mailing, photos',               'gray',   R),
  s('END_USER',         'End User',         'Spare parts, services',         'gray',   R),
];

const PROFILE_DEFAULTS = {
  generic: GENERIC_DEFAULT,
  rin:     GENERIC_DEFAULT,
  jcp:     JCP_DEFAULT,
  zang:    ZANG_DEFAULT,
};

const PROFILE_PIPELINE_NAMES = { generic: 'Pipeline', rin: 'Pipeline', jcp: 'Funnel', zang: 'Zang Flow' };

function clone(stages) { return stages.map((st) => ({ ...st })); }

function normalizeProfile(profile) {
  return PROFILE_DEFAULTS[profile] ? profile : 'generic';
}

function defaultStagesFor(profile) {
  return clone(PROFILE_DEFAULTS[normalizeProfile(profile)]);
}

function maxStagesFor(profile) {
  const def = PROFILE_DEFAULTS[normalizeProfile(profile)];
  return Math.max(MAX_STAGES, def.length + 5);
}

// Phases derived from the stage list: zang-style multi-phase when stages
// carry a phase, otherwise one phase named after the profile default.
function derivePhases(stages, profile) {
  const withPhase = stages.filter((st) => st.phase);
  if (withPhase.length === 0) {
    const id = normalizeProfile(profile) === 'jcp' ? 'funnel' : 'pipeline';
    return [{ id, label: id === 'funnel' ? 'Funnel' : 'Pipeline', stage_ids: stages.map((st) => st.id) }];
  }
  const order = [];
  const byPhase = {};
  for (const st of stages) {
    const ph = st.phase || 'pre_sale';
    if (!byPhase[ph]) { byPhase[ph] = []; order.push(ph); }
    byPhase[ph].push(st.id);
  }
  // Keep canonical phase order (pre → post → ship) regardless of list order.
  order.sort((a, b) => VALID_PHASES.indexOf(a) - VALID_PHASES.indexOf(b));
  return order.map((ph) => ({ id: ph, label: PHASE_LABELS[ph] || ph, stage_ids: byPhase[ph] }));
}

function shape({ profile, stages, row = null }) {
  const p = normalizeProfile(profile);
  return {
    profile: p,
    is_custom: !!row,
    id: row ? row.id : null,
    // Which pipeline this IS: 'default' for the org default / profile default
    // (including a typed lookup that fell back), the type slug otherwise.
    deal_type: (row && row.deal_type) || DEFAULT_DEAL_TYPE,
    name: (row && row.name) || PROFILE_PIPELINE_NAMES[p] || 'Pipeline',
    stages,
    phases: derivePhases(stages, p),
    default_stage: stages[0] ? stages[0].id : null,
    updated_at: row ? row.updated_at : null,
    updated_by: row ? row.updated_by : null,
  };
}

// ---------------------------------------------------------------------------
// Validation (pure) — returns { ok, errors, stages } with a normalized copy.
// ---------------------------------------------------------------------------
function slugify(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([^a-z])/, 's_$1')
    .slice(0, 40) || 'stage';
}

function validateStages(rawStages, profile) {
  const errors = [];
  if (!Array.isArray(rawStages)) return { ok: false, errors: ['stages must be an array'], stages: [] };
  if (rawStages.length === 0) errors.push('at least one stage is required');
  const cap = maxStagesFor(profile);
  if (rawStages.length > cap) errors.push(`at most ${cap} stages are allowed`);

  const seen = new Set();
  const stages = [];
  rawStages.forEach((raw, i) => {
    const at = `stages[${i}]`;
    if (!raw || typeof raw !== 'object') { errors.push(`${at} must be an object`); return; }
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    if (!label) errors.push(`${at}: label is required`);
    else if (label.length > MAX_LABEL) errors.push(`${at}: label must be ${MAX_LABEL} characters or fewer`);

    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : slugify(label);
    if (!SLUG_RE.test(id)) errors.push(`${at}: id "${id}" must start with a letter and contain only letters, digits, or _ (max 40)`);
    const key = id.toLowerCase();
    if (seen.has(key)) errors.push(`${at}: duplicate stage id "${id}"`);
    seen.add(key);

    const tone = raw.tone === undefined || raw.tone === null || raw.tone === '' ? 'gray' : raw.tone;
    if (!TONES.includes(tone)) errors.push(`${at}: tone must be one of ${TONES.join(', ')}`);

    const phase = raw.phase === undefined || raw.phase === '' ? null : raw.phase;
    if (phase !== null && !VALID_PHASES.includes(phase)) errors.push(`${at}: phase must be one of ${VALID_PHASES.join(', ')} or null`);

    const desc = raw.desc === undefined || raw.desc === null ? '' : String(raw.desc).trim();
    if (desc.length > MAX_DESC) errors.push(`${at}: desc must be ${MAX_DESC} characters or fewer`);

    const is_won = raw.is_won === true;
    const is_lost = raw.is_lost === true;
    if (is_won && is_lost) errors.push(`${at}: a stage cannot be both won and lost`);

    let probability = null;
    if (raw.probability !== undefined && raw.probability !== null && raw.probability !== '') {
      probability = Number(raw.probability);
      if (!Number.isInteger(probability) || probability < 0 || probability > 100) errors.push(`${at}: probability must be an integer 0..100`);
    }
    stages.push({ id, label, desc, tone, phase, is_won, is_lost, probability });
  });

  if (stages.length && !stages.some((st) => st.is_won)) errors.push('at least one stage must be marked as won');
  if (stages.length && !stages.some((st) => st.is_lost)) errors.push('at least one stage must be marked as lost');
  return { ok: errors.length === 0, errors, stages };
}

// ---------------------------------------------------------------------------
// Effective pipeline (cached 30s per org+dealType; a write busts the org)
// ---------------------------------------------------------------------------
const cache = new Map(); // `${orgId}:${dealType}` -> { value, expires }

function bustCache(orgId) {
  if (orgId === undefined) { cache.clear(); return; }
  const prefix = `${Number(orgId)}:`;
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}

// 'supply' → 'supply'; undefined/null/'' → 'default'; anything off-slug
// throws a 400 the routes/tools pass straight through.
function normalizeDealType(dealType) {
  if (dealType === undefined || dealType === null || dealType === '') return DEFAULT_DEAL_TYPE;
  const t = String(dealType).trim().toLowerCase();
  if (!DEAL_TYPE_RE.test(t)) {
    throw fail(400, { error: 'Invalid deal_type', validation_errors: [`deal_type "${dealType}" must start with a letter and contain only lowercase letters, digits, or _ (max 40)`] });
  }
  return t;
}

async function fetchProfile(orgId, db = pool) {
  const r = await db.query(`SELECT profile FROM organizations WHERE id = $1`, [orgId]);
  return (r && r.rows && r.rows[0] && r.rows[0].profile) || 'generic';
}

async function fetchDefaultRow(orgId, db = pool) {
  const r = await db.query(
    `SELECT id, name, stage_defs, profile, updated_at, updated_by
       FROM pipelines WHERE org_id = $1 AND is_default = TRUE LIMIT 1`,
    [orgId]
  );
  const row = r && r.rows && r.rows[0];
  if (!row || !Array.isArray(row.stage_defs) || row.stage_defs.length === 0) return null;
  return row;
}

async function fetchTypeRow(orgId, dealType, db = pool) {
  const r = await db.query(
    `SELECT id, name, stage_defs, profile, deal_type, updated_at, updated_by
       FROM pipelines WHERE org_id = $1 AND deal_type = $2 LIMIT 1`,
    [orgId, dealType]
  );
  const row = r && r.rows && r.rows[0];
  if (!row || !Array.isArray(row.stage_defs) || row.stage_defs.length === 0) return null;
  return row;
}

/**
 * The org's effective pipeline for a deal type. `profile` is optional — when
 * omitted it is read from organizations (one cached query). Org-less callers
 * (personal workspaces) always get the profile default. `dealType` defaults
 * to 'default'; a type without its own row falls back to the org default row,
 * then the profile default (spec 201).
 */
async function getEffectivePipeline(orgId, profile, { db = pool, skipCache = false, dealType } = {}) {
  const type = normalizeDealType(dealType);
  if (!orgId) return shape({ profile: profile || 'generic', stages: defaultStagesFor(profile || 'generic') });
  const key = `${Number(orgId)}:${type}`;
  const hit = cache.get(key);
  if (!skipCache && hit && hit.expires > Date.now()) return hit.value;

  const p = profile || await fetchProfile(orgId, db);
  const row = (type !== DEFAULT_DEAL_TYPE && await fetchTypeRow(orgId, type, db))
    || await fetchDefaultRow(orgId, db);
  const value = row
    ? shape({ profile: p, stages: validateStages(row.stage_defs, p).stages, row })
    : shape({ profile: p, stages: defaultStagesFor(p) });
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * Deal counts per stage for ONE deal type of the org — includes stages NOT on
 * the pipeline (strays). Scoped to the type since spec 201: a default-row
 * save/reset sweeps only deal_type='default' deals, never typed ones (before
 * migration 156 every deal is 'default', so behaviour is unchanged).
 */
async function dealCountsByStage(orgId, db = pool, dealType = DEFAULT_DEAL_TYPE) {
  const r = await db.query(
    `SELECT stage, COUNT(*)::int AS n FROM deals WHERE org_id = $1 AND deal_type = $2 GROUP BY stage`,
    [orgId, normalizeDealType(dealType)]
  );
  const out = {};
  for (const row of (r && r.rows) || []) out[row.stage] = row.n;
  return out;
}

/**
 * Every pipeline the org has, for switchers/selectors:
 * [{ deal_type, name, is_custom, stage_count }, ...] — the default pipeline
 * first (custom row or profile default), then type rows alphabetically.
 */
async function listPipelines(orgId, profile, db = pool) {
  const p = normalizeProfile(profile || (orgId ? await fetchProfile(orgId, db) : 'generic'));
  const defaults = { deal_type: DEFAULT_DEAL_TYPE, name: PROFILE_PIPELINE_NAMES[p] || 'Pipeline', is_custom: false, stage_count: PROFILE_DEFAULTS[p].length };
  if (!orgId) return [defaults];
  const r = await db.query(
    `SELECT deal_type, name, stage_defs, is_default FROM pipelines
      WHERE org_id = $1 AND (is_default = TRUE OR deal_type IS NOT NULL)`,
    [orgId]
  );
  const rows = (r && r.rows) || [];
  const defaultRow = rows.find((row) => row.is_default && !row.deal_type);
  const list = [defaultRow
    ? { deal_type: DEFAULT_DEAL_TYPE, name: defaultRow.name || defaults.name, is_custom: true, stage_count: Array.isArray(defaultRow.stage_defs) ? defaultRow.stage_defs.length : 0 }
    : defaults];
  for (const row of rows.filter((x) => x.deal_type).sort((a, b) => a.deal_type.localeCompare(b.deal_type))) {
    list.push({ deal_type: row.deal_type, name: row.name || row.deal_type, is_custom: true, stage_count: Array.isArray(row.stage_defs) ? row.stage_defs.length : 0 });
  }
  return list;
}

// Resolve where each stray stage's deals go. `moveDealsTo` is a slug (all
// strays → that stage) or a { fromSlug: toSlug } map. Returns { ok, errors,
// moves: [{ from, to, count }] , unresolved: [{ stage, count }] }.
function planMoves(counts, newStages, moveDealsTo) {
  const ids = new Set(newStages.map((st) => st.id));
  const strays = Object.entries(counts).filter(([stage, n]) => n > 0 && !ids.has(stage));
  const moves = [];
  const unresolved = [];
  const errors = [];
  for (const [stage, n] of strays) {
    let to = null;
    if (typeof moveDealsTo === 'string') to = moveDealsTo;
    else if (moveDealsTo && typeof moveDealsTo === 'object') to = moveDealsTo[stage] || moveDealsTo['*'] || null;
    if (!to) { unresolved.push({ stage, count: n }); continue; }
    if (!ids.has(to)) { errors.push(`moveDealsTo: "${to}" is not a stage on the new pipeline`); continue; }
    moves.push({ from: stage, to, count: n });
  }
  return { ok: errors.length === 0 && unresolved.length === 0, errors, moves, unresolved };
}

function fail(status, body) {
  return Object.assign(new Error(body.error || 'pipeline_error'), { status, body });
}

async function applyMoves(client, orgId, moves, newStages, dealType = DEFAULT_DEAL_TYPE) {
  const phaseOf = {};
  for (const st of newStages) phaseOf[st.id] = st.phase;
  for (const mv of moves) {
    const phase = phaseOf[mv.to] || phaseForStage(mv.to);
    await client.query(
      `UPDATE deals SET stage = $1, phase = $2, updated_at = CURRENT_TIMESTAMP
        WHERE org_id = $3 AND stage = $4 AND deal_type = $5`,
      [mv.to, phase, orgId, mv.from, dealType]
    );
  }
}

/**
 * Save a pipeline of the org. Validates, plans deal moves for any stage that
 * is disappearing, and writes everything in one transaction. `dealType`
 * (default 'default') picks WHICH pipeline: 'default' upserts the migration-
 * 155 is_default row and sweeps only deal_type='default' deals; any other
 * slug upserts (or CREATES — this is how a second pipeline is born) the
 * (org, deal_type) row and sweeps only that type's deals.
 * Throws { status, body } errors: 400 (validation), 409 (stages_have_deals).
 */
async function savePipeline(orgId, rawStages, userId, { moveDealsTo, name, dealType } = {}) {
  if (!orgId) throw fail(400, { error: 'Org context required' });
  const type = normalizeDealType(dealType);
  const profile = await fetchProfile(orgId);
  const v = validateStages(rawStages, profile);
  if (!v.ok) throw fail(400, { error: 'Invalid pipeline', validation_errors: v.errors });

  const counts = await dealCountsByStage(orgId, pool, type);
  const plan = planMoves(counts, v.stages, moveDealsTo);
  if (plan.errors.length) throw fail(400, { error: 'Invalid pipeline', validation_errors: plan.errors });
  if (plan.unresolved.length) {
    throw fail(409, {
      error: 'stages_have_deals',
      message: 'Some deals sit in stages that are not on the new pipeline. Pass moveDealsTo to choose where they go.',
      stages_with_deals: plan.unresolved,
    });
  }

  const isDefault = type === DEFAULT_DEAL_TYPE;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyMoves(client, orgId, plan.moves, v.stages, type);
    const existing = isDefault
      ? await client.query(`SELECT id FROM pipelines WHERE org_id = $1 AND is_default = TRUE LIMIT 1`, [orgId])
      : await client.query(`SELECT id FROM pipelines WHERE org_id = $1 AND deal_type = $2 LIMIT 1`, [orgId, type]);
    const fallbackName = isDefault
      ? (PROFILE_PIPELINE_NAMES[normalizeProfile(profile)] || 'Pipeline')
      : type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, ' ');
    const pipelineName = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 255) : fallbackName;
    const slugs = v.stages.map((st) => st.id);
    let row;
    if (existing.rows && existing.rows[0]) {
      const r = await client.query(
        `UPDATE pipelines SET stage_defs = $1::jsonb, stages = $2, name = $3, profile = $4,
                updated_by = $5, updated_at = CURRENT_TIMESTAMP
          WHERE id = $6 RETURNING id, name, stage_defs, profile, deal_type, updated_at, updated_by`,
        [JSON.stringify(v.stages), slugs, pipelineName, profile, userId || null, existing.rows[0].id]
      );
      row = r.rows[0];
    } else {
      const r = await client.query(
        `INSERT INTO pipelines (user_id, org_id, name, stages, stage_defs, is_default, deal_type, profile, created_by, updated_by)
         VALUES (NULL, $1, $2, $3, $4::jsonb, $5, $6, $7, $8, $8)
         RETURNING id, name, stage_defs, profile, deal_type, updated_at, updated_by`,
        [orgId, pipelineName, slugs, JSON.stringify(v.stages), isDefault, isDefault ? null : type, profile, userId || null]
      );
      row = r.rows[0];
    }
    await client.query('COMMIT');
    bustCache(orgId);
    return { pipeline: shape({ profile, stages: v.stages, row }), moved: plan.moves };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Drop a custom pipeline row and fall back down the chain. For the default
 * pipeline: back to the profile default (as before — but only
 * deal_type='default' deals are swept). For a type pipeline: the type's deals
 * keep their deal_type and fall back to the org default / profile pipeline.
 * Deals in stages the fallback doesn't have must be given a destination
 * (moveDealsTo).
 */
async function resetPipeline(orgId, userId, { moveDealsTo, dealType } = {}) {
  if (!orgId) throw fail(400, { error: 'Org context required' });
  const type = normalizeDealType(dealType);
  const isDefault = type === DEFAULT_DEAL_TYPE;
  const profile = await fetchProfile(orgId);
  // What the type's deals will validate against AFTER the row is gone.
  const fallback = isDefault ? null : await fetchDefaultRow(orgId);
  const stages = fallback ? validateStages(fallback.stage_defs, profile).stages : defaultStagesFor(profile);
  const counts = await dealCountsByStage(orgId, pool, type);
  const plan = planMoves(counts, stages, moveDealsTo);
  if (plan.errors.length) throw fail(400, { error: 'Invalid reset', validation_errors: plan.errors });
  if (plan.unresolved.length) {
    throw fail(409, {
      error: 'stages_have_deals',
      message: 'Some deals sit in stages the default pipeline does not have. Pass moveDealsTo to choose where they go.',
      stages_with_deals: plan.unresolved,
    });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyMoves(client, orgId, plan.moves, stages, type);
    if (isDefault) await client.query(`DELETE FROM pipelines WHERE org_id = $1 AND is_default = TRUE`, [orgId]);
    else await client.query(`DELETE FROM pipelines WHERE org_id = $1 AND deal_type = $2`, [orgId, type]);
    await client.query('COMMIT');
    bustCache(orgId);
    return { pipeline: shape({ profile, stages, row: fallback }), moved: plan.moves };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Delete a TYPE pipeline outright (spec 201): its deals are re-typed to
 * `retypeTo` (default 'default') and stray stages re-homed via `moveDealsTo`
 * against the target type's effective pipeline — all in one transaction.
 * Refuses (409) while the type still has deals and no resolution is given.
 * The default pipeline can't be deleted — that's resetPipeline.
 */
async function deleteTypePipeline(orgId, dealType, userId, { moveDealsTo, retypeTo } = {}) {
  if (!orgId) throw fail(400, { error: 'Org context required' });
  const type = normalizeDealType(dealType);
  if (type === DEFAULT_DEAL_TYPE) throw fail(400, { error: 'The default pipeline cannot be deleted — reset it instead' });
  const target = normalizeDealType(retypeTo);
  if (target === type) throw fail(400, { error: 'retype_to must be a different deal type' });
  const row = await fetchTypeRow(orgId, type);
  if (!row) throw fail(404, { error: 'Pipeline not found', deal_type: type });

  const profile = await fetchProfile(orgId);
  const targetPipeline = await getEffectivePipeline(orgId, profile, { dealType: target, skipCache: true });
  if (target !== DEFAULT_DEAL_TYPE && targetPipeline.deal_type !== target) {
    throw fail(400, { error: `retype_to "${target}" is not a deal type with a pipeline` });
  }
  const counts = await dealCountsByStage(orgId, pool, type);
  const plan = planMoves(counts, targetPipeline.stages, moveDealsTo);
  if (plan.errors.length) throw fail(400, { error: 'Invalid delete', validation_errors: plan.errors });
  if (plan.unresolved.length) {
    throw fail(409, {
      error: 'stages_have_deals',
      message: `Deals of type "${type}" sit in stages the "${target}" pipeline does not have. Pass moveDealsTo to choose where they go.`,
      stages_with_deals: plan.unresolved,
    });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyMoves(client, orgId, plan.moves, targetPipeline.stages, type);
    await client.query(
      `UPDATE deals SET deal_type = $1, updated_at = CURRENT_TIMESTAMP WHERE org_id = $2 AND deal_type = $3`,
      [target, orgId, type]
    );
    await client.query(`DELETE FROM pipelines WHERE org_id = $1 AND deal_type = $2`, [orgId, type]);
    await client.query('COMMIT');
    bustCache(orgId);
    return { deleted: type, retyped_to: target, moved: plan.moves };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Diff helpers for the chat tool: apply { add, rename, remove, reorder } to a
// stage list and describe the result in plain English.
// ---------------------------------------------------------------------------
function applyEdits(current, edits = {}) {
  const errors = [];
  let stages = clone(current);
  const byId = () => new Map(stages.map((st) => [st.id, st]));
  const findId = (ref) => {
    const m = byId();
    if (m.has(ref)) return ref;
    const lower = String(ref || '').toLowerCase();
    for (const st of stages) if (st.id.toLowerCase() === lower || st.label.toLowerCase() === lower) return st.id;
    return null;
  };
  const changes = [];

  for (const [ref, label] of Object.entries(edits.rename || {})) {
    const id = findId(ref);
    if (!id) { errors.push(`rename: no stage "${ref}"`); continue; }
    const st = byId().get(id);
    changes.push(`rename "${st.label}" to "${label}"`);
    st.label = String(label || '').trim();
  }
  const removeMap = {};
  for (const rm of edits.remove || []) {
    const ref = typeof rm === 'string' ? rm : rm && rm.slug;
    const id = findId(ref);
    if (!id) { errors.push(`remove: no stage "${ref}"`); continue; }
    const st = byId().get(id);
    changes.push(`remove "${st.label}"`);
    if (rm && typeof rm === 'object' && rm.moveDealsTo) removeMap[id] = rm.moveDealsTo;
    stages = stages.filter((x) => x.id !== id);
  }
  for (const add of edits.add || []) {
    const a = typeof add === 'string' ? { label: add } : (add || {});
    const label = String(a.label || a.name || '').trim();
    const id = a.id || a.slug || slugify(label);
    const st = s(id, label, a.desc || '', a.tone || 'gray', {
      phase: a.phase || null, is_won: a.is_won === true, is_lost: a.is_lost === true,
      probability: a.probability === undefined ? null : a.probability,
    });
    let idx = stages.length;
    if (a.after) { const ai = stages.findIndex((x) => x.id === findId(a.after)); if (ai >= 0) idx = ai + 1; }
    if (a.before) { const bi = stages.findIndex((x) => x.id === findId(a.before)); if (bi >= 0) idx = bi; }
    stages.splice(idx, 0, st);
    changes.push(`add "${label}"${a.after ? ` after ${a.after}` : a.before ? ` before ${a.before}` : ''}`);
  }
  if (Array.isArray(edits.reorder) && edits.reorder.length) {
    const ids = edits.reorder.map(findId);
    const missing = edits.reorder.filter((_, i) => !ids[i]);
    if (missing.length) errors.push(`reorder: unknown stage(s) ${missing.join(', ')}`);
    else {
      const m = byId();
      const ordered = ids.map((id) => m.get(id));
      const rest = stages.filter((st) => !ids.includes(st.id));
      stages = [...ordered, ...rest];
      changes.push(`reorder to ${stages.map((st) => st.label).join(' → ')}`);
    }
  }
  // Resolve moveDealsTo refs against the NEW list (labels allowed).
  const finalIds = new Map(stages.map((st) => [st.id.toLowerCase(), st.id]));
  const moveDealsTo = {};
  for (const [from, to] of Object.entries(removeMap)) {
    const lower = String(to).toLowerCase();
    const match = finalIds.get(lower) || stages.find((st) => st.label.toLowerCase() === lower)?.id;
    if (!match) errors.push(`moveDealsTo: "${to}" is not a stage on the new pipeline`);
    else moveDealsTo[from] = match;
  }
  return { stages, changes, errors, moveDealsTo };
}

function describeStages(stages) {
  return stages.map((st) => st.label + (st.is_won ? ' (won)' : st.is_lost ? ' (lost)' : '')).join(' → ');
}

module.exports = {
  TONES, VALID_PHASES, MAX_STAGES, MAX_LABEL, PROFILE_DEFAULTS, PHASE_LABELS,
  DEAL_TYPE_RE, DEFAULT_DEAL_TYPE,
  defaultStagesFor, maxStagesFor, validateStages, slugify, normalizeDealType,
  getEffectivePipeline, dealCountsByStage, listPipelines, planMoves,
  savePipeline, resetPipeline, deleteTypePipeline,
  applyEdits, describeStages, bustCache, _clearCache: () => cache.clear(),
};
