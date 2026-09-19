// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// First-run workspace builder (spec 203, Phase 1): "describe how your
// business sells" → a bundle of confirm-first proposals that, applied in
// order, turn the default workspace into that business's CRM.
//
// This module makes ONE structured Claude call and then does all the real
// work deterministically: every piece of the plan is normalized into the
// exact action shape the existing confirm-first machinery accepts and pushed
// through chatActions.validateAction — the same validator POST
// /api/ai/actions/apply re-runs. So the planner can propose nothing that the
// apply endpoint would not also accept, and NOTHING is written here: the
// frontend applies each proposal through the one existing writer, in the
// order returned (pipeline first, so automation stage ids exist by the time
// the rules land).
//
// Why not just let the chat copilot do this with its propose_* tools? It can,
// one change at a time. But the chat loop caps output at ~1k tokens a round,
// five tool rounds a turn, and four action chips a reply — fine for "add a
// field", too tight to reliably hand a stranger a whole workspace in one
// reviewable moment. A single planning call with a strict JSON contract is
// cheaper, deterministic, and testable.

const ai = require('./ai');
const pipelines = require('./pipelines');
const chatActions = require('./chatActions');
const featureFlags = require('./featureFlags');
const dealStages = require('../utils/dealStages');
const customFields = require('../routes/customFieldsRoutes');

const LIMITS = { fields: 8, automations: 5, views: 4 };
const MIN_DESCRIPTION = 12;
const MAX_DESCRIPTION = 4000;

const FIELD_ENTITIES = {
  deal: 'deals', deals: 'deals', opportunity: 'deals', opportunities: 'deals',
  company: 'companies', companies: 'companies', account: 'companies', accounts: 'companies',
  contact: 'contacts', contacts: 'contacts', person: 'contacts', people: 'contacts',
};
const FIELD_TYPE_ALIASES = {
  checkbox: 'boolean', bool: 'boolean', boolean: 'boolean', dropdown: 'select', picklist: 'select',
  select: 'select', multiselect: 'multiselect', multi_select: 'multiselect', tags: 'multiselect',
  url: 'text', link: 'text', email: 'text', string: 'text', text: 'text', textarea: 'text',
  number: 'number', integer: 'number', decimal: 'number', currency: 'number', money: 'number',
  percent: 'number', date: 'date', datetime: 'date',
};
const PLANNER_TRIGGERS = ['deal_stage_is', 'deal_idle_days'];
const PLANNER_ACTIONS = ['create_task', 'notify', 'set_hot_flag'];
const TASK_PRIORITIES = ['low', 'medium', 'high'];

