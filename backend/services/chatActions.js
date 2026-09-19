// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Confirm-first chat write-actions.
//
// The chat copilot's `propose_*` tools call validateAction() ONLY — they never
// write. The lone writer is POST /api/ai/actions/apply, which re-validates and
// then calls applyAction() inside a transaction. Mirrors the proven
// org-customizations propose -> validate -> apply pattern (aiRoutes.js).
//
// SECURITY MODEL:
//   - Allowlist: only the fields below are writable from chat. Anything else the
//     model emits is dropped. (Tool input schemas also set additionalProperties:false.)
//   - Org-scoping: every write is bound to the caller's [sf, sv] = qs(req) scope.
//     Updates use `WHERE id = $target AND ${sf} = $scope` so a cross-org id can
//     never be written. Referenced ids (deal_id/contact_id/company_id) are
//     ownership-checked against the same scope before apply.
//   - Re-validation: the apply endpoint re-runs validateAction on the echoed
//     proposal; the client/model copy is never trusted.

const featureFlags = require('./featureFlags');
const { LIFECYCLE_STAGES, CHURN_REASONS } = require('../schemas/companies');
// Pure spec validator (no DB / env / AI) — re-run on every plugin.create_draft
// validation so an unchecked generated spec can never reach the plugins table.
const pluginSpecValidator = require('./pluginSpecValidator');
// Workspace-building actions reuse the EXACT validators their admin surfaces
// use, so a chat-built field / rule / view / report can never diverge from a
// hand-built one: customFieldsRoutes.validateFieldDefShape (reserved-column +
// options rules), schemas/automationRules (trigger/action enums + per-trigger
// refinements), schemas/savedViews, and reportBuilder.validateConfig (the
// allowlist the report engine itself enforces).
const customFields = require('../routes/customFieldsRoutes');
const ruleSchemas = require('../schemas/automationRules');
const savedViewSchemas = require('../schemas/savedViews');
const reportBuilder = require('./reportBuilder');

// Module/tier flags an org admin may toggle from chat. Platform flags
// (phase2_entities, v2_dual_write) are deliberately excluded — too risky to flip
// conversationally.
const TOGGLEABLE_FLAGS = (featureFlags.KNOWN_FLAGS || [])
  .filter((f) => f.category === 'module' || f.category === 'tier')
  .map((f) => f.name);

const ENUM = (...vals) => (v) => typeof v === 'string' && vals.includes(v);
const STR = (max) => (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const OPTSTR = (max) => (v) => v === null || (typeof v === 'string' && v.length <= max);
const INT = (v) => Number.isInteger(v) && v > 0;
const NUM = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const BOOL = (v) => typeof v === 'boolean';
const ISODATE = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const ISODATETIME = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?)?$/.test(v);
const INTARRAY = (maxItems) => (v) =>
  Array.isArray(v) && v.length > 0 && v.length <= maxItems && v.every((n) => Number.isInteger(n) && n > 0);
const OBJ = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const STRARRAY = (maxItems, maxLen) => (v) =>
  Array.isArray(v) && v.length <= maxItems && v.every((o) => typeof o === 'string' && o.length <= maxLen);
// zod issue list -> the flat string errors validateAction reports.
const zodErrors = (result) => result.error.issues.map((i) => `${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`);

// The cohort harness's allowlisted verbs. Each maps onto the segments bulk
// machinery (services/segments.js) or, for enroll_in_sequence, onto
// services/sequences.enroll — never onto free-form SQL.
const COHORT_ACTIONS = ['set_lifecycle_stage', 'assign_owner', 'create_task_for_each', 'enroll_in_sequence', 'open_case_for_each'];

