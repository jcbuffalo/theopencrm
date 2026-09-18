# DATA_MODEL — The Open CRM

Table-by-table reference. Every claim cites `backend/migrations/<file>:<line>`. For per-route shapes see [`API.md`](./API.md); for the multi-tenant pattern see [`ARCHITECTURE.md`](./ARCHITECTURE.md#cross-tenant-isolation--the-invariants).

Conventions throughout:
- `org_id` is the canonical tenant scope. Almost every business table carries it (added in migration 033 for the original 7 tables; included from creation on everything since).
- `user_id` typically denotes the row's creator, not its tenant. Migration 054 separated `created_by` / `updated_by` / `entity_version` from `user_id` on the original entities.
- `public_id UUID` is added to entities referenced externally (URLs, signed PDFs) — `migration 050:22-39` introduced it for companies/deals/quotes; later entities (purchase_orders, invoices, plugins) carry it from creation.
- Most CHECK constraints live on status / urgency / type / role enums.
- All immutability triggers are on `audit_log` (migration 048).

## Domain map

| Domain | Tables | Migrations |
|---|---|---|
| Identity & access | users, admin_users, organizations, org_invites, account_deletions, user_password_history | 001, 002, 032, 043, 045, 059, 065 |
| Audit & compliance | audit_log, audit_logs, security_checks, accessibility_audits, playstore_compliance | 003, 004, 005, 006, 042, 048, 054, 062 |
| CRM core (v1) | companies, contacts, deals, activities, tasks, pipelines, custom_fields | 020-026, 030, 033-037, 046, 049, 050, 054, 068, 070 |
| Customer/vendor (v1 quoting) | quotes, quote_revisions, quote_line_items, vendor_quotes, submittals, change_orders, issues, documents, service_contracts, appreciation_queue, addresses, company_roles | 038, 039, 040, 041, 045, 046, 047, 049 |
| Phase 2 (v2 entities) | rfqs, rfq_line_items, rfq_versions, purchase_orders, purchase_order_line_items, purchase_order_versions, invoices, invoice_line_items, invoice_versions, invoice_allocations | 051, 052, 053, 057 |
| Feature flags & branding | (columns on `organizations`) | 044, 055, 056, 061, 063 |
| Plugin platform | plugins, plugin_runs, plugin_quota_usage, org_field_definitions | 061, 062, 069, 070, 075 |
| Saved views / filters | saved_views (legacy `saved_filters` dropped in 079) | 046, 068, 073, 079 |
| Chat copilot | chat_sessions, chat_messages | 071 |
| Email send-from-CRM | email_templates, email_sends, email_unsubscribes | 067, 072 |
| Notifications | (columns on `users`, `admin_users`) | 058, 064, 066, 074 |
| Integrations | quickbooks_connections, qb_oauth_state, automation_runs, survey_invitations, meeting_logs | 045 |
| Usage / billing | usage_meter, (tier + stripe on `organizations`) | 060, 061, 063 |

---

## Identity & access

### `users` (001)
PK `id SERIAL`. Unique `email`. Fields: `name`, `password_hash`, `provider`, `oauth_id` (Google), `plan` (legacy — superseded by `organizations.tier`), `stripe_customer_id`. Indexes: `email`, `(provider, oauth_id)`. Migration 033 added `org_id FK organizations(id) ON DELETE SET NULL` + `org_role` (default `'owner'`). Migration 043 added user-status fields: `status` (`active | pending_approval | rejected | suspended | pending_deletion` — last value documented in `059:29`), `request_company`, `request_reason`, `requested_at`, `approved_at`, `approved_by`, `rejected_reason`. Migration 045 added email-verification and 2FA fields: `email_verified`, `email_verification_token`, `email_verification_expires`, `two_factor_secret`, `two_factor_enabled`, `two_factor_recovery_codes TEXT[]`. Migration 064 added `notification_preferences JSONB`. Migration 066 added `notification_email VARCHAR(254)` and `notification_phone VARCHAR(32)` (both nullable; NULL has semantic meaning — see JSONB Appendix).

### `admin_users` (002)
PK `id`. Unique `user_id FK users(id) ON DELETE CASCADE`. `role` ∈ `super_admin | admin | moderator | viewer` (default `viewer`, line 6). `permissions TEXT[]`. Migration 058 added `notification_preferences JSONB`. Note: there is no CHECK constraint pinning `role` to the documented set — application code enforces.

### `organizations` (032)
PK `id`. `name`, `owner_user_id FK users(id) CASCADE`, `plan` (default `free`). Migration 044 added `profile VARCHAR(40)` (default `generic`; documented values `generic | zang` — `044:5-8`). Migration 055 added `branding JSONB` (default `{}`). Migration 056 added `features JSONB` (default `{}`) — the per-org feature-flag store. Migration 061 added `tier VARCHAR(20)` with CHECK ∈ `free | starter | pro | enterprise` (`061:13-14`). Migration 063 added `stripe_customer_id`. GIN indexes on `branding` and `features` for `@>` containment queries.

### `org_invites` (032:12-26)
PK `id`. `org_id`, `invited_by_user_id`, `email`, `role` (default `member`), unique `token`, `accepted_at`, `expires_at`. Used by `/api/invites/:token`.

### `account_deletions` (059)
PK `id`. `user_id`, `requested_at`, `scheduled_at` (7-day grace), `processed_at`, `cancelled_at`, `status` with CHECK ∈ `scheduled | cancelled | processed | failed` (`059:15-16`), `reason`, `notes`. Partial index `idx_account_deletions_status_scheduled_at WHERE status='scheduled'` (`059:22-24`) drives the worker.

### `user_password_history` (065)
PK `id BIGSERIAL`. `user_id`, `password_hash TEXT`, `set_at TIMESTAMPTZ`. Index `(user_id, set_at DESC)` for "last N hashes" lookups. Used by `validatePasswordAsync` to enforce no-reuse-of-last-N policy (`auth.js:71-98`).

---

## Audit & compliance

### `audit_log` (042) — append-only
PK `id BIGSERIAL`. Fields: `event`, `actor_user_id`, `org_id`, `target_type`, `target_id`, `ip`, `user_agent`, `request_id`, `meta JSONB`, `success BOOLEAN`. Indexes: `event`, `actor_user_id`, `org_id`, `created_at`, `(target_type, target_id)`. Migration 048 installs `audit_log_immutable()` triggers on BEFORE UPDATE / BEFORE DELETE that raise EXCEPTION — application credentials cannot rewrite history (`048:12-26`). Compliance: NIST SP 800-53 AU-9, SOC 2 CC7.2. Migration 062:52-54 adds partial index `idx_audit_log_auth_fail_lookup ON audit_log(event, created_at DESC) WHERE event='auth.login.failed'`.

Event vocabulary lives in `backend/services/audit.js:EVENTS` (`audit.js:11-85`).

### `audit_logs` (003) — legacy
PK `id`. `user_id`, `admin_id`, `action`, `resource_type`, `resource_id`, `changes JSONB`, `ip_address`, `user_agent`, `status`, `details`. Written by the admin-action middleware (`backend/middleware/auditLog.js:10-43`). Coexists with `audit_log` (042) — both are populated; `audit_log` is the canonical newer surface, `audit_logs` is the legacy admin-route surface.

### `security_checks` (004), `accessibility_audits` (005), `playstore_compliance` (006)
Internal compliance scaffolds. Not tenant-scoped. Used by admin dashboards.

---

## CRM core (v1)

### `companies` (020 + 035 + 036 + 046 + 049 + 050 + 054 + 068 + 070)
PK `id`. Original cols (020): `user_id`, `name`, `industry`, `website`, `location`, `employee_count`, `annual_revenue BIGINT`, `notes`, `status` (default `active`). Migration 033 added `org_id` + index. Migration 036 added `type VARCHAR(20)` (default `customer`; values `customer | vendor | end_user | partner | other` per `services/ai.js:191-198`) + `phone`. Migration 046 added `first_deal_at`, `last_deal_at` (backfilled from `deals`). Migration 050 added `public_id UUID UNIQUE NOT NULL` (`050:22,32,37`), plus `source`, `tax_id`, `taxable BOOLEAN`, `marketing_opt_in INTEGER`, `quickbooks_id`. Migration 054 added `created_by`, `updated_by`, `entity_version`. Migration 068 added `owner_id FK users(id)`. Migration 070 added `custom_fields JSONB NOT NULL DEFAULT '{}'` + GIN index (`070:51,59`).

### `contacts` (021 + 035 + 050 + 054 + 068 + 070)
PK `id`. `user_id`, `company_id FK companies ON DELETE SET NULL`, `first_name`, `last_name`, `email`, `phone`, `job_title`, `status` (default `prospect`; values `prospect | customer | lead | inactive` per `services/ai.js:185-187`), `ai_summary`, `ai_next_action`, `notes`, `tags VARCHAR(255)[]`. `org_id` added 033. Migration 050:50-51 added `contact_role` with CHECK ∈ `buyer | decisionmaker | technical | operations | manager | other`. Migration 054 added audit metadata. Migration 068 added `owner_id`. Migration 070 added `custom_fields JSONB` + GIN.

NB: there was an earlier `contacts` table from `010_create_contacts.sql` with a different shape (`user_id` + `company VARCHAR` flat). The 021 migration recreates with `IF NOT EXISTS` — which is a no-op if 010 already ran. On fresh DBs 021 wins; on long-lived DBs schema is the 010 shape plus all later ALTERs. (Honest gap: this dual-history is a footgun; the 010/021 collision should be cleaned up.)

### `deals` (023 + many)
PK `id`. Long-evolving table. Key fields and where they came from:
- Core (023): `user_id`, `contact_id`, `company_id`, `title`, `amount DECIMAL(15,2)`, `stage` (default `lead` — full CHECK-free value vocabulary in `services/ai.js:170-171`), `expected_close_date`, `closed_date`, `closed_amount`, `ai_health_score`, `ai_win_probability`, `ai_risk_factors`, `notes`, `tags`.
- Migration 030: `kanban_position INTEGER`.
- Migration 033: `org_id`.
- Migration 036: `vendor_id FK companies`, `salesman_id FK users`, `vertical`, `lost_reason`.
- Migration 037 (Zang lifecycle): `phase VARCHAR(20)` default `pre_sale` (values `pre_sale | post_sale | post_ship` per `services/ai.js:171`), `customer_id FK companies`, `po_number`, `ship_to`, `poc_name`, `poc_email`, `poc_phone`, `target_ship_date`, `actual_ship_date`, `hot_flag BOOLEAN`, `release_status` default `released`, `hold_reason`, `last_activity_at`.
- Migration 045: `qb_invoice_id`, `qb_invoiced_at`.
- Migration 046: `end_user_company_id`, `end_user_contact_id`, `buy_back_status` (`none | eligible | requested | approved | completed`, `046:11-12`), `buy_back_amount`, `buy_back_notes`, `delivery_checklist JSONB DEFAULT '[]'`, `deal_class`, `deal_size`, `product`, `office_location`.
- Migration 050: `external_ref`, `public_id UUID UNIQUE NOT NULL`.
- Migration 054: `created_by`, `updated_by`, `entity_version`.
- Migration 070: `custom_fields JSONB` + GIN.

Stage CHECK constraint is absent — application code in `routes/dealRoutes.js:40-47` keeps the `VALID_STAGES` list.

### `activities` (024 + 033 + 054)
PK `id`. `user_id`, `contact_id`, `deal_id`, `type` (call/email/meeting etc.), `title`, `description`, `activity_date`, `duration_minutes`, `outcome`, `ai_summary`, `ai_action_items`, `ai_next_steps`, `notes`. `org_id` added 033. Audit metadata 054.

### `tasks` (025 + 033 + 054 + 068 + 070 + 074)
PK `id`. `user_id`, `contact_id`, `deal_id`, `title`, `description`, `due_date DATE`, `status` (default `open`), `priority` (default `medium`). Migration 033 `org_id`. Migration 054 audit metadata. Migration 068 added `assigned_to FK users(id)`. Migration 070 added `custom_fields JSONB`. Migration 074 added `last_overdue_notified_at TIMESTAMPTZ` + partial index for the overdue-task worker.

### `pipelines` (026 + 033)
PK `id`. `user_id`, `name`, `stages VARCHAR(255)[]` (default `lead/qualified/proposal/negotiation/won/lost`), `owner_id`. `org_id` added 033.

### `custom_fields` (022) — legacy v1 EAV table
PK `id`. `user_id`, `object_type`, `object_id`, `field_name`, `field_value TEXT`. Now superseded by the per-entity `custom_fields JSONB` columns added in migration 070; this legacy table is still queryable but new writes go to the JSONB column.

---

## Quoting / vendor workflow (v1)

### `quotes` (038 + 050 + 054)
PK `id`. `user_id`, `org_id`, `deal_id`, `customer_id`, `title`, `status` (default `draft`), `total_amount`, `valid_until`, `current_revision`, `notes`. Migration 050 added `public_id UUID UNIQUE NOT NULL`. Migration 054 added audit metadata.

### `quote_revisions` (038:21-32)
PK `id`. UNIQUE `(quote_id, revision_number)`. Snapshot model is per-row revision.

### `quote_line_items` (038:34-46)
PK `id`. `quote_id`, `vendor_id`, `description`, `quantity`, `unit_price`, `markup_pct`, `position`.

### `vendor_quotes` (038:48-67)
PK `id`. `user_id`, `org_id`, `deal_id`, `vendor_id`, `status` (default `requested`), `rfq_sent_at`, `quote_received_at`, `amount`, `lead_time_days`, `is_selected BOOLEAN`, `notes`.

### `submittals` (039:1-16)
PK `id`. `user_id`, `org_id`, `deal_id`, `version`, `type` (default `drawing`), `status` (default `pending_vendor`), `notes`, `approved_at`.

### `change_orders` (039:18-30)
PK `id`. `user_id`, `org_id`, `deal_id`, `number`, `description`, `amount_delta`, `status` (default `pending`), `approved_at`.

### `issues` (040:1-26)
PK `id`. `user_id`, `org_id`, `related_type`, `related_id`, `title`, `description`, `category`, `sub_category`, `urgency` default `green` (vocabulary: `red | yellow | green` — application convention), `financial_impact`, `blocks_workflow BOOLEAN`, `status` default `open`, `assigned_to_user_id`, `resolution_notes`, `resolved_at`. Indexes on `org_id`, `status`, `urgency`, `(related_type, related_id)`, `assigned_to_user_id`.

### `documents` (040:28-47 + 041)
PK `id`. `user_id`, `org_id`, `related_type`, `related_id`, `doc_type`, `filename`, `url VARCHAR(1000)`, `content BYTEA` (in-DB fallback), `size`, `mime_type`, `notes`, `uploaded_by`. Migration 041 added `gcs_object_path`, `gcs_bucket` for GCS-backed storage with the inline `content` blob as the fallback.

### `service_contracts` (046:55-71)
PK `id`. `user_id`, `org_id`, `customer_id`, `deal_id`, `name`, `contract_type` (default `service`), `start_date`, `end_date`, `renewal_notice_days` default 30, `status` default `active`, `monthly_amount`, `notes`. The renewal-alert cron uses `end_date - renewal_notice_days`.

### `appreciation_queue` (047)
PK `id`. `user_id`, `org_id`, `customer_id`, `contact_id`, `deal_id`, `reason VARCHAR(100)` (vocab: `project_completed | big_milestone | long_dormant_recovered | birthday | manual` — `047:14-15`), `gift_type` (`thank_you_note | gift_card | merchandise | flowers | phone_call | other`, `047:17-18`), `status` (`queued | in_progress | sent | skipped`, `047:19-20`), `notes`, `scheduled_for DATE`, `completed_at`, `completed_by`.

### `addresses` (049:17-43)
PK `id BIGSERIAL`. `org_id`, `company_id`, `contact_id`, `type` CHECK ∈ `primary | billing | shipping | warehouse | other` (`049:22-23`), `street1`, `street2`, `city`, `state`, `postal_code`, `country`, `is_default`. CHECK `addresses_owner_required`: `company_id IS NOT NULL OR contact_id IS NOT NULL` (`049:37-38`). Audit metadata + `entity_version`.

### `company_roles` (049:45-62)
PK `id BIGSERIAL`. `org_id`, `company_id`, `role` CHECK ∈ `customer | vendor | internal | partner | prospect` (`049:49-50`), `is_active`. UNIQUE `(company_id, role)`. Lets one company be customer + vendor.

---

## Phase 2 / v2 entities (RFQ / PO / Invoice)

Pattern: every v2 table carries `org_id`, audit metadata (`created_by`, `updated_by`, `entity_version`), and a `*_versions` companion that snapshots `line_items_snapshot JSONB` + `metadata_snapshot JSONB` to preserve historical state cleanly (the fix for the proposal's broken versioning model — see `051:9-12`).

### `rfqs` (051:14-41)
PK `id BIGSERIAL`. `org_id`, `deal_id`, `customer_id`, `vendor_id`, `status` CHECK ∈ `draft | sent | responded | closed | cancelled` (`051:22-23`), `title`, `description`, `external_ref`, `current_version`, `sent_at`, `responded_at`. With `rfq_line_items` (`051:43-59`) and `rfq_versions` (`051:61-77`).

### `purchase_orders` (052:10-39)
PK `id BIGSERIAL`. `org_id`, `deal_id`, `quote_id`, `vendor_id NOT NULL ON DELETE RESTRICT`, `status` CHECK ∈ `draft | sent | acknowledged | released | received | cancelled` (`052:17-18`), `po_number`, `external_ref`, `current_version`, `sent_at`, `acknowledged_at`, `released_at`, `public_id UUID UNIQUE NOT NULL`. With `purchase_order_line_items` (`052:41-62`; carries denormalized `quantity_invoiced` + `amount_invoiced`) and `purchase_order_versions` (`052:64-77`).

### `invoices` (053:15-39)
PK `id BIGSERIAL`. `org_id`, `deal_id`, `customer_id`, `status` CHECK ∈ `draft | sent | partial | paid | void | overdue` (`053:20-21`), `invoice_number`, `external_ref`, `total_amount`, `due_date`, `paid_at`, `current_version`, `public_id UUID UNIQUE`, `quickbooks_id`. With `invoice_line_items` (`053:48-65`; `amount` is `GENERATED ALWAYS AS (quantity * unit_price) STORED` — `053:55`) and `invoice_versions`.

### `invoice_allocations` (053:87-106)
PK `id BIGSERIAL`. The pattern that justifies the v2 layer: one invoice line consumes (`allocated_quantity DECIMAL(15,4)`, `allocated_amount DECIMAL(15,2)`) from one `purchase_order_line_items.id` (ON DELETE RESTRICT — cannot drop a PO line that's been allocated). Many-to-many across invoice/PO line pairs. Sum-of-allocations CHECK against PO line quantity is enforced in app layer (`053:11-13`).

---

## Plugin platform

### `plugins` (061:25-53)
PK `id BIGSERIAL`. `org_id`, `name`, `description`, `spec_json JSONB` default `{}`, `source_code TEXT`, `source_kind` CHECK ∈ `conversational | library | code` (`061:37-38`), `status` CHECK ∈ `draft | active | suspended | errored` (`061:39-40`), `trigger_event VARCHAR(120)`, `trigger_filter_json JSONB`, `public_id UUID`. UNIQUE `(org_id, name)`. Audit metadata.

### `plugin_runs` (061:62-82 + 069 + 075 + 081)
PK `id BIGSERIAL`. `plugin_id`, `org_id`, `started_at`, `ended_at`, `status`, `trigger_kind`, `trigger_data JSONB`, `result_summary`, `error_message`, `cpu_ms`, `db_queries`, `egress_bytes`, `ai_input_tokens`, `ai_output_tokens`. Migration 069 added `triggered_by`, `trigger_source` (`manual | webhook | cron | event | test_run`), `input_payload JSONB`, `output_payload JSONB`, `log_lines TEXT[]`. Migration 081 dropped `memory_peak_bytes` — isolated-vm does not expose peak heap after `dispose()`, so the column always stored 0; if we revive a memory metric it will be under an honestly-named column with a real source. Status CHECK widened twice:
- 069 → `running | success | ok | error | timeout | memory_exceeded | killed | quota_exceeded | rejected`
- 075 → adds `query_budget_exceeded`, `concurrent_limit_exceeded`

Final CHECK from `075:32-43`: `'running','success','ok','error','timeout','memory_exceeded','killed','quota_exceeded','rejected','query_budget_exceeded','concurrent_limit_exceeded'`.

### `plugin_quota_usage` (061:94-101)
PK `id`. `org_id`, `window_kind` CHECK ∈ `minute | hour | day`, `window_start`, `runs_count`. UNIQUE `(org_id, window_kind, window_start)`.

### `org_field_definitions` (070:27-44)
PK `id BIGSERIAL`. `org_id`, `entity` CHECK ∈ `companies | contacts | deals | tasks` (`070:31`), `name`, `label`, `type` CHECK ∈ `text | number | date | select | multiselect | boolean` (`070:33-34`), `options JSONB DEFAULT '[]'`, `required`, `position`. UNIQUE `(org_id, entity, name)`. The registry; the values live in each entity's `custom_fields JSONB`.

---

## Saved filters / views

### `saved_filters` — **DROPPED in migration 079 (2026-05-15)**
Legacy table created by 046:80-91 (`user_id`, `org_id`, `scope`, `name`, `filters JSONB`). Backfilled into `saved_views` by migration 073:62-81 and dropped by migration 079. `filterRoutes.js` reads/writes `saved_views` exclusively while preserving the legacy `/api/filters/saved` wire shape (`scope`↔`resource`, `filters`↔`filter_spec`).

### `saved_views` (068 + 073)
PK `id BIGSERIAL`. `user_id`, `org_id`, `resource VARCHAR(32)` (`companies | contacts | deals | tasks`), `name VARCHAR(80)`, `filter_spec JSONB DEFAULT '{}'`, `sort_spec JSONB DEFAULT '{}'`, `is_default BOOLEAN`. Migration 073 added `is_shared BOOLEAN` (cross-org publish) and `display_order INTEGER` (drag-to-reorder). Partial index `idx_saved_views_org_shared WHERE is_shared=TRUE`.

---

## Chat / copilot

### `chat_sessions` (071:23-30)
PK `id UUID DEFAULT gen_random_uuid()`. `user_id`, `org_id`, `started_at`, `last_message_at`, `message_count`. Cascade-delete with user.

### `chat_messages` (071:41-49)
PK `id BIGSERIAL`. `session_id UUID FK chat_sessions`, `role` CHECK ∈ `user | assistant`, `content TEXT NOT NULL`, `tool_calls JSONB DEFAULT '[]'` (raw Anthropic tool_use blocks), `actions JSONB DEFAULT '[]'`. Indexed by `(session_id, created_at)`.

---

## Email send-from-CRM

### `email_templates` (067:29-38 + 072:29-35)
PK `id BIGSERIAL`. `org_id`, `name VARCHAR(120)`, `subject TEXT`, `body TEXT`, `created_by`, `last_used_at TIMESTAMPTZ` (added 072 for "Recently used" picker). Index `(org_id, last_used_at DESC NULLS LAST)`.

### `email_sends` (067:51-71 + 072:46-47)
PK `id BIGSERIAL`. `org_id`, `sent_by`, `to_contact_id`, `to_deal_id`, `to_email NOT NULL`, `subject`, `body`, `template_id` (informational only — content is copied at send time), `opened_at TIMESTAMPTZ` (stamped by tracking-pixel route), `sent_at`, `provider_message_id TEXT`. Indexes: `(org_id, sent_at DESC)`, partial on `to_contact_id`, partial on `to_deal_id`, and `sent_at` alone (072 — for retention sweep).

### `email_unsubscribes` (067:82-95)
PK `id BIGSERIAL`. `org_id`, `email`, `contact_id`, `unsubscribed_at`, `token VARCHAR(64) UNIQUE`. The `/send` gate checks for any row with non-null `unsubscribed_at` matching `(org_id, email)`.

---

## Integrations

### `quickbooks_connections` (045:16-31)
PK `id`. UNIQUE `org_id`. `realm_id`, `access_token`, `refresh_token`, `access_token_expires_at`, `environment` default `production`, `connected_by`, `last_sync_at`, `last_sync_status`, `last_sync_error`.

### `qb_oauth_state` (045:33-42)
PK `id`. Short-lived (`expires_at`) OAuth state token.

### `automation_runs` (045:51-63)
PK `id BIGSERIAL`. `org_id`, `rule`, `target_type`, `target_id`, `fired_at`, `status` default `fired`, `meta JSONB`. Tracks triggered automation rule executions for dedupe + observability.

### `survey_invitations` (045:66-78)
PK `id`. `user_id`, `org_id`, `deal_id`, `customer_email`, `survey_token UNIQUE`, `sent_at`, `responded_at`, `rating`, `feedback`.

### `meeting_logs` (045:86-103)
PK `id`. `user_id`, `org_id`, `related_type`, `related_id`, `source`, `external_id`, `title`, `participants`, `occurred_at`, `duration_minutes`, `recording_url`, `transcript`, `summary`, `raw_payload JSONB`. Inserts from `/api/webhooks/*` (Teams, Zoom, generic).

---

## Usage metering

### `usage_meter` (060)
PK `id BIGSERIAL`. UNIQUE `(org_id, period, metric)`. `period VARCHAR(10)` (e.g. `'2026-05'`), `metric VARCHAR(50)` (`ai_requests | ai_input_tokens | ai_output_tokens | plugin_runs | emails_sent | documents_uploaded_bytes`), `count BIGINT`, `estimated_cost_usd_cents BIGINT`, `first_at`, `last_at`. Indexes `(org_id, period)` and `(period)`.

---

# Appendix — JSONB shape contracts

Exact key/type expectations for every JSONB column. Application code reads/writes via these contracts; migrations include comments where relevant.

### `audit_log.meta`
Event-specific. Examples documented inline at `services/audit.js:11-85`:
- `email.sent`: `{ "transport_kind": "sendgrid"|"gmail"|"console", "to":"...", "template_id": N? }`
- `plugin.run`: `{ "runId": N, "status":"...", "triggerSource":"...", "cpu_ms":N, "db_queries":N }`
- `ai.chat_message`: `{ "session_id":"uuid", "user_message":"...", "reply":"...", "tool_calls":[...] }`
- `ai.debug_tool_invoked`: `{ "tool":"name", "args":{...}, "scope":"org"|"super_admin" }`
- `ai.conversational_search`: `{ "query":"...", "resource":"...", "filter":{...} }`
- `customization.applied`: `{ "actions":[...], "request":"natural-language prompt" }`
- `bulk.update` / `bulk.delete`: `{ "ids":[...], "patch":{...} }`

### `organizations.branding` (`055:7-23`)
```jsonc
{
  "displayName":  "string",
  "logoUrl":      "https://...",     // optional
  "primaryColor": "#hexcolor",       // optional
  "labels": {                        // optional; only override what you need
    "externalRef": "string",
    "deal":        "string",
    "deals":       "string"
  }
}
```

### `organizations.features` (`056:8-12`)
Flat object `{ "<flag_name>": <boolean> }`. Known names enumerated in `services/featureFlags.js:KNOWN_FLAGS`.

### `users.notification_preferences` (`066:30-37` — current shape; replaces the flat shape from migration 064)
```jsonc
{
  "task_assigned":   { "email": true, "sms": false },
  "task_overdue":    { "email": true, "sms": false },
  "deal_activity":   { "email": false, "sms": false },
  "weekly_summary":  { "email": true, "sms": false }
}
```
`users.notification_email` (NULL → fall back to `users.email`) and `users.notification_phone` (NULL → SMS disabled regardless of toggle) are sibling columns on the same table.

### `admin_users.notification_preferences` (`058:8-19`)
```jsonc
{
  "email": "override@example.com",       // optional override
  "events": {
    "access_request_submitted": true,
    "signup":                   true,
    "login_failed_threshold":   true,
    "login_success_new_ip":     false,
    "weekly_digest":            false
  },
  "throttle_minutes": 30
}
```
Missing event keys → fall back to per-event defaults in `services/adminNotify.js`.

### `<entity>.custom_fields` (`070:51-54`)
Open object `{ "<field_name>": <value> }` where `field_name` matches an `org_field_definitions` row for the same `(org_id, entity)`. Value type aligns with `org_field_definitions.type`:
- `text` → string
- `number` → number
- `date` → ISO date string (`YYYY-MM-DD`)
- `select` → string from `options` array
- `multiselect` → array of strings from `options`
- `boolean` → true/false
The validator lives in `routes/customFieldsRoutes.js`; CRUD handlers merge incoming `custom_fields` patches into the JSONB column.

### `org_field_definitions.options` (`070:34`)
Array of strings (for `select`/`multiselect`). Empty `[]` for other types.

### `saved_views.filter_spec` and `.sort_spec` (`068:29-30`)
Deliberately opaque per-resource. Each list page (Deals/Contacts/Companies/Tasks) defines its own shape; no cross-page normalization layer. `sort_spec` typical shape: `{ "field": "name", "direction": "asc" }`.

### `saved_filters.filters` (`046:84`) — dropped
Legacy free-form filter object. Backfilled into `saved_views.filter_spec` by `073:62-81`; table dropped in migration 079 (2026-05-15).

### `deals.delivery_checklist` (`046:18`)
Array. Default `[]`. Each entry is a free-form checklist item; frontend ships a default template.

### `rfq_versions.line_items_snapshot` / `metadata_snapshot` (`051:69-70`); same pattern for `purchase_order_versions` / `invoice_versions`
`line_items_snapshot` is an array of objects mirroring the live `*_line_items` row shape at the moment of snapshot. `metadata_snapshot` is an object of any non-line-item header fields the route handler chose to snapshot. Self-contained; the version row does NOT FK to current line items.

### `plugins.spec_json` (`061:31`)
Structured representation of a Claude-authored plugin. Free-form during Phase C; expected shape evolves as the conversational authoring matures.

### `plugins.trigger_filter_json` (`061:44`)
Optional. Free-form filter the trigger engine applies before invoking the plugin (e.g. `{ "stage": "TRIAGE" }` to only fire when a deal enters TRIAGE).

### `plugin_runs.input_payload` / `output_payload` / `trigger_data` (`069:31-32`, `061:71`)
- `input_payload`: the JSON object the caller passed in (request body or trigger event payload).
- `output_payload`: the JSON object the plugin's `run()` returned (truncated to 64 KB by the runner).
- `trigger_data`: the original event payload for triggered runs.

### `chat_messages.tool_calls` / `.actions` (`071:46-47`)
- `tool_calls`: array of raw Anthropic `tool_use` blocks `[{name, input, id}, ...]`.
- `actions`: array of action chips the host UI can render `[{label, kind, payload}, ...]`.

### `automation_runs.meta` (`045:59`)
Rule-specific. The triggered-automation engine stamps fields like `{ "from_stage":"...", "to_stage":"...", "dedupe_key":"..." }`.

### `meeting_logs.raw_payload` (`045:100`)
The verbatim webhook body from Teams / Zoom / etc., kept for forensics + future reprocessing.

### `survey_invitations`-adjacent — none (no JSONB on this table).

### Legacy `audit_logs.changes` (`003:11-12`)
`{ "before": {...}, "after": {...} }`. Set by the admin-action middleware on UPDATE-y routes.

---

## Footnotes

- **Foreign-key cascade choices.** Tenant-scoped tables CASCADE off `organizations(id)` so deleting an org wipes its rows in one transaction. Identity tables SET NULL off `users(id)` for `created_by` / `updated_by` so audit history survives user deletion.
- **`public_id` rationale** (`050:1-9`): BIGSERIAL primary keys are enumerable. Anything that travels in an outbound URL (signed PDF, vendor portal, kanban share link) uses the UUID instead. Internal joins keep using the integer PKs for index efficiency.
- **No `RESTRICT` cascades** except `invoice_allocations.purchase_order_line_item_id` (`053:92`) and `purchase_orders.vendor_id` (`052:16`) — protecting against accidental drops of in-use vendor/PO line records.
- **No data-level multi-tenant policy** (no Postgres RLS). Application-level `qs(req)` is the enforcement point. See [`ARCHITECTURE.md`](./ARCHITECTURE.md#cross-tenant-isolation--the-invariants).
- **Honest gap.** The `audit_log` table is not partitioned. See [`RUNBOOK.md` §7](./RUNBOOK.md#7-audit-log-growth--retention).