function toFieldKey(raw) {
  const k = String(raw || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  return /^[a-z]/.test(k) ? k : (k ? `f_${k}`.slice(0, 60) : '');
}

function reservedList(entity) {
  return Array.from(customFields.RESERVED_COLUMNS[entity] || [])
    .filter((c) => !['id', 'user_id', 'org_id', 'public_id', 'external_ref', 'custom_fields', 'created_at', 'updated_at'].includes(c))
    .sort().join(', ');
}

function buildSystemPrompt({ profile, currentStages, existingFields, automationEnabled }) {
  const maxStages = pipelines.maxStagesFor(profile);
  const tones = pipelines.TONES.join(', ');
  const dealFilters = Object.entries(ai.SEARCH_CATALOG.deals.filters)
    .filter(([k]) => ['stage', 'hot', 'amount_min', 'amount_max', 'last_activity_window', 'overdue'].includes(k))
    .map(([k, v]) => `      ${k}: ${v.replace(/one of TRIAGE[^,]*(,[^,]*)*closed_lost/, 'one of the proposed stage LABELS')}`)
    .join('\n');
  const fieldsLines = existingFields.length
    ? existingFields.map((d) => `  - ${d.entity}.${d.name} (${d.type})`).join('\n')
    : '  (none yet)';

  return [
    'You are setting up a CRM workspace for a business owner who just described, in plain English, how their business sells.',
    'Turn that description into a starting configuration. Use THEIR words for stage and field names. Be concrete and restrained: a good first workspace is small and obviously right, not exhaustive.',
    '',
    `Current pipeline (the default they start with): ${currentStages.map((st) => st.label).join(' → ')}.`,
    'Propose a replacement pipeline ONLY if their process differs from that; otherwise set "pipeline": null and they keep the default.',
    '',
    'PIPELINE RULES',
    `  • 4 to 9 stages (hard max ${maxStages}), in the order a deal moves. Labels ≤ 40 chars, desc ≤ 120 chars.`,
    '  • Exactly one stage with "is_won": true and at least one with "is_lost": true (a business that never loses a deal still needs a lost stage). Won/lost stages go last.',
    `  • "tone" is one of: ${tones}. Early stages cool (slate/blue/cyan), mid stages warm (yellow/amber/orange), won green/emerald, lost red/rose.`,
    '  • "probability" is an integer 0–100 or null.',
    '',
    'FIELD RULES',
    '  • At most 6 custom fields, only ones the description actually implies. Entities: deals, companies, contacts.',
    '  • Types: text, number, date, select (needs 2–12 "options"), multiselect, boolean. Money and percentages are number. Use select when they named a fixed set of values.',
    '  • "name" is snake_case; "label" is what they would call it.',
    '  • These columns ALREADY EXIST — never propose them as custom fields:',
    `      deals: ${reservedList('deals')}`,
    `      companies: ${reservedList('companies')}`,
    `      contacts: ${reservedList('contacts')}`,
    '  • Existing custom fields in this workspace (do not duplicate):',
    fieldsLines,
    '',
    'AUTOMATION RULES',
    automationEnabled
      ? [
        '  • At most 3, and ONLY for a "when X then Y" the description states or clearly implies (e.g. "remind the rep after a week").',
        '  • trigger "deal_stage_is" with "stage" = the LABEL of one of the proposed stages (or a current stage if pipeline is null); or trigger "deal_idle_days" with "days" (1–365).',
        '  • action "create_task" (needs "title", optional "priority" low|medium|high), "notify" (notifies the deal owner), or "set_hot_flag".',
      ].join('\n')
      : '  • Automations are switched off in this workspace — return "automations": [].',
    '',
    'VIEW RULES',
    '  • At most 2 saved list views on deals, only if useful (e.g. "Hot deals", "Stalled quotes"). Allowed deal filters:',
    dealFilters,
    '',
    'OUTPUT (CRITICAL — parsed as JSON; reply with ONE JSON object, no prose, no markdown fence):',
    '{',
    '  "narrative": "<1–2 sentences to the owner, plain English, describing what you set up in their terms. No marketing voice.>",',
    '  "pipeline": { "name": "<short pipeline name>", "stages": [ { "label", "desc", "tone", "is_won", "is_lost", "probability" } ] } | null,',
    '  "fields": [ { "entity", "name", "label", "type", "options"?, "why": "<one short sentence>" } ],',
    '  "automations": [ { "name", "trigger", "stage"?, "days"?, "action", "title"?, "priority"?, "why" } ],',
    '  "views": [ { "entity": "deals", "name", "filters": { ... }, "why" } ]',
    '}',
    'If the text does not describe a business that sells anything (gibberish, a question, a complaint), return {"narrative": "<ask them, in one sentence, to describe how their business finds and closes customers>", "pipeline": null, "fields": [], "automations": [], "views": []}.',
  ].join('\n');
}

// Claude usually obeys "JSON only"; defend against fences and stray prose.
function parseJson(text) {
  if (!text || typeof text !== 'string') return { error: 'Empty response from AI' };
  let s = text.trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return { parsed: JSON.parse(s) }; } catch (_) { /* fall through */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return { error: 'Model output was not parseable JSON' };
  try { return { parsed: JSON.parse(s.slice(start, end + 1)) }; } catch (e) { return { error: `Failed to parse JSON: ${e.message}` }; }
}

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// --- pipeline ---------------------------------------------------------------

function normalizeStages(rawStages) {
  if (!Array.isArray(rawStages)) return [];
  return rawStages
    .filter((st) => st && typeof st === 'object' && str(st.label, 40))
    .map((st) => ({
      label: str(st.label, 40),
      desc: str(st.desc, 120),
      tone: pipelines.TONES.includes(st.tone) ? st.tone : 'gray',
      is_won: st.is_won === true,
      is_lost: st.is_lost === true,
      probability: Number.isInteger(st.probability) && st.probability >= 0 && st.probability <= 100 ? st.probability : null,
    }));
}

// The model sometimes forgets a terminal stage; a missing won/lost is fixed
// deterministically rather than failing the whole plan.
function ensureTerminalStages(stages, notes) {
  const out = stages.slice();
  if (out.length && !out.some((st) => st.is_won)) {
    out.push({ label: 'Closed Won', desc: 'Won the deal', tone: 'green', is_won: true, is_lost: false, probability: 100 });
    notes.push('Added a "Closed Won" stage — every pipeline needs a won stage.');
  }
  if (out.length && !out.some((st) => st.is_lost)) {
    out.push({ label: 'Closed Lost', desc: 'Did not win', tone: 'red', is_won: false, is_lost: true, probability: 0 });
    notes.push('Added a "Closed Lost" stage — every pipeline needs a lost stage.');
  }
  return out;
}

async function planPipeline({ orgId, profile, raw, current, notes, skipped }) {
  if (!raw || typeof raw !== 'object') return null;
  const normalized = normalizeStages(raw.stages);
  if (normalized.length < 2) {
    skipped.push({ kind: 'pipeline', label: 'Pipeline', reason: 'The proposed pipeline had fewer than two usable stages; keeping the default.' });
    return null;
  }
  const withTerminals = ensureTerminalStages(normalized, notes);
  const v = pipelines.validateStages(withTerminals, profile);
  if (!v.ok) {
    skipped.push({ kind: 'pipeline', label: 'Pipeline', reason: v.errors.join('; ') });
    return null;
  }
  // Deals already sitting in a stage the new pipeline drops have to go
  // somewhere — a fresh org has none; an older one gets them parked in the
  // first stage, and the card says so.
  const counts = await pipelines.dealCountsByStage(orgId);
  const fields = {
    stages: v.stages,
    change_summary: `Replace the ${current.stages.length}-stage default with your ${v.stages.length}-stage ${str(raw.name, 40) || 'sales'} pipeline`,
  };
  const plan = pipelines.planMoves(counts, v.stages, undefined);
  if (plan.unresolved.length) {
    fields.moveDealsTo = v.stages[0].id;
    const n = plan.unresolved.reduce((acc, u) => acc + u.count, 0);
    notes.push(`${n} existing deal${n === 1 ? '' : 's'} will move to "${v.stages[0].label}" because their current stage is not on the new pipeline.`);
  }
  const action = chatActions.validateAction({ entity: 'pipeline', op: 'update', fields });
  if (!action.ok) {
    skipped.push({ kind: 'pipeline', label: 'Pipeline', reason: action.errors.join('; ') });
    return null;
  }
  return {
    kind: 'pipeline',
    label: str(raw.name, 40) || 'Pipeline',
    summary: action.action.summary,
    detail: v.stages.map((st) => st.label).join(' → '),
    why: 'The stages a deal moves through, in your words.',
    proposal: action.action,
  };
}

// --- fields -----------------------------------------------------------------

async function planFields({ orgId, raw, existingFields, skipped }) {
  const out = [];
  const seen = new Set(existingFields.map((d) => `${d.entity}.${d.name}`));
  for (const f of (Array.isArray(raw) ? raw : []).slice(0, LIMITS.fields)) {
    if (!f || typeof f !== 'object') continue;
    const label = str(f.label, 120) || str(f.name, 60);
    const entity = FIELD_ENTITIES[String(f.entity || '').toLowerCase()];
    if (!entity) { skipped.push({ kind: 'field', label, reason: `Unsupported entity "${f.entity}" — fields go on deals, companies, or contacts.` }); continue; }
    const name = toFieldKey(f.name || f.label);
    if (!name) { skipped.push({ kind: 'field', label, reason: 'No usable field name.' }); continue; }
    const key = `${entity}.${name}`;
    if (seen.has(key)) { skipped.push({ kind: 'field', label, reason: `"${name}" already exists on ${entity}.` }); continue; }
    const typeRaw = String(f.type || 'text').toLowerCase();
    const type = FIELD_TYPE_ALIASES[typeRaw] || typeRaw;
    const fields = { entity, name, type };
    if (label && label !== name) fields.label = label;
    if (Array.isArray(f.options)) fields.options = f.options.filter((o) => typeof o === 'string' && o.trim()).map((o) => o.trim().slice(0, 80)).slice(0, 50);
    const action = chatActions.validateAction({ entity: 'custom_field', op: 'create', fields });
    if (!action.ok) { skipped.push({ kind: 'field', label, reason: action.errors.join('; ') }); continue; }
    seen.add(key);
    out.push({
      kind: 'field',
      label,
      summary: action.action.summary,
      detail: `${entity} · ${type}${fields.options ? ` (${fields.options.join(', ')})` : ''}`,
      why: str(f.why, 200),
      proposal: action.action,
    });
  }
  return out;
}

// --- automations ------------------------------------------------------------

function planAutomations({ raw, stagesForResolution, automationEnabled, skipped }) {
  const out = [];
  const list = (Array.isArray(raw) ? raw : []).slice(0, LIMITS.automations);
  if (!automationEnabled) {
    if (list.length) skipped.push({ kind: 'automation', label: 'Automations', reason: 'The automation module is switched off for this workspace — an owner/admin can enable it under Modules.' });
    return out;
  }
  const pipelineForResolve = { stages: stagesForResolution, is_custom: true };
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    const label = str(a.name, 200) || 'Automation';
    const trigger = String(a.trigger || '');
    const actionType = String(a.action || '');
    if (!PLANNER_TRIGGERS.includes(trigger)) { skipped.push({ kind: 'automation', label, reason: `Unsupported trigger "${trigger}".` }); continue; }
    if (!PLANNER_ACTIONS.includes(actionType)) { skipped.push({ kind: 'automation', label, reason: `Unsupported action "${actionType}".` }); continue; }
    const conditions = {};
    if (trigger === 'deal_stage_is') {
      const stageId = dealStages.resolveStageId(a.stage, pipelineForResolve);
      if (!stageId) { skipped.push({ kind: 'automation', label, reason: `"${a.stage}" is not one of the pipeline stages.` }); continue; }
      conditions.stage = stageId;
    } else {
      const days = Number(a.days);
      if (!Number.isFinite(days) || days < 1 || days > 365) { skipped.push({ kind: 'automation', label, reason: 'deal_idle_days needs "days" between 1 and 365.' }); continue; }
      conditions.days = Math.round(days);
    }
    const action = { type: actionType };
    if (actionType === 'create_task') {
      action.title = str(a.title, 200) || label;
      if (TASK_PRIORITIES.includes(a.priority)) action.priority = a.priority;
    }
    const fields = { name: label, trigger, conditions, action, enabled: true };
    const validated = chatActions.validateAction({ entity: 'automation_rule', op: 'create', fields });
    if (!validated.ok) { skipped.push({ kind: 'automation', label, reason: validated.errors.join('; ') }); continue; }
    out.push({
      kind: 'automation',
      label,
      summary: validated.action.summary,
      detail: null,
      why: str(a.why, 200),
      proposal: validated.action,
    });
  }
  return out;
}

