# Chat Tools Reference

Every tool that Claude can call inside `POST /api/ai/chat`. The Claude SDK
sees these tool schemas in the `tools:` payload (`backend/services/ai.js:351`);
the route handler implements each via `buildChatToolRunner(req)` in
`backend/routes/aiRoutes.js:536`. Tool inputs are validated against
`input_schema`; the org scope is always injected server-side via `qs(req)` —
never trusted from the model.

53 tools live in seven groups:

- **CRM-action tools (8)** — surface deals, tasks, attention, at-risk accounts,
  drafts. Always available to every authenticated user in any mode.
- **Module read tools (5)** — `list_extensions`, `list_leads`, `list_open_cases`,
  `list_upcoming_meetings`, `list_sequences`. Org-scoped reads over the
  July-2026 module wave. Flag-aware: each gated handler checks the same
  feature flag its module's `/api` mount uses and returns `{ error, code:
  'FEATURE_DISABLED' }` when the org has the module off (org-less personal
  workspaces fail open, mirroring `middleware/featureGate.js`).
- **Customer diagnostic tools (11)** — self-service "why didn't X happen" plus
  the customer-plugin-loop tools (`run_plugin`, `describe_plugin`). Always
  exposed in the tool list (Claude needs the schema), but the system prompt
  only encourages diagnostic-tool use when the request is sent with
  `mode: 'debug'`. The two plugin-loop tools are usable in normal mode too.
- **Super-admin diagnostic tools (3)** — cross-tenant triage. Same schema for
  everyone, but each handler returns `{ error: 'not_authorized', code:
  'NOT_AUTHORIZED' }` unless `req.adminRole === 'super_admin'`.
- **Write-action tools (18, confirm-first / Spec 200 + control plane)** — the
  `propose_*` family, covering every module: deals (update + create), tasks,
  activities, contacts, companies, leads, cases, meetings, account lifecycle
  stage, record owners, sequence enrollment, playbook runs, feature flags,
  extension installs + run-mode changes (`propose_install_extension` w/ `autonomous?`,
  `propose_set_extension_mode`) — plus the
  **cohort harness** (`propose_cohort_action`) for bulk actions over a
  segment's current members, and the **chat plugin builder**
  (`propose_build_plugin`): describe a tool in plain English and get a
  validator-screened plugin-spec draft proposal (gated on `plugins_enabled`;
  Apply saves a `status='draft'` plugins row only — running it stays behind
  the existing sandboxed preview → owner/admin apply flow, so a chat-built
  plugin never auto-executes). These tools **never write.** Each validates +
  ownership-checks its inputs and returns a `{ proposal }` object the host UI
  renders as an Apply/Cancel card. The lone writer is
  `POST /api/ai/actions/apply`, which re-validates the echoed proposal
  server-side before committing. See "Confirm-first write flow" below.
- **Workspace-building tools (5, confirm-first — "chat and BUILD")** —
  `propose_add_custom_field`, `propose_automation_rule`,
  `propose_saved_view`, `propose_report`, `propose_update_pipeline`. The
  copilot can now build the
  workspace, not just edit records: each tool normalizes the plain-English
  request into exactly what the admin page's POST route accepts, validates it
  with **that route's own validator** (`customFieldsRoutes.validateFieldDefShape`,
  `schemas/automationRules`, `schemas/savedViews`, `reportBuilder.validateConfig`,
  `services/pipelines.validateStages`),
  and returns a proposal. Custom fields, automation rules, and pipeline
  edits are org
  owner/admin-only at propose AND apply (same bar as `/admin/customizations`,
  `/admin/automation`, and `/settings/pipeline`); saved views and reports are
  member-level, like their routes. See "Workspace-building tools" below.
- **Navigation + capability tools (3)** — `open_page` resolves any
  authenticated destination from the **navigation registry**
  (`chatCapabilities.PAGES`, ~55 pages, flag-aware) so the copilot never types
  a URL from memory; `how_do_i` / `list_modules` give grounded answers to
  "can I / how do I / what do I have turned on" from the capability registry
  (synonym-aware matching, top-2 on ambiguity, effective per-org flag values),
  so the copilot never invents features or setup steps.

Tier gating: every tool is universally available across Free / Starter / Pro /
Enterprise (the `/api/ai/chat` endpoint enforces feature gating + quotas
upstream — see `PRICING_AND_FEATURES.md`). The chat endpoint itself is gated
by `ai_features_enabled` and the per-tier monthly AI quota.

Audit event for every invocation:
- CRM-action tools: covered by the surrounding `ai.chat_message` row (which
  serializes the full `toolCalls` array in `meta`).
- Customer + super-admin diagnostic tools: each call additionally writes one
  `audit_log` row with `event = ai.debug_tool_invoked` (`DEBUG_TOOL_INVOKED`,
  `audit.js:84`), `target_type = 'chat_session'`, and `meta = { tool, args,
  scope }` where `scope` is `'org'` or `'super_admin'`. Rejected super-admin
  calls write `success = false` with `meta.rejected = 'not_authorized'`.

---

## CRM-action tools (8)

These are the original copilot tools. Each is hard-scoped to the caller's org
via the `[sf, sv] = qs(req)` closure captured at the top of
`buildChatToolRunner` (`aiRoutes.js:537`).

### `list_at_risk_accounts`

| Field | Value |
|---|---|
| Signature | `(band?: 'red'\|'yellow')` — default returns both |
| Scope | per-org |
| Reads | latest `account_health_snapshots` row per company (computed daily by the account-health worker) |
| Tier | universal |
| Example prompt | "Which customers are at risk?" / "What accounts should I check on?" |

Returns up to 20 rows, worst (lowest health score) first. Part of the
customer-success surface (see `/api/accounts` in `API.md`).

### 1. `list_deals`

| Field | Value |
|---|---|
| Signature | `(stage?: string, phase?: 'pre_sale'\|'post_sale'\|'post_ship', deal_type?: string, hot?: boolean, min_amount?: number, search?: string)` |
| Scope | per-org |
| Reads | `deals`, joined to `companies` (customer name) |
| Tier | universal |
| Source | `aiRoutes.js:539` |
| Example prompt | "Show me my deals over $50K in the customer-quoting stage." |

Response shape:
```json
{ "rows": [
  { "id":42, "title":"Acme HVAC retrofit", "stage":"CUSTOMER_QUOTING",
    "phase":"pre_sale", "deal_type":"default", "amount":75000,
    "expected_close_date":"2026-07-01",
    "last_activity_at":"2026-05-10T14:22:00Z", "hot_flag":true,
    "customer_name":"Acme Inc" }
] }
```

### 2. `get_deal`

| Field | Value |
|---|---|
| Signature | `(deal_id: integer)` (required) |
| Scope | per-org |
| Reads | `deals`, `companies`, `vendor_quotes`, `issues`, `activities` |
| Tier | universal |
| Source | `aiRoutes.js:558` |
| Example prompt | "What's the state of deal 42? Any open issues?" |

Returns `{ deal, vendor_quotes: [...], open_issues: [...], last_activities:
[...] }`. The deal block carries the same fields as `list_deals` + `notes` +
`next_step` / `next_step_date` (the rep's committed next action, migration 172;
`null` when none is set). The deal drawer's "Ask the copilot" button opens
`/chat?seed=deal&deal_id=N`, which pre-sends one grounded turn that leans on
this tool.

### 3. `list_overdue_tasks`

| Field | Value |
|---|---|
| Signature | `()` |
| Scope | per-org |
| Reads | `tasks` |
| Tier | universal |
| Source | `aiRoutes.js:581` |
| Example prompt | "What's overdue on my plate?" |

Returns `{ rows: [{ id, title, due_date, priority, deal_id, contact_id }] }`,
status `open` and `due_date < CURRENT_DATE`, ordered by due_date ascending,
limit 20.

### 4. `list_dormant_deals`

| Field | Value |
|---|---|
| Signature | `(days?: integer 1..365 — default 30)` |
| Scope | per-org |
| Reads | `deals`, `companies` |
| Tier | universal |
| Source | `aiRoutes.js:591` |
| Example prompt | "Who's gone dark? Anything quiet for 60+ days." |

Returns active deals (phase `pre_sale` or `post_sale`) with no activity in N
days, ordered by `last_activity_at` asc with nulls first.

### 5. `list_hot_deals`

| Field | Value |
|---|---|
| Signature | `()` |
| Scope | per-org |
| Reads | `deals`, `companies` |
| Tier | universal |
| Source | `aiRoutes.js:607` |
| Example prompt | "What hot pre-sale deals do I have?" |

Returns `phase='pre_sale' AND hot_flag=TRUE`, ordered by amount desc.

### 6. `summarize_attention`

| Field | Value |
|---|---|
| Signature | `()` |
| Scope | per-org |
| Reads | `deals`, `issues`, `tasks` (counts only) |
| Tier | universal |
| Source | `aiRoutes.js:621` |
| Example prompt | "What should I do today?" |

Returns aggregate counts (no PII): `{ hot_deals, active_deals,
pre_sale_pipeline_value, blocking_issues, red_urgency_issues, overdue_tasks }`.
Mirrors `metricsRoutes.js#/dashboard` so the copilot speaks the same numbers as
the dashboard.

