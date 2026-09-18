// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../auth');
const pool = require('../db');
const ai = require('../services/ai');
const audit = require('../services/audit');
const { aiSearchLimiter, chatLimiter, chatDebugLimiter, consumePluginRunAllowance } = require('../middleware/rateLimits');
const customFields = require('./customFieldsRoutes');
const pluginRunner = require('../services/pluginRunner');
const { friendlyStatus } = require('../services/pluginRunFormatter');
const chatActions = require('../services/chatActions');
const chatCapabilities = require('../services/chatCapabilities');
const featureFlags = require('../services/featureFlags');
const { evaluateAiBilling } = require('../middleware/requireAiBilling');
const stripeService = require('../services/stripe');
const { isSuperAdmin } = require('../middleware/adminAuth');
const segments = require('../services/segments');
const sequences = require('../services/sequences');
const playbooks = require('../services/playbooks');
// Plugin trigger engine (migration 164) — fire-and-forget post-commit dispatch.
const pluginEvents = require('../services/pluginEvents');
const { ownerValidationError } = require('../services/recordOwnership');
const { LIFECYCLE_STAGES } = require('../schemas/companies');
// Per-org pipeline stages (migration 155): stage ids resolve against the
// org's EFFECTIVE pipeline, and propose_update_pipeline edits it (confirm-first).
const dealStages = require('../utils/dealStages');
const pipelines = require('../services/pipelines');
// Chat plugin builder (propose_build_plugin): shared generation engine +
// pure spec validator. The generator never writes; the validator gate runs at
// propose AND apply (via chatActions' plugin.create_draft check).
const pluginGenerator = require('../services/pluginGenerator');
const { validateSpec: validatePluginSpec } = require('../services/pluginSpecValidator');
// Extension library (curated plugin templates): list_extensions reads the
// catalog + the org's install status; propose_install_extension's apply branch
// routes to the SAME install+activate internals the library page uses.
const pluginLibrary = require('../services/pluginLibrary');
const extensionInstall = require('../services/extensionInstall');

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// Where an applied workspace-building action lives afterwards (navigation
// registry keys — services/chatCapabilities.PAGES). Read by /actions/apply.
const BUILD_RESULT_PAGES = {
  custom_field:    () => chatCapabilities.pageFor('custom_fields'),
  automation_rule: () => chatCapabilities.pageFor('automations'),
  saved_view:      (action) => ({ path: `/${action.fields.resource}`, label: `Open ${action.fields.resource}` }),
  report:          () => chatCapabilities.pageFor('report_builder'),
};

// Tool → navigation-registry page for the post-turn action chips. The chips
// and the open_page tool read the SAME registry (chatCapabilities.PAGES), so
// they can never disagree about where a page lives. `when` gates a chip on
// the tool input; a FEATURE_DISABLED result always suppresses the chip so a
// disabled module never gets a dead "Open …" button. `label` overrides the
// registry label where the historical chip wording is more specific.
const TOOL_NAV_CHIPS = {
  list_overdue_tasks:     { page: 'overdue_tasks' },
  list_hot_deals:         { page: 'hot_deals' },
  list_dormant_deals:     { page: 'dormant_deals' },
  list_at_risk_accounts:  { page: 'companies', label: 'Show accounts' },
  list_deals:             { page: 'pre_sale_deals', when: (tc) => tc.input?.phase === 'pre_sale' },
  summarize_attention:    { page: 'dashboard' },
  list_leads:             { page: 'leads' },
  list_open_cases:        { page: 'cases' },
  list_upcoming_meetings: { page: 'calendar' },
  list_sequences:         { page: 'sequences' },
  list_extensions:        { page: 'plugin_library', label: 'Browse the extension library' },
};

// Same privilege bar as POST /api/segments/:id/bulk (segmentRoutes.isOrgAdmin):
// bulk/cohort writes are owner/admin territory; a user without an org is their
// own admin.
function isOrgAdminReq(req) {
  if (!req.orgId) return true;
  return req.orgRole === 'owner' || req.orgRole === 'admin';
}

// The scope shape services/segments.js and services/sequences.js expect.
function segmentScope(req) {
  const [scopeField, scopeValue] = qs(req);
  return { scopeField, scopeValue, userId: req.userId, orgId: req.orgId || null };
}

// ============================================================================
// Cohort harness helpers (Spec 200 follow-on — the manage-at-scale surface).
// Shared by the propose_cohort_action tool AND the apply endpoint so both
// sides resolve, validate, and count the SAME way. Nothing here writes except
// executeCohortAction, which is only ever reached from /actions/apply.
// ============================================================================

// Cohort verb -> segments.runBulkAction verb. enroll_in_sequence is special-
// cased in executeCohortAction (it goes through sequences.enroll).
const COHORT_TO_BULK = {
  set_lifecycle_stage: 'set_lifecycle_stage',
  assign_owner: 'assign_owner',
  create_task_for_each: 'create_task',
  open_case_for_each: 'open_case',
};
const COHORT_CASE_PRIORITIES = ['low', 'normal', 'high', 'urgent'];

// Resolve the cohort's segment definition: a saved segment by id/name (org-
// scoped lookup, so a foreign segment id is simply "not found") or the inline
// {entity_type, criteria} filter carried in the proposal fields. Saved
// segments are re-read at APPLY time too, so the action always runs the
// segment's CURRENT criteria, never a stale copy.
async function resolveCohortSegment(req, fields) {
  const [sf, sv] = qs(req);
  if (fields.segment_id !== undefined || fields.segment_name !== undefined) {
    let r;
    if (fields.segment_id !== undefined) {
      r = await pool.query(
        `SELECT id, name, entity_type, criteria FROM segments WHERE id = $1 AND ${sf} = $2`,
        [fields.segment_id, sv]);
    } else {
      r = await pool.query(
        `SELECT id, name, entity_type, criteria FROM segments WHERE LOWER(name) = LOWER($1) AND ${sf} = $2 ORDER BY id ASC`,
        [fields.segment_name, sv]);
      if (r.rows.length > 1) {
        return { error: 'ambiguous_segment', detail: `Multiple segments are named "${fields.segment_name}" — use segment_id (${r.rows.map((s) => `#${s.id}`).join(', ')})` };
      }
    }
    if (r.rows.length === 0) {
      return { error: 'not_found_in_org', detail: 'That segment was not found in your org. Use /segments (or ask me to list them) to find the right one.' };
    }
    const seg = r.rows[0];
    return { segment: { id: seg.id, name: seg.name, entity_type: seg.entity_type, criteria: seg.criteria } };
  }
  return { segment: { id: null, name: null, entity_type: fields.entity_type, criteria: fields.criteria } };
}

// Per-verb action_params validation. Returns an error STRING (400 material) or
// null when acceptable. DB checks (owner membership, sequence visibility, the
// per-verb module flag) run here so BOTH propose and apply enforce them.
async function cohortParamsError(req, entityType, action, p) {
  if (!p || typeof p !== 'object') return 'action_params object required';
  if (action === 'set_lifecycle_stage') {
    if (entityType !== 'company') return 'set_lifecycle_stage only applies to company cohorts';
    if (!LIFECYCLE_STAGES.includes(p.lifecycle_stage)) {
      return `lifecycle_stage must be one of: ${LIFECYCLE_STAGES.join(', ')}`;
    }
    return null;
  }
  if (action === 'assign_owner') {
    const n = Number(p.owner_id);
    if (!Number.isInteger(n) || n < 1) return 'owner_id must be a positive integer';
    // In-org membership (segments.runBulkAction re-validates at write time).
    return await ownerValidationError(req, n);
  }
  if (action === 'create_task_for_each') {
    if (typeof p.title !== 'string' || !p.title.trim() || p.title.length > 200) {
      return 'title is required (a non-empty string, max 200 chars)';
    }
    if (p.due_date != null && p.due_date !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(p.due_date))) {
      return 'due_date expects YYYY-MM-DD';
    }
    return null;
  }
  if (action === 'open_case_for_each') {
    if (typeof p.subject !== 'string' || !p.subject.trim() || p.subject.length > 500) {
      return 'subject is required (a non-empty string, max 500 chars)';
    }
    if (p.priority != null && !COHORT_CASE_PRIORITIES.includes(p.priority)) {
      return `priority must be one of: ${COHORT_CASE_PRIORITIES.join(', ')}`;
    }
    return null;
  }
  if (action === 'enroll_in_sequence') {
    if (entityType !== 'contact') return 'enroll_in_sequence only applies to contact cohorts';
    const sid = Number(p.sequence_id);
    if (!Number.isInteger(sid) || sid < 1) return 'sequence_id must be a positive integer';
    // The sequences module has its own flag, distinct from the segments one.
    if (req.orgId && !(await featureFlags.hasFeature(req.orgId, 'campaigns_enabled'))) {
      return 'the email-sequences module (campaigns_enabled) is not enabled for this organization';
    }
    const [sf, sv] = qs(req);
    const r = await pool.query(`SELECT 1 FROM sequences WHERE id = $1 AND ${sf} = $2`, [sid, sv]);
    if (r.rows.length === 0) return `sequence #${sid} was not found in your org`;
    return null;
  }
  return `unknown cohort action "${action}"`;
}

// THE cohort writer — only ever called from POST /api/ai/actions/apply.
// Membership is re-evaluated here (compiled criteria as of NOW), the
// MAX_BULK_AFFECTED cap is enforced, and every write goes through the
// allowlisted machinery: segments.runBulkAction for the four bulk verbs,
// sequences.enroll (batched) for enrollment.
//
// EMAIL GUARDRAIL: enroll_in_sequence writes sequence_enrollments rows ONLY.
// No email is composed or sent on this path — sending belongs exclusively to
// the sequence worker (sequences.processDueEnrollments), which checks the
// per-recipient suppression list and no-ops entirely when no email transport
// is configured. A cohort enroll therefore cannot bulk-email anyone.
async function executeCohortAction(req, segment, action, p) {
  const scope = segmentScope(req);

  if (action === 'enroll_in_sequence') {
    // Mirror runBulkAction's blast-radius refusal (same message shape).
    const memberCount = await segments.count(scope, segment);
    if (memberCount > segments.MAX_BULK_AFFECTED) {
      throw new segments.CriteriaError(
        `This cohort matches ${memberCount} records — over the ${segments.MAX_BULK_AFFECTED} limit for a single bulk action. Narrow the segment (add a rule) and try again.`
      );
    }
    const ids = await segments.memberIds(scope, segment, { max: segments.MAX_BULK_AFFECTED });
    let enrolled = 0;
    let skipped = 0;
    // sequences.enroll accepts at most 500 ids per call; batch the cohort
    // through it. Idempotent: already-enrolled contacts count as skipped.
    for (let i = 0; i < ids.length; i += 500) {
      const out = await sequences.enroll(
        { orgId: req.orgId || null, userId: req.userId },
        p.sequence_id,
        ids.slice(i, i + 500)
      );
      if (out === null) {
        const e = new Error('sequence not found in your org');
        e.status = 404;
        throw e;
      }
      if (out.error) {
        const e = new Error(out.error);
        e.status = 400;
        throw e;
      }
      enrolled += out.enrolled;
      skipped += out.skipped;
    }
    return { affected: enrolled, skipped };
  }

  const bulkVerb = COHORT_TO_BULK[action];
  if (!bulkVerb) {
    throw new segments.CriteriaError(`Unknown cohort action "${action}"`);
  }
  const bulkParams = action === 'set_lifecycle_stage' ? { lifecycle_stage: p.lifecycle_stage }
    : action === 'assign_owner' ? { owner_id: Number(p.owner_id) }
    : action === 'create_task_for_each' ? { title: p.title, description: p.description, due_date: p.due_date }
    : { subject: p.subject, description: p.description, priority: p.priority };
  // runBulkAction re-counts and enforces MAX_BULK_AFFECTED internally.
  return await segments.runBulkAction(scope, segment, bulkVerb, bulkParams);
}

// Status probe. `configured` = ANTHROPIC_API_KEY present. `billing` = the
// same verdict the /api/ai billing gate applies, surfaced up-front so the
// Chat page can show a "start your AI plan" card (or a trial countdown)
// instead of letting the user discover a 402 by typing. `can_manage` tells
// the UI whether THIS user can start checkout (org owner/admin or
// super-admin) or should be pointed at their admin.
router.get('/status', authMiddleware, async (req, res) => {
  const configured = ai.isConfigured(req.orgId);
  let billing = null;
  try {
    const verdict = await evaluateAiBilling({ orgId: req.orgId, userId: req.userId, log: req.log });
    const stripeReady = stripeService.isConfigured() && !!process.env.STRIPE_PRICE_AI_USAGE;
    let canManage = req.orgRole === 'owner' || req.orgRole === 'admin';
    if (!canManage && req.userId) {
      try { canManage = await isSuperAdmin(req.userId); } catch { /* keep false */ }
    }
    billing = {
      allowed: verdict.allowed,
      status: verdict.status,
      code: verdict.code,
      action: verdict.action,
      message: verdict.message,
      trial_ends_at: verdict.trial_ends_at || null,
      can_manage: !!canManage,
      stripe_ready: stripeReady,
    };
  } catch (err) {
    // Never let the probe itself fail: the frontend treats a missing billing
    // block as "unknown, assume allowed" and the gate still protects writes.
    if (req.log) req.log.warn('ai_status_billing_verdict_failed', { error: err.message });
  }
  res.json({ configured, billing });
});

async function loadDealContext(req, dealId) {
  const [sf, sv] = qs(req);
  const dealRes = await pool.query(
    `SELECT d.*, cu.name AS customer_name, co.name AS company_name, v.name AS vendor_name
     FROM deals d
     LEFT JOIN companies cu ON d.customer_id = cu.id
     LEFT JOIN companies co ON d.company_id = co.id
     LEFT JOIN companies v  ON d.vendor_id  = v.id
     WHERE d.id = $1 AND d.${sf} = $2`,
    [dealId, sv]
  );
  if (dealRes.rows.length === 0) return null;
  const deal = dealRes.rows[0];

  const [vqRes, issuesRes, actsRes] = await Promise.all([
    pool.query(`SELECT vq.*, c.name AS vendor_name FROM vendor_quotes vq LEFT JOIN companies c ON vq.vendor_id = c.id WHERE vq.deal_id = $1`, [dealId]),
    pool.query(`SELECT * FROM issues WHERE related_type = 'deal' AND related_id = $1 AND status IN ('open', 'in_progress') ORDER BY CASE urgency WHEN 'red' THEN 1 WHEN 'yellow' THEN 2 ELSE 3 END LIMIT 10`, [dealId]),
    pool.query(`SELECT * FROM activities WHERE deal_id = $1 ORDER BY activity_date DESC LIMIT 10`, [dealId]),
  ]);
  return { deal, vendorQuotes: vqRes.rows, issues: issuesRes.rows, lastActivities: actsRes.rows };
}