// --- views ------------------------------------------------------------------

function planViews({ raw, stagesForResolution, skipped }) {
  const out = [];
  const catalog = ai.SEARCH_CATALOG.deals;
  const pipelineForResolve = { stages: stagesForResolution, is_custom: true };
  for (const v of (Array.isArray(raw) ? raw : []).slice(0, LIMITS.views)) {
    if (!v || typeof v !== 'object') continue;
    const name = str(v.name, 80);
    if (!name) continue;
    const entity = FIELD_ENTITIES[String(v.entity || 'deals').toLowerCase()];
    if (entity !== 'deals') { skipped.push({ kind: 'view', label: name, reason: 'Starter views are deals-only.' }); continue; }
    const filters = {};
    const rawFilters = v.filters && typeof v.filters === 'object' && !Array.isArray(v.filters) ? v.filters : {};
    let bad = null;
    for (const [k, val] of Object.entries(rawFilters)) {
      if (!(k in catalog.filters)) { bad = `unknown filter "${k}"`; break; }
      if (k === 'stage') {
        const id = dealStages.resolveStageId(val, pipelineForResolve);
        if (!id) { bad = `"${val}" is not a pipeline stage`; break; }
        filters.stage = id;
      } else {
        filters[k] = val;
      }
    }
    if (bad) { skipped.push({ kind: 'view', label: name, reason: bad }); continue; }
    const fields = { resource: 'deals', name, filter_spec: filters, is_shared: true };
    const validated = chatActions.validateAction({ entity: 'saved_view', op: 'create', fields });
    if (!validated.ok) { skipped.push({ kind: 'view', label: name, reason: validated.errors.join('; ') }); continue; }
    out.push({
      kind: 'view',
      label: name,
      summary: validated.action.summary,
      detail: null,
      why: str(v.why, 200),
      proposal: validated.action,
    });
  }
  return out;
}