// Per entity+op: the writable-field allowlist (field -> validator), required
// fields, the entities a *_id reference must be ownership-checked against, and a
// human summary builder for the confirm card.
const SPECS = {
  'deal.update': {
    table: 'deals',
    fields: {
      stage: STR(64),
      amount: NUM,
      hot_flag: BOOL,
      expected_close_date: ISODATE,
      append_note: STR(4000), // appended to notes, not overwrite
      next_step: STR(500),          // the rep's committed next action (migration 172)
      next_step_date: ISODATE,      // the day it's due
    },
    required: [],
    needsTarget: true,            // target_id = deal id (ownership-checked)
    summary: (a) => {
      const f = a.fields;
      const parts = [];
      if (f.stage !== undefined) parts.push(`stage → ${f.stage}`);
      if (f.amount !== undefined) parts.push(`amount → $${f.amount.toLocaleString()}`);
      if (f.hot_flag !== undefined) parts.push(f.hot_flag ? 'flag hot' : 'unflag hot');
      if (f.expected_close_date !== undefined) parts.push(`close date → ${f.expected_close_date}`);
      if (f.next_step !== undefined) parts.push(`next step → "${f.next_step}"`);
      if (f.next_step_date !== undefined) parts.push(`next step due → ${f.next_step_date}`);
      if (f.append_note !== undefined) parts.push('add a note');
      return `Update deal #${a.target_id}: ${parts.join(', ')}`;
    },
  },
  // Deal creation from chat ("create a $20k deal for Acme, stage
  // negotiation"). A SERVICE action, not a generic table write: `company` /
  // `contact_name` / `contact_email` are find-or-create by NAME (mirroring
  // the lead-convert upsert in services/leads.js convertLead), and `stage` /
  // `deal_type` must validate against the org's EFFECTIVE pipeline
  // (services/pipelines.js) — none of which the pure allowlist validator
  // below can do (no DB access here). routes/aiRoutes.js resolves + revalidates
  // both at propose AND apply time; this spec only bounds shape/type.
  'deal.create': {
    service: 'deal_create',
    fields: {
      title:         STR(255),
      company:       STR(200),   // company name — find-or-create, case-insensitive
      contact_name:  STR(200),   // contact name — find-or-create alongside contact_email
      contact_email: STR(254),
      amount:        NUM,
      close_date:    ISODATE,
      stage:         STR(64),    // resolved id or label; re-validated against the pipeline at apply
      deal_type:     (v) => typeof v === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(v),
      notes:         STR(4000),
    },
    required: ['title'],
    summary: (a) => {
      const f = a.fields;
      const bits = [];
      if (f.company) bits.push(`for ${f.company}`);
      if (f.amount !== undefined) bits.push(`$${f.amount.toLocaleString()}`);
      if (f.stage) bits.push(`stage "${f.stage}"`);
      if (f.deal_type && f.deal_type !== 'default') bits.push(`type "${f.deal_type}"`);
      return `Create deal "${f.title}"${bits.length ? ' (' + bits.join(', ') + ')' : ''}`;
    },
  },
  'task.create': {
    table: 'tasks',
    fields: {
      title: STR(200),
      due_date: ISODATE,
      priority: ENUM('low', 'medium', 'high'),
      deal_id: INT,
      contact_id: INT,
    },
    required: ['title'],
    refs: { deal_id: 'deals', contact_id: 'contacts' },
    summary: (a) => `Create task "${a.fields.title}"${a.fields.due_date ? ` due ${a.fields.due_date}` : ''}${a.fields.deal_id ? ` on deal #${a.fields.deal_id}` : ''}`,
  },
  'activity.create': {
    table: 'activities',
    fields: {
      type: ENUM('call', 'email', 'meeting', 'note', 'demo'),
      title: STR(200),
      note: STR(4000),
      deal_id: INT,
      contact_id: INT,
      activity_date: ISODATETIME,
    },
    required: ['type'],
    refs: { deal_id: 'deals', contact_id: 'contacts' },
    summary: (a) => `Log ${a.fields.type}${a.fields.deal_id ? ` on deal #${a.fields.deal_id}` : ''}${a.fields.contact_id ? ` with contact #${a.fields.contact_id}` : ''}`,
  },
  'contact.create': {
    table: 'contacts',
    fields: {
      first_name: STR(120), last_name: STR(120), email: STR(254),
      phone: STR(40), company_id: INT, job_title: STR(120),
      status: ENUM('active', 'inactive'),
    },
    required: ['first_name'],
    refs: { company_id: 'companies' },
    summary: (a) => `Create contact ${a.fields.first_name || ''} ${a.fields.last_name || ''}`.trim(),
  },
  'contact.update': {
    table: 'contacts',
    fields: {
      first_name: STR(120), last_name: STR(120), email: STR(254),
      phone: STR(40), company_id: INT, job_title: STR(120),
      status: ENUM('active', 'inactive'),
    },
    required: [],
    needsTarget: true,
    refs: { company_id: 'companies' },
    summary: (a) => `Update contact #${a.target_id}`,
  },
  'company.create': {
    table: 'companies',
    fields: {
      name: STR(200), industry: STR(120), phone: STR(40),
      location: STR(200), type: ENUM('customer', 'vendor', 'partner', 'other'),
      status: ENUM('active', 'inactive'),
    },
    required: ['name'],
    summary: (a) => `Create company "${a.fields.name}"`,
  },
  'company.update': {
    table: 'companies',
    fields: {
      name: STR(200), industry: STR(120), phone: STR(40),
      location: STR(200), type: ENUM('customer', 'vendor', 'partner', 'other'),
      status: ENUM('active', 'inactive'),
    },
    required: [],
    needsTarget: true,
    summary: (a) => `Update company #${a.target_id}`,
  },
  // Lead intake from chat ("add Jane from Acme as a lead"). Plain table create —
  // status defaults to 'new' in the schema when omitted; 'converted' is
  // deliberately NOT proposable (only the convert endpoint may stamp it, since
  // it must create the contact/deal transactionally). `flag` gates both the
  // propose_* handler and the apply endpoint on the org's leads module.
  'lead.create': {
    table: 'leads',
    flag: 'leads_enabled',
    fields: {
      name: STR(200),
      email: STR(254),
      phone: STR(50),
      company_name: STR(200),
      title: STR(200),
      source: STR(64),
      status: ENUM('new', 'working', 'qualified', 'unqualified'),
      notes: STR(4000),
    },
    required: ['name'],
    summary: (a) => `Create lead "${a.fields.name}"${a.fields.company_name ? ` (${a.fields.company_name})` : ''}`,
  },
  // Support-case intake from chat ("open a high-priority case for Acme").
  // status defaults to 'open' in the schema; resolution transitions stay in
  // caseRoutes.js (they stamp resolved_at), so only creation is proposable.
  'case.create': {
    table: 'cases',
    flag: 'customer_success_enabled',
    fields: {
      subject: STR(500),
      description: STR(8000),
      priority: ENUM('low', 'normal', 'high', 'urgent'),
      company_id: INT,
      contact_id: INT,
      sla_due_at: ISODATETIME,
    },
    required: ['subject'],
    refs: { company_id: 'companies', contact_id: 'contacts' },
    summary: (a) => `Open ${a.fields.priority || 'normal'}-priority case "${a.fields.subject}"${a.fields.company_id ? ` for company #${a.fields.company_id}` : ''}`,
  },
  // In-app meeting from chat ("book a call with Acme Friday 10am"). Plain
  // table create mirroring POST /api/meetings (schemas/meetings.js): title +
  // starts_at required, optional links ownership-checked, created_by stamped
  // via extraCols. The meetings mount is not flag-gated, so no `flag` here.
  'meeting.create': {
    table: 'meetings',
    fields: {
      title: STR(500),
      starts_at: ISODATETIME,
      ends_at: ISODATETIME,
      location: STR(500),
      notes: STR(4000),
      company_id: INT,
      deal_id: INT,
      contact_id: INT,
    },
    required: ['title', 'starts_at'],
    refs: { company_id: 'companies', deal_id: 'deals', contact_id: 'contacts' },
    extraCols: { created_by: 'userId' }, // scope key -> column, applied on INSERT
    check: (f) => (f.starts_at && f.ends_at && new Date(f.ends_at).getTime() < new Date(f.starts_at).getTime()
      ? ['ends_at must be after starts_at'] : []),
    summary: (a) => `Create meeting "${a.fields.title}" at ${a.fields.starts_at}${a.fields.company_id ? ` (company #${a.fields.company_id})` : ''}${a.fields.deal_id ? ` (deal #${a.fields.deal_id})` : ''}`,
  },
  // Account lifecycle move ("mark Acme at-risk"). Mirrors PATCH
  // /api/companies/:id/lifecycle-stage: allowlisted stage, churned_reason only
  // valid when churning, churned_at stamped/cleared by the same CASE SQL. The
  // apply endpoint fires success playbooks post-commit (firesPlaybooks), best-
  // effort — exactly like the route it mirrors.
  'company.set_lifecycle_stage': {
    table: 'companies',
    flag: 'customer_success_enabled',
    needsTarget: true,
    firesPlaybooks: true,
    fields: {
      lifecycle_stage: ENUM(...LIFECYCLE_STAGES),
      churned_reason: ENUM(...CHURN_REASONS),
    },
    required: ['lifecycle_stage'],
    check: (f) => (f.churned_reason !== undefined && f.lifecycle_stage !== 'churned'
      ? ['churned_reason is only valid when moving to churned'] : []),
    summary: (a) => `Move company #${a.target_id} to lifecycle stage "${a.fields.lifecycle_stage}"${a.fields.churned_reason ? ` (churn reason: ${a.fields.churned_reason})` : ''}`,
  },
  // Record-owner assignment (migration 135's owner_user_id). One spec per
  // entity so the flag gates match the underlying routes (leads_enabled for
  // leads; companies/deals ungated). `ownerField` tells the propose handler
  // AND the apply endpoint to run recordOwnership.ownerValidationError — the
  // new owner must be a member of the caller's org (or the caller themself in
  // a personal workspace), so a cross-org user id can never be written.
  'company.assign_owner': {
    table: 'companies',
    needsTarget: true,
    ownerField: 'owner_user_id',
    fields: { owner_user_id: INT },
    required: ['owner_user_id'],
    summary: (a) => `Assign company #${a.target_id} to user #${a.fields.owner_user_id}`,
  },
  'deal.assign_owner': {
    table: 'deals',
    needsTarget: true,
    ownerField: 'owner_user_id',
    fields: { owner_user_id: INT },
    required: ['owner_user_id'],
    summary: (a) => `Assign deal #${a.target_id} to user #${a.fields.owner_user_id}`,
  },
  'lead.assign_owner': {
    table: 'leads',
    flag: 'leads_enabled',
    needsTarget: true,
    ownerField: 'owner_user_id',
    fields: { owner_user_id: INT },
    required: ['owner_user_id'],
    summary: (a) => `Assign lead #${a.target_id} to user #${a.fields.owner_user_id}`,
  },
  // Sequence enrollment — a SERVICE action (no direct table write here): the
  // apply endpoint routes it to services/sequences.enroll, which only inserts
  // sequence_enrollments rows. EMAIL GUARDRAIL: enrolling sends nothing — the
  // only thing that ever emails is the sequence worker
  // (sequences.processDueEnrollments), which is suppression-aware and no-ops
  // entirely (skipped: email_not_configured) when no transport is configured.
  'sequence.enroll': {
    service: 'sequence_enroll',
    flag: 'campaigns_enabled',
    fields: {
      sequence_id: INT,
      contact_ids: INTARRAY(500),
    },
    required: ['sequence_id', 'contact_ids'],
    refs: { sequence_id: 'sequences', contact_ids: 'contacts' },
    summary: (a) => `Enroll ${a.fields.contact_ids.length} contact${a.fields.contact_ids.length === 1 ? '' : 's'} into sequence #${a.fields.sequence_id} (steps send via the sequence worker; inert until email is configured)`,
  },
  // Manual playbook run — SERVICE action routed to
  // playbooks.runPlaybookForCompany. Idempotent per (playbook, company) via
  // the playbook_runs UNIQUE guard, so re-applying can never duplicate tasks.
  'playbook.run': {
    service: 'playbook_run',
    flag: 'customer_success_enabled',
    fields: {
      playbook_id: INT,
      company_id: INT,
    },
    required: ['playbook_id', 'company_id'],
    refs: { playbook_id: 'playbooks', company_id: 'companies' },
    summary: (a) => `Run playbook #${a.fields.playbook_id} for company #${a.fields.company_id} (spawns its task checklist; once per company)`,
  },
  // Cohort harness — the manage-at-scale SERVICE action. The cohort is a saved
  // segment (segment_id / segment_name) OR an inline filter (entity_type +
  // criteria, compiled through the strict allowlist in services/segments.js).
  // The verb is one of COHORT_ACTIONS; free-form SQL is impossible. The
  // proposal carries expected_count for the card; the apply endpoint
  // RE-EVALUATES membership, re-counts, enforces segments.MAX_BULK_AFFECTED,
  // and is owner/admin-gated (requiresAdmin) — same privilege bar as
  // POST /api/segments/:id/bulk.
  'cohort.action': {
    service: 'cohort',
    flag: 'customer_success_enabled', // the segments machinery's module
    requiresAdmin: true,
    fields: {
      segment_id: INT,
      segment_name: STR(120),
      entity_type: ENUM('company', 'contact'),
      criteria: (v) => Array.isArray(v) && v.length >= 1 && v.length <= 20,
      action: ENUM(...COHORT_ACTIONS),
      action_params: OBJ,
      // Display-only: the member count at propose time. NEVER trusted at apply
      // — the apply endpoint re-counts the live membership.
      expected_count: (v) => Number.isInteger(v) && v >= 0,
    },
    required: ['action'],
    check: (f) => {
      const errors = [];
      const hasSaved = f.segment_id !== undefined || f.segment_name !== undefined;
      const hasInline = f.criteria !== undefined || f.entity_type !== undefined;
      if (hasSaved && hasInline) {
        errors.push('give EITHER a saved segment (segment_id / segment_name) OR an inline filter (entity_type + criteria), not both');
      } else if (!hasSaved && (f.entity_type === undefined || f.criteria === undefined)) {
        errors.push('cohort needs a saved segment (segment_id or segment_name) or an inline filter (entity_type + criteria)');
      }
      if (f.segment_id !== undefined && f.segment_name !== undefined) {
        errors.push('give segment_id OR segment_name, not both');
      }
      return errors;
    },
    summary: (a) => {
      const f = a.fields;
      const VERBS = {
        set_lifecycle_stage: `set lifecycle stage → ${f.action_params?.lifecycle_stage ?? '?'}`,
        assign_owner: `assign owner → user #${f.action_params?.owner_id ?? '?'}`,
        create_task_for_each: `create a task ("${f.action_params?.title ?? ''}") for each member`,
        enroll_in_sequence: `enroll every member in sequence #${f.action_params?.sequence_id ?? '?'} (email stays inert until a transport is configured)`,
        open_case_for_each: `open a support case ("${f.action_params?.subject ?? ''}") for each member`,
      };
      const src = f.segment_id !== undefined ? `segment #${f.segment_id}`
        : f.segment_name !== undefined ? `segment "${f.segment_name}"`
        : `an inline ${f.entity_type} filter`;
      const n = f.expected_count !== undefined ? `${f.expected_count} current member${f.expected_count === 1 ? '' : 's'}` : 'all current members';
      return `Cohort action on ${src}: ${VERBS[f.action] || f.action} — ${n} affected (membership re-checked at apply)`;
    },
  },
  // Chat plugin builder ("build me a tool that…") — a SERVICE action: the
  // apply endpoint saves the AI-generated spec as a plugins row with
  // status='draft'. NOTHING RUNS on apply: a draft only executes later through
  // the existing plugin run model (POST /api/plugins/:id/run previews in the
  // isolated-vm sandbox; POST /api/plugins/:id/apply commits proposals,
  // owner/admin-gated) — that is the second confirm gate. The spec itself is
  // re-validated through services/pluginSpecValidator (SDK-method allowlist,
  // trigger-event allowlist, dangerous-pattern scan) via `check` — at BOTH
  // propose and apply time, since /actions/apply re-runs validateAction on the
  // untrusted echoed proposal.
  'plugin.create_draft': {
    service: 'plugin_draft',
    flag: 'plugins_enabled',
    fields: {
      name: STR(120),
      description: OPTSTR(2000),
      trigger_event: STR(80),
      spec_json: OBJ,
      source_code: STR(200000),
    },
    required: ['name', 'trigger_event', 'spec_json', 'source_code'],
    check: (f) => {
      const v = pluginSpecValidator.validateSpec({
        name: f.name,
        description: f.description ?? null,
        trigger_event: f.trigger_event,
        source_kind: 'conversational',
        spec_json: f.spec_json,
        source_code: f.source_code,
      });
      return v.ok ? [] : v.errors.map((e) => `plugin spec ${e.field}: ${e.message}`);
    },
    summary: (a) => `Save plugin draft "${a.fields.name}" (trigger: ${a.fields.trigger_event}). Saved as a DRAFT only — it never runs automatically; test-run and apply it from /plugins.`,
  },
  // Curated extension install ("turn on the stalled-deal digest") — a SERVICE
  // action: the apply endpoint routes it to
  // services/extensionInstall.installLibraryTemplate — the SAME internals the
  // library page's Enable button uses (atomic install+activate, idempotent per
  // template). Only `slug` + `activate` are trusted at apply time: the server
  // re-resolves the template from the curated catalog, so the display-only
  // name/trigger/summary fields on the card can never alter what installs.
  // Owner/admin at propose AND apply (same bar as applying plugin writes).
  'extension.install': {
    service: 'extension',
    flag: 'plugins_enabled',
    requiresAdmin: true,
    requiresOrg: true,
    fields: {
      slug:              STR(120),
      activate:          BOOL,
      // 'preview' (default) | 'autonomous' (migration 167). Autonomous means
      // the extension's changes apply immediately with no human Apply step —
      // the card summary MUST say so plainly (see summary below).
      run_mode:          OPTSTR(12),
      // Display-only card context, re-resolved server-side at apply.
      name:              OPTSTR(200),
      trigger_event:     OPTSTR(80),
      extension_summary: OPTSTR(2000),
    },
    required: ['slug'],
    check: (f) => (
      f.run_mode !== undefined && f.run_mode !== null && !['preview', 'autonomous'].includes(f.run_mode)
        ? ["run_mode must be 'preview' or 'autonomous'"]
        : []
    ),
    summary: (a) => {
      const f = a.fields;
      const label = f.name || f.slug;
      const trig = f.trigger_event ? ` (trigger: ${f.trigger_event})` : '';
      const auto = f.run_mode === 'autonomous'
        ? ' — and let it APPLY ITS CHANGES AUTOMATICALLY (tasks created, fields updated) without an Apply step. You can switch it back to confirm-first any time.'
        : '';
      return f.activate === false
        ? `Install extension "${label}"${trig} as a draft — it stays off until you activate it${auto}`
        : `Install and turn ON extension "${label}"${trig} from the curated library${auto}`;
    },
  },
  // Flip an existing extension between confirm-first 'preview' and
  // 'autonomous' (migration 167) — the chat mirror of
  // PATCH /api/plugins/:id/run-mode. SERVICE action: apply runs the same
  // org-scoped UPDATE + plugin.run_mode_changed audit as the route.
  // Owner/admin at propose AND apply (autonomous grants the plugin standing
  // write authority).
  'extension.set_mode': {
    service: 'extension',
    flag: 'plugins_enabled',
    requiresAdmin: true,
    requiresOrg: true,
    fields: {
      plugin_id: NUM,
      run_mode:  STR(12),
      // Display-only card context, re-resolved server-side at apply.
      name:      OPTSTR(200),
    },
    required: ['plugin_id', 'run_mode'],
    check: (f) => (
      !['preview', 'autonomous'].includes(f.run_mode)
        ? ["run_mode must be 'preview' or 'autonomous'"]
        : []
    ),
    summary: (a) => {
      const f = a.fields;
      const label = f.name ? `"${f.name}"` : `#${f.plugin_id}`;
      return f.run_mode === 'autonomous'
        ? `Let extension ${label} run autonomously — it will APPLY ITS CHANGES IMMEDIATELY (tasks created, fields updated) without an Apply step. You can switch back any time.`
        : `Switch extension ${label} back to confirm-first — its changes will wait for an owner/admin to Apply them.`;
    },
  },
  // ==========================================================================
  // WORKSPACE-BUILDING ACTIONS ("chat and BUILD"). Each mirrors the POST route
  // of its admin surface exactly — same validators, same INSERT shape — and
  // applyAction below carries a dedicated branch per entity (they need
  // JSONB/created_by columns the generic writer does not know about).
  //   custom_field.create    → POST /api/custom-fields      (owner/admin)
  //   automation_rule.create → POST /api/automation-rules   (owner/admin, automation_enabled)
  //   saved_view.create      → POST /api/saved-views        (any member)
  //   report.create          → POST /api/reports/saved      (any member, reports_enabled)
  // `requiresAdmin` is enforced at propose AND apply; `requiresOrg` because
  // these tables key on org_id (a personal workspace has no org schema).
  // ==========================================================================
  'custom_field.create': {
    table: 'org_field_definitions',
    requiresAdmin: true,
    requiresOrg: true,
    fields: {
      entity:   ENUM(...customFields.VALID_ENTITIES),
      name:     STR(60),
      label:    STR(120),
      type:     ENUM(...customFields.VALID_TYPES),
      options:  STRARRAY(50, 80),
      required: BOOL,
      position: (v) => Number.isInteger(v) && v >= 0 && v <= 999,
    },
    required: ['entity', 'name', 'type'],
    // The route's own source-of-truth validator: snake_case key, reserved-
    // column collision, select/multiselect options non-empty + unique.
    check: (f) => {
      const err = customFields.validateFieldDefShape(f);
      return err ? [err] : [];
    },
    summary: (a) => {
      const f = a.fields;
      const kind = f.type === 'boolean' ? 'checkbox' : f.type === 'select' ? 'dropdown' : f.type;
      return `Add ${kind} field "${f.label || f.name}" (${f.name}) to ${f.entity}`
        + (f.options && f.options.length ? ` — options: ${f.options.join(', ')}` : '')
        + (f.required ? ' (required)' : '');
    },
  },
  'automation_rule.create': {
    table: 'automation_rules',
    flag: 'automation_enabled',
    requiresAdmin: true,
    requiresOrg: true,
    fields: {
      name:       STR(200),
      trigger:    ENUM(...ruleSchemas.TRIGGERS),
      conditions: OBJ,
      action:     OBJ,
      enabled:    BOOL,
    },
    required: ['name', 'trigger', 'action'],
    // Same zod schema POST /api/automation-rules runs (trigger/action enums,
    // per-trigger condition refinements, deal-only action compatibility).
    check: (f) => {
      const r = ruleSchemas.createSchema.safeParse({
        name: f.name, trigger: f.trigger, conditions: f.conditions || {}, action: f.action, enabled: f.enabled !== false,
      });
      return r.success ? [] : zodErrors(r);
    },
    summary: (a) => describeRule(a.fields),
  },
  'saved_view.create': {
    table: 'saved_views',
    fields: {
      resource:    ENUM(...savedViewSchemas.VALID_RESOURCES),
      name:        STR(80),
      filter_spec: OBJ,
      sort_spec:   OBJ,
      is_default:  BOOL,
      is_shared:   BOOL,
    },
    required: ['resource', 'name'],
    check: (f) => {
      const r = savedViewSchemas.createSchema.safeParse(f);
      return r.success ? [] : zodErrors(r);
    },
    summary: (a) => {
      const f = a.fields;
      const filters = f.filter_spec ? Object.entries(f.filter_spec).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`) : [];
      return `Save ${f.is_shared ? 'a shared' : 'a'} ${f.resource} view "${f.name}"`
        + (filters.length ? ` filtered by ${filters.join(', ')}` : ' (no filters)')
        + (f.sort_spec && f.sort_spec.field ? `, sorted by ${f.sort_spec.field} ${f.sort_spec.direction || 'asc'}` : '')
        + (f.is_default ? ' — set as your default tab' : '');
    },
  },
  'report.create': {
    table: 'saved_reports',
    flag: 'reports_enabled',
    fields: {
      name:   STR(120),
      config: OBJ,
    },
    required: ['name', 'config'],
    // The report engine's own allowlist validator (entity/column/metric/op).
    check: (f) => {
      const v = reportBuilder.validateConfig(f.config);
      return v.ok ? [] : v.errors.map((e) => `config${e.path ? '.' + e.path : ''}: ${e.message}`);
    },
    summary: (a) => {
      const c = a.fields.config || {};
      const metric = !c.metric || c.metric === 'count' ? 'count' : c.metric.replace(':', ' of ');
      const filters = Array.isArray(c.filters) ? c.filters.map((fl) => `${fl.field} ${fl.op}${fl.value !== undefined ? ' ' + (Array.isArray(fl.value) ? fl.value.join('|') : fl.value) : ''}`) : [];
      return `Save report "${a.fields.name}": ${metric} of ${c.entity}`
        + (c.group_by ? ` grouped by ${c.group_by}${/(_at|_date)$/.test(c.group_by) ? ` (per ${c.group_by_granularity || 'month'})` : ''}` : '')
        + (filters.length ? `, where ${filters.join(' and ')}` : '')
        + ` as a ${c.chart_type || 'bar'} chart`;
    },
  },
  // Pipeline stages (migration 155) — a service action: the apply endpoint
  // routes it to services/pipelines.savePipeline (the SAME validator + deal-
  // move transaction PUT /api/pipelines runs). Owner/admin + org required at
  // propose AND apply. `stages` is the FULL resulting list, not a diff, so a
  // stale proposal can never half-apply; `change_summary` is the plain-
  // English diff shown on the card.
  'pipeline.update': {
    service: 'pipeline',
    requiresAdmin: true,
    requiresOrg: true,
    fields: {
      stages: (v) => Array.isArray(v) && v.length > 0 && v.length <= 60
        && v.every((st) => st && typeof st === 'object' && typeof st.label === 'string' && (st.id === undefined || typeof st.id === 'string')),
      moveDealsTo: (v) => typeof v === 'string' ? v.trim().length > 0 : (OBJ(v) && Object.values(v).every((x) => typeof x === 'string')),
      change_summary: STR(2000),
      // Which pipeline (spec 201) — a lowercase deal-type slug; omitted =
      // the default pipeline. Mirrors services/pipelines.DEAL_TYPE_RE.
      deal_type: (v) => typeof v === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(v),
    },
    required: ['stages'],
    check: (f) => {
      // Profile-independent rules only (the cap is profile-aware and runs
      // again inside savePipeline with the real profile).
      const pipelines = require('./pipelines');
      const v = pipelines.validateStages(f.stages, 'zang');
      return v.ok ? [] : v.errors;
    },
    summary: (a) => {
      const f = a.fields;
      const order = f.stages.map((st) => st.label).join(' → ');
      const which = f.deal_type ? `"${f.deal_type}" pipeline stages` : 'pipeline stages';
      return (f.change_summary ? `Update ${which}: ${f.change_summary}. ` : `Update ${which}. `)
        + `New order: ${order}`
        + (f.moveDealsTo && typeof f.moveDealsTo === 'object' && Object.keys(f.moveDealsTo).length
          ? ` (moving deals: ${Object.entries(f.moveDealsTo).map(([from, to]) => `${from} → ${to}`).join(', ')})` : '');
    },
  },
  // Module enablement — not a table write; the apply endpoint routes this to
  // featureFlags.setFeature after a role check (owner/admin/super-admin only).
  'feature_flag.set': {
    service: 'feature_flag',
    requiresAdmin: true,
    fields: {
      flag: (v) => typeof v === 'string' && TOGGLEABLE_FLAGS.includes(v),
      enabled: BOOL,
    },
    required: ['flag', 'enabled'],
    summary: (a) => `${a.fields.enabled ? 'Enable' : 'Disable'} the "${a.fields.flag}" module for your organization`,
  },
};

function specKey(entity, op) { return `${entity}.${op}`; }

// Plain-English rendering of an automation rule for the confirm card —
// "When a deal moves to closed_won, create a task "Send welcome email" (rule
// "Welcome email")". Uses the same trigger/action vocabulary as
// schemas/automationRules.js + the AdminAutomation form.
function describeRule(f) {
  const c = f.conditions || {};
  const act = f.action || {};
  let when;
  if (f.trigger === 'deal_stage_is') when = `When a deal moves to ${c.stage ?? '?'}`;
  else if (f.trigger === 'deal_idle_days') when = `When a deal has been idle for ${c.days ?? '?'} days`;
  else if (f.trigger === 'task_overdue') when = 'When a task becomes overdue';
  else when = `When ${f.trigger}`;
  let then;
  if (act.type === 'create_task') then = `create a task "${act.title || ''}"${act.priority ? ` (${act.priority} priority)` : ''} for the owner`;
  else if (act.type === 'notify') then = 'notify the record owner';
  else if (act.type === 'set_hot_flag') then = 'flag the deal as hot';
  else then = `run ${act.type}`;
  return `${when}, ${then} (rule "${f.name}"${f.enabled === false ? ', created disabled' : ''})`;
}

/**
 * Pure validation (no DB). Returns { ok, errors:[], action } where `action` is the
 * normalized { entity, op, target_id?, fields, summary }. Drops non-allowlisted
 * fields. DB-dependent checks (target/ref ownership) happen in the caller using
 * the org-scoped pool.
 */
function validateAction(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['action must be an object'] };
  const { entity, op } = raw;
  const spec = SPECS[specKey(entity, op)];
  if (!spec) {
    return { ok: false, errors: [`Unsupported action: ${entity}.${op}. Allowed: ${Object.keys(SPECS).join(', ')}`] };
  }
  const inFields = (raw.fields && typeof raw.fields === 'object') ? raw.fields : {};
  const fields = {};
  for (const [k, v] of Object.entries(inFields)) {
    if (!(k in spec.fields)) { errors.push(`field "${k}" is not writable on ${entity}`); continue; }
    if (!spec.fields[k](v)) { errors.push(`field "${k}" has an invalid value`); continue; }
    fields[k] = typeof v === 'string' && k !== 'append_note' && k !== 'note' ? v.trim() : v;
  }
  for (const r of spec.required) {
    if (fields[r] === undefined) errors.push(`field "${r}" is required`);
  }
  let target_id;
  if (spec.needsTarget) {
    if (!INT(raw.target_id)) errors.push(`${entity}.${op} requires a numeric target_id`);
    else target_id = raw.target_id;
  }
  if (op === 'update' && Object.keys(fields).length === 0) {
    errors.push('update needs at least one field to change');
  }
  // Spec-level cross-field checks (e.g. meeting ends_at >= starts_at, cohort
  // selector exclusivity). Pure — DB-dependent checks stay in the routes.
  if (spec.check && errors.length === 0) {
    errors.push(...spec.check(fields));
  }
  if (errors.length) return { ok: false, errors };
  const action = { entity, op, target_id, fields };
  action.summary = spec.summary(action);
  return { ok: true, errors: [], action };
}

// Collect the *_id references in an action that must be ownership-checked.
// Array-valued ref fields (e.g. sequence.enroll's contact_ids) fan out to one
// check per id, so a single smuggled cross-org id fails the whole proposal.
function referencedIds(action) {
  const spec = SPECS[specKey(action.entity, action.op)];
  const out = [];
  if (spec && spec.refs) {
    for (const [field, table] of Object.entries(spec.refs)) {
      const v = action.fields[field];
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        for (const id of v) out.push({ field, table, id });
      } else {
        out.push({ field, table, id: v });
      }
    }
  }
  return out;
}

/**
 * Execute a validated action inside an open pg client/transaction.
 * `scope` = { sf, sv, userId, orgId }. Updates are bound to the scope so a
 * cross-org target cannot be written. Returns the affected row (or null if the
 * scoped WHERE matched nothing — caller should treat as 404).
 */
async function applyAction(client, action, scope) {
  const { sf, sv, userId, orgId } = scope;
  const spec = SPECS[specKey(action.entity, action.op)];
  const f = action.fields;

  // Service actions (feature_flag.set, sequence.enroll, playbook.run,
  // cohort.action) are routed by the apply endpoint to their services — they
  // must never reach the generic table writer.
  if (spec.service) {
    throw new Error(`${action.entity}.${action.op} is a service action and cannot be applied as a table write`);
  }

  // Single-purpose owner assignment: one scoped UPDATE of owner_user_id.
  // The route re-ran ownerValidationError before calling us.
  if (action.op === 'assign_owner') {
    const r = await client.query(
      `UPDATE ${spec.table} SET owner_user_id = $1, updated_at = NOW()
        WHERE id = $2 AND ${sf} = $3 RETURNING *`,
      [f.owner_user_id, action.target_id, sv]);
    return r.rows[0] || null;
  }

  // Account lifecycle move — same UPDATE shape as PATCH
  // /api/companies/:id/lifecycle-stage (churned_at stamped on churn, cleared
  // on re-engage; churned_reason kept unless replaced). Playbooks fire in the
  // route AFTER commit, mirroring companyRoutes.
  if (action.op === 'set_lifecycle_stage') {
    const isChurn = f.lifecycle_stage === 'churned';
    const r = await client.query(
      `UPDATE companies SET lifecycle_stage = $1,
              churned_at = CASE WHEN $4::boolean THEN COALESCE(churned_at, CURRENT_TIMESTAMP) ELSE NULL END,
              churned_reason = CASE WHEN $4::boolean THEN COALESCE($5::text, churned_reason) ELSE NULL END,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $2 AND ${sf} = $3 RETURNING *`,
      [f.lifecycle_stage, action.target_id, sv, isChurn, f.churned_reason || null]);
    return r.rows[0] || null;
  }

  if (action.op === 'update') {
    if (action.entity === 'deal' && f.append_note !== undefined) {
      // append_note is special: concatenate onto existing notes rather than overwrite.
      const { append_note, ...rest } = f;
      const sets = [];
      const vals = [];
      for (const [k, v] of Object.entries(rest)) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
      vals.push(append_note);
      sets.push(`notes = COALESCE(notes || E'\\n', '') || $${vals.length}`);
      vals.push(action.target_id); const idIdx = vals.length;
      vals.push(sv); const scopeIdx = vals.length;
      const r = await client.query(
        `UPDATE ${spec.table} SET ${sets.join(', ')}, updated_at = NOW()
          WHERE id = $${idIdx} AND ${sf} = $${scopeIdx} RETURNING *`, vals);
      return r.rows[0] || null;
    }
    const keys = Object.keys(f);
    const sets = keys.map((k, i) => `${k} = $${i + 1}`);
    const vals = keys.map((k) => f[k]);
    vals.push(action.target_id); const idIdx = vals.length;
    vals.push(sv); const scopeIdx = vals.length;
    const r = await client.query(
      `UPDATE ${spec.table} SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${idIdx} AND ${sf} = $${scopeIdx} RETURNING *`, vals);
    return r.rows[0] || null;
  }

  // Workspace-building creates — each mirrors its admin route's INSERT.
  if (action.entity === 'custom_field') {
    // Same dup check + INSERT as POST /api/custom-fields. Re-run the shape
    // validator here too (defense in depth — the spec's `check` already did).
    const shapeErr = customFields.validateFieldDefShape(f);
    if (shapeErr) throw Object.assign(new Error(shapeErr), { status: 400 });
    const existing = await client.query(
      `SELECT id FROM org_field_definitions WHERE org_id = $1 AND entity = $2 AND name = $3`,
      [orgId, f.entity, f.name]);
    if (existing.rows.length > 0) {
      throw Object.assign(new Error(`Field "${f.name}" already exists on ${f.entity} for this org`), { status: 409 });
    }
    const r = await client.query(
      `INSERT INTO org_field_definitions
         (org_id, entity, name, label, type, options, required, position, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       RETURNING *`,
      [orgId, f.entity, f.name, f.label || f.name, f.type,
        JSON.stringify(f.options || []), !!f.required,
        Number.isInteger(f.position) ? f.position : 0, userId]);
    return r.rows[0] || null;
  }
  if (action.entity === 'automation_rule') {
    // Same INSERT as POST /api/automation-rules (zod-validated in `check`).
    const r = await client.query(
      `INSERT INTO automation_rules (org_id, name, trigger, conditions, action, enabled, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
       RETURNING id, org_id, name, trigger, conditions, action, enabled, created_by, created_at`,
      [orgId, f.name, f.trigger, JSON.stringify(f.conditions || {}), JSON.stringify(f.action), f.enabled !== false, userId]);
    return r.rows[0] || null;
  }
  if (action.entity === 'saved_view') {
    // Same transaction shape as POST /api/saved-views: clearing the previous
    // default and inserting happen on the one client so two defaults can
    // never be observed at once.
    if (f.is_default === true) {
      await client.query(
        `UPDATE saved_views SET is_default = FALSE WHERE user_id = $1 AND resource = $2 AND is_default = TRUE`,
        [userId, f.resource]);
    }
    const r = await client.query(
      `INSERT INTO saved_views
         (user_id, org_id, resource, name, filter_spec, sort_spec, is_default, is_shared)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, user_id, org_id, resource, name, filter_spec, sort_spec,
                 is_default, is_shared, display_order, created_at, updated_at`,
      [userId, orgId || null, f.resource, f.name,
        JSON.stringify(f.filter_spec || {}), JSON.stringify(f.sort_spec || {}),
        f.is_default === true, f.is_shared === true]);
    return r.rows[0] || null;
  }
  if (action.entity === 'report') {
    // Same INSERT as POST /api/reports/saved — persist the NORMALIZED config
    // (defaults filled in) so the saved report is always runnable.
    const v = reportBuilder.validateConfig(f.config);
    if (!v.ok) throw Object.assign(new Error('Invalid report config: ' + v.errors.map((e) => e.message).join('; ')), { status: 400 });
    const r = await client.query(
      `INSERT INTO saved_reports (org_id, user_id, name, entity, config, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, org_id, user_id, name, entity, config, created_by, created_at, updated_at`,
      [orgId || null, userId, f.name, v.config.entity, JSON.stringify(v.config), userId]);
    return r.rows[0] || null;
  }

  // create
  const cols = ['user_id', 'org_id'];
  const vals = [userId, orgId];
  // Spec-declared extra columns filled from the caller's scope (e.g.
  // meetings.created_by = userId) — never from model-supplied fields.
  if (spec.extraCols) {
    for (const [col, scopeKey] of Object.entries(spec.extraCols)) {
      cols.push(col);
      vals.push(scope[scopeKey]);
    }
  }
  // activity stores its note in the `description` column.
  const colMap = { note: 'description' };
  for (const [k, v] of Object.entries(f)) {
    cols.push(colMap[k] || k);
    vals.push(v);
  }
  const placeholders = vals.map((_, i) => `$${i + 1}`);
  const r = await client.query(
    `INSERT INTO ${spec.table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`, vals);
  return r.rows[0] || null;
}

module.exports = { validateAction, referencedIds, applyAction, describeRule, SPECS, COHORT_ACTIONS };