router.post('/summarize-deal/:id', authMiddleware, async (req, res) => {
  try {
    if (!ai.isConfigured()) return res.status(503).json({ error: 'AI not configured.' });
    const ctx = await loadDealContext(req, req.params.id);
    if (!ctx) return res.status(404).json({ error: 'Deal not found' });
    const result = await ai.summarizeDeal({ ...ctx, orgId: req.orgId, userId: req.userId });
    audit.fromReq(req, { event: 'ai.summarize_deal', targetType: 'deal', targetId: Number(req.params.id), success: result.ok !== false });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Conversational search — Differentiation Bet #3 (see COMPETITIVE_REVIEW.md).
//
// POST /api/ai/search
//   body: { query: 'show me deals over $50K from CA, no activity in 30 days',
//           resource?: 'deals'|'contacts'|'companies'|'tasks' }
//   returns: { resource, filter, sort, explanation }
//
// The model only ever sees the schema (ai.SEARCH_CATALOG) and the user's
// query — no customer data. The returned filter object is keyed against the
// allowlist below before being trusted; unknown keys are dropped (not just
// rejected) so the rest of a usable spec still flows through. If the entire
// filter is empty after sanitization, we 400.
// ============================================================================

const SEARCH_ALLOWED_RESOURCES = ['deals', 'contacts', 'companies', 'tasks'];

function sanitizeSpec(spec) {
  if (!spec || typeof spec !== 'object') {
    return { error: 'Model returned a non-object spec' };
  }
  const resource = spec.resource;
  if (!SEARCH_ALLOWED_RESOURCES.includes(resource)) {
    return { error: `Model returned unknown resource: ${resource}` };
  }
  const catalog = ai.SEARCH_CATALOG[resource];
  const allowed = Object.keys(catalog.filters);
  const rawFilter = (spec.filter && typeof spec.filter === 'object') ? spec.filter : {};
  const filter = {};
  const dropped = [];
  for (const [k, v] of Object.entries(rawFilter)) {
    if (allowed.includes(k)) {
      // Skip null/undefined/empty-string keys — the spec used to use those
      // to "blank a filter" but the frontend interprets missing-key as
      // not-applied, so dropping them keeps the URL clean.
      if (v === null || v === undefined || v === '') continue;
      filter[k] = v;
    } else {
      dropped.push(k);
    }
  }
  let sort = null;
  if (spec.sort && typeof spec.sort === 'object' && spec.sort.field) {
    if (catalog.sortFields.includes(spec.sort.field)) {
      sort = {
        field: spec.sort.field,
        direction: spec.sort.direction === 'asc' ? 'asc' : 'desc',
      };
    } else {
      dropped.push(`sort.${spec.sort.field}`);
    }
  }
  return {
    resource,
    filter,
    sort,
    explanation: typeof spec.explanation === 'string' ? spec.explanation : '',
    droppedKeys: dropped,
  };
}

router.post('/search', authMiddleware, aiSearchLimiter, async (req, res) => {
  const { query, resource } = req.body || {};
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'query is required' });
  }
  if (resource && !SEARCH_ALLOWED_RESOURCES.includes(resource)) {
    return res.status(400).json({ error: `resource must be one of ${SEARCH_ALLOWED_RESOURCES.join(', ')}` });
  }
  if (!ai.isConfigured()) {
    return res.status(503).json({ error: 'AI not configured. Set ANTHROPIC_API_KEY on the backend.' });
  }
  try {
    const result = await ai.conversationalSearch({
      query: query.slice(0, 1000), // hard cap on prompt size to bound cost
      resource,
      orgId: req.orgId,
      userId: req.userId,
    });
    if (!result.ok) {
      // Surface a parse failure distinctly from a transport / quota error so
      // the UI can offer a "try rephrasing" hint vs. a generic retry.
      const isParseFailure = /JSON/i.test(result.error || '');
      audit.fromReq(req, {
        event: audit.EVENTS.CONVERSATIONAL_SEARCH,
        targetType: 'ai_search',
        success: false,
        meta: { query, resource: resource || null, error: result.error, rawText: result.rawText },
      });
      return res.status(isParseFailure ? 422 : 502).json({
        error: result.error || 'AI search failed',
        code: isParseFailure ? 'MALFORMED_RESPONSE' : 'AI_ERROR',
      });
    }
    const sanitized = sanitizeSpec(result.spec);
    if (sanitized.error) {
      audit.fromReq(req, {
        event: audit.EVENTS.CONVERSATIONAL_SEARCH,
        targetType: 'ai_search',
        success: false,
        meta: { query, resource: resource || null, modelSpec: result.spec, error: sanitized.error },
      });
      return res.status(422).json({ error: sanitized.error, code: 'INVALID_SPEC' });
    }
    if (Object.keys(sanitized.filter).length === 0 && !sanitized.sort) {
      audit.fromReq(req, {
        event: audit.EVENTS.CONVERSATIONAL_SEARCH,
        targetType: 'ai_search',
        success: false,
        meta: { query, resource: sanitized.resource, modelSpec: result.spec, note: 'empty_filter' },
      });
      return res.status(422).json({
        error: 'Could not extract any filters from that query. Try being more specific.',
        code: 'EMPTY_FILTER',
      });
    }
    audit.fromReq(req, {
      event: audit.EVENTS.CONVERSATIONAL_SEARCH,
      targetType: 'ai_search',
      success: true,
      meta: { query, resource: sanitized.resource, filter: sanitized.filter, droppedKeys: sanitized.droppedKeys },
    });
    res.json({
      resource: sanitized.resource,
      filter: sanitized.filter,
      sort: sanitized.sort,
      explanation: sanitized.explanation,
      droppedKeys: sanitized.droppedKeys,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/draft-followup/:id', authMiddleware, async (req, res) => {
  try {
    if (!ai.isConfigured()) return res.status(503).json({ error: 'AI not configured.' });
    const ctx = await loadDealContext(req, req.params.id);
    if (!ctx) return res.status(404).json({ error: 'Deal not found' });
    const { recipient, tone, customNote } = req.body || {};
    const result = await ai.draftFollowUp({ deal: ctx.deal, recipient, tone, customNote, orgId: req.orgId, userId: req.userId });
    audit.fromReq(req, { event: 'ai.draft_followup', targetType: 'deal', targetId: Number(req.params.id), success: result.ok !== false });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Claude-authored org customizations — Differentiation Bet #2.
//
// Two-phase flow (propose → review → apply) so the human is always the gate
// between Claude and the org's schema:
//
//   POST /api/ai/propose-customization
//     body: { entity: 'companies'|'contacts'|'deals'|'tasks',
//             request: 'plain-English description of the desired change' }
//     -> Calls Claude with a system prompt that knows the entity's shared
//        schema + the org's existing custom field defs. Returns a JSON
//        proposal { actions: [...] } the admin can review. NOTHING is
//        written. Each action is sanitized server-side against the same
//        validateFieldDefShape used by hand-editing.
//
//   POST /api/ai/apply-customization
//     body: { actions: [{ kind, entity, name, label, type, options, required, position }] }
//     -> Owner/admin only. Re-validates the entire proposal, then performs
//        the writes in a transaction so a partial failure doesn't leave the
//        org with half a customization. Audit-logs the diff.
//
// The validator is single-sourced: aiRoutes never reaches into the DB to
// write defs directly — it goes through the same SQL the customFieldsRoutes
// POST/PUT/DELETE do, just bypassing HTTP. That way the rules can't drift.
// ============================================================================

const ACTION_KINDS = ['add_field', 'modify_field', 'remove_field'];

// Build the system prompt for Claude. We give it:
//   • The four supported entities
//   • The reserved columns on each (so it doesn't propose name clashes)
//   • The org's existing custom-field defs (so it doesn't propose duplicates,
//     and so "rename the commission tier field" has the right target)
//   • A strict JSON output contract — no prose, no markdown, no preface
function buildProposalSystemPrompt({ entity, existingDefs }) {
  const reservedLines = customFields.VALID_ENTITIES.map(e => {
    const cols = Array.from(customFields.RESERVED_COLUMNS[e]).sort().join(', ');
    return `  ${e}: ${cols}`;
  }).join('\n');

  const defsLines = existingDefs.length === 0
    ? '  (none yet)'
    : existingDefs.map(d =>
        `  - ${d.entity}.${d.name} (${d.type}${d.options?.length ? `, options=[${d.options.join('|')}]` : ''}${d.required ? ', required' : ''})`
      ).join('\n');

  return [
    'You are a CRM schema assistant. The admin will describe a customization in plain English.',
    'You must propose ONLY changes to per-org custom fields — never DDL on shared columns.',
    '',
    'Supported entities: companies, contacts, deals, tasks.',
    `Focus entity for this request: ${entity}.`,
    '',
    'RESERVED column names you may NOT use as a new field name (already in shared schema):',
    reservedLines,
    '',
    "This org's existing custom-field definitions:",
    defsLines,
    '',
    'Output rules (CRITICAL — your reply is parsed as JSON):',
    '  • Reply with a single JSON object. No prose, no markdown fence, no commentary.',
    '  • Shape: { "actions": [ { "kind": "add_field"|"modify_field"|"remove_field",',
    '              "entity": "<one of the four>",',
    '              "name": "<snake_case, [a-z][a-z0-9_]{1,59}>",',
    '              "label": "<human label, optional>",',
    '              "type": "text"|"number"|"date"|"select"|"multiselect"|"boolean",',
    '              "options": [ ... ] (required when type is select/multiselect),',
    '              "required": true|false,',
    '              "position": <int>,',
    '              "rationale": "<one short sentence explaining why>" } ] }',
    '  • For modify_field, include only the keys that should change (plus name+entity to identify the target).',
    '  • For remove_field, only name+entity are required.',
    '  • If the request is ambiguous (e.g. "add tiers" with no values), pick a small reasonable default and explain it in the rationale.',
    '  • If the request cannot be satisfied (e.g. clash with reserved name), still return { "actions": [] } with no actions and put the reason in a top-level "rejected_reason" string.',
    '  • NEVER propose changes to shared schema. Field names must not collide with reserved columns.',
  ].join('\n');
}

// Pull the structured proposal out of Claude's text. Claude usually obeys the
// "JSON only" instruction but defends against the times it doesn't (extra
// prose, code fences) by stripping markdown and falling back to the first
// JSON object substring.
function parseProposalText(text) {
  if (!text || typeof text !== 'string') return { error: 'Empty response from AI' };
  let s = text.trim();
  // Strip ```json ... ``` fences if present.
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  try {
    return { parsed: JSON.parse(s) };
  } catch (_) {
    // Fall back to the first {...} substring.
    const start = s.indexOf('{');
    const end   = s.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      return { error: 'Model output was not parseable JSON' };
    }
    try {
      return { parsed: JSON.parse(s.slice(start, end + 1)) };
    } catch (e) {
      return { error: `Failed to parse JSON: ${e.message}` };
    }
  }
}

// Validate a proposal object end-to-end. Returns { actions: [...], errors: [...] }.
// Per-action errors are gathered (not first-fail) so the UI can show the
// admin everything that's wrong in one shot.
async function validateProposal({ orgId, proposal }) {
  const errors = [];
  if (!proposal || typeof proposal !== 'object') {
    return { actions: [], errors: ['Proposal must be a JSON object'] };
  }
  if (!Array.isArray(proposal.actions)) {
    return { actions: [], errors: ['Proposal must include an actions array'] };
  }
  const actions = [];
  for (let i = 0; i < proposal.actions.length; i++) {
    const a = proposal.actions[i];
    const tag = `actions[${i}]`;
    if (!a || typeof a !== 'object') { errors.push(`${tag} is not an object`); continue; }
    if (!ACTION_KINDS.includes(a.kind)) { errors.push(`${tag}.kind must be one of ${ACTION_KINDS.join(', ')}`); continue; }
    if (!customFields.VALID_ENTITIES.includes(a.entity)) { errors.push(`${tag}.entity invalid: ${a.entity}`); continue; }
    if (typeof a.name !== 'string') { errors.push(`${tag}.name must be a string`); continue; }

    if (a.kind === 'add_field') {
      const shapeErr = customFields.validateFieldDefShape({
        entity: a.entity, name: a.name, type: a.type, options: a.options,
        label: a.label, required: a.required, position: a.position,
      });
      if (shapeErr) { errors.push(`${tag}: ${shapeErr}`); continue; }
      // Reject if name already exists for this org on this entity — caller
      // probably meant modify_field.
      const existing = await pool.query(
        `SELECT 1 FROM org_field_definitions WHERE org_id = $1 AND entity = $2 AND name = $3`,
        [orgId, a.entity, a.name]
      );
      if (existing.rows.length > 0) {
        errors.push(`${tag}: "${a.name}" already exists on ${a.entity} — use modify_field to change it.`);
        continue;
      }
      actions.push(a);
    } else if (a.kind === 'modify_field') {
      const existing = await pool.query(
        `SELECT * FROM org_field_definitions WHERE org_id = $1 AND entity = $2 AND name = $3`,
        [orgId, a.entity, a.name]
      );
      if (existing.rows.length === 0) {
        errors.push(`${tag}: no existing field "${a.name}" on ${a.entity} to modify.`);
        continue;
      }
      // Re-validate merged shape so a bad options array fails fast.
      const cur = existing.rows[0];
      const shapeErr = customFields.validateFieldDefShape({
        entity:  cur.entity,
        name:    cur.name,
        type:    cur.type, // type changes are not allowed; cur.type wins
        options: a.options ?? cur.options,
        label:   a.label ?? cur.label,
        required: a.required ?? cur.required,
        position: a.position ?? cur.position,
      });
      if (shapeErr) { errors.push(`${tag}: ${shapeErr}`); continue; }
      actions.push(a);
    } else { // remove_field
      const existing = await pool.query(
        `SELECT 1 FROM org_field_definitions WHERE org_id = $1 AND entity = $2 AND name = $3`,
        [orgId, a.entity, a.name]
      );
      if (existing.rows.length === 0) {
        errors.push(`${tag}: no existing field "${a.name}" on ${a.entity} to remove.`);
        continue;
      }
      actions.push(a);
    }
  }
  return { actions, errors, rejectedReason: typeof proposal.rejected_reason === 'string' ? proposal.rejected_reason : null };
}

router.post('/propose-customization', authMiddleware, async (req, res) => {
  try {
    if (!req.orgId) return res.status(400).json({ error: 'Org context required' });
    const { entity, request } = req.body || {};
    if (!customFields.VALID_ENTITIES.includes(entity)) {
      return res.status(400).json({ error: `entity must be one of ${customFields.VALID_ENTITIES.join(', ')}` });
    }
    if (!request || typeof request !== 'string' || !request.trim()) {
      return res.status(400).json({ error: 'request (plain-English description) is required' });
    }
    if (!ai.isConfigured()) {
      return res.status(503).json({ error: 'AI not configured. Set ANTHROPIC_API_KEY on the backend.' });
    }
    const existingDefs = await customFields.loadOrgDefs(req.orgId, entity);
    const system = buildProposalSystemPrompt({ entity, existingDefs });
    const claudeRes = await ai.callClaude({
      system,
      messages: [{ role: 'user', content: request.slice(0, 2000) }],
      maxTokens: 1200,
      orgId: req.orgId,
      userId: req.userId,
      endpoint: 'propose-customization',
    });
    if (!claudeRes || claudeRes.ok === false || !claudeRes.text) {
      return res.status(502).json({ error: claudeRes?.error || 'AI proposal call failed', code: claudeRes?.code });
    }
    const parsed = parseProposalText(claudeRes.text);
    if (parsed.error) {
      return res.status(422).json({ error: parsed.error, rawText: claudeRes.text, code: 'MALFORMED_RESPONSE' });
    }
    const validation = await validateProposal({ orgId: req.orgId, proposal: parsed.parsed });
    res.json({
      ok: true,
      entity,
      request,
      proposal: { actions: validation.actions, rejectedReason: validation.rejectedReason },
      validationErrors: validation.errors,
      rawText: claudeRes.text,
    });
  } catch (err) {
    console.error('propose-customization error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/apply-customization', authMiddleware, aiSearchLimiter, async (req, res) => {
  try {
    if (!req.orgId) return res.status(400).json({ error: 'Org context required' });
    if (req.orgRole !== 'owner' && req.orgRole !== 'admin') {
      return res.status(403).json({ error: 'Only org owners/admins can apply customizations' });
    }
    const { actions, request: originalRequest } = req.body || {};
    if (!Array.isArray(actions) || actions.length === 0) {
      return res.status(400).json({ error: 'actions[] is required and must be non-empty' });
    }
    // Re-validate top-to-bottom. We do NOT trust the client to have left the
    // proposal intact — re-running validation closes the obvious tamper hole
    // and re-checks the DB state (in case another admin edited defs between
    // propose and apply, our own propose-then-stale-apply race).
    const validation = await validateProposal({ orgId: req.orgId, proposal: { actions } });
    if (validation.errors.length > 0) {
      return res.status(400).json({ error: 'Proposal failed validation', validationErrors: validation.errors });
    }
    if (validation.actions.length === 0) {
      return res.status(400).json({ error: 'No applicable actions in proposal' });
    }

    // Apply in a transaction so a partial failure doesn't leave a half-applied
    // customization. Records the diff snapshot for audit.
    const client = await pool.connect();
    const applied = [];
    try {
      await client.query('BEGIN');
      for (const a of validation.actions) {
        if (a.kind === 'add_field') {
          const r = await client.query(
            `INSERT INTO org_field_definitions (org_id, entity, name, label, type, options, required, position, created_by)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9) RETURNING *`,
            [
              req.orgId, a.entity, a.name, a.label || a.name, a.type,
              JSON.stringify(a.options || []),
              !!a.required,
              Number.isInteger(a.position) ? a.position : 0,
              req.userId,
            ]
          );
          applied.push({ kind: a.kind, def: r.rows[0] });
        } else if (a.kind === 'modify_field') {
          const r = await client.query(
            `UPDATE org_field_definitions
                SET label    = COALESCE($1, label),
                    options  = COALESCE($2::jsonb, options),
                    required = COALESCE($3, required),
                    position = COALESCE($4, position),
                    updated_at = NOW()
              WHERE org_id = $5 AND entity = $6 AND name = $7
              RETURNING *`,
            [
              a.label ?? null,
              a.options !== undefined ? JSON.stringify(a.options) : null,
              a.required ?? null,
              a.position ?? null,
              req.orgId, a.entity, a.name,
            ]
          );
          applied.push({ kind: a.kind, def: r.rows[0] });
        } else if (a.kind === 'remove_field') {
          const r = await client.query(
            `DELETE FROM org_field_definitions WHERE org_id = $1 AND entity = $2 AND name = $3 RETURNING *`,
            [req.orgId, a.entity, a.name]
          );
          applied.push({ kind: a.kind, def: r.rows[0] });
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('apply-customization txn failed:', err);
      return res.status(500).json({ error: 'Failed to apply customization', detail: err.message });
    } finally {
      client.release();
    }

    audit.fromReq(req, {
      event: audit.EVENTS.CUSTOMIZATION_APPLIED,
      targetType: 'org_field_definitions',
      success: true,
      meta: { request: originalRequest || null, actions: validation.actions, applied },
    });

    res.json({ ok: true, applied });
  } catch (err) {
    console.error('apply-customization error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Chat write-actions apply endpoint (Spec 200 — the ONLY writer).
//
// The chat copilot's propose_* tools never write; they validate + ownership-
// check and return a proposal. This endpoint takes the echoed proposal, RE-
// VALIDATES it server-side (never trusts the client/model copy — closes the
// tamper hole), re-runs the org-ownership pre-flight, and executes the write
// in a transaction via chatActions.applyAction. Every applied write is
// audit-logged (ai.action_applied).
//
// Gating: inherits the /api/ai middleware (auth + requireFeature
// ('ai_features_enabled') + CSRF) — it is deliberately NOT CSRF-exempt.
// feature_flag.set additionally requires owner/admin/super_admin.
// ============================================================================
router.post('/actions/apply', authMiddleware, async (req, res) => {
  try {
    const { proposal } = req.body || {};
    // Re-validate from scratch. The client/model echo is untrusted: a tampered
    // or non-allowlisted field is rejected here regardless of what propose_*
    // returned earlier.
    const v = chatActions.validateAction(proposal);
    if (!v.ok) {
      return res.status(400).json({ error: 'Proposal failed validation', validation_errors: v.errors });
    }
    const action = v.action;

    // Flag-gated entities (lead.create → leads_enabled, case.create →
    // customer_success_enabled): re-check the module flag at apply time so a
    // proposal minted before an admin switched the module off (or a hand-
    // crafted one) can never write into a disabled module. Org-less personal
    // workspaces fail-open, mirroring middleware/featureGate.js.
    const actionSpec = chatActions.SPECS[`${action.entity}.${action.op}`];
    if (actionSpec && actionSpec.flag && req.orgId) {
      const enabled = await featureFlags.hasFeature(req.orgId, actionSpec.flag);
      if (!enabled) {
        return res.status(403).json({
          error: `Feature "${actionSpec.flag}" is not enabled for this organization. Contact your admin.`,
          code: 'FEATURE_DISABLED',
          feature: actionSpec.flag,
        });
      }
    }

    // Workspace-building actions (custom_field / automation_rule): org context
    // + owner/admin role, mirroring the requireOrgAdmin guards on
    // /api/custom-fields and /api/automation-rules. Service actions keep their
    // own bespoke checks below (feature_flag allows a platform super-admin).
    if (actionSpec && actionSpec.requiresOrg && !req.orgId) {
      return res.status(400).json({ error: 'Org context required for this action' });
    }
    if (actionSpec && actionSpec.requiresAdmin && !actionSpec.service && !isOrgAdminReq(req)) {
      return res.status(403).json({ error: 'Only an org owner/admin can apply this action' });
    }

    // feature_flag.set is a service action (not a table write). Route it to
    // featureFlags after a role check — only an org owner/admin (or a platform
    // super-admin) may flip a module for the org.
    if (action.entity === 'feature_flag') {
      // Resolve admin_role lazily — authMiddleware doesn't load admin_users.
      let adminRole = req.adminRole;
      if (adminRole === undefined) {
        try {
          const arow = await pool.query(`SELECT role FROM admin_users WHERE user_id = $1`, [req.userId]);
          adminRole = arow.rows[0]?.role || null;
        } catch { adminRole = null; }
      }
      const allowed = req.orgRole === 'owner' || req.orgRole === 'admin' || adminRole === 'super_admin';
      if (!allowed) {
        return res.status(403).json({ error: 'Only an org owner/admin can change modules for your organization' });
      }
      if (!req.orgId) {
        return res.status(400).json({ error: 'Org context required to set a module flag' });
      }
      await featureFlags.setFeature(req.orgId, action.fields.flag, action.fields.enabled);
      audit.fromReq(req, {
        event: audit.EVENTS.AI_ACTION_APPLIED,
        targetType: action.entity,
        targetId: null,
        meta: { op: action.op, fields: Object.keys(action.fields) },
      });
      return res.json({ ok: true, applied: { flag: action.fields.flag, enabled: action.fields.enabled } });
    }

    // pipeline.update is a service action — the same savePipeline PUT
    // /api/pipelines runs (validation + deal moves in one txn). Owner/admin
    // only, org context required.
    if (action.entity === 'pipeline') {
      if (!req.orgId) return res.status(400).json({ error: 'Org context required to edit pipeline stages' });
      if (!isOrgAdminReq(req)) return res.status(403).json({ error: 'Only an org owner/admin can change pipeline stages' });
      try {
        const result = await pipelines.savePipeline(req.orgId, action.fields.stages, req.userId, { moveDealsTo: action.fields.moveDealsTo, dealType: action.fields.deal_type });
        audit.fromReq(req, {
          event: audit.EVENTS.AI_ACTION_APPLIED,
          targetType: 'pipeline',
          targetId: result.pipeline.id,
          meta: { op: action.op, deal_type: result.pipeline.deal_type, stages: result.pipeline.stages.map((st) => st.id), moved: result.moved },
        });
        return res.json({ ok: true, result: result.pipeline, moved: result.moved, open_path: '/settings/pipeline', open_label: 'Open pipeline settings' });
      } catch (err) {
        if (err && err.status && err.body) return res.status(err.status).json(err.body);
        throw err;
      }
    }

    // Cohort harness (service action) — the manage-at-scale writer. Owner/
    // admin-gated (same bar as POST /api/segments/:id/bulk), membership
    // RE-EVALUATED here, capped by segments.MAX_BULK_AFFECTED, and executed
    // exclusively through the allowlisted segments/sequences machinery.
    if (action.entity === 'cohort') {
      if (!isOrgAdminReq(req)) {
        return res.status(403).json({ error: 'Only an org owner/admin can apply a cohort action' });
      }
      const resolved = await resolveCohortSegment(req, action.fields);
      if (resolved.error) {
        return res.status(resolved.error === 'not_found_in_org' ? 404 : 400).json(resolved);
      }
      const segment = resolved.segment;
      const paramsErr = await cohortParamsError(req, segment.entity_type, action.fields.action, action.fields.action_params || {});
      if (paramsErr) return res.status(400).json({ error: 'invalid_action_params', detail: paramsErr });
      try {
        const out = await executeCohortAction(req, segment, action.fields.action, action.fields.action_params || {});
        audit.fromReq(req, {
          event: audit.EVENTS.AI_ACTION_APPLIED,
          targetType: 'cohort',
          targetId: segment.id || null,
          meta: { op: action.op, fields: Object.keys(action.fields), action: action.fields.action, affected: out.affected },
        });
        return res.json({ ok: true, applied: { action: action.fields.action, affected: out.affected, ...(out.skipped !== undefined ? { skipped: out.skipped } : {}) } });
      } catch (err) {
        if (err.name === 'CriteriaError' || err.status === 400) {
          return res.status(400).json({ error: err.message });
        }
        if (err.status === 404) return res.status(404).json({ error: err.message });
        console.error('cohort apply failed:', err);
        return res.status(500).json({ error: 'Failed to apply cohort action', detail: err.message });
      }
    }

    // Chat plugin builder (service action) — SAVE-ONLY writer for
    // plugin.create_draft proposals. Inserts the generated spec as a plugins
    // row with status='draft' and source_kind='conversational'. It NEVER runs
    // the plugin: execution stays exclusively behind the existing plugin run
    // model (sandboxed preview via POST /api/plugins/:id/run, then the
    // owner/admin-gated POST /api/plugins/:id/apply) — the second confirm
    // gate. validateAction above already re-screened the untrusted echoed
    // spec through pluginSpecValidator (the chatActions spec's `check`); the
    // explicit re-validation here is defense-in-depth so this branch is safe
    // even if the chatActions spec ever drifts.
    if (action.entity === 'plugin' && action.op === 'create_draft') {
      if (!req.orgId) {
        return res.status(400).json({ error: 'Org context required to save a plugin draft' });
      }
      const pv = validatePluginSpec({
        name: action.fields.name,
        description: action.fields.description ?? null,
        trigger_event: action.fields.trigger_event,
        source_kind: 'conversational',
        spec_json: action.fields.spec_json,
        source_code: action.fields.source_code,
      });
      if (!pv.ok) {
        return res.status(422).json({
          error: 'Generated plugin spec failed validation',
          code: 'SPEC_REJECTED',
          validation_errors: pv.errors,
        });
      }

      // (org_id, name) is UNIQUE on plugins — suffix like the library-clone
      // path so "build me another one like X" doesn't 409. Bounded loop.
      let candidateName = action.fields.name;
      for (let i = 2; i < 50; i++) {
        const clash = await pool.query(`SELECT 1 FROM plugins WHERE org_id = $1 AND name = $2`, [req.orgId, candidateName]);
        if (clash.rows.length === 0) break;
        candidateName = `${action.fields.name} (Draft${i === 2 ? '' : ' ' + i})`;
      }

      const inserted = await pool.query(
        `INSERT INTO plugins (org_id, name, description, spec_json, source_code, source_kind,
                              trigger_event, trigger_filter_json, status, created_by, updated_by)
         VALUES ($1, $2, $3, $4::jsonb, $5, 'conversational', $6, $7::jsonb, 'draft', $8, $8)
         RETURNING id, name, public_id, status, source_kind, description, trigger_event`,
        [
          req.orgId,
          candidateName,
          action.fields.description || null,
          JSON.stringify(action.fields.spec_json),
          action.fields.source_code,
          action.fields.trigger_event,
          action.fields.spec_json && action.fields.spec_json.triggerFilter
            ? JSON.stringify(action.fields.spec_json.triggerFilter)
            : null,
          req.userId,
        ]
      );
      const row = inserted.rows[0];
      audit.fromReq(req, {
        event: audit.EVENTS.AI_ACTION_APPLIED,
        targetType: 'plugin',
        targetId: row.id,
        meta: { op: action.op, fields: Object.keys(action.fields), name: row.name, status: row.status },
      });
      return res.json({
        ok: true,
        applied: {
          plugin_id: row.id,
          name: row.name,
          status: row.status, // always 'draft'
          open_path: `/plugins/${row.id}`,
          open_label: 'Open in Plugins',
          note: 'Saved as a draft. It will not run until you test-run and apply it from the Plugins page.',
        },
      });
    }

    // Curated-extension install (service action) — routed to
    // services/extensionInstall.installLibraryTemplate, the SAME atomic
    // install+activate internals POST /api/plugins/from-template uses (so the
    // chat path and the library page's Enable button can never diverge). Only
    // the echoed `slug` + `activate` matter: the template is re-resolved from
    // the curated catalog server-side, so tampered display fields (name /
    // trigger / summary) cannot change what installs. Owner/admin + org
    // required, mirroring the propose-time gate; the plugins_enabled flag was
    // re-checked above via the spec's `flag`.
    if (action.entity === 'extension' && action.op === 'install') {
      if (!req.orgId) return res.status(400).json({ error: 'Org context required to install an extension' });
      if (!isOrgAdminReq(req)) {
        return res.status(403).json({ error: 'Only an org owner/admin can install extensions' });
      }
      // run_mode was validated by the chatActions spec ('preview'|'autonomous');
      // 'autonomous' reversed the confirm-first posture, so it rides the same
      // owner/admin gate as the install itself (checked just above).
      const requestedRunMode = action.fields.run_mode === 'autonomous' ? 'autonomous' : undefined;
      const result = await extensionInstall.installLibraryTemplate({
        orgId: req.orgId,
        userId: req.userId,
        slug: action.fields.slug,
        activate: action.fields.activate !== false, // default: install AND turn on
        runMode: requestedRunMode,
        log: req.log,
      });
      if (!result.body || !result.body.success) {
        return res.status(result.http).json({
          error: (result.body && result.body.error) || 'Install failed',
          ...(result.body && result.body.code ? { code: result.body.code } : {}),
        });
      }
      const row = result.body.plugin;
      audit.fromReq(req, {
        event: audit.EVENTS.AI_ACTION_APPLIED,
        targetType: 'plugin',
        targetId: row.id,
        meta: {
          op: action.op,
          template_slug: action.fields.slug,
          name: row.name,
          status: row.status,
          activated: !!result.body.activated,
          ...(requestedRunMode ? { run_mode: requestedRunMode } : {}),
        },
      });
      // Autonomous granted at install time gets the same dedicated audit row
      // as PATCH /api/plugins/:id/run-mode.
      if (requestedRunMode === 'autonomous') {
        audit.fromReq(req, {
          event: audit.EVENTS.PLUGIN_RUN_MODE_CHANGED,
          targetType: 'plugin',
          targetId: row.id,
          success: true,
          meta: { old: 'preview', new: 'autonomous', via: 'chat' },
        });
      }
      return res.json({
        ok: true,
        applied: {
          plugin_id: row.id,
          name: row.name,
          status: row.status,
          run_mode: row.run_mode || (requestedRunMode || 'preview'),
          template_slug: action.fields.slug,
          already_active: !!result.body.already_active,
          open_path: '/plugins/library',
          open_label: 'Open extension library',
          note: (result.body.already_active && !result.body.run_mode_changed)
            ? 'This extension was already installed and turned on — nothing changed.'
            : (row.status === 'active'
              ? (requestedRunMode === 'autonomous'
                ? 'Installed and turned on in AUTONOMOUS mode — it applies its changes immediately, no Apply step. Switch it back any time from the plugin page.'
                : 'Installed and turned on. Manage it from the Plugins page.')
              : 'Installed as a draft. Activate it from the Plugins page when ready.'),
        },
      });
    }

    // Extension run-mode change (service action) — the chat mirror of
    // PATCH /api/plugins/:id/run-mode. Same org-scoped UPDATE, same
    // plugin.run_mode_changed audit row. Owner/admin re-checked here (the
    // spec's requiresAdmin was enforced at propose time; a stale/tampered
    // proposal cannot bypass this gate).
    if (action.entity === 'extension' && action.op === 'set_mode') {
      if (!req.orgId) return res.status(400).json({ error: 'Org context required' });
      if (!isOrgAdminReq(req)) {
        return res.status(403).json({ error: 'Only an org owner/admin can change how an extension applies its changes' });
      }
      const pluginId = Number(action.fields.plugin_id);
      const nextMode = action.fields.run_mode; // spec-validated: 'preview' | 'autonomous'
      const cur = await pool.query(
        `SELECT id, name, run_mode FROM plugins WHERE id = $1 AND org_id = $2`,
        [pluginId, req.orgId]
      );
      if (cur.rows.length === 0) {
        return res.status(404).json({ error: `Plugin #${pluginId} was not found in your org` });
      }
      const oldMode = cur.rows[0].run_mode || 'preview';
      let row = cur.rows[0];
      if (oldMode !== nextMode) {
        const upd = await pool.query(
          `UPDATE plugins
              SET run_mode = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2,
                  entity_version = entity_version + 1
            WHERE id = $3 AND org_id = $4
            RETURNING id, name, status, run_mode`,
          [nextMode, req.userId, pluginId, req.orgId]
        );
        if (upd.rows.length === 0) {
          return res.status(404).json({ error: `Plugin #${pluginId} was not found in your org` });
        }
        row = upd.rows[0];
        audit.fromReq(req, {
          event: audit.EVENTS.PLUGIN_RUN_MODE_CHANGED,
          targetType: 'plugin',
          targetId: pluginId,
          success: true,
          meta: { old: oldMode, new: nextMode, via: 'chat' },
        });
      }
      audit.fromReq(req, {
        event: audit.EVENTS.AI_ACTION_APPLIED,
        targetType: 'plugin',
        targetId: pluginId,
        meta: { op: action.op, run_mode: nextMode, old_run_mode: oldMode, name: row.name },
      });
      return res.json({
        ok: true,
        applied: {
          plugin_id: pluginId,
          name: row.name,
          run_mode: nextMode,
          open_path: `/plugins/${pluginId}`,
          open_label: 'Open plugin',
          note: nextMode === 'autonomous'
            ? `"${row.name}" now runs autonomously — its changes apply immediately (tasks created, fields updated) with no Apply step. Every safety cap and the auto-pause net stay in force; switch back any time.`
            : `"${row.name}" is back to confirm-first — its proposed changes will wait for an owner/admin to Apply them.`,
        },
      });
    }

    // Table / remaining service entities. Re-run the ownership pre-flight
    // against the caller's scope before writing so a cross-org target/ref can
    // never be written. Array refs (sequence.enroll's contact_ids) fan out to
    // one check per id — a single smuggled cross-org id rejects the apply.
    const [sf, sv] = qs(req);
    const spec = chatActions.SPECS[`${action.entity}.${action.op}`];
    for (const ref of chatActions.referencedIds(action)) {
      const r = await pool.query(`SELECT 1 FROM ${ref.table} WHERE id = $1 AND ${sf} = $2`, [ref.id, sv]);
      if (r.rows.length === 0) {
        return res.status(404).json({ error: 'not_found_in_org', detail: `${ref.field} #${ref.id} was not found in your org` });
      }
    }
    if (spec && spec.needsTarget && action.target_id) {
      const r = await pool.query(`SELECT 1 FROM ${spec.table} WHERE id = $1 AND ${sf} = $2`, [action.target_id, sv]);
      if (r.rows.length === 0) {
        return res.status(404).json({ error: 'not_found_in_org', detail: `${action.entity} #${action.target_id} was not found in your org` });
      }
    }
    // Owner assignment: the proposed owner_user_id must be a member of the
    // caller's org (or the caller themself in a personal workspace). Re-checked
    // here regardless of what propose_* verified earlier.
    if (spec && spec.ownerField) {
      const ownerErr = await ownerValidationError(req, action.fields[spec.ownerField]);
      if (ownerErr) return res.status(400).json({ error: 'invalid_owner', detail: ownerErr });
    }

    // Sequence enrollment (service action) — routed to sequences.enroll, which
    // only inserts enrollment rows (scoped INSERT...SELECT). Nothing is emailed
    // on this path: sending belongs to the suppression-aware sequence worker,
    // which no-ops entirely while no email transport is configured.
    if (action.entity === 'sequence' && action.op === 'enroll') {
      const out = await sequences.enroll(
        { orgId: req.orgId || null, userId: req.userId },
        action.fields.sequence_id,
        action.fields.contact_ids
      );
      if (out === null) return res.status(404).json({ error: 'not_found_in_org', detail: 'sequence was not found in your org' });
      if (out.error) return res.status(400).json({ error: out.error });
      audit.fromReq(req, {
        event: audit.EVENTS.AI_ACTION_APPLIED,
        targetType: action.entity,
        targetId: action.fields.sequence_id,
        meta: { op: action.op, fields: Object.keys(action.fields), enrolled: out.enrolled },
      });
      return res.json({ ok: true, applied: { enrolled: out.enrolled, skipped: out.skipped } });
    }

    // Manual playbook run (service action) — routed to
    // playbooks.runPlaybookForCompany. Idempotent per (playbook, company).
    if (action.entity === 'playbook' && action.op === 'run') {
      const out = await playbooks.runPlaybookForCompany({
        orgScopeField: sf,
        orgScopeValue: sv,
        playbookId: action.fields.playbook_id,
        companyId: action.fields.company_id,
        userId: req.userId,
      });
      if (out === null) return res.status(404).json({ error: 'not_found_in_org', detail: 'playbook was not found (or is inactive) in your org' });
      audit.fromReq(req, {
        event: audit.EVENTS.AI_ACTION_APPLIED,
        targetType: action.entity,
        targetId: action.fields.playbook_id,
        meta: { op: action.op, fields: Object.keys(action.fields), tasks_created: out.tasks_created, already_ran: out.already_ran },
      });
      return res.json({ ok: true, applied: out });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await chatActions.applyAction(client, action, {
        sf, sv, userId: req.userId, orgId: req.orgId,
      });
      if (!row) {
        // Scoped WHERE matched nothing (cross-org / deleted between pre-flight
        // and write) — treat as 404, write nothing.
        await client.query('ROLLBACK').catch(() => {});
        return res.status(404).json({ error: 'not_found_in_org', detail: `${action.entity} could not be written in your org` });
      }
      await client.query('COMMIT');
      // Success playbooks fire AFTER the stage change commits, best-effort —
      // exactly like PATCH /api/companies/:id/lifecycle-stage. A playbook
      // failure must never break the write the user confirmed.
      if (spec && spec.firesPlaybooks) {
        try {
          await playbooks.runPlaybooksForStageChange({
            orgScopeField: sf,
            orgScopeValue: sv,
            companyId: row.id,
            newStage: action.fields.lifecycle_stage,
            userId: req.userId,
          });
        } catch (playbookError) {
          if (req.log) req.log.error('playbooks_fire_failed', { error: playbookError, company_id: row.id });
          else console.error('Playbook trigger error:', playbookError);
        }
      }
      // Deal-stage playbooks (migration 158): a confirmed deal.update that set
      // the stage goes through this writer, not dealRoutes — fire the same
      // shared trigger here, best-effort, after the commit. The service's
      // (playbook, deal) idempotency guard makes a no-op-stage re-apply safe.
      if (action.entity === 'deal' && action.op === 'update' && action.fields.stage !== undefined) {
        try {
          await playbooks.runPlaybooksForDealStageChange({
            orgScopeField: sf,
            orgScopeValue: sv,
            dealId: row.id,
            newStage: row.stage || action.fields.stage,
            dealType: row.deal_type,
            companyId: row.company_id || row.customer_id || null,
            userId: req.userId,
          });
        } catch (playbookError) {
          if (req.log) req.log.error('deal_playbooks_fire_failed', { error: playbookError, deal_id: row.id });
          else console.error('Deal playbook trigger error:', playbookError);
        }
        // Plugin trigger (migration 164) — same post-commit seam as the
        // playbook hook above. This writer doesn't capture the before-row, so
        // prev_stage is null and the dedupe key discriminates on the TARGET
        // stage only (retries of the same apply dedupe; a later apply to a
        // different stage fires again).
        if (req.orgId) {
          pluginEvents.emit(req.orgId, 'deal.stage_changed', {
            id: row.id,
            title: row.title,
            stage: row.stage || action.fields.stage,
            prev_stage: null,
            deal_type: row.deal_type,
            amount: row.amount,
          }, { dedupeKey: `deal.stage_changed:${row.id}:apply->${row.stage || action.fields.stage}` });
        }
      }
      audit.fromReq(req, {
        event: audit.EVENTS.AI_ACTION_APPLIED,
        targetType: action.entity,
        targetId: row.id || action.target_id || null,
        meta: { op: action.op, fields: Object.keys(action.fields) },
      });
      // Workspace-building results carry the page where the new thing lives
      // so the host UI can offer an "Open …" follow-up.
      const openPage = BUILD_RESULT_PAGES[action.entity] ? BUILD_RESULT_PAGES[action.entity](action, row) : null;
      return res.json({ ok: true, result: row, ...(openPage ? { open_path: openPage.path, open_label: openPage.label } : {}) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // applyAction raises typed errors for route-equivalent rejections (409
      // duplicate custom field, 400 invalid config) — surface them as such.
      if (Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
        return res.status(err.status).json({ error: err.message });
      }
      console.error('actions/apply txn failed:', err);
      return res.status(500).json({ error: 'Failed to apply action', detail: err.message });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('actions/apply error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// CHAT-FIRST COPILOT — POST /api/ai/chat (+ session listing endpoints)
//
// Multi-turn conversational interface. Each call:
//   1. Resolves or creates a chat_sessions row (scoped to req.userId/orgId).
//   2. Loads the last N messages as Claude conversation history.
//   3. Runs the tool-use agent loop (ai.runChatTurn). Tool execution is
//      hard-scoped to req.orgId — we NEVER trust Claude's claimed scope.
//   4. Persists the user + assistant turns to chat_messages.
//   5. Emits structured `actions[]` derived from the tool calls Claude made
//      so the frontend can render action chips.
//
// Daily cap (200 messages/user) is enforced via a single COUNT query before
// burning the Claude call. Rate-limit middleware enforces the burst cap.
// ============================================================================

const HISTORY_LIMIT = 12; // how many past turns we feed back to Claude
const DAILY_MESSAGE_CAP = 200;

// Per-tool handlers. Each one receives (input, ctx) where ctx = { orgId,
// userId, qs } — and returns a serializable result. Errors thrown here bubble
// up to runChatTurn which surfaces { error } back to Claude so the model can
// recover gracefully.
function buildChatToolRunner(req) {
  const [sf, sv] = qs(req);

  async function list_deals(input) {
    const { stage, phase, deal_type, hot, min_amount, search } = input || {};
    let q = `SELECT d.id, d.title, d.stage, d.phase, d.deal_type, d.amount, d.expected_close_date,
                    d.last_activity_at, d.hot_flag,
                    cu.name AS customer_name
             FROM deals d
             LEFT JOIN companies cu ON d.customer_id = cu.id
             WHERE d.${sf} = $1`;
    const params = [sv];
    if (stage)      { q += ` AND d.stage = $${params.length + 1}`; params.push(stage); }
    if (phase)      { q += ` AND d.phase = $${params.length + 1}`; params.push(phase); }
    if (deal_type)  { q += ` AND d.deal_type = $${params.length + 1}`; params.push(String(deal_type).toLowerCase()); }
    if (hot === true) { q += ` AND d.hot_flag = TRUE`; }
    if (typeof min_amount === 'number') { q += ` AND d.amount >= $${params.length + 1}`; params.push(min_amount); }
    if (search)     { q += ` AND d.title ILIKE $${params.length + 1}`; params.push(`%${search}%`); }
    q += ' ORDER BY d.amount DESC NULLS LAST, d.last_activity_at DESC NULLS LAST LIMIT 20';
    const r = await pool.query(q, params);
    return { rows: r.rows };
  }

  async function get_deal(input) {
    const id = Number(input?.deal_id);
    if (!Number.isInteger(id)) return { error: 'deal_id must be an integer' };
    const ctx = await loadDealContext(req, id);
    if (!ctx) return { error: `Deal ${id} not found in your org` };
    return {
      deal: {
        id: ctx.deal.id, title: ctx.deal.title, stage: ctx.deal.stage, phase: ctx.deal.phase,
        amount: ctx.deal.amount, expected_close_date: ctx.deal.expected_close_date,
        customer_name: ctx.deal.customer_name, vendor_name: ctx.deal.vendor_name,
        last_activity_at: ctx.deal.last_activity_at, hot_flag: ctx.deal.hot_flag,
        notes: ctx.deal.notes,
      },
      vendor_quotes: ctx.vendorQuotes.map(v => ({
        vendor_name: v.vendor_name, amount: v.amount, is_selected: v.is_selected, status: v.status,
      })),
      open_issues: ctx.issues.map(i => ({ title: i.title, urgency: i.urgency, status: i.status })),
      last_activities: ctx.lastActivities.slice(0, 5).map(a => ({
        type: a.type, title: a.title, activity_date: a.activity_date,
      })),
    };
  }

  async function list_overdue_tasks() {
    const r = await pool.query(
      `SELECT id, title, due_date, priority, deal_id, contact_id
       FROM tasks WHERE ${sf} = $1 AND status = 'open' AND due_date < CURRENT_DATE
       ORDER BY due_date ASC LIMIT 20`,
      [sv]
    );
    return { rows: r.rows };
  }

  async function list_dormant_deals(input) {
    const days = Number.isInteger(input?.days) ? input.days : 30;
    const r = await pool.query(
      `SELECT d.id, d.title, d.stage, d.amount, d.last_activity_at, cu.name AS customer_name
       FROM deals d
       LEFT JOIN companies cu ON d.customer_id = cu.id
       WHERE d.${sf} = $1
         AND d.phase IN ('pre_sale', 'post_sale')
         AND (d.last_activity_at IS NULL OR d.last_activity_at < NOW() - ($2 || ' days')::interval)
       ORDER BY d.last_activity_at ASC NULLS FIRST, d.amount DESC NULLS LAST
       LIMIT 20`,
      [sv, String(days)]
    );
    return { rows: r.rows, days };
  }

  async function list_at_risk_accounts(input) {
    const band = (input?.band === 'red' || input?.band === 'yellow') ? input.band : null;
    // Latest snapshot per (company) for this org, then keep only yellow/red.
    // DISTINCT ON gives us the most recent row per company; the outer filter
    // selects the at-risk bands. Org-scoped via [sf, sv].
    const params = [sv];
    let bandClause = `latest.band IN ('red', 'yellow')`;
    if (band) { bandClause = `latest.band = $${params.length + 1}`; params.push(band); }
    const r = await pool.query(
      `SELECT latest.company_id, c.name AS company_name, latest.score, latest.band,
              latest.signals, latest.computed_at
         FROM (
           SELECT DISTINCT ON (s.company_id)
                  s.company_id, s.score, s.band, s.signals, s.computed_at
             FROM account_health_snapshots s
            WHERE s.${sf} = $1
            ORDER BY s.company_id, s.computed_at DESC
         ) latest
         LEFT JOIN companies c ON c.id = latest.company_id AND c.${sf} = $1
        WHERE ${bandClause}
        ORDER BY latest.score ASC NULLS FIRST
        LIMIT 20`,
      params
    );
    return { rows: r.rows };
  }

  async function list_hot_deals() {
    const r = await pool.query(
      `SELECT d.id, d.title, d.stage, d.amount, d.expected_close_date, d.last_activity_at,
              cu.name AS customer_name
       FROM deals d
       LEFT JOIN companies cu ON d.customer_id = cu.id
       WHERE d.${sf} = $1 AND d.hot_flag = TRUE AND d.phase = 'pre_sale'
       ORDER BY d.amount DESC NULLS LAST
       LIMIT 20`,
      [sv]
    );
    return { rows: r.rows };
  }

  async function summarize_attention() {
    // Mirror the metricsRoutes.js dashboard logic so the copilot speaks the
    // same numbers as the dashboard the user sees.
    const [totals, issuesAgg, tasksAgg] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE hot_flag = TRUE AND phase = 'pre_sale') AS hot_count,
           COUNT(*) FILTER (WHERE phase IN ('pre_sale','post_sale')) AS active_deals,
           COALESCE(SUM(amount) FILTER (WHERE phase = 'pre_sale'), 0) AS pre_sale_value
         FROM deals WHERE ${sf} = $1`,
        [sv]
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'open' AND urgency = 'red') AS red_open,
           COUNT(*) FILTER (WHERE status = 'open' AND blocks_workflow) AS blocking_open
         FROM issues WHERE ${sf} = $1`,
        [sv]
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'open' AND due_date < CURRENT_DATE) AS overdue_tasks
         FROM tasks WHERE ${sf} = $1`,
        [sv]
      ),
    ]);
    return {
      hot_deals: Number(totals.rows[0].hot_count || 0),
      active_deals: Number(totals.rows[0].active_deals || 0),
      pre_sale_pipeline_value: Number(totals.rows[0].pre_sale_value || 0),
      blocking_issues: Number(issuesAgg.rows[0].blocking_open || 0),
      red_urgency_issues: Number(issuesAgg.rows[0].red_open || 0),
      overdue_tasks: Number(tasksAgg.rows[0].overdue_tasks || 0),
    };
  }

  async function draft_email_for_deal(input) {
    const id = Number(input?.deal_id);
    if (!Number.isInteger(id)) return { error: 'deal_id must be an integer' };
    const ctx = await loadDealContext(req, id);
    if (!ctx) return { error: `Deal ${id} not found in your org` };
    const draft = await ai.draftFollowUp({
      deal: ctx.deal,
      recipient: 'customer',
      tone: 'professional',
      customNote: input?.intent || '',
      orgId: req.orgId,
      userId: req.userId,
    });
    if (!draft.ok) return { error: draft.error || 'draft failed' };
    return { draft: draft.text, deal_id: id, deal_title: ctx.deal.title };
  }

  // ==========================================================================
  // MODULE READ TOOLS — leads / cases / meetings / sequences.
  // Same org-scoping contract as the tools above ([sf, sv] closure; the model
  // never supplies scope). Each flagged handler mirrors the requireFeature
  // mount of the matching /api route: org-less personal workspaces fail-open
  // (there is no other tenant to gate against — see middleware/featureGate.js),
  // an org with the module off gets a structured FEATURE_DISABLED error the
  // copilot can relay honestly instead of hallucinating data.
  // ==========================================================================

  async function moduleDisabled(flag) {
    if (!req.orgId) return null; // personal workspace → fail-open, like featureGate
    const enabled = await featureFlags.hasFeature(req.orgId, flag);
    if (enabled) return null;
    return {
      error: `The module gated by "${flag}" is not enabled for this organization. An org owner/admin can turn it on at /admin/feature-flags (or you can propose it with propose_set_feature_flag).`,
      code: 'FEATURE_DISABLED',
      feature: flag,
    };
  }

  async function list_leads(input) {
    const denied = await moduleDisabled('leads_enabled');
    if (denied) return denied;
    const LEAD_STATUSES = ['new', 'working', 'qualified', 'unqualified', 'converted'];
    const status = LEAD_STATUSES.includes(input?.status) ? input.status : null;
    const search = typeof input?.search === 'string' ? input.search.slice(0, 120) : null;
    let q = `SELECT id, name, email, company_name, source, status, owner_user_id, created_at
               FROM leads
              WHERE ${sf} = $1`;
    const params = [sv];
    if (status) { q += ` AND status = $${params.length + 1}`; params.push(status); }
    if (search) { q += ` AND (name ILIKE $${params.length + 1} OR company_name ILIKE $${params.length + 1})`; params.push(`%${search}%`); }
    q += ' ORDER BY created_at DESC LIMIT 20';
    const r = await pool.query(q, params);
    return { rows: r.rows };
  }

  async function list_open_cases(input) {
    const denied = await moduleDisabled('customer_success_enabled');
    if (denied) return denied;
    const CASE_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
    const priority = CASE_PRIORITIES.includes(input?.priority) ? input.priority : null;
    const companyId = Number.isInteger(input?.company_id) ? input.company_id : null;
    // Open = anything not resolved/closed (matches the SLA partial index).
    // sla_breached is computed server-side so the model never does date math.
    let q = `SELECT cs.id, cs.subject, cs.status, cs.priority, cs.sla_due_at, cs.created_at,
                    cs.company_id, c.name AS company_name,
                    (cs.sla_due_at IS NOT NULL AND cs.sla_due_at < NOW()) AS sla_breached
               FROM cases cs
               LEFT JOIN companies c ON c.id = cs.company_id AND c.${sf} = $1
              WHERE cs.${sf} = $1 AND cs.status NOT IN ('resolved', 'closed')`;
    const params = [sv];
    if (priority)  { q += ` AND cs.priority = $${params.length + 1}`; params.push(priority); }
    if (companyId) { q += ` AND cs.company_id = $${params.length + 1}`; params.push(companyId); }
    q += ` ORDER BY cs.sla_due_at ASC NULLS LAST, cs.created_at ASC LIMIT 20`;
    const r = await pool.query(q, params);
    return { rows: r.rows };
  }

  async function list_upcoming_meetings(input) {
    // In-app meetings are core CRM (the /api/meetings mount is ungated) — no
    // module flag here, matching backend/index.js.
    const days = clampInt(input?.days, 7, 1, 90);
    const r = await pool.query(
      `SELECT m.id, m.title, m.starts_at, m.ends_at, m.location,
              m.company_id, c.name AS company_name, m.deal_id, m.contact_id
         FROM meetings m
         LEFT JOIN companies c ON c.id = m.company_id AND c.${sf} = $1
        WHERE m.${sf} = $1
          AND m.starts_at >= NOW()
          AND m.starts_at < NOW() + ($2 || ' days')::interval
        ORDER BY m.starts_at ASC
        LIMIT 20`,
      [sv, String(days)]
    );
    return { rows: r.rows, window_days: days };
  }

  async function list_sequences() {
    const denied = await moduleDisabled('campaigns_enabled');
    if (denied) return denied;
    // Enrollments inherit the sequence's org (FK, stamped at enroll time), so
    // scoping the sequences side scopes the join. Status values from
    // services/sequences.js ENROLLMENT_STATUSES.
    const r = await pool.query(
      `SELECT s.id, s.name, s.is_active, s.created_at,
              (SELECT COUNT(*)::int FROM sequence_steps st WHERE st.sequence_id = s.id) AS step_count,
              COUNT(e.id) FILTER (WHERE e.status = 'active')::int    AS active_enrollments,
              COUNT(e.id) FILTER (WHERE e.status = 'completed')::int AS completed_enrollments
         FROM sequences s
         LEFT JOIN sequence_enrollments e ON e.sequence_id = s.id
        WHERE s.${sf} = $1
        GROUP BY s.id
        ORDER BY s.created_at DESC
        LIMIT 20`,
      [sv]
    );
    return { rows: r.rows };
  }

  // ==========================================================================
  // DEBUG-SURFACE TOOL HANDLERS — every handler is hard-scoped to req.orgId
  // via the `sf`/`sv` closure captured at the top of buildChatToolRunner.
  // The Claude-supplied input never carries org context; we ignore any field
  // shaped like org_id even if the model tries to add one.
  //
  // Every handler emits an audit row via audit.fromReq(...) tagged with
  // EVENTS.DEBUG_TOOL_INVOKED so the support team can analyze invocation
  // patterns later. Audit writes are fire-and-forget — a failed audit log
  // must NEVER block the tool result.
  // ==========================================================================

  // Clamp + sanitize a numeric input. Returns the default if input is missing
  // or out of bounds.
  function clampInt(v, def, min, max) {
    const n = Number(v);
    if (!Number.isInteger(n)) return def;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function logDebugInvocation(toolName, args, scope) {
    audit.fromReq(req, {
      event: audit.EVENTS.DEBUG_TOOL_INVOKED,
      targetType: 'chat_session',
      success: true,
      meta: { tool: toolName, args: args || {}, scope },
    });
  }

  async function recent_audit_events(input) {
    const limit  = clampInt(input?.limit, 20, 1, 100);
    const hours  = clampInt(input?.hours, 72, 1, 720);
    const prefix = typeof input?.event_prefix === 'string' ? input.event_prefix.slice(0, 64) : null;
    const ttype  = typeof input?.target_type  === 'string' ? input.target_type.slice(0, 64)  : null;
    logDebugInvocation('recent_audit_events', { limit, hours, prefix, ttype }, 'org');
    const conds = [`org_id = $1`, `created_at > NOW() - ($2 || ' hours')::interval`];
    const params = [req.orgId, String(hours)];
    if (prefix) { conds.push(`event LIKE $${params.length + 1}`); params.push(prefix + '%'); }
    if (ttype)  { conds.push(`target_type = $${params.length + 1}`); params.push(ttype); }
    const r = await pool.query(
      `SELECT created_at AS time, event, success, meta, target_type, target_id, actor_user_id AS user_id
         FROM audit_log
        WHERE ${conds.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT $${params.length + 1}`,
      [...params, limit]
    );
    return { rows: r.rows, window_hours: hours };
  }

  async function inspect_plugin_run(input) {
    const id = Number(input?.run_id);
    if (!Number.isInteger(id)) return { error: 'run_id must be an integer' };
    logDebugInvocation('inspect_plugin_run', { run_id: id }, 'org');
    // org_id filter in the WHERE clause is the structural cross-tenant block.
    const r = await pool.query(
      `SELECT id, plugin_id, org_id, started_at, ended_at, status, error_message,
              result_summary, trigger_kind, trigger_source, triggered_by,
              cpu_ms, db_queries, egress_bytes,
              input_payload, output_payload, log_lines
         FROM plugin_runs
        WHERE id = $1 AND org_id = $2`,
      [id, req.orgId]
    );
    if (r.rows.length === 0) return { error: `plugin_run ${id} not found in your org` };
    return { run: r.rows[0] };
  }

  async function recent_plugin_failures(input) {
    const hours = clampInt(input?.hours, 24, 1, 720);
    const limit = clampInt(input?.limit, 20, 1, 50);
    const pluginId = Number.isInteger(input?.plugin_id) ? input.plugin_id : null;
    logDebugInvocation('recent_plugin_failures', { hours, limit, pluginId }, 'org');
    const conds = [
      `org_id = $1`,
      `status NOT IN ('success', 'ok', 'running')`,
      `started_at > NOW() - ($2 || ' hours')::interval`,
    ];
    const params = [req.orgId, String(hours)];
    if (pluginId !== null) {
      conds.push(`plugin_id = $${params.length + 1}`);
      params.push(pluginId);
    }
    const r = await pool.query(
      `SELECT id AS run_id, plugin_id, started_at, ended_at, status, error_message,
              cpu_ms, db_queries, trigger_source, triggered_by
         FROM plugin_runs
        WHERE ${conds.join(' AND ')}
        ORDER BY started_at DESC
        LIMIT $${params.length + 1}`,
      [...params, limit]
    );
    return { rows: r.rows, window_hours: hours };
  }

  // Truncate a log_lines array to the most recent N entries so the chat reply
  // doesn't blow past the tool-result size budget for a chatty plugin. We
  // keep the tail (most recent) since errors usually log just before throwing.
  function tailLogLines(lines, n = 50) {
    if (!Array.isArray(lines)) return [];
    return lines.length > n ? lines.slice(-n) : lines;
  }

  async function run_plugin(input) {
    const explicitId   = Number.isInteger(input?.plugin_id) ? input.plugin_id : null;
    const nameQuery    = typeof input?.plugin_name === 'string' ? input.plugin_name.trim() : '';
    const inputPayload = (input?.input_payload && typeof input.input_payload === 'object') ? input.input_payload : {};
    logDebugInvocation('run_plugin', { plugin_id: explicitId, plugin_name: nameQuery || null }, 'org');

    if (!req.orgId) {
      return { error: 'Org context required', code: 'ORG_REQUIRED' };
    }

    // Same 60/min/user budget as POST /api/plugins/:id/run — the chat path
    // must not be a rate-limit bypass. Shares the pluginRunLimiter store, so
    // manual runs and chat runs draw from ONE allowance.
    const allowance = await consumePluginRunAllowance(req);
    if (!allowance.allowed) {
      return {
        error: 'Too many plugin runs. Try again in a minute.',
        code: 'PLUGIN_RUN_RATE_LIMIT',
      };
    }

    // Resolve target plugin. Prefer the explicit integer id; fall back to
    // case-insensitive substring on name. Multiple name matches → ambiguous,
    // surface the candidate list so the model can ask the user to pick.
    let plugin = null;
    if (explicitId !== null) {
      const r = await pool.query(
        `SELECT id, name, status FROM plugins WHERE id = $1 AND org_id = $2`,
        [explicitId, req.orgId]
      );
      plugin = r.rows[0] || null;
    } else if (nameQuery) {
      const r = await pool.query(
        `SELECT id, name, status FROM plugins
          WHERE org_id = $1 AND name ILIKE $2
          ORDER BY name ASC
          LIMIT 10`,
        [req.orgId, `%${nameQuery}%`]
      );
      if (r.rows.length > 1) {
        return {
          error: `Multiple plugins match "${nameQuery}". Ask the user which one.`,
          code: 'AMBIGUOUS_NAME',
          candidates: r.rows.map(p => ({ id: p.id, name: p.name })),
        };
      }
      plugin = r.rows[0] || null;
    } else {
      return {
        error: 'Either plugin_id or plugin_name is required.',
        code: 'PLUGIN_REF_REQUIRED',
      };
    }

    if (!plugin) {
      return { error: 'PLUGIN_NOT_FOUND', code: 'PLUGIN_NOT_FOUND' };
    }
    // The runner treats `status='active'` as enabled (services/pluginRunner.js).
    // A draft / suspended plugin is "not enabled" from the customer's POV.
    if (plugin.status !== 'active') {
      return {
        error: 'PLUGIN_DISABLED',
        code: 'PLUGIN_DISABLED',
        plugin_id: plugin.id,
        name: plugin.name,
        status: plugin.status,
        hint: 'Open the plugin and toggle it on, or ask me to enable it.',
      };
    }

    // Invoke through the same runner /api/plugins/:id/run uses. ALWAYS go
    // through the sandbox — never bypass. trigger_kind='chat' marks the run
    // in plugin_runs so we can later analyze "how often does chat invoke
    // plugins" without joining audit_log.
    //
    // CONFIRM-FIRST: runs in the default 'preview' posture. Any write the
    // plugin attempts is captured as a proposal, NOT committed — the plugin
    // cannot write directly from chat any more than from the /run route. The
    // user applies proposed changes on the plugin page (POST /:id/apply).
    const result = await pluginRunner.run({
      pluginId:      plugin.id,
      orgId:         req.orgId,
      userId:        req.userId,
      triggerKind:   'chat',
      triggerSource: 'copilot',
      triggerData:   inputPayload,
      input:         inputPayload,
    });

    // Re-fetch the persisted row so the model sees the same fields the runs
    // UI sees (result_summary, log_lines truncated, error_message, etc.).
    // Runner returns runId on success and most failure paths; fall back to
    // the in-memory `result` shape if the row isn't queryable.
    let runRow = null;
    if (result.runId) {
      const r = await pool.query(
        `SELECT id, plugin_id, started_at, ended_at, status, error_message,
                result_summary, trigger_kind, trigger_source, triggered_by,
                cpu_ms, db_queries, log_lines
           FROM plugin_runs
          WHERE id = $1 AND org_id = $2`,
        [result.runId, req.orgId]
      );
      runRow = r.rows[0] || null;
    }
    const raw = runRow || {
      id: result.runId || null,
      plugin_id: plugin.id,
      status: result.status,
      error_message: result.error || null,
      cpu_ms: result.cpu_ms || 0,
      db_queries: result.db_queries || 0,
      log_lines: result.logs || [],
      result_summary: null,
    };

    // Surface the confirm-first proposals so the copilot tells the user the
    // truth: nothing was written; N change(s) are staged for their approval.
    const proposedActions = Array.isArray(result.proposed_actions) ? result.proposed_actions : [];

    return {
      run: {
        ...raw,
        log_lines: tailLogLines(raw.log_lines, 50),
        friendly_status: friendlyStatus(raw.status),
      },
      plugin_id: plugin.id,
      plugin_name: plugin.name,
      // Confirm-first: writes are NOT applied. The user must approve them.
      proposed_actions: proposedActions,
      proposed_change_count: proposedActions.length,
      writes_applied: false,
      apply_hint: proposedActions.length > 0
        ? `This run proposed ${proposedActions.length} change(s). Nothing was written. Open the plugin's page and click "Apply" (or run POST /api/plugins/${plugin.id}/apply with runId ${result.runId}) to commit them.`
        : undefined,
    };
  }

  async function describe_plugin(input) {
    const id = Number(input?.plugin_id);
    if (!Number.isInteger(id)) return { error: 'plugin_id must be an integer' };
    logDebugInvocation('describe_plugin', { plugin_id: id }, 'org');
    const r = await pool.query(
      `SELECT id, name, description, status, source_kind, trigger_event,
              trigger_filter_json, spec_json
         FROM plugins
        WHERE id = $1 AND ${sf} = $2`,
      [id, sv]
    );
    if (r.rows.length === 0) return { error: `plugin ${id} not found in your org` };
    const p = r.rows[0];
    // Expose only action kinds + optional `label` / `title_template` / `kind`
    // descriptors. We deliberately do NOT return `source_code` — the read-back
    // tool is for explaining intent, not for inspecting the executable body.
    // A field-by-field whitelist also stops a future spec_json shape change
    // from accidentally leaking secrets stored inside an action.
    const rawActions = Array.isArray(p.spec_json?.actions) ? p.spec_json.actions : [];
    const SAFE_KEYS = ['kind', 'label', 'title_template', 'due_in_days', 'subject_template', 'store_as', 'entity', 'field'];
    const actions = rawActions.slice(0, 20).map(a => {
      const safe = {};
      if (a && typeof a === 'object') {
        for (const k of SAFE_KEYS) {
          if (a[k] !== undefined) safe[k] = a[k];
        }
      }
      return safe;
    });
    return {
      plugin: {
        id: p.id,
        name: p.name,
        description: p.description,
        status: p.status,
        source_kind: p.source_kind,
        trigger_event: p.trigger_event,
        trigger_filter: p.trigger_filter_json || null,
        summary: p.spec_json?.summary || null,
        actions,
      },
    };
  }

  // Extension library read surface — "what extensions do you have for
  // follow-ups?". Curated catalog + the org's install status (one query),
  // filterable by category / tag / free-text search. Read-only; installing is
  // the confirm-first propose_install_extension.
  async function list_extensions(input) {
    const denied = await moduleDisabled('plugins_enabled');
    if (denied) return denied;
    const category = typeof input?.category === 'string' ? input.category.trim().toLowerCase() : null;
    const tag      = typeof input?.tag === 'string' ? input.tag.trim().toLowerCase() : null;
    const search   = typeof input?.search === 'string' ? input.search.trim().toLowerCase() : null;

    let items = pluginLibrary.list();
    const categories = Array.from(new Set(items.map((i) => i.category))).sort();
    // Install status is best-effort — a lookup failure degrades to the bare
    // catalog rather than failing the read.
    try {
      const statusBySlug = await extensionInstall.getLibraryStatusForOrg(req.orgId);
      items = extensionInstall.enrichLibraryList(items, statusBySlug);
    } catch { /* catalog without status */ }

    if (category) items = items.filter((i) => String(i.category || '').toLowerCase() === category);
    if (tag)      items = items.filter((i) => (i.tags || []).some((t) => String(t).toLowerCase().includes(tag)));
    if (search) {
      items = items.filter((i) =>
        [i.name, i.slug, i.summary, ...(i.tags || [])].join(' ').toLowerCase().includes(search));
    }

    return {
      extensions: items.slice(0, 50).map((i) => ({
        slug: i.slug,
        name: i.name,
        category: i.category,
        summary: i.summary,
        tags: i.tags || [],
        trigger_event: i.triggerEvent,
        required_integration: i.requiredIntegration || null,
        installed: !!i.installed,
        active: !!i.active,
        ...(i.installed_plugin_id ? { installed_plugin_id: i.installed_plugin_id } : {}),
      })),
      total: items.length,
      categories,
      note: 'Enable one with propose_install_extension (an org owner/admin applies; it installs AND turns the extension on). The gallery lives at /plugins/library.',
    };
  }

  async function email_send_history(input) {
    const limit      = clampInt(input?.limit, 20, 1, 50);
    const contactId  = Number.isInteger(input?.contact_id)  ? input.contact_id  : null;
    const dealId     = Number.isInteger(input?.deal_id)     ? input.deal_id     : null;
    const templateId = Number.isInteger(input?.template_id) ? input.template_id : null;
    logDebugInvocation('email_send_history', { contactId, dealId, templateId, limit }, 'org');
    const conds  = [`es.org_id = $1`];
    const params = [req.orgId];
    if (contactId  !== null) { conds.push(`es.to_contact_id = $${params.length + 1}`); params.push(contactId); }
    if (dealId     !== null) { conds.push(`es.to_deal_id    = $${params.length + 1}`); params.push(dealId); }
    if (templateId !== null) { conds.push(`es.template_id   = $${params.length + 1}`); params.push(templateId); }
    const r = await pool.query(
      `SELECT es.id, es.sent_at, es.to_email, es.subject, es.template_id,
              es.to_contact_id, es.to_deal_id, es.opened_at,
              es.provider_message_id IS NOT NULL AS provider_dispatched,
              eu.unsubscribed_at
         FROM email_sends es
         LEFT JOIN email_unsubscribes eu
                ON eu.org_id = es.org_id
               AND eu.email  = es.to_email
               AND eu.unsubscribed_at IS NOT NULL
        WHERE ${conds.join(' AND ')}
        ORDER BY es.sent_at DESC
        LIMIT $${params.length + 1}`,
      [...params, limit]
    );
    return { rows: r.rows };
  }

  async function notification_diagnostic(input) {
    const requestedId = Number.isInteger(input?.user_id) ? input.user_id : null;
    // Non-super-admin callers can only inspect themselves.
    const isSuper = req.adminRole === 'super_admin';
    const targetUserId = (requestedId !== null && (isSuper || requestedId === req.userId))
      ? requestedId
      : req.userId;
    if (requestedId !== null && requestedId !== req.userId && !isSuper) {
      logDebugInvocation('notification_diagnostic', { requestedId, fallback: 'self' }, 'org');
      return {
        error: 'You can only inspect your own notification settings. Super-admins can inspect any user.',
        code: 'NOT_AUTHORIZED',
      };
    }
    logDebugInvocation('notification_diagnostic', { user_id: targetUserId }, isSuper && requestedId ? 'super_admin' : 'org');
    // For org users (non-super), enforce same-org constraint.
    const u = await pool.query(
      `SELECT id, email, name, org_id, notification_preferences,
              notification_email, notification_phone
         FROM users WHERE id = $1`,
      [targetUserId]
    );
    if (u.rows.length === 0) return { error: `user ${targetUserId} not found` };
    const userRow = u.rows[0];
    if (!isSuper && userRow.org_id !== req.orgId) {
      return { error: 'Cross-org lookup blocked.', code: 'NOT_AUTHORIZED' };
    }
    // Recent task_assigned / overdue audit events for this user.
    const recent = await pool.query(
      `SELECT created_at AS time, event, success, meta
         FROM audit_log
        WHERE actor_user_id = $1
          AND (event LIKE 'task.%' OR event LIKE 'me.notification%' OR event LIKE 'email.%')
          AND created_at > NOW() - INTERVAL '7 days'
        ORDER BY created_at DESC
        LIMIT 10`,
      [targetUserId]
    );
    const smsConfigured = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
    const emailConfigured = !!(process.env.SENDGRID_API_KEY || process.env.SMTP_HOST);
    return {
      user: {
        id: userRow.id,
        login_email: userRow.email,
        name: userRow.name,
        notification_email: userRow.notification_email,
        effective_notification_email: userRow.notification_email || userRow.email,
        notification_phone: userRow.notification_phone,
        notification_preferences: userRow.notification_preferences || {},
      },
      platform: {
        sms_configured: smsConfigured,
        email_configured: emailConfigured,
      },
      recent_notification_events: recent.rows,
      hints: [
        userRow.notification_phone ? null : 'No notification_phone set — SMS is OFF for this user regardless of toggle state.',
        smsConfigured ? null : 'Platform Twilio credentials not set — SMS is OFF globally.',
        emailConfigured ? null : 'No SENDGRID_API_KEY or SMTP_HOST set — emails fall back to console-only.',
      ].filter(Boolean),
    };
  }

  async function saved_view_info(input) {
    const id = Number(input?.view_id);
    if (!Number.isInteger(id)) return { error: 'view_id must be an integer' };
    logDebugInvocation('saved_view_info', { view_id: id }, 'org');
    // A saved view is visible if it belongs to this user OR is_shared=TRUE on
    // an org the caller belongs to.
    const r = await pool.query(
      `SELECT sv.id, sv.user_id, sv.org_id, sv.resource, sv.name,
              sv.filter_spec, sv.sort_spec, sv.is_default, sv.is_shared,
              sv.display_order, sv.created_at, sv.updated_at,
              u.email AS creator_email, u.name AS creator_name
         FROM saved_views sv
         LEFT JOIN users u ON u.id = sv.user_id
        WHERE sv.id = $1
          AND (sv.user_id = $2 OR (sv.is_shared = TRUE AND sv.org_id = $3))`,
      [id, req.userId, req.orgId]
    );
    if (r.rows.length === 0) return { error: `saved_view ${id} not found or not visible to you` };
    return { view: r.rows[0] };
  }

  async function custom_field_status(input) {
    const entity = String(input?.entity || '');
    if (!['companies', 'contacts', 'deals', 'tasks'].includes(entity)) {
      return { error: 'entity must be one of companies, contacts, deals, tasks' };
    }
    logDebugInvocation('custom_field_status', { entity }, 'org');
    // Static table allowlist already enforced above — safe to interpolate.
    const defs = await pool.query(
      `SELECT id, name, label, type, options, required, position, created_at
         FROM org_field_definitions
        WHERE org_id = $1 AND entity = $2
        ORDER BY position ASC, name ASC`,
      [req.orgId, entity]
    );
    // Sample five recent rows of that entity's custom_fields. The scope column
    // matches the entity's org_id/user_id pattern via qs(req) — safe because
    // each entity table follows the same convention.
    const samples = await pool.query(
      `SELECT id, custom_fields
         FROM ${entity}
        WHERE ${sf} = $1 AND custom_fields IS NOT NULL AND custom_fields::text <> '{}'
        ORDER BY created_at DESC NULLS LAST
        LIMIT 5`,
      [sv]
    );
    return {
      entity,
      definitions: defs.rows,
      sample_values: samples.rows,
    };
  }

  async function try_api(input) {
    const method = String(input?.method || '').toUpperCase();
    const path   = String(input?.path || '');
    logDebugInvocation('try_api', { method, path }, 'org');
    if (method !== 'GET') {
      return {
        error: 'try_api is read-only — call those endpoints from the actual UI. Only GET is allowed.',
        code: 'METHOD_NOT_ALLOWED',
      };
    }
    if (!path.startsWith('/api/')) {
      return { error: 'path must start with /api/' };
    }
    // Re-dispatch the GET back through the express app so middleware + auth
    // run exactly as a real request would. We use a synthetic in-process
    // fetch by replaying through the same router using a stub req/res.
    // Simplest implementation: use the global fetch back to the same host
    // is NOT safe (the request loses the user's auth cookie). Instead, run
    // the path through the actual `req.app` handler with a mock res object.
    return await new Promise((resolve) => {
      try {
        const mockReq = Object.create(req);
        mockReq.method = 'GET';
        mockReq.url = path;
        mockReq.originalUrl = path;
        mockReq.body = {};
        // Strip any query string from path-only routing key
        const qIdx = path.indexOf('?');
        mockReq.path = qIdx >= 0 ? path.slice(0, qIdx) : path;
        mockReq.query = {};
        if (qIdx >= 0) {
          const qstr = path.slice(qIdx + 1);
          for (const pair of qstr.split('&')) {
            const [k, v = ''] = pair.split('=');
            if (k) mockReq.query[decodeURIComponent(k)] = decodeURIComponent(v);
          }
        }
        let statusCode = 200;
        const chunks = [];
        const headers = {};
        let finished = false;
        const finalize = () => {
          if (finished) return;
          finished = true;
          const bodyText = Buffer.concat(
            chunks.map(c => Buffer.isBuffer(c) ? c : Buffer.from(String(c)))
          ).toString('utf8').slice(0, 2048);
          resolve({ status: statusCode, body_preview: bodyText, truncated: bodyText.length >= 2048 });
        };
        const mockRes = {
          statusCode: 200,
          setHeader(k, v) { headers[k] = v; },
          getHeader(k) { return headers[k]; },
          removeHeader(k) { delete headers[k]; },
          status(code) { statusCode = code; this.statusCode = code; return this; },
          set(k, v) { headers[k] = v; return this; },
          json(obj) {
            try { chunks.push(JSON.stringify(obj)); } catch { chunks.push('null'); }
            finalize();
            return this;
          },
          send(data) {
            chunks.push(data == null ? '' : (typeof data === 'object' ? JSON.stringify(data) : String(data)));
            finalize();
            return this;
          },
          end(data) {
            if (data != null) chunks.push(typeof data === 'object' ? JSON.stringify(data) : String(data));
            finalize();
            return this;
          },
          write(data) {
            if (data != null) chunks.push(data);
            return true;
          },
        };
        // Express app is on req.app. Dispatch via its handle method.
        const app = req.app;
        if (!app || typeof app.handle !== 'function') {
          return resolve({ error: 'try_api: express app handle unavailable in this context' });
        }
        // Timeout guard — bound the replay so a slow endpoint doesn't block
        // the chat loop.
        const timer = setTimeout(() => {
          statusCode = 504;
          chunks.push('try_api: replay timed out after 5 s');
          finalize();
        }, 5000);
        try {
          app.handle(mockReq, mockRes, (err) => {
            clearTimeout(timer);
            if (err) {
              statusCode = 500;
              chunks.push(`try_api: ${err.message || 'replay failed'}`);
            } else if (!finished) {
              statusCode = 404;
              chunks.push('try_api: no route matched');
            }
            finalize();
          });
        } catch (err) {
          clearTimeout(timer);
          resolve({ error: 'try_api replay failed: ' + (err.message || 'unknown') });
        }
      } catch (err) {
        resolve({ error: 'try_api setup failed: ' + (err.message || 'unknown') });
      }
    });
  }

  // Static knowledge-base lookup for the most common codebase-specific errors.
  // Pure no-op data-wise: returns a hint string the model can incorporate. We
  // deliberately don't run any DB queries here so the tool stays cheap.
  const ERROR_HINTS = {
    PLUGIN_QUERY_BUDGET_EXCEEDED:
      'The plugin exceeded its per-run DB-query budget (50 calls). See backend/services/pluginSdk.js → MAX_QUERIES_PER_RUN. Refactor the plugin to batch queries or filter earlier.',
    PLUGIN_AI_BUDGET_EXCEEDED:
      'The plugin exceeded its per-run AI budget (2 upstream crm.ai.complete calls). See backend/services/pluginSdk.js → MAX_AI_CALLS_PER_RUN. Batch prompts into fewer calls; unconfigured/billing-blocked attempts do not count.',
    PLUGIN_SANDBOX_UNAVAILABLE:
      'The isolated-vm native module failed to load on this server. Plugins cannot run until the operator fixes the deployment. See backend/services/pluginRunner.js header comment.',
    QUOTA_EXCEEDED:
      'The org hit its free-tier monthly quota for the metric in details.metric. Either upgrade tier (see quotaEnforcer.TIER_QUOTAS) or wait for the next month\'s reset.',
    CHAT_DAILY_CAP:
      'The user sent 200 chat messages in 24 hours. Cap resets in 24 h. See HISTORY_LIMIT / DAILY_MESSAGE_CAP in backend/routes/aiRoutes.js.',
    CHAT_RATE_LIMIT:
      'The user is sending chat messages faster than 20/min. See chatLimiter in backend/middleware/rateLimits.js.',
    CHAT_DEBUG_RATE_LIMIT:
      'Debug-mode chat is rate-limited to 40/min/user. See chatDebugLimiter in backend/middleware/rateLimits.js.',
    AI_NOT_CONFIGURED:
      'ANTHROPIC_API_KEY is not set on the backend. AI features will return 503 until the operator wires it up.',
    EMPTY_FILTER:
      'The conversational-search model could not extract any allowed filter keys from the query. The user should be more specific or pre-select a resource.',
    METHOD_NOT_ALLOWED:
      'try_api only supports GET. Use the real UI for POST/PUT/DELETE.',
  };

  async function explain_error(input) {
    const raw = String(input?.error || '').slice(0, 500);
    logDebugInvocation('explain_error', { error: raw }, 'org');
    // Match by code first (uppercase token), then by case-insensitive substring.
    const codeMatch = raw.match(/[A-Z][A-Z0-9_]{4,}/);
    let hint = null;
    if (codeMatch && ERROR_HINTS[codeMatch[0]]) {
      hint = { code: codeMatch[0], explanation: ERROR_HINTS[codeMatch[0]] };
    } else {
      const lower = raw.toLowerCase();
      for (const [code, exp] of Object.entries(ERROR_HINTS)) {
        if (lower.includes(code.toLowerCase()) || lower.includes(exp.toLowerCase().slice(0, 20))) {
          hint = { code, explanation: exp };
          break;
        }
      }
    }
    if (!hint) {
      return {
        error_string: raw,
        recognized: false,
        hint: 'No specific knowledge-base entry. Look for the error string in backend/services/ or backend/middleware/, then trace where it is thrown. Generic causes: missing env var, missing DB column, downstream API outage.',
      };
    }
    return { error_string: raw, recognized: true, ...hint };
  }

  // ---- Super-admin-only handlers ------------------------------------------
  function requireSuperAdmin(toolName, args) {
    if (req.adminRole !== 'super_admin') {
      // Audit the attempted use so we can spot non-super-admins poking at
      // these tools — useful for permission-creep detection.
      audit.fromReq(req, {
        event: audit.EVENTS.DEBUG_TOOL_INVOKED,
        targetType: 'chat_session',
        success: false,
        meta: { tool: toolName, args: args || {}, scope: 'super_admin', rejected: 'not_authorized' },
      });
      return {
        error: 'not_authorized — this tool requires the super_admin role. Tell the user you can\'t answer this and suggest they ask their platform admin.',
        code: 'NOT_AUTHORIZED',
      };
    }
    return null;
  }

  async function inspect_org(input) {
    const id = Number(input?.org_id);
    if (!Number.isInteger(id)) return { error: 'org_id must be an integer' };
    const denied = requireSuperAdmin('inspect_org', { org_id: id });
    if (denied) return denied;
    logDebugInvocation('inspect_org', { org_id: id }, 'super_admin');
    const orgRow = await pool.query(
      `SELECT id, name, profile, tier, created_at FROM organizations WHERE id = $1`,
      [id]
    );
    if (orgRow.rows.length === 0) return { error: `org ${id} not found` };
    const [userCount, dealCount, auditCount, recentFails] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE org_id = $1`, [id]),
      pool.query(`SELECT COUNT(*)::int AS c FROM deals WHERE org_id = $1`, [id]),
      pool.query(`SELECT COUNT(*)::int AS c FROM audit_log WHERE org_id = $1 AND created_at > NOW() - INTERVAL '30 days'`, [id]),
      pool.query(
        `SELECT created_at AS time, event, success, meta, target_type, target_id, actor_user_id
           FROM audit_log
          WHERE org_id = $1 AND success = FALSE
          ORDER BY created_at DESC LIMIT 10`,
        [id]
      ),
    ]);
    return {
      org: orgRow.rows[0],
      user_count: userCount.rows[0].c,
      deal_count: dealCount.rows[0].c,
      audit_events_last_30d: auditCount.rows[0].c,
      recent_failed_events: recentFails.rows,
    };
  }

  async function inspect_user(input) {
    const id = Number(input?.user_id);
    if (!Number.isInteger(id)) return { error: 'user_id must be an integer' };
    const denied = requireSuperAdmin('inspect_user', { user_id: id });
    if (denied) return denied;
    logDebugInvocation('inspect_user', { user_id: id }, 'super_admin');
    const u = await pool.query(
      `SELECT u.id, u.email, u.name, u.status, u.org_id, u.org_role, u.last_login_at, u.created_at,
              au.role AS admin_role
         FROM users u
         LEFT JOIN admin_users au ON au.user_id = u.id
        WHERE u.id = $1`,
      [id]
    );
    if (u.rows.length === 0) return { error: `user ${id} not found` };
    const events = await pool.query(
      `SELECT created_at AS time, event, success, target_type, target_id, org_id, meta
         FROM audit_log WHERE actor_user_id = $1
         ORDER BY created_at DESC LIMIT 10`,
      [id]
    );
    return { user: u.rows[0], recent_events: events.rows };
  }

  async function cross_org_recent_errors(input) {
    const hours = clampInt(input?.hours, 24, 1, 168);
    const limit = clampInt(input?.limit, 20, 1, 50);
    const denied = requireSuperAdmin('cross_org_recent_errors', { hours, limit });
    if (denied) return denied;
    logDebugInvocation('cross_org_recent_errors', { hours, limit }, 'super_admin');
    const r = await pool.query(
      `SELECT created_at AS time, event, success, meta, target_type, target_id, org_id, actor_user_id
         FROM audit_log
        WHERE success = FALSE
          AND created_at > NOW() - ($1 || ' hours')::interval
        ORDER BY created_at DESC
        LIMIT $2`,
      [String(hours), limit]
    );
    return { rows: r.rows, window_hours: hours };
  }

  // ==========================================================================
  // WRITE-ACTION TOOLS (Spec 200 — confirm-first). Every propose_* handler:
  //   1. Builds an { entity, op, target_id?, fields } from the tool input.
  //   2. Runs chatActions.validateAction (allowlist + type + enum checks).
  //   3. Ownership pre-flight: every referenced *_id and (for updates) the
  //      target itself must belong to the caller's [sf, sv] scope.
  //   4. Audits ai.action_proposed and returns { proposal } — NO WRITE.
  // The lone writer is POST /api/ai/actions/apply, which re-validates.
  // ==========================================================================

  // Pre-flight: confirm every referenced id (and the update target) belongs to
  // the caller's org scope. Returns null on success, or a { error } object.
  async function ownershipPreflight(action) {
    for (const ref of chatActions.referencedIds(action)) {
      const r = await pool.query(
        `SELECT 1 FROM ${ref.table} WHERE id = $1 AND ${sf} = $2`,
        [ref.id, sv]
      );
      if (r.rows.length === 0) {
        return { error: 'not_found_in_org', detail: `${ref.field} #${ref.id} was not found in your org` };
      }
    }
    const spec = chatActions.SPECS[`${action.entity}.${action.op}`];
    if (spec && spec.needsTarget && action.target_id) {
      const r = await pool.query(
        `SELECT 1 FROM ${spec.table} WHERE id = $1 AND ${sf} = $2`,
        [action.target_id, sv]
      );
      if (r.rows.length === 0) {
        return { error: 'not_found_in_org', detail: `${action.entity} #${action.target_id} was not found in your org` };
      }
    }
    return null;
  }

  // Validate -> module-flag gate -> ownership pre-flight -> audit proposed ->
  // return proposal.
  async function buildProposal(entity, op, target_id, fields) {
    const v = chatActions.validateAction({ entity, op, target_id, fields });
    if (!v.ok) return { error: 'invalid', validation_errors: v.errors };
    // Flag-gated entities (lead.create → leads_enabled, case.create →
    // customer_success_enabled) are inert when the org has the module off.
    // The apply endpoint re-checks, so a stale proposal can't sneak a write in.
    const spec = chatActions.SPECS[`${entity}.${op}`];
    if (spec && spec.flag) {
      const flagDenied = await moduleDisabled(spec.flag);
      if (flagDenied) return flagDenied;
    }
    // Workspace-building specs: org context + owner/admin at propose time too
    // (same bar the apply endpoint re-enforces), so a member gets an honest
    // "ask your admin" instead of a card they cannot apply.
    if (spec && spec.requiresOrg && !req.orgId) {
      return { error: 'org_required', detail: 'This needs an organization workspace — personal workspaces have no org-level schema/rules.' };
    }
    if (spec && spec.requiresAdmin && !isOrgAdminReq(req)) {
      return { error: 'not_authorized', detail: `Only an org owner/admin can ${op === 'create' ? 'create' : 'apply'} a ${entity.replace(/_/g, ' ')}. Tell the user to ask their owner/admin (who can make the same request here).` };
    }
    const denied = await ownershipPreflight(v.action);
    if (denied) return denied;
    // Owner assignment: the proposed owner must be a member of the caller's
    // org (recordOwnership.ownerValidationError) — re-checked again at apply.
    if (spec && spec.ownerField) {
      const ownerErr = await ownerValidationError(req, v.action.fields[spec.ownerField]);
      if (ownerErr) return { error: 'invalid_owner', detail: ownerErr };
    }
    audit.fromReq(req, {
      event: audit.EVENTS.AI_ACTION_PROPOSED,
      targetType: v.action.entity,
      targetId: v.action.target_id || null,
      meta: { op: v.action.op, fields: Object.keys(v.action.fields) },
    });
    return { proposal: v.action };
  }

  async function propose_update_deal(input) {
    const { deal_id, ...fields } = input || {};
    return buildProposal('deal', 'update', deal_id, fields);
  }

  async function propose_create_task(input) {
    return buildProposal('task', 'create', undefined, input || {});
  }

  async function propose_log_activity(input) {
    return buildProposal('activity', 'create', undefined, input || {});
  }

  async function propose_upsert_contact(input) {
    const { id, ...fields } = input || {};
    if (id !== undefined) return buildProposal('contact', 'update', id, fields);
    return buildProposal('contact', 'create', undefined, fields);
  }

  async function propose_upsert_company(input) {
    const { id, ...fields } = input || {};
    if (id !== undefined) return buildProposal('company', 'update', id, fields);
    return buildProposal('company', 'create', undefined, fields);
  }

  async function propose_create_lead(input) {
    return buildProposal('lead', 'create', undefined, input || {});
  }

  async function propose_create_case(input) {
    return buildProposal('case', 'create', undefined, input || {});
  }

  async function propose_create_meeting(input) {
    return buildProposal('meeting', 'create', undefined, input || {});
  }

  async function propose_set_lifecycle_stage(input) {
    const { company_id, ...fields } = input || {};
    return buildProposal('company', 'set_lifecycle_stage', company_id, fields);
  }

  async function propose_assign_owner(input) {
    const { entity, record_id, owner_user_id } = input || {};
    if (!['company', 'deal', 'lead'].includes(entity)) {
      return { error: 'invalid', validation_errors: ['entity must be one of: company, deal, lead'] };
    }
    return buildProposal(entity, 'assign_owner', record_id, { owner_user_id });
  }

  async function propose_enroll_in_sequence(input) {
    return buildProposal('sequence', 'enroll', undefined, input || {});
  }

  async function propose_run_playbook(input) {
    return buildProposal('playbook', 'run', undefined, input || {});
  }

  // The cohort harness proposal. Resolves the cohort (saved segment or inline
  // criteria), validates the verb's params, and — critically — counts the
  // CURRENT members and pulls a small sample so the confirm card shows the
  // exact blast radius BEFORE anything writes. Owner/admin-gated at propose
  // time (same bar the apply endpoint re-enforces). NO WRITE happens here.
  async function propose_cohort_action(input) {
    if (!isOrgAdminReq(req)) {
      return { error: 'not_authorized', detail: 'Only an org owner/admin can run cohort actions.' };
    }
    const v0 = chatActions.validateAction({ entity: 'cohort', op: 'action', fields: input || {} });
    if (!v0.ok) return { error: 'invalid', validation_errors: v0.errors };
    const spec = chatActions.SPECS['cohort.action'];
    const flagDenied = await moduleDisabled(spec.flag);
    if (flagDenied) return flagDenied;

    const resolved = await resolveCohortSegment(req, v0.action.fields);
    if (resolved.error) return resolved;
    const segment = resolved.segment;

    // Compile the criteria now (pure, allowlist-enforced) so a bad inline
    // filter surfaces as a friendly error instead of dying at apply.
    try {
      segments.compileCriteria(segment.entity_type, sf, segment.criteria);
    } catch (e) {
      if (e.name === 'CriteriaError') return { error: 'invalid_criteria', detail: e.message };
      throw e;
    }

    const paramsErr = await cohortParamsError(req, segment.entity_type, v0.action.fields.action, v0.action.fields.action_params || {});
    if (paramsErr) return { error: 'invalid_action_params', detail: paramsErr };

    const scope = segmentScope(req);
    const count = await segments.count(scope, segment);
    if (count === 0) {
      return { error: 'empty_cohort', detail: 'No records currently match this cohort — nothing to do.' };
    }
    if (count > segments.MAX_BULK_AFFECTED) {
      return { error: 'over_limit', detail: `This cohort matches ${count} records — over the ${segments.MAX_BULK_AFFECTED} cap for a single action. Narrow the filter and try again.` };
    }
    const sample = await segments.evaluate(scope, segment, { limit: 5 });

    // Re-validate WITH expected_count so the proposal summary states the exact
    // affected count. The apply endpoint re-counts; expected_count is display-
    // only and never trusted.
    const v = chatActions.validateAction({
      entity: 'cohort', op: 'action',
      fields: { ...v0.action.fields, expected_count: count },
    });
    if (!v.ok) return { error: 'invalid', validation_errors: v.errors };

    audit.fromReq(req, {
      event: audit.EVENTS.AI_ACTION_PROPOSED,
      targetType: 'cohort',
      targetId: segment.id || null,
      meta: { op: 'action', fields: Object.keys(v.action.fields), action: v.action.fields.action, count },
    });
    return {
      proposal: v.action,
      cohort_preview: {
        count,
        sample,
        segment: segment.id ? { id: segment.id, name: segment.name, entity_type: segment.entity_type } : { inline: true, entity_type: segment.entity_type },
        note: 'Membership is re-evaluated when the user clicks Apply; nothing has been written.',
      },
    };
  }

  async function propose_set_feature_flag(input) {
    const { flag, enabled } = input || {};
    // feature_flag.set is a service action, not a table write, and has no
    // ownership refs — validateAction is the gate; the role check happens at
    // apply time (only owner/admin/super_admin can flip it).
    const v = chatActions.validateAction({ entity: 'feature_flag', op: 'set', fields: { flag, enabled } });
    if (!v.ok) return { error: 'invalid', validation_errors: v.errors };
    audit.fromReq(req, {
      event: audit.EVENTS.AI_ACTION_PROPOSED,
      targetType: v.action.entity,
      targetId: null,
      meta: { op: v.action.op, fields: Object.keys(v.action.fields) },
    });
    return { proposal: v.action };
  }

  // Build-a-tool-from-chat (confirm-first, TWO gates). This handler:
  //   1. Gates on plugins_enabled BEFORE burning an AI call.
  //   2. Calls the SHARED generation engine (services/pluginGenerator — the
  //      same prompt/parse/retry the /api/plugins/from-prompt route uses,
  //      metered per-org through ai.callClaude like every other AI call).
  //   3. Screens the generated spec through pluginSpecValidator (SDK-method
  //      allowlist + trigger-event allowlist + dangerous-pattern scan).
  //   4. Returns a { proposal } card via buildProposal — NOTHING is saved and
  //      NOTHING runs here. Gate #1: the user clicks Apply and
  //      /api/ai/actions/apply saves the spec as a plugins row with
  //      status='draft'. Gate #2: the draft only ever executes through the
  //      existing plugin run model (sandboxed preview run, then the
  //      owner/admin-gated POST /api/plugins/:id/apply). No new exec path.
  async function propose_build_plugin(input) {
    const denied = await moduleDisabled('plugins_enabled');
    if (denied) return denied;
    const description = typeof input?.description === 'string' ? input.description.trim() : '';
    if (description.length < 10 || description.length > 2000) {
      return { error: 'invalid', validation_errors: ['description must be 10–2000 characters of plain English describing the tool'] };
    }

    const gen = await pluginGenerator.generatePluginSpec({
      description,
      orgId: req.orgId,
      userId: req.userId,
      endpoint: 'chat-plugin-builder',
    });
    if (!gen.ok) {
      if (gen.configured === false) return { error: 'AI is not configured on this server', code: 'AI_NOT_CONFIGURED' };
      if (gen.code === 'QUOTA_EXCEEDED') return { error: gen.error || 'AI quota exceeded', code: 'QUOTA_EXCEEDED' };
      if (gen.parseFailed) return { error: 'The generator returned unparseable output. Ask the user to rephrase the tool description.', code: 'AI_PARSE_FAILED' };
      return { error: gen.error || 'Plugin generation failed', code: gen.code || 'GENERATION_FAILED' };
    }

    const spec = gen.spec || {};
    if (typeof input?.name === 'string' && input.name.trim()) {
      spec.name = input.name.trim().slice(0, 120);
    }
    spec.source_kind = 'conversational';

    // Validator screen BEFORE proposing — an invalid generated spec never
    // becomes a proposal (and so can never reach the plugins table or the
    // runner). buildProposal re-runs this same check via the chatActions spec,
    // and /actions/apply runs it a third time on the untrusted echo.
    const validation = validatePluginSpec(spec);
    if (!validation.ok) {
      return {
        error: 'The generated plugin spec failed validation — tell the user what was rejected and offer to regenerate with a tighter description.',
        code: 'SPEC_REJECTED',
        validation_errors: validation.errors.map((e) => `${e.field}: ${e.message}`),
      };
    }

    const proposal = await buildProposal('plugin', 'create_draft', undefined, {
      name: spec.name,
      description: spec.description || null,
      trigger_event: spec.trigger_event,
      spec_json: spec.spec_json,
      source_code: spec.source_code,
    });
    if (proposal.error) return proposal;
    return {
      ...proposal,
      // Compact preview so the model can narrate what the tool will do
      // without dumping the whole source blob into the reply.
      spec_preview: {
        name: spec.name,
        description: spec.description || null,
        trigger_event: spec.trigger_event,
        action_kinds: Array.isArray(spec.spec_json?.actions) ? spec.spec_json.actions.map((a) => a && a.kind).filter(Boolean) : [],
        source_code_excerpt: typeof spec.source_code === 'string' ? spec.source_code.slice(0, 600) : null,
      },
      note: 'Nothing has been saved or run. Applying saves it as a DRAFT in /plugins; running it later is a separate sandboxed preview + confirm step.',
    };
  }

  // Curated-extension install (confirm-first — mirrors propose_automation_rule
  // exactly). Resolves the slug against the curated catalog, summarises what
  // the extension does + its trigger on the card, and returns a proposal.
  // NOTHING installs here; /actions/apply routes extension.install to
  // services/extensionInstall — the SAME internals the library page's Enable
  // button uses. Owner/admin at propose AND apply; gated by plugins_enabled
  // (the chatActions spec's `flag`, enforced inside buildProposal and
  // re-checked at apply).
  async function propose_install_extension(input) {
    const slug = typeof input?.slug === 'string' ? input.slug.trim() : '';
    if (!slug) {
      return { error: 'invalid', validation_errors: ['slug is required — find the right extension with list_extensions first'] };
    }
    const tpl = pluginLibrary.getBySlug(slug);
    if (!tpl) {
      return {
        error: 'unknown_extension',
        detail: `No library extension has the slug "${slug}". Use list_extensions to find the right one — do not invent slugs.`,
        known_slugs: pluginLibrary.list().map((i) => i.slug).slice(0, 40),
      };
    }
    const activate = input?.activate !== false; // default: install AND turn on
    // AUTONOMOUS (migration 167) — opt-in, default false. The proposal card's
    // summary states plainly that the extension will apply its changes
    // automatically; apply threads run_mode through to installLibraryTemplate.
    const autonomous = input?.autonomous === true;

    // Already installed + on → nothing to propose; point at the live plugin.
    let installedStatus = null;
    try {
      const statusBySlug = await extensionInstall.getLibraryStatusForOrg(req.orgId);
      installedStatus = statusBySlug[slug] || null;
    } catch { /* best-effort — the apply path is idempotent regardless */ }
    if (activate && installedStatus && installedStatus.active) {
      return {
        error: 'already_installed',
        detail: `"${tpl.name}" is already installed and turned on for this org (plugin #${installedStatus.plugin_id}). Nothing to do.`,
        plugin_id: installedStatus.plugin_id,
      };
    }

    const proposal = await buildProposal('extension', 'install', undefined, {
      slug,
      activate,
      ...(autonomous ? { run_mode: 'autonomous' } : {}),
      name: tpl.name,
      trigger_event: tpl.spec.triggerEvent,
      extension_summary: tpl.summary,
    });
    if (proposal.error) return proposal;
    return {
      ...proposal,
      extension: {
        slug,
        name: tpl.name,
        category: tpl.category,
        summary: tpl.summary,
        trigger_event: tpl.spec.triggerEvent,
        tags: tpl.tags || [],
        required_integration: tpl.requiredIntegration || null,
        run_mode: autonomous ? 'autonomous' : 'preview',
      },
      ...(autonomous
        ? { autonomous_note: 'This proposal enables AUTONOMOUS mode: the extension will apply its changes immediately (tasks created, fields updated) without an Apply step. Say that plainly to the user. They can switch back any time (propose_set_extension_mode or the plugin page).' }
        : {}),
      ...(installedStatus && !installedStatus.active
        ? { note: `Already installed as "${installedStatus.status}" (plugin #${installedStatus.plugin_id}) — applying turns that existing copy on instead of duplicating it.` }
        : {}),
      ...(tpl.requiredIntegration
        ? { setup_note: `This extension needs the ${tpl.requiredIntegration} integration connected before it can do its job — mention that to the user.` }
        : {}),
      apply_requires: 'org owner/admin',
    };
  }

  // Flip an existing extension between confirm-first 'preview' and
  // 'autonomous' (migration 167). Confirm-first like every propose_* tool:
  // the card states the consequence plainly; /actions/apply runs the same
  // org-scoped UPDATE + plugin.run_mode_changed audit as
  // PATCH /api/plugins/:id/run-mode. Owner/admin at propose AND apply.
  async function propose_set_extension_mode(input) {
    const pluginId = Number(input?.plugin_id);
    const runMode = typeof input?.run_mode === 'string' ? input.run_mode : '';
    if (!Number.isInteger(pluginId) || pluginId <= 0) {
      return { error: 'invalid', validation_errors: ['plugin_id must be a positive integer — find it with list_extensions (installed_plugin_id) or the Plugins page'] };
    }
    if (!['preview', 'autonomous'].includes(runMode)) {
      return { error: 'invalid', validation_errors: ["run_mode must be 'preview' or 'autonomous'"] };
    }
    if (!req.orgId) {
      return { error: 'org_required', detail: 'Extensions live in an organization workspace.' };
    }
    // Resolve the plugin (org-scoped) so the card names it and a same-mode
    // no-op is caught before proposing.
    const r = await pool.query(
      `SELECT id, name, status, run_mode FROM plugins WHERE id = $1 AND org_id = $2`,
      [pluginId, req.orgId]
    );
    if (r.rows.length === 0) {
      return { error: 'not_found', detail: `No plugin #${pluginId} in this org. Use list_extensions or the Plugins page to find the right id.` };
    }
    const row = r.rows[0];
    if ((row.run_mode || 'preview') === runMode) {
      return {
        error: 'unchanged',
        detail: `"${row.name}" is already in ${runMode} mode. Nothing to do.`,
      };
    }
    const proposal = await buildProposal('extension', 'set_mode', undefined, {
      plugin_id: pluginId,
      run_mode: runMode,
      name: row.name,
    });
    if (proposal.error) return proposal;
    return {
      ...proposal,
      current_mode: row.run_mode || 'preview',
      ...(runMode === 'autonomous'
        ? { autonomous_note: 'Applying lets this extension apply its changes immediately (tasks created, fields updated) without an Apply step. Say that plainly to the user. All sandbox caps and the auto-pause safety net stay in force.' }
        : {}),
      apply_requires: 'org owner/admin',
    };
  }

  // ==========================================================================
  // WORKSPACE-BUILDING TOOLS ("chat and BUILD"). Each normalizes the plain-
  // English tool input into the exact shape its admin route accepts, then
  // goes through buildProposal (validate → flag → org/role → audit → card).
  // NOTHING is written here; /actions/apply runs the mirrored INSERT.
  // ==========================================================================
  const ENTITY_TABLES = {
    deal: 'deals', deals: 'deals', company: 'companies', companies: 'companies',
    account: 'companies', accounts: 'companies', contact: 'contacts', contacts: 'contacts',
    task: 'tasks', tasks: 'tasks', activity: 'activities', activities: 'activities',
  };
  // Chat-friendly type names → the storage types customFieldsRoutes accepts.
  const FIELD_TYPE_ALIASES = {
    checkbox: 'boolean', bool: 'boolean', boolean: 'boolean', dropdown: 'select', picklist: 'select',
    select: 'select', multiselect: 'multiselect', multi_select: 'multiselect', tags: 'multiselect',
    url: 'text', link: 'text', email: 'text', string: 'text', text: 'text', textarea: 'text',
    number: 'number', integer: 'number', decimal: 'number', currency: 'number', money: 'number',
    date: 'date', datetime: 'date',
  };
  // "Contract Value" → contract_value (must satisfy the route's NAME_RE).
  function toFieldKey(raw) {
    const k = String(raw || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
    return /^[a-z]/.test(k) ? k : (k ? `f_${k}`.slice(0, 60) : '');
  }

  async function propose_add_custom_field(input) {
    const i = input || {};
    const entityRaw = String(i.entity || '').toLowerCase();
    if (/^leads?$/.test(entityRaw)) {
      return { error: 'invalid', validation_errors: ['Custom fields are not available on leads yet — supported entities: deal, company, contact, task.'] };
    }
    const entity = ENTITY_TABLES[entityRaw];
    if (!entity || entity === 'activities') {
      return { error: 'invalid', validation_errors: ['entity must be one of: deal, company, contact, task'] };
    }
    const typeRaw = String(i.type || 'text').toLowerCase();
    const type = FIELD_TYPE_ALIASES[typeRaw] || typeRaw;
    const label = typeof i.name === 'string' && i.name.trim() ? i.name.trim() : undefined;
    const name = toFieldKey(typeof i.key === 'string' && i.key.trim() ? i.key : i.name);
    const fields = { entity, name, type };
    if (label && label !== name) fields.label = label;
    if (i.options !== undefined) fields.options = i.options;
    if (i.required !== undefined) fields.required = i.required;

    // Pure validation first (reserved columns, options rules) so a bad
    // request never reaches the DB, then the same duplicate-name check POST
    // /api/custom-fields makes — a friendlier "already exists" than a 409 at
    // apply. The apply endpoint repeats both.
    const v = chatActions.validateAction({ entity: 'custom_field', op: 'create', fields });
    if (!v.ok) return { error: 'invalid', validation_errors: v.errors };
    if (req.orgId) {
      const dup = await pool.query(
        `SELECT id FROM org_field_definitions WHERE org_id = $1 AND entity = $2 AND name = $3`,
        [req.orgId, entity, name]);
      if (dup.rows.length > 0) {
        return { error: 'already_exists', detail: `A "${name}" field already exists on ${entity}. custom_field_status shows the current definitions.` };
      }
    }
    const proposal = await buildProposal('custom_field', 'create', undefined, fields);
    if (proposal.error) return proposal;
    return {
      ...proposal,
      field_key: name,
      ...(type !== typeRaw ? { note: `"${typeRaw}" is stored as a ${type} field.` } : {}),
      apply_requires: 'org owner/admin',
    };
  }

  // Resolve a user-typed stage ("Closed Won") to a real deal stage id on the
  // org's EFFECTIVE pipeline (custom stages or the profile default — ids,
  // case-insensitive ids, or labels all resolve).
  async function resolveStageId(stage) {
    const pipeline = await pipelines.getEffectivePipeline(req.orgId);
    return dealStages.resolveStageId(stage, pipeline);
  }

  // Edit the org's pipeline stages from chat — confirm-first. Applies the
  // requested add / rename / remove / reorder to the CURRENT effective
  // pipeline, validates the result with the same validator PUT /api/pipelines
  // uses, checks which removed stages still hold deals (each needs a
  // moveDealsTo destination), and returns a proposal card. NOTHING is written
  // here; /actions/apply calls services/pipelines.savePipeline.
  async function propose_update_pipeline(input) {
    const i = input || {};
    if (!req.orgId) {
      return { error: 'org_required', detail: 'Pipeline stages belong to an organization workspace — personal workspaces use the fixed default.' };
    }
    if (!isOrgAdminReq(req)) {
      return { error: 'not_authorized', detail: 'Only an org owner/admin can change pipeline stages. Ask them to apply this, or to open /settings/pipeline.' };
    }
    // deal_type (spec 201): which of the org's pipelines to edit. Omitted =
    // the default pipeline (unchanged behaviour); a NEW slug creates that
    // pipeline on apply, starting from its current effective stages.
    let dealType;
    try {
      dealType = pipelines.normalizeDealType(i.deal_type);
    } catch (err) {
      return { error: 'invalid', validation_errors: (err.body && err.body.validation_errors) || ['Invalid deal_type'] };
    }
    const current = await pipelines.getEffectivePipeline(req.orgId, undefined, { dealType });
    const edits = { add: i.add, rename: i.rename, remove: i.remove, reorder: i.reorder };
    if (!edits.add && !edits.rename && !edits.remove && !edits.reorder) {
      return { error: 'invalid', validation_errors: ['Give at least one of add, rename, remove, reorder.'], current_stages: current.stages.map((st) => ({ id: st.id, label: st.label })) };
    }
    const applied = pipelines.applyEdits(current.stages, edits);
    if (applied.errors.length) {
      return { error: 'invalid', validation_errors: applied.errors, current_stages: current.stages.map((st) => ({ id: st.id, label: st.label })) };
    }
    const v = pipelines.validateStages(applied.stages, current.profile);
    if (!v.ok) return { error: 'invalid', validation_errors: v.errors };
    const counts = await pipelines.dealCountsByStage(req.orgId, undefined, dealType);
    const plan = pipelines.planMoves(counts, v.stages, applied.moveDealsTo);
    if (plan.errors.length) return { error: 'invalid', validation_errors: plan.errors };
    if (plan.unresolved.length) {
      return {
        error: 'stages_have_deals',
        detail: 'Some deals sit in a stage that is being removed. Say where each should go (remove: [{ slug, moveDealsTo }]).',
        stages_with_deals: plan.unresolved,
        new_stages: v.stages.map((st) => ({ id: st.id, label: st.label })),
      };
    }
    const summary = applied.changes.join('; ');
    const fields = { stages: v.stages, change_summary: summary };
    if (dealType !== pipelines.DEFAULT_DEAL_TYPE) fields.deal_type = dealType;
    if (Object.keys(applied.moveDealsTo).length) fields.moveDealsTo = applied.moveDealsTo;
    const proposal = await buildProposal('pipeline', 'update', undefined, fields);
    if (proposal.error) return proposal;
    return {
      ...proposal,
      resulting_pipeline: pipelines.describeStages(v.stages),
      deals_to_move: plan.moves,
      apply_requires: 'org owner/admin',
      note: 'Nothing changes until Apply. The board at /deals and /settings/pipeline reflect it immediately afterwards.',
    };
  }

  async function propose_automation_rule(input) {
    const i = input || {};
    const conditions = { ...(i.conditions && typeof i.conditions === 'object' ? i.conditions : {}) };
    if (i.stage !== undefined) conditions.stage = i.stage;
    if (i.days !== undefined) conditions.days = i.days;
    if (i.trigger === 'deal_stage_is' && conditions.stage !== undefined) {
      const resolved = await resolveStageId(conditions.stage);
      if (!resolved) {
        return { error: 'invalid', validation_errors: [`"${conditions.stage}" is not a deal stage id. Ask how_do_i about pipeline stages for the org's real stage ids (generic: lead, qualified, proposal, negotiation, closed_won, closed_lost).`] };
      }
      conditions.stage = resolved;
    }
    const action = { type: i.action, ...(i.params && typeof i.params === 'object' ? i.params : {}) };
    if (action.type === 'create_task' && typeof action.title === 'string') action.title = action.title.trim();
    const fields = { trigger: i.trigger, conditions, action };
    if (typeof i.enabled === 'boolean') fields.enabled = i.enabled;
    // Name: the user's, or a compact generated one ("closed_won → task: Send welcome email").
    let name = typeof i.name === 'string' ? i.name.trim() : '';
    if (!name) {
      const trig = i.trigger === 'deal_stage_is' ? `Deal → ${conditions.stage ?? '?'}`
        : i.trigger === 'deal_idle_days' ? `Deal idle ${conditions.days ?? '?'}d`
        : i.trigger === 'task_overdue' ? 'Task overdue' : String(i.trigger || 'rule');
      const act = action.type === 'create_task' ? `task: ${action.title || ''}`
        : action.type === 'notify' ? 'notify owner'
        : action.type === 'set_hot_flag' ? 'flag hot' : String(action.type || '');
      name = `${trig}: ${act}`.slice(0, 200);
    }
    fields.name = name;
    const proposal = await buildProposal('automation_rule', 'create', undefined, fields);
    if (proposal.error) return proposal;
    return { ...proposal, rule_summary: proposal.proposal.summary, apply_requires: 'org owner/admin' };
  }

  async function propose_saved_view(input) {
    const i = input || {};
    const resource = ENTITY_TABLES[String(i.entity || '').toLowerCase()];
    if (!resource || resource === 'activities') {
      return { error: 'invalid', validation_errors: ['entity must be one of: deal, company, contact, task'] };
    }
    // Filter keys must be ones the list page actually understands (the same
    // catalog conversational search emits) — otherwise the tab would silently
    // show everything.
    const catalog = ai.SEARCH_CATALOG[resource];
    const filters = i.filters && typeof i.filters === 'object' && !Array.isArray(i.filters) ? i.filters : {};
    const badKeys = catalog ? Object.keys(filters).filter((k) => !(k in catalog.filters)) : [];
    if (badKeys.length) {
      return { error: 'invalid', validation_errors: [`unknown filter key(s) for ${resource}: ${badKeys.join(', ')}. Allowed: ${Object.keys(catalog.filters).join(', ')}`] };
    }
    if (i.sort && catalog && i.sort.field && !catalog.sortFields.includes(i.sort.field)) {
      return { error: 'invalid', validation_errors: [`sort.field must be one of: ${catalog.sortFields.join(', ')}`] };
    }
    const fields = { resource, name: typeof i.name === 'string' ? i.name.trim() : i.name, filter_spec: filters };
    if (i.sort && typeof i.sort === 'object') fields.sort_spec = i.sort;
    if (typeof i.is_shared === 'boolean') fields.is_shared = i.is_shared;
    if (typeof i.is_default === 'boolean') fields.is_default = i.is_default;
    return buildProposal('saved_view', 'create', undefined, fields);
  }

  async function propose_report(input) {
    const i = input || {};
    const entity = ENTITY_TABLES[String(i.entity || '').toLowerCase()];
    if (!entity || entity === 'tasks') {
      return { error: 'invalid', validation_errors: ['entity must be one of: deals, contacts, companies, activities'] };
    }
    const config = {
      entity,
      filters: Array.isArray(i.filters) ? i.filters : [],
      group_by: typeof i.group_by === 'string' && i.group_by ? i.group_by : null,
      group_by_granularity: i.granularity || 'month',
      metric: typeof i.metric === 'string' && i.metric ? i.metric : 'count',
      chart_type: i.chart || 'bar',
    };
    return buildProposal('report', 'create', undefined, {
      name: typeof i.name === 'string' ? i.name.trim() : i.name,
      config,
    });
  }

  // Navigation (read-only): plain English → registry page, flag-aware.
  async function open_page(input) {
    const r = chatCapabilities.resolvePage(input?.page);
    if (!r.page) {
      return {
        error: 'unknown_page',
        detail: `No page matches "${input?.page}". Offer the suggestions (or ask what they meant) — do not invent a URL.`,
        suggestions: r.suggestions,
        known_pages: chatCapabilities.PAGES.map((p) => p.key),
      };
    }
    const page = { key: r.page.key, path: r.page.path, label: r.page.label };
    if (r.page.gating) {
      const denied = await moduleDisabled(r.page.gating);
      if (denied) {
        return { page, disabled: true, feature: r.page.gating, code: 'FEATURE_DISABLED', hint: `That module is switched off for this org — an owner/admin can enable "${r.page.gating}" (propose it with propose_set_feature_flag).` };
      }
    }
    return { page };
  }

  // Strip matcher metadata + annotate with the org's effective flag value so
  // the copilot can say "that module is on/off for you" without a second call.
  async function annotateCapability(cap) {
    const { keywords, synonyms, ...out } = cap;
    if (cap.gating && req.orgId) out.enabled_for_your_org = await featureFlags.hasFeature(req.orgId, cap.gating);
    return out;
  }

  async function how_do_i(input) {
    const hits = chatCapabilities.lookupAll(input?.question, 2);
    if (!hits.length) {
      return {
        capability: { status: 'unknown', summary: 'Not sure — nothing in the capability registry matches. Say so honestly and point the user to /handoff or an admin; do not guess.' },
        known_topics: chatCapabilities.CAPABILITIES.map((c) => c.topic),
      };
    }
    const capability = await annotateCapability(hits[0].capability);
    if (capability.topic === 'pipeline_stages' && req.orgId) {
      // Tell the user THEIR stages — the org's effective pipeline (custom
      // edits included), not just the per-profile table.
      try {
        const pipeline = await pipelines.getEffectivePipeline(req.orgId);
        capability.your_profile = pipeline.profile;
        capability.your_pipeline_is_custom = pipeline.is_custom;
        capability.your_stages = pipeline.stages.map((st) => ({ id: st.id, label: st.label, ...(st.phase ? { phase: st.phase } : {}), ...(st.is_won ? { won: true } : {}), ...(st.is_lost ? { lost: true } : {}) }));
        capability.can_edit = isOrgAdminReq(req);
      } catch { /* non-fatal — the per-profile table is still in the entry */ }
    }
    const result = { capability };
    // Ambiguous question → hand back the runner-up too so the copilot can
    // mention both instead of silently picking one.
    if (hits[1] && hits[1].score >= hits[0].score * 0.6) {
      result.also_relevant = await annotateCapability(hits[1].capability);
    }
    return result;
  }

  async function list_modules() {
    const flags = (featureFlags.KNOWN_FLAGS || []).filter((f) => f.category !== 'platform');
    const flagNames = new Set(flags.map((f) => f.name));
    for (const c of chatCapabilities.CAPABILITIES) if (c.gating) flagNames.add(c.gating);
    const effective = {};
    if (req.orgId) {
      await Promise.all(Array.from(flagNames).map(async (name) => {
        effective[name] = await featureFlags.hasFeature(req.orgId, name);
      }));
    }
    const eff = (name) => (name && req.orgId ? (effective[name] ?? null) : null);
    return {
      org_scoped: !!req.orgId,
      modules: chatCapabilities.CAPABILITIES.map((c) => ({
        topic: c.topic, status: c.status, summary: c.summary, where: c.where, gating: c.gating,
        enabled_for_your_org: eff(c.gating),
      })),
      flags: flags.map((f) => ({
        name: f.name, category: f.category, description: f.description, default: f.defaultValue,
        enabled_for_your_org: eff(f.name),
      })),
      note: 'enabled_for_your_org is the effective value for this org (explicit setting, else the flag default); null = ungated, or a personal workspace with no org flags.',
    };
  }

  return async function runTool(name, input) {
    switch (name) {
      case 'list_deals':              return await list_deals(input);
      case 'get_deal':                return await get_deal(input);
      case 'list_overdue_tasks':      return await list_overdue_tasks();
      case 'list_dormant_deals':      return await list_dormant_deals(input);
      case 'list_at_risk_accounts':   return await list_at_risk_accounts(input);
      case 'list_hot_deals':          return await list_hot_deals();
      case 'summarize_attention':     return await summarize_attention();
      case 'draft_email_for_deal':    return await draft_email_for_deal(input);
      // Module reads — org-scoped + flag-aware (leads/cases/sequences return
      // FEATURE_DISABLED when the org has the module off).
      case 'list_leads':              return await list_leads(input);
      case 'list_open_cases':         return await list_open_cases(input);
      case 'list_upcoming_meetings':  return await list_upcoming_meetings(input);
      case 'list_sequences':          return await list_sequences();
      // Debug surface — every customer tool below is hard-scoped to req.orgId.
      case 'recent_audit_events':     return await recent_audit_events(input);
      case 'inspect_plugin_run':      return await inspect_plugin_run(input);
      case 'recent_plugin_failures':  return await recent_plugin_failures(input);
      case 'run_plugin':              return await run_plugin(input);
      case 'describe_plugin':         return await describe_plugin(input);
      case 'list_extensions':         return await list_extensions(input);
      case 'email_send_history':      return await email_send_history(input);
      case 'notification_diagnostic': return await notification_diagnostic(input);
      case 'saved_view_info':         return await saved_view_info(input);
      case 'custom_field_status':     return await custom_field_status(input);
      case 'try_api':                 return await try_api(input);
      case 'explain_error':           return await explain_error(input);
      // Super-admin debug surface — gated inside each handler.
      case 'inspect_org':             return await inspect_org(input);
      case 'inspect_user':            return await inspect_user(input);
      case 'cross_org_recent_errors': return await cross_org_recent_errors(input);
      // Write-action surface — propose_* validate + ownership-check and return
      // a proposal; they NEVER write. how_do_i / list_modules are read-only
      // capability lookups.
      case 'propose_update_deal':     return await propose_update_deal(input);
      case 'propose_create_task':     return await propose_create_task(input);
      case 'propose_log_activity':    return await propose_log_activity(input);
      case 'propose_upsert_contact':  return await propose_upsert_contact(input);
      case 'propose_upsert_company':  return await propose_upsert_company(input);
      case 'propose_create_lead':     return await propose_create_lead(input);
      case 'propose_create_case':     return await propose_create_case(input);
      case 'propose_create_meeting':  return await propose_create_meeting(input);
      case 'propose_set_lifecycle_stage': return await propose_set_lifecycle_stage(input);
      case 'propose_assign_owner':    return await propose_assign_owner(input);
      case 'propose_enroll_in_sequence': return await propose_enroll_in_sequence(input);
      case 'propose_run_playbook':    return await propose_run_playbook(input);
      case 'propose_cohort_action':   return await propose_cohort_action(input);
      case 'propose_set_feature_flag': return await propose_set_feature_flag(input);
      case 'propose_build_plugin':    return await propose_build_plugin(input);
      case 'propose_install_extension': return await propose_install_extension(input);
      case 'propose_set_extension_mode': return await propose_set_extension_mode(input);
      // Workspace-building surface — confirm-first like the rest.
      case 'propose_add_custom_field': return await propose_add_custom_field(input);
      case 'propose_automation_rule': return await propose_automation_rule(input);
      case 'propose_saved_view':      return await propose_saved_view(input);
      case 'propose_report':          return await propose_report(input);
      case 'propose_update_pipeline': return await propose_update_pipeline(input);
      // Navigation + capability brain — read-only.
      case 'open_page':               return await open_page(input);
      case 'how_do_i':                return await how_do_i(input);
      case 'list_modules':            return await list_modules();
      default: return { error: `Unknown tool: ${name}` };
    }
  };
}

// Follow-up QUESTIONS the user is likely to ask next, keyed by the tool that
// just ran. These become `ask` chips: clicking one seeds the composer with the
// prompt (the user stays in chat and can edit before sending). Navigation
// chips (`navigate` / `open_deal`) stay separate — they leave the page, so
// the frontend treats the two kinds differently on click.
const FOLLOW_UP_QUESTIONS = {
  list_overdue_tasks:     { label: 'Which should I do first?',            prompt: 'Which of those overdue tasks should I do first, and why?' },
  list_hot_deals:         { label: 'Draft a check-in for the hottest',    prompt: 'Draft a short, warm check-in email for the hottest of those deals.' },
  list_dormant_deals:     { label: 'Which is worth reviving?',            prompt: 'Which of those dormant deals is most worth reviving, and what should I say?' },
  list_at_risk_accounts:  { label: 'What do I do about the riskiest?',    prompt: 'Which at-risk account should I handle first, and what is the one thing to do?' },
  get_deal:               { label: "What's the next step?",               prompt: "What's the single next step on that deal?" },
  summarize_attention:    { label: "What's the one thing?",               prompt: "If I only have 30 minutes today, what's the one thing I should do?" },
  list_deals:             { label: 'Which is most likely to close?',      prompt: 'Which of those deals is most likely to close this month, and what would move it?' },
  list_leads:             { label: 'Which lead first?',                   prompt: 'Which lead should I follow up with first, and what should I say?' },
  list_open_cases:        { label: 'Which case is most urgent?',          prompt: 'Which open case is most urgent and what should happen next?' },
  list_upcoming_meetings: { label: 'Prep me for the next one',            prompt: 'Help me prepare for my next meeting: who is it with, what deal is it on, and what should I cover?' },
};

// Translate tool calls Claude made into action chips for the frontend. Each
// action has a `kind` the React component knows how to render. We only emit
// chips for tools whose results actually point at a concrete next step.
function buildActionsFromToolCalls(toolCalls) {
  const actions = [];
  const seen = new Set();
  function push(action) {
    const key = `${action.kind}:${action.deal_id || action.path || action.label}`;
    if (seen.has(key)) return;
    seen.add(key);
    actions.push(action);
  }
  // Question chips are appended AFTER the navigation/apply chips so the
  // concrete next step (Apply / Open) always comes first. At most two.
  const asks = [];
  function ask(toolName) {
    const q = FOLLOW_UP_QUESTIONS[toolName];
    if (!q || asks.length >= 2 || asks.some((a) => a.label === q.label)) return;
    asks.push({ kind: 'ask', label: q.label, prompt: q.prompt });
  }
  for (const tc of toolCalls || []) {
    if (tc.result && !tc.result.error && tc.result.code !== 'FEATURE_DISABLED') ask(tc.name);
    const nav = TOOL_NAV_CHIPS[tc.name];
    if (nav) {
      // Registry-driven navigation chips (see TOOL_NAV_CHIPS). A disabled
      // module's read tool never mints a chip to its dead page.
      if (tc.result?.code === 'FEATURE_DISABLED') continue;
      if (nav.when && !nav.when(tc)) continue;
      const page = chatCapabilities.pageFor(nav.page);
      push({ kind: 'navigate', path: page.path, label: nav.label || page.label });
    } else if (tc.name === 'open_page' && tc.result?.page && !tc.result.disabled) {
      // The navigation tool resolved a page — offer the button.
      push({ kind: 'navigate', path: tc.result.page.path, label: tc.result.page.label });
    } else if (tc.name === 'get_deal' && Number.isInteger(tc.input?.deal_id)) {
      push({ kind: 'open_deal', deal_id: tc.input.deal_id, label: `Open deal #${tc.input.deal_id}` });
    } else if (tc.name === 'draft_email_for_deal' && Number.isInteger(tc.input?.deal_id)) {
      push({ kind: 'draft_email', deal_id: tc.input.deal_id, label: 'Open in email composer' });
    } else if (tc.name === 'run_plugin' && tc.result?.run) {
      const pluginId = tc.result.plugin_id || tc.input?.plugin_id;
      const runId    = tc.result.run.id;
      // CONFIRM-FIRST: a preview run stages proposals but writes nothing. When
      // the run proposed changes, offer an inline Apply card so the user can
      // commit them without leaving chat. The card POSTs to the lone plugin
      // writer (POST /api/plugins/:id/apply { runId }), which re-validates the
      // stored proposals and is owner/admin gated — nothing is written here.
      const proposalCount = Number.isInteger(tc.result.proposed_change_count)
        ? tc.result.proposed_change_count
        : 0;
      if (pluginId && runId && proposalCount > 0) {
        push({
          kind: 'apply_plugin_run',
          pluginId,
          runId,
          proposalCount,
          summary: `This run staged ${proposalCount} change${proposalCount === 1 ? '' : 's'}. Nothing was written yet — apply to commit.`,
          label: `Apply ${proposalCount} change${proposalCount === 1 ? '' : 's'}`,
        });
      }
      // Also mint a "View run" chip pointing at the runs UI. The fragment
      // (#run-<id>) auto-expands that row when the page loads so the user
      // lands directly on the result rather than the top of the table.
      // Only emit when the tool returned a usable run row — error paths
      // (PLUGIN_NOT_FOUND, AMBIGUOUS_NAME, PLUGIN_DISABLED) skip the chip.
      if (pluginId && runId) {
        push({
          kind: 'navigate',
          path: `/plugins/${pluginId}/runs#run-${runId}`,
          label: 'View run',
        });
      }
    } else if (tc.name === 'describe_plugin' && tc.result?.plugin?.id) {
      // After describing a plugin, a likely follow-up is to open it in the
      // editor. The chip jumps to the existing detail page.
      push({
        kind: 'navigate',
        path: `/plugins/${tc.result.plugin.id}`,
        label: 'Open plugin',
      });
    } else if (tc.name.startsWith('propose_') && tc.result?.proposal) {
      // Confirm-first write action. The chip carries the validated proposal;
      // the frontend renders an Apply/Cancel card. Nothing is written until
      // the user clicks Apply (-> POST /api/ai/actions/apply).
      push({ kind: 'apply_action', proposal: tc.result.proposal, label: tc.result.proposal.summary });
    } else if (tc.name === 'how_do_i' && tc.result?.capability?.where) {
      // The capability lives at a real route — offer to jump there.
      push({ kind: 'navigate', path: tc.result.capability.where, label: 'Open settings' });
    }
  }
  return actions.slice(0, 4).concat(asks);
}

// Dispatch the chat call to the right rate limiter based on whether the
// request is a debug-mode call. Debug mode gets chatDebugLimiter (40/min);
// everything else stays on the existing chatLimiter (20/min). We delegate
// to one or the other rather than running both because rate-limit counters
// must not double-charge: a debug call shouldn't also count against the
// normal cap, or vice versa.
function chatModeLimiter(req, res, next) {
  const isDebug = req.body && req.body.mode === 'debug';
  return (isDebug ? chatDebugLimiter : chatLimiter)(req, res, next);
}

// Everything a chat turn does BEFORE the model is called, shared by the
// blocking POST /chat and the streaming POST /chat/stream so the two can't
// drift: config check, input validation, debug-role lookup, daily cap,
// session resolve/create (ownership re-verified every call), history pull.
// Returns { reject: { status, body } } for anything the client should get as
// a plain JSON status, else { sessionId, history, message, debugMode }.
async function prepareChatTurn(req) {
  if (!ai.isConfigured()) {
    return { reject: { status: 503, body: { error: 'AI not configured. Set ANTHROPIC_API_KEY on the backend.' } } };
  }
  const { session_id, message, mode } = req.body || {};
  const debugMode = mode === 'debug';

  // Populate req.adminRole so debug-tool handlers can gate super-admin-only
  // tools. The regular authMiddleware doesn't load admin_users (it's not
  // needed for the bulk of /api/* routes). Cheap LEFT JOIN; failure is
  // non-fatal — without this lookup the worst case is a super-admin's
  // debug call falls back to a customer-only tool set.
  if (debugMode) {
    try {
      const arow = await pool.query(
        `SELECT role FROM admin_users WHERE user_id = $1`,
        [req.userId]
      );
      req.adminRole = arow.rows[0]?.role || null;
    } catch {
      req.adminRole = null;
    }
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    return { reject: { status: 400, body: { error: 'message is required' } } };
  }
  if (message.length > 4000) {
    return { reject: { status: 400, body: { error: 'message too long (max 4000 chars)' } } };
  }

  // Daily cap — bounds runaway clients without burning a Claude call.
  const dailyCount = await pool.query(
    `SELECT COUNT(*)::int AS c
     FROM chat_messages m
     JOIN chat_sessions s ON s.id = m.session_id
     WHERE s.user_id = $1 AND m.role = 'user' AND m.created_at > NOW() - INTERVAL '24 hours'`,
    [req.userId]
  );
  if ((dailyCount.rows[0]?.c || 0) >= DAILY_MESSAGE_CAP) {
    return { reject: { status: 429, body: {
      error: `Daily chat cap reached (${DAILY_MESSAGE_CAP} messages/24h). Try again tomorrow.`,
      code: 'CHAT_DAILY_CAP',
    } } };
  }

  // Resolve or create the session. We re-verify ownership on every call so
  // a malicious client cannot post into someone else's session by guessing
  // a UUID.
  let sessionId = session_id;
  if (sessionId) {
    const sCheck = await pool.query(
      `SELECT id FROM chat_sessions WHERE id = $1 AND user_id = $2`,
      [sessionId, req.userId]
    );
    if (sCheck.rows.length === 0) sessionId = null;
  }
  if (!sessionId) {
    const newSession = await pool.query(
      `INSERT INTO chat_sessions (user_id, org_id) VALUES ($1, $2) RETURNING id`,
      [req.userId, req.orgId || null]
    );
    sessionId = newSession.rows[0].id;
  }

  // Pull recent history. Order asc so Claude sees them in conversational
  // order, capped at HISTORY_LIMIT so we bound prompt size.
  const histRes = await pool.query(
    `SELECT role, content FROM chat_messages
     WHERE session_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [sessionId, HISTORY_LIMIT]
  );
  const history = histRes.rows.reverse();

  return { sessionId, history, message, debugMode };
}

// Persist both turns. We persist user first so a partial failure on the
// assistant insert still leaves a record of what the user asked.
async function persistChatTurn({ sessionId, message, turn, actions }) {
  await pool.query(
    `INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', $2)`,
    [sessionId, message]
  );
  await pool.query(
    `INSERT INTO chat_messages (session_id, role, content, tool_calls, actions)
     VALUES ($1, 'assistant', $2, $3::jsonb, $4::jsonb)`,
    [sessionId, turn.reply || '', JSON.stringify(turn.toolCalls || []), JSON.stringify(actions)]
  );
  await pool.query(
    `UPDATE chat_sessions SET last_message_at = NOW(), message_count = message_count + 2 WHERE id = $1`,
    [sessionId]
  );
}

// Build a short, plain-English explanation of which tools were used so
// the UI can render it under the assistant reply. Helps with trust — the
// user sees what data the model looked at.
function buildExplanation(toolCalls) {
  const toolSummary = (toolCalls || [])
    .map(t => t.name.replace(/_/g, ' '))
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(', ');
  return toolSummary ? `Looked up: ${toolSummary}.` : '';
}

router.post('/chat', authMiddleware, chatModeLimiter, async (req, res) => {
  try {
    const prep = await prepareChatTurn(req);
    if (prep.reject) return res.status(prep.reject.status).json(prep.reject.body);
    const { sessionId, history, message, debugMode } = prep;

    const runTool = buildChatToolRunner(req);

    const turn = await ai.runChatTurn({
      userMessage: message,
      history,
      runTool,
      orgId: req.orgId,
      userId: req.userId,
      // Debug mode swaps in the debug-augmented system prompt so Claude knows
      // to call diagnostic tools FIRST when the user asks "why didn't X
      // happen". Normal chat keeps the default sales-copilot prompt.
      systemPrompt: debugMode ? ai.CHAT_SYSTEM_PROMPT_WITH_DEBUG : null,
    });

    if (!turn.ok) {
      audit.fromReq(req, {
        event: audit.EVENTS.CHAT_MESSAGE,
        targetType: 'chat_session',
        success: false,
        meta: { session_id: sessionId, message, error: turn.error, code: turn.code },
      });
      return res.status(turn.code === 'AI_NOT_CONFIGURED' ? 503 : 502).json({
        error: turn.error || 'Chat failed',
        code: turn.code,
      });
    }

    const actions = buildActionsFromToolCalls(turn.toolCalls);
    await persistChatTurn({ sessionId, message, turn, actions });
    const explanation = buildExplanation(turn.toolCalls);

    audit.fromReq(req, {
      event: audit.EVENTS.CHAT_MESSAGE,
      targetType: 'chat_session',
      success: true,
      meta: { session_id: sessionId, message, reply: turn.reply, tool_calls: turn.toolCalls },
    });

    res.json({
      session_id: sessionId,
      reply: turn.reply,
      actions,
      explanation,
    });
  } catch (err) {
    console.error('chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /chat/stream — the same turn as POST /chat, delivered as Server-Sent
// Events so the UI can show progress instead of a 5–15s spinner. Same body,
// same auth / rate-limit / billing / feature gates (it sits under the same
// /api/ai mount chain and reuses chatModeLimiter), same persistence and
// metering. Anything rejected BEFORE the model is called (400 / 429 / 503,
// plus the 402 from the mount-level billing gate) is a plain JSON status —
// the client handles those exactly like the blocking route. Once the stream
// is open, failures arrive as an `error` event.
//
// Events (each `event: <name>\ndata: <json>\n\n`):
//   status  { tool, text }                 a tool call started ("Looking at…")
//   token   { text }                       assistant text delta
//   reset   { text }                       retract the streamed text (it was a
//                                          pre-tool preamble, not the reply)
//   actions { actions, explanation }       chips, right before done
//   done    { session_id, reply, actions, explanation, usage }  — same shape
//                                          as POST /chat's JSON (+ usage); the
//                                          client reconciles on this
//   error   { code, error, status }        terminal
//
// Transport notes (Cloud Run / proxies): SSE works on Cloud Run over
// HTTP/1.1 as long as the response actually streams — we flush the headers
// up front, write each event immediately, and send a `: ping` comment every
// 15s so an idle thinking phase doesn't look like a dead connection. There
// is no compression middleware in index.js (nothing to bypass); the
// `Cache-Control: no-transform` header is what the `compression` package
// keys off to leave a response alone, so it stays safe if one is added.
// `X-Accel-Buffering: no` tells nginx-style proxies not to buffer.
router.post('/chat/stream', authMiddleware, chatModeLimiter, async (req, res) => {
  let prep;
  try {
    prep = await prepareChatTurn(req);
  } catch (err) {
    console.error('chat stream error:', err);
    return res.status(500).json({ error: err.message });
  }
  if (prep.reject) return res.status(prep.reject.status).json(prep.reject.body);
  const { sessionId, history, message, debugMode } = prep;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  if (res.socket && typeof res.socket.setNoDelay === 'function') res.socket.setNoDelay(true);

  let finished = false;
  const send = (event, data) => {
    if (finished || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const ping = setInterval(() => {
    if (!finished && !res.writableEnded) res.write(': ping\n\n');
  }, 15000);
  const end = () => {
    if (finished) return;
    finished = true;
    clearInterval(ping);
    res.end();
  };
  // Client went away (Stop button, tab closed): cancel the in-flight model
  // call so we stop paying for tokens nobody will read. `close` also fires
  // after a normal finish — the `finished` flag keeps that from aborting.
  const abort = new AbortController();
  res.on('close', () => { if (!finished) abort.abort(); });

  try {
    const runTool = buildChatToolRunner(req);
    const turn = await ai.runChatTurn({
      userMessage: message,
      history,
      runTool,
      orgId: req.orgId,
      userId: req.userId,
      systemPrompt: debugMode ? ai.CHAT_SYSTEM_PROMPT_WITH_DEBUG : null,
      signal: abort.signal,
      onEvent: (evt) => {
        if (evt.type === 'token')       send('token',  { text: evt.text });
        else if (evt.type === 'status') send('status', { tool: evt.tool, text: evt.text });
        else if (evt.type === 'reset')  send('reset',  { text: evt.text });
      },
    });

    if (turn.code === 'ABORTED' || abort.signal.aborted) {
      // Nothing persisted — the user cancelled before there was a reply.
      audit.fromReq(req, {
        event: audit.EVENTS.CHAT_MESSAGE,
        targetType: 'chat_session',
        success: false,
        meta: { session_id: sessionId, message, error: 'cancelled', code: 'ABORTED' },
      });
      return end();
    }

    if (!turn.ok) {
      audit.fromReq(req, {
        event: audit.EVENTS.CHAT_MESSAGE,
        targetType: 'chat_session',
        success: false,
        meta: { session_id: sessionId, message, error: turn.error, code: turn.code },
      });
      send('error', {
        error: turn.error || 'Chat failed',
        code: turn.code,
        status: turn.code === 'AI_NOT_CONFIGURED' ? 503 : 502,
      });
      return end();
    }

    const actions = buildActionsFromToolCalls(turn.toolCalls);
    await persistChatTurn({ sessionId, message, turn, actions });
    const explanation = buildExplanation(turn.toolCalls);

    audit.fromReq(req, {
      event: audit.EVENTS.CHAT_MESSAGE,
      targetType: 'chat_session',
      success: true,
      meta: { session_id: sessionId, message, reply: turn.reply, tool_calls: turn.toolCalls },
    });

    send('actions', { actions, explanation });
    send('done', {
      session_id: sessionId,
      reply: turn.reply,
      actions,
      explanation,
      usage: turn.usage,
    });
    end();
  } catch (err) {
    console.error('chat stream error:', err);
    send('error', { error: err.message || 'Chat failed', code: 'CHAT_FAILED', status: 500 });
    end();
  }
});

// History: list this user's sessions (most recent first). The Chat page
// restores the latest session on mount and lists the rest in its "Recent"
// menu. `preview` is the first user message so a session has a human label
// (sessions don't carry titles).
router.get('/chat/sessions', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.id, s.started_at, s.last_message_at, s.message_count,
              LEFT(fm.content, 120) AS preview
       FROM chat_sessions s
       LEFT JOIN LATERAL (
         SELECT content FROM chat_messages
          WHERE session_id = s.id AND role = 'user'
          ORDER BY created_at ASC LIMIT 1
       ) fm ON TRUE
       WHERE s.user_id = $1
       ORDER BY s.last_message_at DESC
       LIMIT 50`,
      [req.userId]
    );
    res.json({ sessions: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/chat/sessions/:id/messages', authMiddleware, async (req, res) => {
  try {
    const own = await pool.query(
      `SELECT id FROM chat_sessions WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.userId]
    );
    if (own.rows.length === 0) return res.status(404).json({ error: 'Session not found' });
    const r = await pool.query(
      `SELECT id, role, content, actions, created_at
       FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json({ messages: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// Test-only export. The runTool factory closes over a real Express `req` (for
// orgId/userId scoping) and over the captured `qs(req)` closure. Exposing it
// here lets unit tests build a synthetic req and exercise individual chat
// tools without spinning the whole tool-use loop. Underscore prefix marks it
// not-for-runtime-use.
module.exports._buildChatToolRunner = buildChatToolRunner;
module.exports._buildActionsFromToolCalls = buildActionsFromToolCalls;