// --- entry point ------------------------------------------------------------

function validateDescription(description) {
  if (typeof description !== 'string') return 'description is required';
  const t = description.trim();
  if (t.length < MIN_DESCRIPTION) return `Tell us a little more — at least ${MIN_DESCRIPTION} characters.`;
  if (t.length > MAX_DESCRIPTION) return `description too long (max ${MAX_DESCRIPTION} chars)`;
  return null;
}

// What the planner needs to know about the org before it can validate
// anything: the effective pipeline, existing custom fields, automation flag.
async function loadContext(orgId, profile) {
  const current = await pipelines.getEffectivePipeline(orgId, profile);
  const [dealDefs, companyDefs, contactDefs] = await Promise.all([
    customFields.loadOrgDefs(orgId, 'deals'),
    customFields.loadOrgDefs(orgId, 'companies'),
    customFields.loadOrgDefs(orgId, 'contacts'),
  ]);
  const automationEnabled = await featureFlags.hasFeature(orgId, 'automation_enabled');
  return { current, existingFields: [...dealDefs, ...companyDefs, ...contactDefs], automationEnabled };
}

// Raw plan (the model's JSON, OR a saved workspace template's config — same
// shape) → validated, apply-ordered proposals. Deterministic; no AI here.
async function assemblePlan({ orgId, raw, ctx }) {
  const { current, existingFields, automationEnabled } = ctx;
  const notes = [];
  const skipped = [];
  const pipelineProposal = await planPipeline({ orgId, profile: current.profile, raw: raw.pipeline, current, notes, skipped });
  const stagesForResolution = pipelineProposal ? pipelineProposal.proposal.fields.stages : current.stages;
  const fieldProposals = await planFields({ orgId, raw: raw.fields, existingFields, skipped });
  const automationProposals = planAutomations({ raw: raw.automations, stagesForResolution, automationEnabled, skipped });
  const viewProposals = planViews({ raw: raw.views, stagesForResolution, skipped });

  const proposals = [
    ...(pipelineProposal ? [pipelineProposal] : []),
    ...fieldProposals,
    ...automationProposals,
    ...viewProposals,
  ];
  return {
    narrative: str(raw.narrative, 600) || (proposals.length ? 'Here is a starting workspace built from what you described.' : 'Tell me how your business finds and closes customers and I will set the workspace up around it.'),
    pipeline_name: pipelineProposal ? pipelineProposal.label : current.name,
    proposals,
    skipped,
    notes,
  };
}