### 7. `draft_email_for_deal`

| Field | Value |
|---|---|
| Signature | `(deal_id: integer, intent: string)` (both required) |
| Scope | per-org |
| Reads | `deals` + context, then calls Claude via `ai.draftFollowUp` |
| Tier | universal (but counts against the org's AI quota — burns a Claude call) |
| Source | `aiRoutes.js:657` |
| Example prompt | "Draft a check-in email for deal 42 — just asking about timing." |

Returns `{ draft, deal_id, deal_title }`. Same tone/recipient defaults as
`POST /api/ai/draft-followup`.

---

## Module read tools (4)

Org-scoped reads over the modules shipped in the July-2026 wave (leads,
cases, in-app meetings, email sequences). Same `[sf, sv] = qs(req)` scoping
contract as the CRM-action tools. The flag-gated ones consult
`featureFlags.hasFeature(req.orgId, <flag>)` — the same flag as the module's
`requireFeature` mount in `backend/index.js` — and return
`{ error, code: 'FEATURE_DISABLED', feature }` when the org has the module
off, so the copilot explains instead of hallucinating. Org-less personal
workspaces fail open (mirrors `middleware/featureGate.js`).

### `list_leads`

| Field | Value |
|---|---|
| Signature | `(status?: 'new'\|'working'\|'qualified'\|'unqualified'\|'converted', search?: string)` |
| Scope | per-org |
| Reads | `leads` |
| Flag | `leads_enabled` |
| Example prompt | "Any new leads this week?" / "Show me qualified leads." |

Returns up to 20 rows (`id, name, email, company_name, source, status,
owner_user_id, created_at`), newest first. `search` substring-matches lead
name or company name.

### `list_open_cases`

| Field | Value |
|---|---|
| Signature | `(priority?: 'low'\|'normal'\|'high'\|'urgent', company_id?: integer)` |
| Scope | per-org |
| Reads | `cases`, joined to `companies` (company name) |
| Flag | `customer_success_enabled` |
| Example prompt | "Any urgent open cases?" / "Are we breaching any SLAs?" |

Open = not resolved/closed. Returns up to 20 rows worst-SLA first, each with
a server-computed `sla_breached` boolean (`sla_due_at < NOW()`).

### `list_upcoming_meetings`

| Field | Value |
|---|---|
| Signature | `(days?: integer 1..90 — default 7)` |
| Scope | per-org |
| Reads | `meetings`, joined to `companies` (company name) |
| Flag | none (in-app meetings are core CRM — the `/api/meetings` mount is ungated) |
| Example prompt | "What meetings do I have this week?" |

Returns up to 20 meetings starting between now and N days out, soonest first.
These are the CRM's own `/calendar` meetings, NOT live Google/Outlook events.

### `list_sequences`

| Field | Value |
|---|---|
| Signature | `()` |
| Scope | per-org |
| Reads | `sequences`, `sequence_steps`, `sequence_enrollments` (aggregates) |
| Flag | `campaigns_enabled` |
| Example prompt | "How are my email sequences doing?" |

Returns up to 20 sequences with `step_count`, `active_enrollments`,
`completed_enrollments`, `is_active`. (Sends require an email transport on
the deployment; without one, due steps are held, not lost.)

---

## Customer diagnostic tools (11)

The self-service "why didn't X happen" surface. Recognized starter prompts
that trigger these (from `frontend/src/pages/Chat.js:37`):

- "Why isn't my last plugin run showing results?"
- "Show me the last 10 failed audit events for my org"
- "Why am I not getting notification emails?"
- "What custom fields does my workspace have configured?"

All are hard-scoped to `req.orgId`. Every invocation emits
`DEBUG_TOOL_INVOKED` with `scope='org'`. Note: schema is exposed regardless of
mode; the `mode: 'debug'` flag swaps in the augmented system prompt that tells
Claude to call them first for troubleshooting questions
(`ai.js:329`, `CHAT_DEBUG_PROMPT_EXTENSION`).

### 8. `recent_audit_events`

| Field | Value |
|---|---|
| Signature | `(limit?: integer 1..100 — default 20, event_prefix?: string, target_type?: string, hours?: integer 1..720 — default 72)` |
| Scope | per-org |
| Reads | `audit_log` |
| Tier | universal |
| Source | `aiRoutes.js:704` |
| Example prompt | "Show me the last 10 failed audit events for my org." / "Any email-related audit events in the last 24 hours?" |

Returns `{ rows: [{ time, event, success, meta, target_type, target_id, user_id }], window_hours }`.
Use `event_prefix` (`'email.'`, `'plugin.'`, `'ai.'`) to narrow. Bounded at
30 days lookback.

### 9. `inspect_plugin_run`

| Field | Value |
|---|---|
| Signature | `(run_id: integer)` (required) |
| Scope | per-org (`org_id` predicate in the WHERE clause) |
| Reads | `plugin_runs` |
| Tier | universal |
| Source | `aiRoutes.js:725` |
| Example prompt | "What happened on plugin run 8401?" |

Returns `{ run: { id, plugin_id, started_at, ended_at, status,
error_message, result_summary, trigger_kind, trigger_source, triggered_by,
cpu_ms, db_queries, egress_bytes, input_payload,
output_payload, log_lines } }`. Cross-tenant lookup is structurally blocked.
(`memory_peak_bytes` was dropped in migration 081.)

### 10. `recent_plugin_failures`

| Field | Value |
|---|---|
| Signature | `(plugin_id?: integer, hours?: integer 1..720 — default 24, limit?: integer 1..50 — default 20)` |
| Scope | per-org |
| Reads | `plugin_runs` (status NOT IN success/ok/running) |
| Tier | universal |
| Source | `aiRoutes.js:743` |
| Example prompt | "Why isn't my last plugin run showing results?" / "What plugins are failing today?" |

Returns `{ rows: [{ run_id, plugin_id, started_at, ended_at, status,
error_message, cpu_ms, db_queries, trigger_source, triggered_by }], window_hours }`.

### 11. `email_send_history`

| Field | Value |
|---|---|
| Signature | `(contact_id?: integer, deal_id?: integer, template_id?: integer, limit?: integer 1..50 — default 20)` |
| Scope | per-org |
| Reads | `email_sends` left-joined to `email_unsubscribes` |
| Tier | universal |
| Source | `aiRoutes.js:770` |
| Example prompt | "Did my email to contact 123 go out yesterday? Did they open it?" |

Returns `{ rows: [{ id, sent_at, to_email, subject, template_id,
to_contact_id, to_deal_id, opened_at, provider_dispatched,
unsubscribed_at }] }`. `provider_dispatched=true` means a real send (vs.
console-fallback when SMTP is unconfigured).

### 12. `notification_diagnostic`

| Field | Value |
|---|---|
| Signature | `(user_id?: integer)` — defaults to caller; non-super-admins can only inspect themselves |
| Scope | per-org (super-admin can cross-tenant) |
| Reads | `users`, `audit_log`, plus env-var check for SMS/email config |
| Tier | universal |
| Source | `aiRoutes.js:799` |
| Example prompt | "Why am I not getting notification emails?" |

Returns `{ user: { login_email, notification_email, effective_notification_email, notification_phone, notification_preferences }, platform: { sms_configured, email_configured }, recent_notification_events, hints }`.
The `hints[]` array surfaces the specific reason (missing phone, missing
Twilio creds, missing SMTP). 403 from inside the tool (`code:
'NOT_AUTHORIZED'`) if a non-super-admin asks for another user.

### 13. `saved_view_info`

| Field | Value |
|---|---|
| Signature | `(view_id: integer)` (required) |
| Scope | per-org (visible if owned by caller OR `is_shared=TRUE` on caller's org) |
| Reads | `saved_views` left-joined to `users` (creator) |
| Tier | universal |
| Source | `aiRoutes.js:862` |
| Example prompt | "My 'Hot pre-sale' tab is empty — show me saved view 17." |

Returns `{ view: { id, user_id, org_id, resource, name, filter_spec,
sort_spec, is_default, is_shared, display_order, created_at, updated_at,
creator_email, creator_name } }`.

### 14. `custom_field_status`

| Field | Value |
|---|---|
| Signature | `(entity: 'companies'\|'contacts'\|'deals'\|'tasks')` (required) |
| Scope | per-org |
| Reads | `org_field_definitions`, plus 5 sample rows of the entity table |
| Tier | universal |
| Source | `aiRoutes.js:883` |
| Example prompt | "What custom fields does my workspace have configured on deals?" |

Returns `{ entity, definitions: [...], sample_values: [{ id, custom_fields }] }`.
Useful when a custom field "isn't showing up" — confirms the def exists and
what's actually been written to the JSONB column.

### 15. `try_api`

| Field | Value |
|---|---|
| Signature | `(method: 'GET', path: string, body?: object)` — GET only; non-GET returns `METHOD_NOT_ALLOWED` |
| Scope | per-org (replays through the same Express app with the caller's auth) |
| Reads | whatever the target GET endpoint reads, with the caller's privileges |
| Tier | universal |
| Source | `aiRoutes.js:915` |
| Example prompt | "Run GET /api/deals?stage=TRIAGE and show me what comes back." |

Returns `{ status, body_preview, truncated }` — first 2 KB of the response,
5-second timeout. Read-only by enforcement (POST/PUT/DELETE rejected). Useful
for "the page is empty but my data should be there" — verifies the actual API
shape without leaving the chat.

### 16. `explain_error`

| Field | Value |
|---|---|
| Signature | `(error: string)` (required) |
| Scope | knowledge-only — no DB query |
| Reads | nothing |
| Tier | universal |
| Source | `aiRoutes.js:1049` (knowledge base at `:1028` `ERROR_HINTS`) |
| Example prompt | "I keep getting PLUGIN_QUERY_BUDGET_EXCEEDED — what does that mean?" |

Returns `{ error_string, recognized: true, code, explanation }` or
`{ recognized: false, hint }`. Known codes (as of 2026-05):
`PLUGIN_QUERY_BUDGET_EXCEEDED`, `PLUGIN_SANDBOX_UNAVAILABLE`, `QUOTA_EXCEEDED`,
`CHAT_DAILY_CAP`, `CHAT_RATE_LIMIT`, `CHAT_DEBUG_RATE_LIMIT`,
`AI_NOT_CONFIGURED`, `EMPTY_FILTER`, `METHOD_NOT_ALLOWED`.

---

### 20. `run_plugin`

| Field | Value |
|---|---|
| Signature | `(plugin_id?: integer, plugin_name?: string, input_payload?: object)` — id OR name is required |
| Scope | per-org (resolves plugins by `org_id`, runner is invoked with `triggerKind='chat'` / `triggerSource='copilot'`) |
| Reads | `plugins`, then writes a `plugin_runs` row via `services/pluginRunner.run` |
| Tier | universal (counts against the org's monthly plugin-run quota) |
| Source | `aiRoutes.js` `run_plugin` handler |
| Example prompt | "Run my stalled-deal digest now." / "Trigger plugin 12 with `{ deal_id: 42 }`." |

Returns the persisted `plugin_runs` row plus a `friendly_status` string from
`services/pluginRunFormatter.friendlyStatus()`:
```json
{ "run": { "id": 901, "plugin_id": 7, "status": "success",
           "friendly_status": "Worked", "cpu_ms": 42, "db_queries": 3,
           "log_lines": [...], "error_message": null, "result_summary": null },
  "plugin_id": 7, "plugin_name": "follow-up" }
```

Error codes the model may surface in plain English:
- `AMBIGUOUS_NAME` — multiple plugins match the name. Response carries
  `candidates: [{id, name}]` so the copilot can ask which one.
- `PLUGIN_NOT_FOUND` — no plugin found (or cross-tenant lookup blocked).
- `PLUGIN_DISABLED` — plugin found but `status != 'active'`. Response carries
  `hint: 'Open the plugin and toggle it on, or ask me to enable it.'`.
- `PLUGIN_REF_REQUIRED` — neither `plugin_id` nor `plugin_name` was supplied.

Action chip: `{ kind: 'navigate', path: '/plugins/<id>/runs#run-<runId>',
label: 'View run' }` — lands the user on the runs viewer with the new row
auto-expanded. Only emitted when the run actually completed (error paths
suppress the chip).

### 21. `describe_plugin`

| Field | Value |
|---|---|
| Signature | `(plugin_id: integer)` (required) |
| Scope | per-org (`qs(req)` predicate) |
| Reads | `plugins` (no source code; only name + description + trigger + action kinds/labels from `spec_json.actions`) |
| Tier | universal |
| Source | `aiRoutes.js` `describe_plugin` handler |
| Example prompt | "What does plugin 11 do?" / Auto-fires when a customer clones a template and lands in `/chat` via the seed prompt. |

Returns a sanitized view of the spec:
```json
{ "plugin": { "id": 11, "name": "...", "description": "...",
              "status": "draft", "source_kind": "library",
              "trigger_event": "deal.stage_changed",
              "trigger_filter": { "stage": "INVOICED" },
              "summary": "...",
              "actions": [{ "kind": "create_task", "title_template": "..." }] } }
```

**Source code is NEVER returned** — the action array exposes only
`kind` / `label` / `title_template` / `due_in_days` / `subject_template` /
`store_as` / `entity` / `field`. A read-back tool is for explaining intent,
not for inspecting the executable body.

Action chip: `{ kind: 'navigate', path: '/plugins/<id>', label: 'Open plugin' }`.

---

## Super-admin diagnostic tools (3)

Same schema for every caller — gating happens inside each handler via
`requireSuperAdmin()` (`aiRoutes.js:1077`). Non-super-admins receive
`{ error: 'not_authorized', code: 'NOT_AUTHORIZED' }`, and the rejection
itself writes an audit row with `success=false` and
`meta.rejected='not_authorized'` so permission-creep attempts are visible.

Audit event scope: `'super_admin'`.

Tier gating: per the marketing claim registry, Enterprise tier ships
super-admin access (only seat-of-trust users in the platform-admin team
should have `admin_users.role = 'super_admin'`).

### 17. `inspect_org`

| Field | Value |
|---|---|
| Signature | `(org_id: integer)` (required) |
| Scope | super-admin (cross-tenant) |
| Reads | `organizations`, `users`, `deals`, `audit_log` |
| Tier | Enterprise (super-admin role) |
| Source | `aiRoutes.js:1095` |
| Example prompt | "Pull the snapshot for org 42 — counts and recent failures." |

Returns `{ org: { id, name, profile, tier, created_at }, user_count,
deal_count, audit_events_last_30d, recent_failed_events: [{ time, event,
success, meta, target_type, target_id, actor_user_id }] }`.

### 18. `inspect_user`

| Field | Value |
|---|---|
| Signature | `(user_id: integer)` (required) |
| Scope | super-admin (cross-tenant) |
| Reads | `users`, `admin_users`, `audit_log` |
| Tier | Enterprise (super-admin role) |
| Source | `aiRoutes.js:1127` |
| Example prompt | "Why can't user 988 log in? Show me their last 10 events." |

Returns `{ user: { id, email, name, status, org_id, org_role, admin_role,
last_login_at, created_at }, recent_events: [...] }`.

### 19. `cross_org_recent_errors`

| Field | Value |
|---|---|
| Signature | `(hours?: integer 1..168 — default 24, limit?: integer 1..50 — default 20)` |
| Scope | super-admin (cross-tenant) |
| Reads | `audit_log` (all orgs, `success = FALSE`) |
| Tier | Enterprise (super-admin role) |
| Source | `aiRoutes.js:1151` |
| Example prompt | "What's broken across the platform right now?" |

Returns `{ rows: [{ time, event, success, meta, target_type, target_id,
org_id, actor_user_id }], window_hours }`. Triage starting point for
incidents — point at the most-frequent failing `event` first.

---

## Write-action tools (16 — confirm-first, Spec 200 + control plane)

These tools **never write to the database.** Each one validates its inputs,
ownership-checks any referenced ids against the caller's org, and returns a
`{ proposal }` the host UI renders as an Apply/Cancel card. The model is
instructed (system prompt) to read current state first (`get_deal`/`list_deals`
etc.) to resolve names → ids before proposing. All schemas set
`additionalProperties: false`.

| Tool | Signature (all optional unless noted) | Proposes |
|---|---|---|
| `propose_update_deal` | `(deal_id: int req, stage?, amount?, hot_flag?, expected_close_date?, next_step?, next_step_date?, append_note?)` | Move stage / set amount / flag hot / set close date / set the committed next step + due date (migration 172) / append a note |
| `propose_create_deal` | `(title: string req, company?, contact_name?, contact_email?, amount?, close_date?, stage?, deal_type?, notes?)` | Create a new deal. `company`/`contact_name`/`contact_email` are find-or-create by name (case-insensitive for the company; by email then name for the contact) — no ids required. `stage` accepts an id or a label and is validated against the org's pipeline for `deal_type` (re-validated again at apply); omitted, it defaults to that pipeline's first stage. `deal_type` (optional) picks which of the org's pipelines to file it under |
| `propose_create_task` | `(title: string req, due_date?, priority?, deal_id?, contact_id?)` | Create a task, optionally attached to a deal/contact |
| `propose_log_activity` | `(type: string req, deal_id?, contact_id?, title?, note?, activity_date?)` | Log a call/email/meeting/note/demo |
| `propose_upsert_contact` | `(id? → update else create, first_name?, last_name?, email?, phone?, company_id?, job_title?, status?)` | Create or update a contact |
| `propose_upsert_company` | `(id? → update else create, name?, industry?, phone?, location?, type?, status?)` | Create or update a company/account |
| `propose_create_lead` | `(name: string req, email?, phone?, company_name?, title?, source?, status?, notes?)` | Create a lead on the `/leads` board. Gated by `leads_enabled`; `status: 'converted'` is never proposable (conversion has its own transactional flow) |
| `propose_create_case` | `(subject: string req, description?, priority?, company_id?, contact_id?, sla_due_at?)` | Open a support case, optionally linked to a company/contact. Gated by `customer_success_enabled` |
| `propose_create_meeting` | `(title: string req, starts_at: string req, ends_at?, location?, notes?, company_id?, deal_id?, contact_id?)` | Create an in-app meeting on the CRM calendar (`created_by` stamped server-side; `ends_at` must follow `starts_at`) |
| `propose_set_lifecycle_stage` | `(company_id: int req, lifecycle_stage: string req, churned_reason?)` | Move an account along the relationship lifecycle (prospect → … → churned). Gated by `customer_success_enabled`; applying fires success playbooks post-commit, exactly like the PATCH route |
| `propose_assign_owner` | `(entity: 'company'\|'deal'\|'lead' req, record_id: int req, owner_user_id: int req)` | Assign a record owner (`owner_user_id`). The owner must be in-org (`recordOwnership.ownerValidationError`, re-checked at apply). Lead assignment gated by `leads_enabled` |
| `propose_enroll_in_sequence` | `(sequence_id: int req, contact_ids: int[] req ≤500)` | Enroll contacts in an email sequence. Gated by `campaigns_enabled`. **Enrollment only** — steps are sent later by the suppression-aware sequence worker, which is inert until an email transport is configured |
| `propose_run_playbook` | `(playbook_id: int req, company_id: int req)` | Run a success playbook's task checklist against a company. Gated by `customer_success_enabled`; idempotent per (playbook, company) |
| `propose_cohort_action` | `(segment_id? \| segment_name? \| (entity_type + criteria), action: string req, action_params?)` | The **cohort harness** — one bulk action over every current member. See below |
| `propose_set_feature_flag` | `(flag: string req, enabled: boolean req)` | Enable/disable a module for the org (owner/admin only can apply) |
| `propose_build_plugin` | `(description: string req, name?: string)` | Build a custom tool from a plain-English description. Reuses the shared spec generator (`services/pluginGenerator.js`, same engine as `POST /api/plugins/from-prompt`, metered as `chat-plugin-builder`), screens the output through `pluginSpecValidator`, and returns a draft proposal. Gated on `plugins_enabled` (inert by default). Applying saves a `status='draft'` plugins row (`applied.open_path` → `/plugins/:id`); execution stays behind the existing sandbox preview + owner/admin apply — two confirm gates, never auto-run |

Module-flag gating for the flag-gated entities (`lead.create`, `case.create`,
`company.set_lifecycle_stage`, `lead.assign_owner`, `sequence.enroll`,
`playbook.run`, `cohort.action`) is enforced **twice**: the `propose_*`
handler goes inert (`FEATURE_DISABLED`) when the module is off, and
`POST /api/ai/actions/apply` re-checks the flag before writing — so a proposal
minted before an admin disabled the module can never land.

### The cohort harness (`propose_cohort_action`)

Runs one allowlisted action over **every current member** of a cohort — the
chat-native version of `POST /api/segments/:id/bulk`:

- **Cohort selector:** a saved segment (`segment_id` or `segment_name`,
  org-scoped lookup) OR an inline filter (`entity_type` + `criteria` rows
  compiled through the strict allowlist in `services/segments.js` — field
  names/operators never reach SQL from user input).
- **Allowlisted actions:** `set_lifecycle_stage {lifecycle_stage}` (company
  cohorts), `assign_owner {owner_id}` (in-org checked),
  `create_task_for_each {title, description?, due_date?}`,
  `enroll_in_sequence {sequence_id}` (contact cohorts, `campaigns_enabled`),
  `open_case_for_each {subject, description?, priority?}`.
- **Proposal card shows the blast radius first:** the exact current member
  count + a 5-row sample, computed at propose time. An empty cohort or one
  over the cap refuses to propose at all.
- **Apply re-evaluates:** membership is recomputed at apply time (saved
  segments are re-read, so edits to the segment apply), capped at
  `MAX_BULK_AFFECTED` (5000), org owner/admin only (proposal AND apply), and
  audited with the affected count.
- **Email guardrail:** `enroll_in_sequence` creates enrollment rows only —
  nothing on the apply path can send mail. Sending belongs exclusively to the
  sequence worker, which honors unsubscribes and no-ops entirely
  (`skipped: 'email_not_configured'`) until the deployment has an email
  transport. Nothing is ever auto-applied; the apply is always an explicit
  user click.

### Workspace-building tools (5 — "chat and BUILD")

| Tool | Signature | Proposes | Apply gate |
|---|---|---|---|
| `propose_update_pipeline` | `(add?: [{label, id?, after?, before?, tone?, phase?, is_won?, is_lost?, desc?}], rename?: {ref: newLabel}, remove?: [{slug, moveDealsTo?}], reorder?: string[], deal_type?)` | A `pipeline.update` — applies the diff to the org's CURRENT effective pipeline and proposes the FULL resulting stage list (so a stale proposal can never half-apply), validated by `services/pipelines.validateStages` — the same validator `PUT /api/pipelines` runs. Removing a stage that still holds deals requires `moveDealsTo` (the tool returns `stages_have_deals` + counts otherwise); the apply runs `savePipeline` (deal moves + upsert in one transaction). **`deal_type` (spec 201, optional)** picks WHICH pipeline when the org runs several — omitted = the main pipeline; a NEW lowercase slug creates a second pipeline for that deal type on apply. Deal sweeps are scoped to the addressed type. | **org owner/admin** (`requiresAdmin` + `requiresOrg`) |
| `propose_add_custom_field` | `(entity: 'deal'\|'company'\|'contact'\|'task' req, name: string req, key?, type: text\|number\|date\|select\|multiselect\|boolean\|checkbox\|url\|email req, options?: string[], required?)` | A `custom_field.create` — a row in `org_field_definitions`, exactly what `POST /api/custom-fields` inserts. `name` is the human label ("Contract Value"); the snake_case key (`contract_value`) is derived unless `key` is given. `checkbox` → `boolean`; `url`/`email` → `text` (noted in the result). Reserved-column collisions and select-without-options are refused by the route's own `validateFieldDefShape`; a duplicate key is refused at propose (org-scoped pre-flight) and again at apply (409). Leads are refused honestly (no custom fields on leads yet). | **org owner/admin** (`requiresAdmin` + `requiresOrg`) |
| `propose_automation_rule` | `(trigger: deal_stage_is\|deal_idle_days\|task_overdue\|custom_date_offset req, stage?, days?, conditions? (custom_date_offset: {entity: deals\|companies\|contacts, field_name (a date-type org field), offset_days ±}), action: create_task\|notify\|set_hot_flag\|create_task_and_notify req, params?: {title, priority?}, name?, enabled?)` | An `automation_rule.create` — the same `{ name, trigger, conditions, action, enabled }` row `POST /api/automation-rules` inserts, validated by the same zod schema (per-trigger conditions, deal-only `set_hot_flag`). A user-typed stage ("Closed Won") is resolved to a real stage id via `utils/dealStages`. The proposal `summary` is the rule in plain English: *"When a deal moves to closed_won, create a task "Send welcome email" for the owner (rule "…")"*. Gated by `automation_enabled`. | **org owner/admin** (`requiresAdmin` + `requiresOrg`) |
| `propose_saved_view` | `(entity: 'deal'\|'company'\|'contact'\|'task' req, name: string req, filters?: object, sort?: {field, direction}, is_shared?, is_default?)` | A `saved_view.create` — the same row `POST /api/saved-views` inserts (with the same set-default-then-insert transaction). Filter keys are checked against `ai.SEARCH_CATALOG` (the keys the list pages actually understand) so a view can never silently show everything. | any member (own views) |
| `propose_report` | `(name: string req, entity: deals\|contacts\|companies\|activities req, filters?: [{field, op, value}], group_by?, granularity?, metric?: 'count'\|'sum:<f>'\|'avg:<f>', chart?: bar\|line\|pie\|table)` | A `report.create` — a `saved_reports` row exactly as `POST /api/reports/saved` writes it; the config is validated (and normalized) by `reportBuilder.validateConfig`, the engine's own allowlist. Gated by `reports_enabled`. | any member |

The apply endpoint returns `open_path` / `open_label` for these
(`/admin/customizations`, `/admin/automation`, `/<resource>`,
`/reports/builder`) so the UI can offer an "Open …" follow-up. Route-equivalent
rejections surface with the route's status (409 duplicate field, 400 invalid
config) rather than a generic 500.

### Apply-permission table (`POST /api/ai/actions/apply`)

Every apply re-validates the echoed proposal, re-checks the module flag
(`flag`), and then applies the role/org gate below. `isOrgAdminReq` = org
owner/admin (a personal workspace user is their own admin, but `requiresOrg`
actions additionally need an org).

| Action | Flag re-checked | Who can apply |
|---|---|---|
| `deal.update`, `deal.create`, `task.create`, `activity.create`, `contact.*`, `company.create/update`, `meeting.create` | — | any member |
| `company.assign_owner`, `deal.assign_owner` | — | any member (owner must be in-org) |
| `lead.create`, `lead.assign_owner` | `leads_enabled` | any member |
| `case.create`, `company.set_lifecycle_stage`, `playbook.run` | `customer_success_enabled` | any member |
| `sequence.enroll` | `campaigns_enabled` | any member |
| `saved_view.create` | — | any member |
| `report.create` | `reports_enabled` | any member |
| `plugin.create_draft` | `plugins_enabled` | any member (org required; saves a draft only) |
| `custom_field.create` | — | **org owner/admin**, org required |
| `automation_rule.create` | `automation_enabled` | **org owner/admin**, org required |
| `pipeline.update` | — | **org owner/admin**, org required (optional `deal_type` addresses one of the org's pipelines) |
| `cohort.action` | `customer_success_enabled` | **org owner/admin** (proposal AND apply) |
| `feature_flag.set` | — | **org owner/admin or platform super-admin**, org required |

### Confirm-first write flow

1. The user asks the copilot to make a change ("move deal 42 to negotiation").
2. The model calls a `propose_*` tool. The handler validates + ownership-checks
   and returns a `{ proposal }` — **nothing is written.**
3. The Chat UI renders an Apply/Cancel card from the proposal.
4. On **Apply**, the frontend calls `POST /api/ai/actions/apply`
   (`aiRoutes.js`) with the echoed proposal. That endpoint — the **only
   writer** — re-validates the proposal server-side and commits the change in a
   transaction (service actions route to their services:
   `sequences.enroll`, `playbooks.runPlaybookForCompany`,
   `segments.runBulkAction`, `featureFlags.setFeature`).
   `propose_set_feature_flag` and `propose_cohort_action` additionally require
   org owner/admin at apply time.

---

## Navigation + capability tools (3)

Grounded product-knowledge tools backed by the capability registry and the
navigation registry (both in `backend/services/chatCapabilities.js`), so the
copilot answers "can I / how do I / where is" without inventing features,
steps, or URLs. The capability registry covers the classic topics (email
import, QuickBooks, branding, GDPR, …), the July-2026 module wave (leads,
cases, meetings, segments, sequences, surveys, playbooks, win-back,
notifications, ownership, tier limits, portal), and — new — the **building**
topics: `custom_fields`, `pipeline_stages` (honest: stages are fixed per
profile today, per-org editing is roadmap; the entry lists every profile's
stages and `how_do_i` adds `your_profile` / `your_stages`),
`automation_rules` (points at `/admin/automation` + `propose_automation_rule`,
**not** plugins), `saved_views`, `reports` (incl. the builder), `forecast`,
`csv_import`, `tasks_basics`, `contacts_companies_basics`, `deals_pipeline`,
`drive_intel`, `outlook_m365`, `google_calendar_sync`, `usage_and_ai_keys`,
`modules_feature_flags`, and `build_with_chat`.

Matching (`chatCapabilities.lookupAll`): questions and keyword phrases are
normalized and stemmed (so "add fields" matches "add a field"); each topic
also carries single-word `synonyms` with a smaller weight ("column" /
"property" → custom fields, "rule" / "trigger" / "automate" → automation
rules). `how_do_i` returns the best entry plus `also_relevant` when the
runner-up scores ≥ 60% of the winner, so an ambiguous question surfaces both.

| Tool | Signature | Returns |
|---|---|---|
| `open_page` | `(page: string req)` | `{ page: { key, path, label } }` resolved from the navigation registry (`PAGES`) by key, label, alias, or path — e.g. "report builder" → `/reports/builder`, "modules" → `/admin/feature-flags`, "my day" → `/today`. Flag-aware: a page whose module is off returns `disabled: true`, the flag, and a hint to propose it. Unknown names return `error: 'unknown_page'` + `suggestions` + `known_pages` — never a guessed URL. Read-only. |
| `how_do_i` | `(question: string req)` | The grounded capability entry: status (`live`/`config`/`roadmap`/`unsupported`), where it lives, the gating flag **and** `enabled_for_your_org` (the flag's effective value for the caller's org), the real setup steps (which name the `propose_*` tool that builds it from chat), plus `also_relevant` on ambiguity. Unknown → `{ status: 'unknown' }` + `known_topics`. |
| `list_modules` | `()` | Every capability with status/location/gating **and** `enabled_for_your_org`, plus every non-platform `KNOWN_FLAGS` entry with its default and effective value for this org (`null` in a personal workspace). Use before proposing a feature-flag change. |

---

## Action-chip mapping

After a chat turn, the route handler inspects `toolCalls` and emits up to 4
"action chips" the React UI renders below the assistant reply
(`aiRoutes.js:1200` `buildActionsFromToolCalls`). The mapping today:

Navigation chips are **registry-driven**: `TOOL_NAV_CHIPS` in `aiRoutes.js`
maps a read tool to a page *key*, and the path/label come from
`chatCapabilities.PAGES` — the same registry `open_page` resolves against —
so a chip and the tool can never disagree about where a page lives. Any tool
result with `code: 'FEATURE_DISABLED'` suppresses its chip.

| Tool | Chip kind | Registry key → path |
|---|---|---|
| `list_overdue_tasks` | navigate | `overdue_tasks` → `/tasks?bucket=overdue` |
| `list_hot_deals` | navigate | `hot_deals` → `/deals?hot=true` |
| `list_dormant_deals` | navigate | `dormant_deals` → `/deals?last_activity_window=30d` |
| `list_at_risk_accounts` | navigate | `companies` → `/companies` (label "Show accounts") |
| `list_deals` (phase=pre_sale) | navigate | `pre_sale_deals` → `/deals?phase=pre_sale` |
| `get_deal` | open_deal | `{ deal_id }` |
| `draft_email_for_deal` | draft_email | `{ deal_id }` |
| `summarize_attention` | navigate | `dashboard` → `/dashboard` |
| `list_leads` (unless FEATURE_DISABLED) | navigate | `leads` → `/leads` |
| `list_open_cases` (unless FEATURE_DISABLED) | navigate | `cases` → `/cases` |
| `list_upcoming_meetings` | navigate | `calendar` → `/calendar` |
| `list_sequences` (unless FEATURE_DISABLED) | navigate | `sequences` → `/sequences` |
| `open_page` (resolved, not disabled) | navigate | the resolved page's `path` / `label` |
| `how_do_i` (entry has a `where`) | navigate | the capability's `where` |
| `propose_*` (on a returned proposal) | apply_action | `{ proposal }` → Apply/Cancel card |
| `run_plugin` (on success) | navigate | `/plugins/<id>/runs#run-<runId>` |
| `describe_plugin` | navigate | `/plugins/<id>` |

Diagnostic tools deliberately do NOT emit action chips — there's no
"navigate to the audit log row" UI yet. (Suggested next iteration: surface a
chip to copy the row id or jump to `/admin/audit-logs?id=...`.)

---

## Invariants you can rely on

1. **Tool execution never trusts a Claude-supplied org id.** Every handler
   captures `[sf, sv] = qs(req)` once and uses it for every query. If Claude
   tries to pass an extra `org_id` field, the input schema's
   `additionalProperties: false` rejects it.
2. **Tool loop is bounded.** `MAX_TOOL_ITERATIONS = 5` in
   `ai.js:588`. A hallucinating model can't run us into the ground.
3. **Diagnostic tools always emit audit rows.** Every customer-facing
   diagnostic tool calls `logDebugInvocation(toolName, args, 'org')` at the
   top of its handler. Super-admin tools log `'super_admin'` scope; rejections
   log `success=false` with `meta.rejected='not_authorized'`.
4. **Rate limiting is mode-aware.** `chatLimiter` (20/min) for normal use;
   `chatDebugLimiter` (40/min) when `mode: 'debug'` is on. Daily cap 200/user
   counted against `chat_messages` (not env-state-based).
5. **The tools list is identical for all callers.** Super-admin tools live in
   `CHAT_TOOLS` for everyone — the model gets the same schema regardless of
   role, and per-call gating happens in the handler. This means a regular user
   could see the super-admin tools described in the system prompt; the prompt
   tells Claude to skip them for non-super-admins, and any actual call returns
   the `not_authorized` error the model surfaces in plain English.

---

## Adding a new tool

1. Define the schema in `CHAT_TOOLS` in `backend/services/ai.js` (after the
   appropriate section comment).
2. Implement the handler in `buildChatToolRunner` in
   `backend/routes/aiRoutes.js` — first call `logDebugInvocation(...)` (if it
   reads anything operational), then run scoped queries.
3. Register the handler in the `runTool` switch at the bottom of
   `buildChatToolRunner` (`aiRoutes.js:1169`).
4. If the tool has a useful UX follow-up, add it to
   `buildActionsFromToolCalls` so the user gets a chip — for a navigation
   chip, add the destination to `chatCapabilities.PAGES` (if missing) and map
   the tool to its key in `TOOL_NAV_CHIPS`; never hardcode a path.
5. Add a row here, an audit-event row to `API.md`'s "Audit events" table, and
   if the tool is intended for a particular tier or super-admin, update
   `PRICING_AND_FEATURES.md`'s AI-copilot section.


---

## Extension tools (2026-09-17)

### `list_extensions`

| Field | Value |
|---|---|
| Signature | `(category?: string, tag?: string, search?: string)` |
| Scope | catalog is global (`services/pluginLibrary.list()`); install status per-org via `services/extensionInstall.getLibraryStatusForOrg` (one query over `plugins.library_slug`) |
| Reads | curated library + `plugins` (status only) |
| Tier | universal; gated on `plugins_enabled` (FEATURE_DISABLED when off; org-less fail-open) |
| Source | `aiRoutes.js` `list_extensions` handler |
| Example prompt | "What extensions do you have for follow-ups?" |

Returns `{ extensions: [{slug, name, category, summary, tags, trigger_event, required_integration, installed, active, installed_plugin_id?}], total, categories, note }`. Action chip: navigate → `/plugins/library` ("Browse the extension library").

### `propose_install_extension`

| Field | Value |
|---|---|
| Signature | `(slug: string, activate?: boolean = true)` |
| Scope | per-org; owner/admin at propose AND apply; `plugins_enabled` re-checked at apply |
| Writes | NONE — proposal card only. The apply branch of `POST /api/ai/actions/apply` routes `extension.install` to `services/extensionInstall.installLibraryTemplate` (same internals as the library page's Enable; idempotent — an existing clone is activated, never duplicated) |
| Errors | `unknown_extension` (+`known_slugs`), `already_installed`, `not_authorized`, `FEATURE_DISABLED`; apply: 403 / 404 `TEMPLATE_NOT_FOUND` |
| Example prompt | "Turn on the stalled-deal digest." |

Triggered extensions run in the confirm-first preview posture: any writes an
event- or schedule-triggered run proposes land as proposals on the run row for
Apply — an extension never writes unattended.


### `propose_set_extension_mode`

| Field | Value |
|---|---|
| Signature | `(slug_or_plugin: string, mode: 'preview'\|'autonomous')` |
| Scope | per-org; owner/admin at propose AND apply |
| Writes | NONE — proposal card; apply mirrors `PATCH /api/plugins/:id/run-mode` (audited `plugin.run_mode_changed`) |
| Example prompt | "Let the stalled-deal digest apply its tasks automatically." |

`propose_install_extension` also accepts `autonomous?: boolean` — the proposal
card states plainly that the extension will apply its changes without an
Apply step.