// Returns { ok: true, plan } or { ok: false, status, error, code }.
// plan = { narrative, pipeline_name, proposals: [...], skipped: [...], notes: [...] }.
async function planWorkspace({ orgId, userId, description, profile }) {
  const descErr = validateDescription(description);
  if (descErr) return { ok: false, status: 400, error: descErr, code: 'INVALID_DESCRIPTION' };
  if (!orgId) return { ok: false, status: 400, error: 'An organization workspace is required.', code: 'ORG_REQUIRED' };

  const ctx = await loadContext(orgId, profile);
  const drafted = await draftRaw({ orgId, userId, description, ctx });
  if (!drafted.ok) return drafted;
  const plan = await assemblePlan({ orgId, raw: drafted.raw, ctx });
  return { ok: true, plan: { ...plan, usage: drafted.usage } };
}

// The one AI call: description → the model's raw plan JSON (unvalidated).
// Split out so the platform-template generator can store the raw, org-
// independent shape instead of org-bound proposals.
async function draftRaw({ orgId, userId, description, ctx }) {
  const system = buildSystemPrompt({ profile: ctx.current.profile, currentStages: ctx.current.stages, existingFields: ctx.existingFields, automationEnabled: ctx.automationEnabled });
  const res = await ai.callClaude({
    system,
    messages: [{ role: 'user', content: description.trim() }],
    maxTokens: 2500,
    orgId,
    userId,
    endpoint: 'onboarding-plan',
  });
  if (!res || res.ok === false || res.configured === false || !res.text) {
    const code = (res && res.code) || (res && res.configured === false ? 'AI_NOT_CONFIGURED' : 'PLAN_FAILED');
    const status = code === 'AI_NOT_CONFIGURED' ? 503 : code === 'QUOTA_EXCEEDED' ? 429 : 502;
    return { ok: false, status, error: (res && (res.error || res.message)) || 'The planning call failed.', code };
  }
  const parsed = parseJson(res.text);
  if (parsed.error) return { ok: false, status: 422, error: parsed.error, code: 'MALFORMED_RESPONSE' };
  return { ok: true, raw: parsed.parsed || {}, usage: res.usage || null };
}

module.exports = {
  planWorkspace,
  loadContext,
  assemblePlan,
  draftRaw,
  normalizeStages,
  validateDescription,
  // exported for tests
  buildSystemPrompt,
  parseJson,
  ensureTerminalStages,
  LIMITS,
  MIN_DESCRIPTION,
  MAX_DESCRIPTION,
};
