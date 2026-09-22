# API Reference

Backend API for The Open CRM. Every endpoint listed here is implemented in
`backend/routes/`. No Swagger / OpenAPI yet — this file is the source of truth.

**Base URL (prod):** `https://synccrm-backend-615440681743.us-central1.run.app/api`
**Base URL (local):** `http://localhost:5001/api`

This refresh enumerates every `router.(get|post|put|delete|patch)` in
`backend/routes/`. Routes are grouped by resource (H2) with one row per
endpoint (H3-equivalent rows in the tables). If you cite this file, cite the
implementation file:line as well — they're the source of truth.

> ⚠️ **Coverage gap (2026-07-14):** three shipped waves are mounted in `index.js`
> but not yet documented below with full request/response shapes. Rather than
> half-document them, they're listed here with their gates (Wave F gets brief
> route-level shapes); full sections are a follow-up. Until then, the route
> files are the reference.
>
> - **Full-lifecycle wave (migrations 123–139):** `/api/playbooks`, `/api/pulse`,
>   `/api/lifecycle-funnel`, `/api/winback`, `/api/segments`, `/api/cases`,
>   `/api/surveys` (+ public `/api/public/surveys`) — all `customer_success_enabled` ·
>   `/api/my-day`, `/api/notifications`, `/api/meetings` + `/api/calendar/agenda` — ungated core ·
>   `/api/leads`, `/api/lead-forms` (+ public `/api/public/lead-forms`) — `leads_enabled` ·
>   `/api/sequences` — `campaigns_enabled` · `/api/commission` — `reports_enabled` ·
>   plus `POST /api/import/deals`, `GET /api/deals/export.csv`, recurring-task
>   fields on `/api/tasks`, and `?owner=me|<id>` filtering on companies/deals.
> - **Earlier wave, also undocumented here:** `/api/products`, `/api/sales-quotes`
>   (`products_enabled`) · `/api/reports` (builder), `/api/forecast`, `/api/retention` ·
>   `/api/sms`, `/api/calls` · `/api/keys`, `/api/webhooks-out`, `/api/v1` ·
>   `/api/automation-rules` · `/api/auth/sso` (OIDC/SCIM) · Google Calendar sync
>   under `/api/calendar` (`calendar_enabled`).
> - **Wave F (migrations 140–141), both inert by default:**
>   - `/api/msgraph` — Outlook / Microsoft 365 (`routes/msgraphAuthRoutes.js`),
>     mounted behind `requireAnyFeature('outlook_mail_enabled', 'outlook_calendar_enabled')`
>     (both default OFF). `GET /connection` · `GET /auth/start` · `GET /auth/callback`
>     (sessionless OAuth redirect target) · `DELETE /connection` ·
>     `POST /mail/sync` (`outlook_mail_enabled`) · `POST /calendar/sync`
>     (`outlook_calendar_enabled`) — the manual-sync routes are per-org rate-limited.
>     Per-deal read surface: `GET /api/deals/:id/outlook-intel` (same any-of gate) →
>     `{ connected, messages, events }` — deal-matched Outlook mail + calendar rows,
>     each lane re-checking its own flag; whitelisted projections (no Graph ids).
>   - `/api/portal/tokens` — customer-portal token management
>     (`routes/portalRoutes.js`, gated `portal_enabled`, default OFF):
>     `GET /` · `POST /` (mints a 192-bit token) · `POST /:id/revoke` · `DELETE /:id`.
>   - `/api/public/portal/:token/(overview|deals|documents|documents/:id/download|cases)` —
>     **public, no session**: the unguessable token is the credential. CSRF-exempt,
>     per-IP rate-limited, strictly scoped to the token's single company, and every
>     failure (bad/revoked/expired token, flag off, foreign document id) is a
>     generic 404 — no oracle. Reads plus FOUR writes behind a shared strict
>     limiter (10/15min/IP): **portal v2 (148)** `POST /:token/cases` submits a
>     support case — sanitized text + allowlisted priority only, rows tagged
>     `source='portal'`, fan-out via `portal_case_submitted`; `GET /:token/cases`
>     lists only that company's portal-submitted cases. **Portal v3 (149)**
>     `POST /:token/quotes/:id/respond` records `{action: 'approved'|`
>     `'changes_requested', note?}` in dedicated `portal_response*` columns —
>     the internal quote `status` lifecycle is never touched from the public
>     surface; fan-out via `portal_quote_response`. **Portal v4 (150)**
>     `GET`/`POST /:token/messages` — the per-company thread in the dedicated
>     `portal_messages` table (structurally customer-visible; NOT
>     record_comments); `author_type` pinned `'customer'` server-side; fan-out
>     via `portal_message_received`. Team side: member-level `GET`/`POST
>     /api/portal/messages?company_id=` (before the admin gate — only token
>     management is owner/admin). **Portal v5 (151)** `POST /:token/documents`
>     uploads a file — token resolved BEFORE multer buffers; 10MB cap;
>     extension+MIME allowlist (no HTML/SVG — stored-XSS guard); sanitized
>     filename; 25-per-company quota; rows tagged `source='portal'` with
>     `uploaded_by NULL`; fan-out via `portal_document_uploaded`. Otherwise
>     read-only except a best-effort `last_accessed_at` stamp.
>
> Also note: mount-level `requireFeature` gates now genuinely enforce
> (`middleware/featureGate.js` resolves the session pre-auth), so a disabled
> module returns `403 { code: 'FEATURE_DISABLED' }` on every gated surface.

---

## Conventions

### Authentication

**Browser clients (canonical, since 2026-05):** Auth lives in an httpOnly cookie
named `authToken` set automatically by `/auth/login`, `/auth/register`,
`/auth/google-signin`, and `/auth/2fa/verify` (see `backend/auth.js`). The
browser sends it on every request. JS can't read it (XSS-safe).

State-changing requests (POST / PUT / PATCH / DELETE) must also include a CSRF
token in the `X-CSRF-Token` header. The token comes from the `csrfToken` cookie
(readable from JS) — the backend uses double-submit comparison to block
cross-origin forgery. The login response also includes `csrfToken` in the JSON
body so SPAs can prime an in-memory copy without re-reading the cookie.

**API clients (TRANSITIONAL — to be removed):** Until ~2026-06-30 the backend
also accepts a JWT in the `Authorization: Bearer <token>` header. This is
provided strictly for CLI / script / external integrations that haven't moved
to cookie-based auth yet. **Do not build new integrations against the Bearer
header.**

Tokens (cookie or Bearer) expire after 24 hours.

Routes that don't require auth are explicitly marked **(public)**. Routes that
require an elevated role are marked **(admin)** or **(super_admin)**.

### Org-scoping (the `qs(req)` pattern)

Every CRUD route scopes data via this helper:
```js
function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }
```
Cross-org access is structurally impossible without skipping the helper. The
endpoint reference below does NOT repeat this for every row — assume it.

### Response shapes

**Success:** either `{ success: true, data: {...} }` or the bare resource.

**Error:**
```json
{
  "success": false,
  "error": "human-readable error",
  "code": "MACHINE_READABLE_CODE",
  "detail": "more context",
  "requestId": "16b45cfce66593d4",
  "disclaimer": "Software provided AS IS, without warranty. See /api/legal."
}
```
Quote `requestId` (also in the `X-Request-Id` response header) on support
tickets.

### Status codes

| Code | Meaning |
|---|---|
| 200 | OK |
| 201 | Created |
| 202 | Accepted (async / pending — e.g. access request) |
| 400 | Bad request (missing/invalid input) |
| 401 | Unauthorized (missing or invalid token) |
| 403 | Forbidden (status gate, pending approval, suspended, role mismatch) |
| 404 | Not found |
| 422 | Semantic failure (e.g. AI returned a malformed spec) |
| 429 | Rate-limited / quota exceeded |
| 500 | Unexpected error |
| 502 | Upstream (Claude) failure |
| 503 | Configuration not done (e.g. `ANTHROPIC_API_KEY` unset) |

### Rate limits (overview)

| Limiter | Scope | Cap | Source |
|---|---|---|---|
| Global IP limiter | all `/api/*` | configured in `index.js` | `index.js` |
| Auth limiter | `/api/auth/*` | tight (anti-brute-force) | `index.js` |
| AI limiter | `/api/ai/*`, `/api/plugins/*` | 60 / 15 min / IP | `index.js` |
| `changePasswordLimiter` | `POST /api/me/change-password` | 5 / 15 min / user | `middleware/rateLimits.js:30` |
| `aiSearchLimiter` | `/api/ai/search`, `/api/ai/apply-customization` | 10 / min / user | `middleware/rateLimits.js:57` |
| `pluginRunLimiter` | `/api/plugins/:id/run`, `/test-run` | 60 / min / user | `middleware/rateLimits.js:83` |
| `chatLimiter` | `POST /api/ai/chat` (normal mode) | 20 / min / user | `middleware/rateLimits.js:108` |
| `chatDebugLimiter` | `POST /api/ai/chat` with `mode: 'debug'` | 40 / min / user | `middleware/rateLimits.js:137` |
| Chat daily cap | `POST /api/ai/chat` per user | 200 / 24h | `routes/aiRoutes.js:530` |

### Audit events (selected)

Defined in `backend/services/audit.js` (`EVENTS` constant). Every route that
mutates state should fire one. Notable codes:

| Constant | Event string | Where |
|---|---|---|
| `AUTH_LOGIN_SUCCESS` | `auth.login.success` | `authRoutes.js` |
| `AUTH_LOGIN_FAIL` | `auth.login.fail` | `authRoutes.js` |
| `LOGIN_2FA_SUCCESS` | `auth.login.2fa_success` | `authRoutes.js` |
| `ORG_INVITE_SENT` | `org.invite.sent` | `orgRoutes.js` |
| `RECORD_DELETED` | `record.deleted` | every DELETE handler |
| `BULK_UPDATE` / `BULK_DELETE` | `bulk.update` / `bulk.delete` | `routes/_bulkOps.js` |
| `SAVED_VIEW_CREATED` | `saved_view.created` | `savedViewsRoutes.js` |
| `EMAIL_SENT` | `email.sent` | `emailRoutes.js` |
| `EMAIL_TEMPLATE_PREVIEW` | `email.template.preview` | `emailRoutes.js` |
| `CONVERSATIONAL_SEARCH` | `ai.conversational_search` | `aiRoutes.js:166` |
| `CUSTOMIZATION_APPLIED` | `customization.applied` | `aiRoutes.js:499` |
| `PLUGIN_RUN` | `plugin.run` | `pluginRoutes.js` |
| `CHAT_MESSAGE` | `ai.chat_message` | `aiRoutes.js:1371` |
| `ORG_AI_KEY_SET` / `ORG_AI_KEY_CLEARED` | `org.ai_key.set` / `org.ai_key.cleared` | `orgAiKeyRoutes.js` (meta carries `key_last4` only, never the key) |
| `DEBUG_TOOL_INVOKED` | `ai.debug_tool_invoked` | every debug tool handler in `aiRoutes.js` (lines ~695, ~728, ~747, ~775, ~813, ~865, ~888, ~918, ~1051, ~1100, ~1132, ~1156) |

---

## Health & meta

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | public | Liveness probe. Returns `{status:"healthy"}`. Fast, no DB hit. |
| GET | `/health/deep` | public | Tests DB + GCS + email + AI. Returns 503 if DB down. Use for deploy verification. |
| GET | `/api/legal` | public | Machine-readable license disclaimer + privacy/terms/data-deletion URLs. `legalRoutes.js:44` |
| GET | `/api/legal/:doc` | public | Fetch one canonical legal doc by slug. `legalRoutes.js:69` |
| GET | `/api/pitch-readiness` | public | Pre-demo green/yellow/red status of every system + integration. |

Curl example:
```bash
curl https://synccrm-backend-615440681743.us-central1.run.app/health/deep
```

---

## Authentication (`/api/auth`)

All routes mounted under `/api/auth` with the auth-tight rate limiter applied
upstream in `index.js:419`.

| Method | Path | Auth | Body / notes | Source |
|---|---|---|---|---|
| POST | `/auth/register` | public | `{ name, email, password }`. 202 `{ pending: true }` for pending users, 201 + `authToken` cookie + `{ csrfToken, user }` for active. CSRF-exempt (issues the token). | `authRoutes.js:87` |
| POST | `/auth/login` | public | `{ email, password }`. May return `{ requires2fa: true, tempToken, user }` instead of cookie. Emits `AUTH_LOGIN_SUCCESS` / `AUTH_LOGIN_FAIL`. CSRF-exempt. | `authRoutes.js:200` |
| POST | `/auth/google-signin` | public | `{ idToken }`. 503 if `GOOGLE_CLIENT_ID` unset. Emits `AUTH_GOOGLE_SIGNIN`. CSRF-exempt. | `authRoutes.js:308` |
| POST | `/auth/logout` | public | Clears `authToken` + `csrfToken` cookies. Idempotent. Emits `AUTH_LOGOUT`. | `authRoutes.js:453` |
| POST | `/auth/2fa/verify` | tempToken | `{ tempToken, code }`. Verifies TOTP / recovery code. Sets `authToken`. Emits `LOGIN_2FA_SUCCESS` / `LOGIN_2FA_FAIL`. CSRF-exempt. | `authRoutes.js:476` |
| GET | `/auth/me` | yes | Current user incl. `is_admin`, `admin_role`, `org_id`, `org_profile`, `org_role`, `org_features`, `org_pipeline(s)`, and **`org_has_customers`** (2026-09-19: `true` once the org has a customer-type / non-prospect company or a won deal — legacy closed stage, `closed_date`, or a custom-pipeline `is_won` stage; `null` if unknown. The nav hides the empty Customers group while it is `false`). | `authRoutes.js:561` |
| GET | `/auth/login-options` | public | Lists which login methods are wired (`google`, `email`, `test`). | `authRoutes.js:611` |
| POST | `/auth/sso/mint` | yes | Mints a short-lived sub-session token for an embed scenario. | `ssoRoutes.js:56` |

Curl example (login):
```bash
curl -X POST https://.../api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"..."}' \
  -c cookies.txt
```

---

## Self-service profile (`/api/me`)

All routes require auth. Validators in `backend/schemas/me.js` (the canonical
Zod proof-of-concept).

| Method | Path | Body / notes | Audit | Source |
|---|---|---|---|---|
| PUT | `/api/me` | `{ name?, notification_email?, notification_phone? }` (zod `updateProfileSchema`). | `PROFILE_UPDATED` | `meRoutes.js:87` |
| POST | `/api/me/change-password` | `{ current_password, new_password }`. Subject to `changePasswordLimiter` (5/15min/user). Full registration policy applies: 10+ chars, 3/4 classes, weak-pattern blocklist, last-5 history. 400 for Google-OAuth-only accounts. | `PASSWORD_CHANGE` | `meRoutes.js:139` |
| PUT | `/api/me/notification-preferences` | `{ task_assigned: { email:bool, sms:bool }, task_overdue:{...}, …, email_delivery: { mode: 'instant'\|'batched'\|'daily', hour: 0-23, tz: IANA } }` — partial merge per key (spec 204: `email_delivery` picks per-alert vs grouped vs one daily digest at `hour` in `tz`). | `NOTIFICATION_PREFERENCES_UPDATED` | `meRoutes.js:244` |
| POST | `/api/me/notification-digest/send-now` | Sends the caller their daily digest now (queued alerts + live My Day queue, one-click buttons). 1/min/user. Returns `{ success, sent, items, subject?, reason?: 'empty'\|'email_off'\|'no_address' }`. | `NOTIFICATION_PREFERENCES_UPDATED` (`op: digest_send_now`) | `meRoutes.js:312` |
| GET | `/api/me/export` | Returns a GDPR/CCPA data export bundle (JSON). | — | `meRoutes.js:302` |
| POST | `/api/me/delete-account` | `{ password? }`. Schedules deletion in 7 days. | — | `meRoutes.js:374` |
| POST | `/api/me/delete-account/cancel` | Cancels a pending deletion (within the 7-day grace). | — | `meRoutes.js:446` |
| GET | `/api/me/delete-account/status` | `{ scheduled_for, status }` or `{ scheduled: false }`. | — | `meRoutes.js:468` |

---

## Platform AI budget guardrails (`/api/billing/ai/admin/platform-budget`) — super-admin

Spec 205, migration 174. The same status object also rides along on `GET /api/billing/ai/admin/list` as `platform_budget`.

| Method | Path | Body / notes | Source |
|---|---|---|---|
| GET | `/api/billing/ai/admin/platform-budget` | `{ period, trials_enabled, accepting_trials, reason: null\|'paused'\|'max_active'\|'budget', active_trials, trial_max_active, trial_pct, trial_org_hard_cap_usd, mtd_trial_cost_usd, mtd_unbilled_cost_usd, mtd_all_cost_usd, unbilled_budget_usd, budget_pct }` | `billingRoutes.js` |
| POST | `/api/billing/ai/admin/platform-budget/trials` | `{ enabled: bool }` — pause/resume NEW trials (`platform_settings.ai_trials_enabled`); returns the status. Audited. | `billingRoutes.js` |

## One-click email actions (`/api/email-actions`) — session-less

Spec 204. The 256-bit single-use token in the path is the credential (sha256 stored, 7-day
expiry, org/user scope from the token row). CSRF-exempt; per-IP rate-limited. The SPA page
`/act/:token` is what the email links to; it calls these.

| Method | Path | Body / notes | Source |
|---|---|---|---|
| GET | `/api/email-actions/:token` | Describe without acting: `{ ok, action, label, entity_type, entity_id }` or `{ ok:false, status, message, used?, expired? }`. | `emailActionRoutes.js` |
| POST | `/api/email-actions/:token/apply` | Perform it (single-use): `{ ok, action, entity_type, entity_id, result, message }`; 410 `used`/`expired`, 404 unknown/gone, 403 inactive user. Actions: `task.complete`, `task.snooze`, `deal.next_step.complete`, `deal.next_step.snooze`, `company.touch`, `notification.read`, `platform.trials.pause` / `platform.trials.resume` (super-admin re-checked at apply). | `emailActionRoutes.js` |

## Public access request (`/api/request-access`)

| Method | Path | Auth | Body / notes | Source |
|---|---|---|---|---|
| POST | `/request-access` | public | `{ name, email, password, company?, reason? }`. Always returns 202 `{ pending: true }` (no enumeration). Notifies admins by email if SMTP configured. | `accessRequestRoutes.js:29` |

Accept-invite (public, two-step) — `/api/invites/:token` (GET) +
`/api/invites/:token/accept` (POST). See `acceptInviteRoutes.js`.

---

## Companies (`/api/companies`)

Standard CRUD + bulk ops. All require auth and are org-scoped.

| Method | Path | Body schema | Notes | Source |
|---|---|---|---|---|
| GET | `/api/companies` | — | Filters: `search`, `industry`, `status`, `type` (customer/vendor/end_user/partner). | `companyRoutes.js:45` |
| GET | `/api/companies/:id` | — | Single company. | `companyRoutes.js:69` |
| POST | `/api/companies` | `schemas/companies.js#createSchema` | Create. | `companyRoutes.js:80` |
| PUT | `/api/companies/:id` | `schemas/companies.js#updateSchema` | COALESCE partial. | `companyRoutes.js:101` |
| DELETE | `/api/companies/:id` | — | Emits `RECORD_DELETED`. | `companyRoutes.js:130` |
| PATCH | `/api/companies/bulk` | `schemas/companies.js#bulkPatchSchema` | `{ ids:[...], patch:{...} }`. One audit row (`BULK_UPDATE`) with the full id list + patch. | `companyRoutes.js:35` |
| DELETE | `/api/companies/bulk` | `{ ids:[...] }` | Emits `BULK_DELETE`. | `companyRoutes.js:41` |

Curl example:
```bash
curl https://.../api/companies?type=vendor -b cookies.txt
```

---

## Contacts (`/api/contacts`)

| Method | Path | Body | Notes | Source |
|---|---|---|---|---|
| PATCH | `/api/contacts/bulk` | `schemas/contacts.js#bulkPatchSchema` | Bulk update. `BULK_UPDATE`. | `contactRoutes.js:35` |
| DELETE | `/api/contacts/bulk` | `{ ids:[...] }` | Bulk delete. `BULK_DELETE`. | `contactRoutes.js:41` |
| GET | `/api/contacts` | — | Filters: `status`, `company_id`, `search`. | `contactRoutes.js:45` |
| GET | `/api/contacts/:id` | — | | `contactRoutes.js:67` |
| GET | `/api/contacts/:id/activities` | — | Sub-resource. | `contactRoutes.js:78` |
| GET | `/api/contacts/:id/deals` | — | Sub-resource. | `contactRoutes.js:91` |
| POST | `/api/contacts` | `schemas/contacts.js#createSchema` | | `contactRoutes.js:104` |
| PUT | `/api/contacts/:id` | `schemas/contacts.js#updateSchema` | | `contactRoutes.js:123` |
| DELETE | `/api/contacts/:id` | — | | `contactRoutes.js:148` |

The contact record drawer (`/contacts/:id`, `components/ContactPanel.js`, 2026-09-19) composes existing endpoints only: `GET /contacts/:id`, `/contacts/:id/deals`, `/contacts/:id/activities`, `GET /meetings?contact_id=`, `GET /tasks?contact_id=`, `GET /emails/sends?contact_id=`, `GET /sequences` + `POST /sequences/:id/enroll`, `POST /contacts/:id/touch`, `GET /contacts/:id/one-pager.pdf`.

---

## Deals (`/api/deals`)

| Method | Path | Body | Notes | Source |
|---|---|---|---|---|
| GET | `/api/deals` | — | Filters: `stage`, `phase`, `contact_id`, `company_id`, `customer_id`, `vendor_id`, `salesman_id`, `hot=true`, `search`. | `dealRoutes.js:51` |
| GET | `/api/deals/:id` | — | | `dealRoutes.js:89` |
| POST | `/api/deals` | `schemas/deals.js#createSchema` | **One-motion create (2026-09-19):** optional `company_name` / `contact_name` / `contact_email` are found-or-created by name inside the deal's transaction (`services/recordUpsert.js`, shared with the chat copilot's `deal.create` apply) when the matching `*_id` is absent; the company also fills `customer_id`. Explicit ids always win. | `dealRoutes.js:108` |
| PATCH | `/api/deals/:id/stage` | `schemas/deals.js#stagePatchSchema` | Kanban drag-drop. | `dealRoutes.js:166` |
| PUT | `/api/deals/:id` | `schemas/deals.js#updateSchema` | COALESCE-style partial update. **Exception:** `next_step` / `next_step_date` (migration 172) use present-key semantics — send `null` to clear a finished step; omit to leave alone. | `dealRoutes.js:248` |
| GET | `/api/deals/:id/po-pdf` | — | Streams branded PO PDF. | `dealRoutes.js:316` |
| DELETE | `/api/deals/:id` | — | | `dealRoutes.js:357` |

**Next-step commitment (migration 172 — 2026-09-19):** every deal carries `next_step` (TEXT ≤500, the rep's own next action) and `next_step_date` (DATE). Returned on every deal GET, accepted on POST/PUT, exported in `GET /api/deals/export.csv` (`Next Step`, `Next Step Date`), and readable/settable through the chat tools `get_deal` / `propose_update_deal`. `GET /api/my-day` surfaces open deals whose `next_step_date <= today` in its `nextSteps` section (most overdue first, `overdue_days` derived); the deal drawer hero edits it inline and My Day's "Done" clears it via `PUT { next_step: null, next_step_date: null }`.

---

## Activities (`/api/activities`)

| Method | Path | Notes | Source |
|---|---|---|---|
| GET | `/api/activities` | Filters: `type`, `contact_id`, `deal_id`, `limit`. | `activityRoutes.js:11` |
| GET | `/api/activities/contact/:contact_id` | | `activityRoutes.js:32` |
| GET | `/api/activities/deal/:deal_id` | | `activityRoutes.js:45` |
| GET | `/api/activities/:id` | | `activityRoutes.js:58` |
| POST | `/api/activities` | `{ type, title, contact_id?, deal_id?, activity_date, duration_min?, outcome?, notes? }` | `activityRoutes.js:69` |
| PUT | `/api/activities/:id` | | `activityRoutes.js:106` |
| DELETE | `/api/activities/:id` | | `activityRoutes.js:127` |

---

## Tasks (`/api/tasks`)

| Method | Path | Body | Notes | Source |
|---|---|---|---|---|
| PATCH | `/api/tasks/bulk` | `schemas/tasks.js#bulkPatchSchema` | `BULK_UPDATE`. | `taskRoutes.js:20` |
| DELETE | `/api/tasks/bulk` | `{ ids:[...] }` | `BULK_DELETE`. | `taskRoutes.js:26` |
| GET | `/api/tasks` | — | Filters: `status`, `contact_id`, `deal_id`. | `taskRoutes.js:30` |
| GET | `/api/tasks/:id` | — | | `taskRoutes.js:49` |
| POST | `/api/tasks` | `schemas/tasks.js#createSchema` | | `taskRoutes.js:60` |
| PUT | `/api/tasks/:id` | `schemas/tasks.js#updateSchema` | | `taskRoutes.js:90` |
| DELETE | `/api/tasks/:id` | — | | `taskRoutes.js:143` |

---

## Pipelines (`/api/pipelines`)

The old per-row CRUD (`/:id`) is gone. `/api/pipelines` is now the org's effective-pipeline surface (per-org editable stages, migration 155; multiple pipelines per org via `deal_type`, spec 201) — see [Pipelines (per-org editable stages)](#pipelines-per-org-editable-stages-migration-155-multiple-pipelines-per-org-via-deal_type-spec-201--migration-156) below.

---

## Quotes (`/api/quotes`) — requires `quotes_enabled`

| Method | Path | Notes | Source |
|---|---|---|---|
| GET | `/api/quotes` | Filters: `customer_id`, `deal_id`. | `quoteRoutes.js:28` |
| GET | `/api/quotes/:id` | Includes embedded `line_items` + revision chain. | `quoteRoutes.js:51` |
| POST | `/api/quotes` | `{ title, customer_id, deal_id, total_amount, valid_until, line_items: [...] }` | `quoteRoutes.js:76` |
| PUT | `/api/quotes/:id` | Use `create_revision: true` to fork a new revision row. | `quoteRoutes.js:111` |
| GET | `/api/quotes/:id/pdf` | Streams branded PDF. Emits `QUOTE_PDF_GENERATED`. | `quoteRoutes.js:146` |
| DELETE | `/api/quotes/:id` | | `quoteRoutes.js:190` |

---

## Vendor Quotes (`/api/vendor-quotes`) — requires `vendor_quotes_enabled`

| Method | Path | Notes | Source |
|---|---|---|---|
| POST | `/api/vendor-quotes/:id/send-rfq` | `{ recipient_email, recipient_name?, custom_message? }`. Emits `RFQ_SENT`. Falls back to console-log if SMTP unconfigured. | `vendorQuoteRoutes.js:51` |
| GET | `/api/vendor-quotes` | Filters: `deal_id`, `vendor_id`, `status`. | `vendorQuoteRoutes.js:131` |
| POST | `/api/vendor-quotes` | | `vendorQuoteRoutes.js:155` |
| PUT | `/api/vendor-quotes/:id` | `is_selected: true` auto-clears flag from siblings. | `vendorQuoteRoutes.js:172` |
| DELETE | `/api/vendor-quotes/:id` | | `vendorQuoteRoutes.js:199` |

---

## Submittals (`/api/submittals`) — requires `submittals_enabled`

| Method | Path | Notes | Source |
|---|---|---|---|
| GET | `/api/submittals` | Filters: `deal_id`, `status`. | `submittalRoutes.js:10` |
| POST | `/api/submittals` | Missing `version` → auto-increments per deal. | `submittalRoutes.js:26` |
| PUT | `/api/submittals/:id` | Status: `pending_vendor → pending_customer → approved | rejected`. | `submittalRoutes.js:49` |
| DELETE | `/api/submittals/:id` | | `submittalRoutes.js:68` |

---

## Change Orders (`/api/change-orders`) — requires `change_orders_enabled`

| Method | Path | Notes | Source |
|---|---|---|---|
| GET / POST / PUT / DELETE | `/api/change-orders[/:id]` | Filters: `deal_id`. Status: `pending → approved | rejected`. | `changeOrderRoutes.js:10/25/44/64` |

---

## Service Contracts (`/api/service-contracts`)

| Method | Path | Notes | Source |
|---|---|---|---|
| GET | `/api/service-contracts` | Filters: `status`, `customer_id`, `due_for_renewal=true` (within `renewal_notice_days` of `end_date`). | `serviceContractRoutes.js:12` |
| GET | `/api/service-contracts/renewals` | Renewal-pipeline rollup: counts + buckets. **Requires `customer_success_enabled`.** Declared before the `:id` routes so `/renewals` is unambiguous. | `serviceContractRoutes.js:49` |
| POST | `/api/service-contracts` | | `serviceContractRoutes.js:41` |
| PUT | `/api/service-contracts/:id` | | `serviceContractRoutes.js:58` |
| DELETE | `/api/service-contracts/:id` | | `serviceContractRoutes.js:79` |

---

## Accounts / customer success (`/api/accounts`) — requires `customer_success_enabled`

The post-sale / account-health surface. Feeds the `list_at_risk_accounts` chat
tool and the account-health worker (daily `account_health_snapshots`).

| Method | Path | Notes | Source |
|---|---|---|---|
| GET | `/api/accounts/:companyId/360` | Merged single-account picture: header + timeline (deals whose `customer_id = :companyId`, plus their contacts/activities/tasks), all org-scoped so a caller can never reach across orgs via a foreign `companyId`. | `accountRoutes.js:31` |

---

## Issues (`/api/issues`)

| Method | Path | Notes | Source |
|---|---|---|---|
| GET | `/api/issues` | Filters: `status`, `urgency`, `category`, `related_type`, `related_id`, `assigned_to_user_id`. Auto-ordered red → yellow → green. | `issueRoutes.js:10` |
| GET | `/api/issues/:id` | | `issueRoutes.js:36` |
| POST | `/api/issues` | `{ title, urgency, status, related_type, related_id, ... }` | `issueRoutes.js:47` |
| PUT | `/api/issues/:id` | | `issueRoutes.js:67` |
| DELETE | `/api/issues/:id` | | `issueRoutes.js:94` |

---

## Documents (`/api/documents`) — requires `documents_enabled`

| Method | Path | Notes | Source |
|---|---|---|---|
| GET | `/api/documents` | Filters: `related_type`, `related_id`, `doc_type`. | `documentRoutes.js:18` |
| GET | `/api/documents/:id/download` | 302 to GCS signed URL (15 min) or streams DB blob. Emits `DOCUMENT_DOWNLOAD`. | `documentRoutes.js:47` |
| GET | `/api/documents/:id/signed-url` | JSON `{ url, expires_in_seconds }`. | `documentRoutes.js:88` |
| POST | `/api/documents` | `multipart/form-data` with field `file`. Form fields: `related_type`, `related_id`, `doc_type`. | `documentRoutes.js:110` |
| DELETE | `/api/documents/:id` | Deletes GCS object + DB row. | `documentRoutes.js:170` |

---

## Custom fields (`/api/custom-fields`)

Per-org field definitions for `companies`, `contacts`, `deals`, `tasks`.

| Method | Path | Auth | Body / notes | Source |
|---|---|---|---|---|
| GET | `/api/custom-fields?entity=deals` | yes | List defs for an entity. | `customFieldsRoutes.js:210` |
| POST | `/api/custom-fields` | org-admin | `{ entity, name, label, type, options?, required?, position? }`. | `customFieldsRoutes.js:239` |
| PUT | `/api/custom-fields/:id` | org-admin | Partial update. | `customFieldsRoutes.js:282` |
| DELETE | `/api/custom-fields/:id` | org-admin | | `customFieldsRoutes.js:337` |

The AI propose/apply endpoints under `/api/ai/*` go through the same
`validateFieldDefShape` + table writes so behavior cannot drift between the
two paths.

---

## Saved views (`/api/saved-views`)

Per-user (or org-shared) filter+sort presets used by list pages.

| Method | Path | Body | Notes | Source |
|---|---|---|---|---|
| GET | `/api/saved-views?resource=deals` | — | Returns visible-to-caller views (own + shared in org). | `savedViewsRoutes.js:42` |
| POST | `/api/saved-views` | `schemas/savedViews.js#createSchema` | `{ resource, name, filter_spec, sort_spec, is_default?, is_shared?, display_order? }`. Emits `SAVED_VIEW_CREATED`. | `savedViewsRoutes.js:72` |
| PUT | `/api/saved-views/:id` | `schemas/savedViews.js#updateSchema` | | `savedViewsRoutes.js:131` |
| DELETE | `/api/saved-views/:id` | — | | `savedViewsRoutes.js:205` |

---

## Filters (`/api/filters`)

| Method | Path | Notes | Source |
|---|---|---|---|
| GET | `/api/filters/options` | Dropdown data for the filter UI (verticals, products, classes, sizes, offices, customers, vendors, salesmen, enum lists). | `filterRoutes.js:14` |
| GET | `/api/filters/saved?scope=deals` | Legacy saved filters (superseded by `/api/saved-views`). | `filterRoutes.js:63` |
| POST | `/api/filters/saved` | `{ scope, name, filters }`. | `filterRoutes.js:83` |
| DELETE | `/api/filters/saved/:id` | | `filterRoutes.js:103` |

---

## Search (`/api/search`)

| Method | Path | Notes | Source |
|---|---|---|---|
| GET | `/api/search?q=...` | `{ companies, contacts, deals }` (max 8 each). Min query length 2. | `searchRoutes.js:10` |

For natural-language search → `/api/ai/search` (below).

---

## Metrics & reports (`/api/metrics`) — requires `reports_enabled`

| Method | Path | Notes | Source |
|---|---|---|---|
| GET | `/api/metrics/dashboard` | Widget totals, by_stage, issues, tasks, counts, pre_sale_funnel. | `metricsRoutes.js:10` |
| GET | `/api/metrics/vendor-performance` | Per-vendor leaderboard. | `metricsRoutes.js:89` |
| GET | `/api/metrics/salesman` | Per-salesman pipeline + commission summary. | `metricsRoutes.js:115` |
| GET | `/api/metrics/reports?window=ytd\|7d\|all&from=ISO&to=ISO` | Exhibit-A metrics. Strict ISO date validation. | `metricsRoutes.js:273` |

---

## Plugins (`/api/plugins`)

Inherits the `/api/ai/*` rate limiter (60/15min/IP) because plugin operations
go through Claude for draft generation. `pluginRunLimiter` (60/min/user) is
applied to the run / test-run endpoints.

| Method | Path | Body | Notes | Source |
|---|---|---|---|---|
| GET | `/api/plugins` | — | List org's plugins. | `pluginRoutes.js:78` |
| GET | `/api/plugins/:id` | — | | `pluginRoutes.js:93` |
| POST | `/api/plugins` | `schemas/plugins.js#createSchema` | | `pluginRoutes.js:110` |
| PUT | `/api/plugins/:id` | `schemas/plugins.js#updateSchema` | | `pluginRoutes.js:143` |
| DELETE | `/api/plugins/:id` | — | | `pluginRoutes.js:183` |
| POST | `/api/plugins/:id/test-run` | — | `pluginRunLimiter`. Dry-run; never persists a `plugin_runs` row in success state. | `pluginRoutes.js:194` |
| POST | `/api/plugins/:id/run` | `schemas/plugins.js#runSchema` | `pluginRunLimiter`. Full invocation. Emits `PLUGIN_RUN`. | `pluginRoutes.js:220` |
| POST | `/api/plugins/from-prompt` | `schemas/plugins.js#fromPromptSchema` | Generates a draft spec via Claude (`{ description }` → `{ name, code, events }`). | `pluginRoutes.js:283` |
| GET | `/api/plugins/:id/runs` | — | Recent `plugin_runs` for the plugin. | `pluginRoutes.js:377` |

Run-status values are extended in migration 075: success / failed /
budget_exceeded / sandbox_unavailable / timed_out / running. The chat
`inspect_plugin_run` tool returns these verbatim.

---

## AI / Claude (`/api/ai`) — requires `ai_features_enabled`

All routes auth-required; mounted with the global `aiLimiter` (60/15min/IP)
via `index.js:519`. Returns 503 with `{ configured: false }` when
`ANTHROPIC_API_KEY` is unset and the org has no bring-your-own key.

**Key resolution (migration 154):** every call resolves its key per org —
the org's own key from `org_ai_keys` wins, otherwise the deployment
`ANTHROPIC_API_KEY`. Calls on an org key are metered with
`billing_mode='byo_key'` and `charged_usd_micro=0`; the billing gate's
verdict for such an org is `{ allowed: true, status: 'byo_key' }`. Manage
the key at [`/api/org/ai-key`](#bring-your-own-anthropic-key-apiorgai-key).

### Pipelines (per-org editable stages, migration 155; multiple pipelines per org via `deal_type`, spec 201 / migration 156)

Every deal carries a `deal_type` (default `'default'`). Each type may have its own pipeline row; resolution falls through **type row → org default row → profile default** (`services/pipelines.js getEffectivePipeline(orgId, profile, { dealType })`). All routes below take an optional `deal_type` (query `?deal_type=` or body) — omitted means the default pipeline, exactly the pre-156 behaviour. Deal-type slugs are lowercase (`^[a-z][a-z0-9_]{0,39}$`); `default` is reserved.

| Method | Path | Body | Notes | Source |
|---|---|---|---|---|
| GET | `/api/pipelines` | — | Effective pipeline: `{ profile, is_custom, id, deal_type, name, stages:[{id,label,desc,tone,phase,is_won,is_lost,probability}], phases, default_stage, deal_counts, can_edit, tones, max_stages, default_stages, pipelines:[{deal_type,name,is_custom,stage_count}] }`. No row → profile default. `?deal_type=` reads that type's pipeline and its type-scoped `deal_counts`. Also served as `org_pipeline` (default) + `org_pipelines` (map keyed by type) on `/auth/me`. | `pipelineRoutes.js` |
| PUT | `/api/pipelines` | `{ stages, moveDealsTo?: slug \| {from: to}, name?, deal_type? }` | Owner/admin (`requireOrgAdmin`). Validates (unique slugs, ≥1 won + ≥1 lost, ≤15 stages, labels ≤40). A NEW `deal_type` slug **creates** that pipeline. Removing a stage that still has deals → **409 `stages_have_deals`** unless `moveDealsTo` re-homes them in the same transaction — deal sweeps are scoped to the addressed `deal_type` (a default-pipeline save never touches typed deals). Audit `pipeline.updated`. | `pipelineRoutes.js` |
| POST | `/api/pipelines/reset` | `{ moveDealsTo?, deal_type? }` | Default: back to the profile default. A type: drops the type row (its deals keep their `deal_type` and fall back to the org default pipeline); same re-homing rule, type-scoped. Audit `pipeline.reset`. | `pipelineRoutes.js` |
| DELETE | `/api/pipelines` | `?deal_type=` + `{ moveDealsTo?, retype_to? }` | Owner/admin. Deletes a TYPE pipeline outright: its deals are re-typed to `retype_to` (default `'default'`) with strays re-homed against the target pipeline — **409 `stages_have_deals`** while unresolved. The default pipeline can only be reset, never deleted. Audit `pipeline.deleted`. | `pipelineRoutes.js` |

Deals API: `POST /api/deals` accepts `deal_type` (unknown type → 400 with `valid_deal_types`; `'default'` plus every type with a pipeline row is valid), `GET /api/deals?deal_type=` filters, `PUT /api/deals/:id` changes `deal_type` only together with a `stage` valid on the target pipeline (else 400 `DEAL_TYPE_NEEDS_STAGE`), and stage validation everywhere resolves the pipeline for the deal's type. CSV deals import takes an optional per-row `deal_type` column validated against the org's known types.

Chat equivalent: `propose_update_pipeline` (confirm-first; apply is owner/admin; optional `deal_type`). Editor UI: `/settings/pipeline` (pipeline selector + New-pipeline + delete-with-retype).

### Deal line items & margin (`/api/deals/:id/line-items`, migrations 145 + 159)

CRUD on a deal's own line items. Each line: `{ description, quantity, unit_price_cents, product_id?, kind: 'revenue'(default)|'cost', category? (≤60 chars, cost bucketing) }`. `GET` returns the lines plus `revenue_total_cents`, `cost_total_cents`, `contribution_cents`, `margin_pct`; while a deal has line items, `deals.amount` auto-rolls up from **revenue lines only** (cost lines never change deal value; a deal with only cost lines keeps its manual amount). `GET /api/deals/export.csv` includes Line Revenue / Line Cost / Contribution / Margin % columns (blank when a deal has no lines). Source: `routes/dealLineItemRoutes.js`, `services/dealLineItems.js`.

### Record one-pager PDFs (migration 161)

`GET /api/deals/:id/one-pager.pdf` · `GET /api/companies/:id/one-pager.pdf` ·
`GET /api/contacts/:id/one-pager.pdf` — auth + `qs(req)` org-scoped; streams an
org-branded single-page PDF (branding logo/color, templated field grid with
custom-field labels, photo strip from the record's first N image documents,
strict one-page budget). `?template_id=` picks a saved template; otherwise the
org's `is_default` template per entity, else a built-in default. Template CRUD:
`GET/POST/PUT/DELETE /api/one-pager-templates` (members read; org owner/admin
write; config JSONB = ordered fields + label overrides + `include_photos` /
`photo_count` / `include_notes` / `footer_text`). Source:
`routes/onePagerRoutes.js`, `services/pdfOnePager.js`.

### Commission (`/api/commission`, migrations 139 + 159a, `reports_enabled`)

Plans: `{ rate_pct, goal?, effective_from, user_id? (rep plan; NULL = org default), kind: 'rep'(default)|'partner', partner_company_id? (partner plans), source_filter? }` — partner plans attribute closed-won deals by the deal's `custom_fields.channel_source` → `.lead_source` → `.source` (case-insensitive) matching `source_filter`, or by direct company link when no filter. `GET /api/commission` returns the rep report (unchanged) plus `partners[]` per-partner statements (deal list, historical rates, fee totals) and `partner_totals`. `kind`/`partner_company_id` are immutable after create. Source: `routes/commissionRoutes.js`, `services/commission.js`.

### Single-shot AI

| Method | Path | Body | Notes | Source |
|---|---|---|---|---|
| GET | `/api/ai/status` | — | `{ configured: bool, billing }`. **Exempt from the AI billing gate** (the only `/api/ai` route that is) so the UI can render the right card before the user types. `billing` = the same verdict the gate applies: `{ allowed, status: 'unconfigured'\|'trial'\|'active'\|'comped'\|'past_due'\|'halted'\|…, code: 'AI_BILLING_REQUIRED'\|'AI_BILLING_TRIAL_EXPIRED'\|'AI_BILLING_PAST_DUE'\|'AI_BILLING_HALTED'\|null, action: 'start_billing'\|'update_payment'\|'contact_admin'\|null, message, trial_ends_at, can_manage (caller is org owner/admin or super-admin), stripe_ready }`. Every other `/api/ai` route returns **402** with `{ code, action, status, error }` when `allowed` is false; the frontend (`components/AiBillingCard.js`) turns either into a "Start AI pay-as-you-go" card that calls `POST /api/billing/ai/start { return_to: 'chat'\|'usage' }` (owner/admin only) and lands back on `/chat?ai_subscribed=1`. | `aiRoutes.js` |
| POST | `/api/ai/summarize-deal/:id` | — | Returns `{ configured, ok, text }`. Emits `ai.summarize_deal`. | `aiRoutes.js:38` |
| POST | `/api/ai/draft-followup/:id` | `{ recipient: 'customer'\|'vendor', tone?, customNote? }` | Emits `ai.draft_followup`. | `aiRoutes.js:184` |

### Conversational search

| Method | Path | Body | Notes | Source |
|---|---|---|---|---|
| POST | `/api/ai/search` | `{ query, resource?: 'deals'\|'contacts'\|'companies'\|'tasks' }` | `aiSearchLimiter` (10/min/user). Returns `{ resource, filter, sort, explanation, droppedKeys }`. Emits `CONVERSATIONAL_SEARCH`. Status: 422 on malformed model response / empty filter; 502 on Claude transport error. | `aiRoutes.js:112` |

### Org-customization (two-phase: propose then apply)

| Method | Path | Body | Notes | Source |
|---|---|---|---|---|
| POST | `/api/ai/propose-customization` | `{ entity, request }` | Returns `{ proposal: { actions, rejectedReason }, validationErrors, rawText }`. NOTHING is written. | `aiRoutes.js:378` |
| POST | `/api/ai/apply-customization` | `{ actions: [...], request? }` | Owner/admin only. `aiSearchLimiter`. Re-validates and writes inside a transaction. Emits `CUSTOMIZATION_APPLIED`. | `aiRoutes.js:421` |

### Workspace builder — "describe how you sell" (`/api/onboarding`, spec 203 Phase 1 — 2026-09-19)

Mounted beside `/api/ai` (same `aiLimiter`) so the template list stays reachable without an AI
billing verdict; `/plan` applies `requireAiBilling()` + `requireFeature('ai_features_enabled')`
per-route. **Nothing here writes.** The frontend (`components/WorkspaceBuilder.js`, at `/setup`
and embedded in the Chat first-run surface) applies each returned proposal through the ONE
existing writer, `POST /api/ai/actions/apply`, in the order returned (pipeline first, so
automation stage ids exist when the rules land).

| Method | Path | Body | Notes | Source |
|---|---|---|---|---|
| GET | `/api/onboarding/templates` | — | `{ templates: [{ id, name, tagline }] }` — 12 starting templates (`services/onboardingTemplates.js`). Descriptions stay server-side. Any member. | `onboardingRoutes.js` |
| POST | `/api/onboarding/plan` | `{ description?, template_id? }` (one required; both = template text + `"Also: …"`) | ONE structured Claude call (`endpoint: 'onboarding-plan'`, metered as usual) → `{ ok, can_apply, template_id, plan: { narrative, pipeline_name, proposals: [{ kind: pipeline\|field\|automation\|view, label, summary, detail, why, proposal }], skipped: [{ kind, label, reason }], notes: [] } }`. Every `proposal` is a `chatActions.validateAction`-clean action (`pipeline.update` / `custom_field.create` / `automation_rule.create` / `saved_view.create`) — exactly what `/actions/apply` re-validates. Bad pieces are **skipped with a reason, never fatal**; automation/view stage labels resolve against the PROPOSED pipeline; a missing won/lost stage is added deterministically; existing deals in dropped stages get `moveDealsTo` = first new stage (noted). `can_apply` = caller is org owner/admin. 400 `INVALID_DESCRIPTION` (< 12 chars) / `UNKNOWN_TEMPLATE`, 402 (billing), 422 `MALFORMED_RESPONSE`, 429 `QUOTA_EXCEEDED`, 503 `AI_NOT_CONFIGURED`. Audit: `AI_ACTION_PROPOSED` (`targetType: 'workspace_plan'`). | `onboardingRoutes.js`, `services/onboardingPlanner.js` |

### Saved workspace templates (`/api/workspace-templates`, spec 203 Phase 2, migration 171 — 2026-09-19)

A template's `config` is the SAME raw shape the planner consumes (`{ pipeline, fields, automations, views }`), so **cloning is deterministic — no AI call** (`services/workspaceTemplates.js` → `onboardingPlanner.assemblePlan`), and works for an org with AI off. Structural only: `snapshotOrg` reads definitions (effective pipeline, `org_field_definitions`, enabled `automation_rules` in the planner vocabulary, shared deal `saved_views`), never records; `sanitizeConfig` whitelists keys. `org_id NULL` = platform-authored. Visibility = own org OR `is_public`. Not behind the AI billing gate.

| Method | Path | Body | Notes | Source |
|---|---|---|---|---|
| GET | `/api/workspace-templates?scope=all\|mine\|public` | — | `{ templates: [summary] }` — summary = `{ id, org_id, slug, name, tagline, vertical, description, is_public, is_platform, use_count, stages: [labels], pipeline_name, field_labels, automation_count, view_count }`. No `config`. Any member. | `workspaceTemplateRoutes.js` |
| GET | `/api/workspace-templates/:id` | — | Full template incl. `config` + `can_edit` (own org). 404 unless own or public. | |
| POST | `/api/workspace-templates` | `{ name, tagline?, vertical?, description?, is_public?, source: 'snapshot' }` **or** `{ …, config }` | Owner/admin (`requireOrgAdmin`). Snapshot = current workspace structure. `config` validated structurally (`validateConfig`: stages need won+lost, fields pass the custom-field validator, automation stage refs must exist on the template pipeline). 400 `INVALID_TEMPLATE` + `validation_errors`. Slug auto-derived, unique per org. | |
| PUT | `/api/workspace-templates/:id` | any of `name, tagline, vertical, description, is_public, config` | Owner/admin, **own org only** (SQL-scoped). 404 otherwise. | |
| DELETE | `/api/workspace-templates/:id` | — | Owner/admin, own org only. | |
| POST | `/api/workspace-templates/:id/plan` | — | Template → validated proposals for THE CALLER'S org (same `plan` shape as `/api/onboarding/plan`; dupes skipped, stage refs resolved). Any member; `can_apply` by role. Bumps `use_count`. Client applies via `POST /api/ai/actions/apply`. | |
| POST | `/api/workspace-templates/generate-platform` | `{ only?: [static ids] }` | **Super-admin only.** Runs the planner's draft step once per static template (`onboardingTemplates.js`) and upserts public platform rows (`org_id NULL`, slug = static id). The one AI-calling route here; metered as usual. | |
| GET | `/api/public/workspace-templates` | — | **Unauthenticated**, `publicFormLimiter`, `Cache-Control: max-age=300`. Public template summaries for the marketing site. Never `config`. | |

Frontend: `/templates` (gallery + save/manage + super-admin generate), `/setup?template=wt:<id>` (saved-template mode in `WorkspaceBuilder`), saved-template chips on the builder, "Save as template" in `/settings/pipeline`, cards on Settings → Workspace.

### Chat-First copilot

The conversational front door. Tool-grounded. 30 tools live (8 CRM-action + 11
customer-diagnostic (incl. `run_plugin` / `describe_plugin`) + 3
super-admin-only diagnostic + 6 confirm-first write-action (`propose_*`) + 2
capability (`how_do_i` / `list_modules`)). Tools, args, scopes, and triggering
prompts are documented in `CHAT_TOOLS_REFERENCE.md`.

Write actions are **confirm-first**: the `propose_*` tools never mutate — they
return a validated `{ proposal }` the UI renders as an Apply/Cancel card. The
sole writer is `POST /api/ai/actions/apply` (below).

| Method | Path | Body | Notes | Source |
|---|---|---|---|---|
| POST | `/api/ai/chat` | `{ message, session_id?, mode?: 'debug' }` | Routes to `chatLimiter` (20/min/user) or `chatDebugLimiter` (40/min/user) based on `mode`. Daily cap 200/user enforced via SQL count before burning a Claude call (429 `CHAT_DAILY_CAP`). Emits `CHAT_MESSAGE` and one `DEBUG_TOOL_INVOKED` per tool call. Returns `{ session_id, reply, actions, explanation }`. | `aiRoutes.js:1240` |
| POST | `/api/ai/actions/apply` | `{ proposal }` (the object returned by a `propose_*` tool) | **The only copilot writer.** Re-validates + ownership-checks the echoed proposal, then commits in a transaction. `propose_set_feature_flag` proposals additionally require org owner/admin. | `aiRoutes.js:535` |
| GET | `/api/ai/chat/sessions` | — | List caller's last 50 sessions. | `aiRoutes.js:1393` |
| GET | `/api/ai/chat/sessions/:id/messages` | — | Replay one session's messages (own only). | `aiRoutes.js:1409` |

Curl example (debug mode):
```bash
curl -X POST https://.../api/ai/chat \
  -b cookies.txt -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: $(grep csrfToken cookies.txt | awk '{print $7}')" \
  -d '{"message":"Why did plugin run 42 fail?","mode":"debug"}'
```

Error codes specific to chat: `AI_NOT_CONFIGURED`, `AI_ERROR`,
`AI_NETWORK_ERROR`, `MAX_ITERATIONS`, `CHAT_DAILY_CAP`, `CHAT_RATE_LIMIT`,
`CHAT_DEBUG_RATE_LIMIT`, `NOT_AUTHORIZED` (per-tool, surfaced inside the reply
text).

---

## Multi-tenancy (`/api/org`)

| Method | Path | Notes | Audit | Source |
|---|---|---|---|---|
| GET | `/api/org` | `{ org, members, pendingInvites }`. | — | `orgRoutes.js:25` |
| POST | `/api/org/invite` | `{ email, role? }`. | `ORG_INVITE_SENT` | `orgRoutes.js:58` |
| DELETE | `/api/org/invites/:id` | | — | `orgRoutes.js:93` |
| DELETE | `/api/org/members/:id` | | `ORG_MEMBER_REMOVED` | `orgRoutes.js:109` |
| PUT | `/api/org` | Rename / update org. | — | `orgRoutes.js:130` |
| GET | `/api/org/email-identity` | Outbound sender identity (2026-09-19): `{ sender_name, reply_to, effective: { from, reply_to }, email_configured, transport }`. Any member. | — | `orgRoutes.js` |
| PUT | `/api/org/email-identity` | `{ sender_name?, reply_to? }` — owner/admin (`requireOrgAdmin`). `null`/`''` clears a key. Stored on `organizations.branding.email` (`services/senderIdentity.js`); the From: display name is used **verbatim** when set (else `"<Org> via The Open CRM"`), Reply-To falls back to the sending user's login email on one-off sends. Applied by `POST /api/emails/send` and every sequence step; both also now carry a plain-text unsubscribe footer + `List-Unsubscribe` header pointing at the existing `GET /api/emails/unsubscribe/:token`. 400 on a malformed address. | `ORG_EMAIL_IDENTITY_UPDATED` | `orgRoutes.js` |
| GET | `/api/invites/:token` (public) | Lookup invite. | — | `acceptInviteRoutes.js:7` |
| POST | `/api/invites/:token/accept` (public) | `{ name, password }`. Emits `ORG_INVITE_ACCEPTED`. CSRF-exempt. | `ORG_INVITE_ACCEPTED` | `acceptInviteRoutes.js:30` |

---

## Bring-your-own Anthropic key (`/api/org/ai-key`)

One Anthropic key per org (migration 154, table `org_ai_keys`), encrypted
AES-256-GCM under `DRIVE_TOKEN_ENCRYPTION_KEY` via `services/driveTokens.js`
(`services/orgAiKeys.js`). While a key is stored, every AI call for the org
goes out under it, Anthropic bills the org directly, and the platform
upcharge does not apply. The plaintext is never returned or logged — only
`last4`. Personal workspaces (no org) get `400 ORG_REQUIRED`.

Response shape (all three routes): `{ configured, provider: 'anthropic',
last4, last_validated_at, last_error, updated_at, billing_mode:
'byo_key'|'platform', can_manage }`.

| Method | Path | Auth | Notes | Audit | Source |
|---|---|---|---|---|---|
| GET | `/api/org/ai-key` | any org member | Status only; members use it for the "your org uses its own key" note on `/usage`. | — | `orgAiKeyRoutes.js` |
| PUT | `/api/org/ai-key` | org owner/admin | `{ key }`. Format check (`sk-ant-…`), then ONE `max_tokens: 1` probe call to Anthropic on the org's configured model. 400 `INVALID_KEY_FORMAT` · 422 `KEY_REJECTED` (401/403 from Anthropic — nothing stored) · 503 `ENCRYPTION_UNAVAILABLE` (master key unset) · 403 `ADMIN_REQUIRED`. A transient probe failure still stores the key and sets `last_error`. Rate-limited 10 / 15 min / user. | `ORG_AI_KEY_SET` | `orgAiKeyRoutes.js` |
| DELETE | `/api/org/ai-key` | org owner/admin | Removes the key; the org drops back to pay-as-you-go on the platform key. Adds `removed: bool`. | `ORG_AI_KEY_CLEARED` | `orgAiKeyRoutes.js` |

---

## Email (`/api/emails`) — no feature gate

> Not gated by any `requireFeature(...)` flag (there is no `emails_enabled`
> flag). Email degrades gracefully to a console-fallback send when SMTP is
> unconfigured; the `POST /send` path still records an `email_sends` row.

| Method | Path | Auth | Notes | Source |
|---|---|---|---|---|
| GET | `/api/emails/track/:id.gif` | public | Tracking-pixel endpoint. Sets `opened_at` on the matched `email_sends` row. CSRF-exempt; 1x1 GIF response. | `emailRoutes.js:60` |
| GET | `/api/emails/unsubscribe/:token` | public | Renders unsubscribe page + writes `email_unsubscribes`. CSRF-exempt. | `emailRoutes.js:86` |
| GET | `/api/emails/templates` | yes | List org templates. | `emailRoutes.js:135` |
| POST | `/api/emails/templates` | yes | Create. | `emailRoutes.js:168` |
| PUT | `/api/emails/templates/:id` | yes | | `emailRoutes.js:190` |
| DELETE | `/api/emails/templates/:id` | yes | | `emailRoutes.js:212` |
| POST | `/api/emails/templates/:id/preview` | yes | `{ to_email? }`. Emits `EMAIL_TEMPLATE_PREVIEW`. | `emailRoutes.js:237` |
| GET | `/api/emails/sends` | yes | List sent emails. Filters: `contact_id`, `deal_id`, `template_id`. | `emailRoutes.js:300` |
| POST | `/api/emails/send` | yes | `{ to_email, subject, body, contact_id?, deal_id?, template_id? }`. Emits `EMAIL_SENT` (including the console-fallback path). | `emailRoutes.js:410` |

---

## Billing & Stripe (`/api/billing`)

Stripe webhook must be CSRF-exempt and parses raw bodies (see `/webhook`).

| Method | Path | Auth | Notes | Source |
|---|---|---|---|---|
| POST | `/api/billing/webhook` | Stripe signature | `express.raw({ type: 'application/json' })`. Verifies `Stripe-Signature` header. CSRF-exempt. | `billingRoutes.js:40` |
| GET | `/api/billing/status` | yes | `{ tier, stripe_customer_id, subscription_status, ... }`. | `billingRoutes.js:160` |
| POST | `/api/billing/checkout` | yes | `{ tier }`. Returns `{ url }` to Stripe Checkout. | `billingRoutes.js:178` |
| POST | `/api/billing/portal` | yes | Returns `{ url }` to Stripe Customer Portal. | `billingRoutes.js:214` |

503 when Stripe env vars (`STRIPE_SECRET_KEY`, price IDs, webhook secret) are
unset — endpoints surface a `{ configured: false }` shape so the frontend can
hide upgrade CTAs gracefully.

---

## Usage (`/api/usage`)

| Method | Path | Notes | Source |
|---|---|---|---|
| GET | `/api/usage` | Current month's metered usage + projection (ai_requests, ai_input_tokens, ai_output_tokens, etc.). `ai_usage` also carries `byo_key_calls` (total + per `by_endpoint` row) so the page can label calls made on the org's own Anthropic key as not billed by us. | `usageRoutes.js:19` |

---

## Appreciation (`/api/appreciation`)

| Method | Path | Notes | Source |
|---|---|---|---|
| GET | `/api/appreciation` | List nominations. | `appreciationRoutes.js:24` |
| POST | `/api/appreciation` | Create nomination. | `appreciationRoutes.js:47` |
| PUT | `/api/appreciation/:id` | | `appreciationRoutes.js:62` |
| POST | `/api/appreciation/:id/complete` | Mark complete. | `appreciationRoutes.js:81` |
| DELETE | `/api/appreciation/:id` | | `appreciationRoutes.js:96` |

---

## Extension autonomous mode (migration 167 — 2026-09-18)

`PATCH /api/plugins/:id/run-mode` `{ run_mode: 'preview'|'autonomous' }` — org
owner/admin; audited (`plugin.run_mode_changed`). Autonomous plugins auto-apply a
SUCCESSFUL run's proposals through the shared apply machinery
(`services/pluginActions.applyRunProposals`) for every entry point (manual, chat,
event, schedule); failed runs never commit; all sandbox caps unchanged; writes audited
with `autonomous: true`. `run_mode` appears on plugin list/detail/run payloads and the
library's `installed_run_mode`; install endpoints accept `{ run_mode }`
(non-admin requesting autonomous → 403).

## API keys as a credential + the `/api/v1` façade (spec 206 — 2026-09-22)

An API key (`Settings → Developer`, `tocrm_…`, sent as `Authorization: Bearer` or `X-API-Key`)
now authenticates **the same org-scoped routers the browser uses**. Nothing is duplicated:
`auth.js authMiddleware` falls back to `middleware/apiKeyAuth.resolveApiKey` when there is no
session cookie. The key acts as its creator (org, current org_role, write attribution) and
stops working if the creator is suspended or deleted.

| Rule | Detail |
|---|---|
| Scope | `read` keys: GET/HEAD/OPTIONS only. `write` keys ("Allow writes" at creation): everything else. 403 `API_KEY_SCOPE`. |
| Denylist (any scope) | `/auth`, `/security`, `/me` (except `/api/v1/me`), `/admin`, `/billing`, `/keys`, `/org`, `/team`, `/invites`, `/gateway`, `/sso`, `/platform-integrations`, OAuth connectors, `/access-requests`, `/contact`, `/request-access`, `/legal`, `/portal`, inbound `/webhooks`. 403 `API_KEY_FORBIDDEN_ROUTE`. |
| CSRF | Exempt for key-authenticated requests with no auth cookie (custom header ⇒ CORS preflight ⇒ no cross-site forgery). |
| Gates | Feature flags, the AI billing gate and rate limits apply exactly as for the browser. |
| Failure posture | Unknown/revoked key, inactive creator, or a DB error during lookup → 401 (fail closed). |

`/api/v1/<resource>` is the documented, versioned spelling; the plain `/api/<resource>` paths accept keys too.

| Prefix under `/api/v1` | Router | Notes |
|---|---|---|
| `/me` | `apiV1Routes.js` | `{ api_key: { name, key_prefix, scopes }, org_id }` |
| `/companies`, `/contacts`, `/deals`, `/tasks`, `/activities` | the CRM routers | full CRUD, same bodies as the browser (see sections above) |
| `/leads` | `leadRoutes.js` | `leads_enabled` gate |
| `/import` | `importRoutes.js` | `POST /parse` (multipart `file`) then `POST /contacts|companies|deals` |
| `/pipelines`, `/custom-fields`, `/search`, `/my-day`, `/notifications` | as named | |
| `/ai` | `aiRoutes.js` | `POST /chat`, `POST /actions/apply`, `GET /chat/sessions` — metered to the key's org |
| `/plugins` | `pluginRoutes.js` | `POST /:id/run` |
| `/webhooks-out` | `outboundWebhookRoutes.js` | subscriptions (org-admin creator required) |

## AI Gateway (spec 202 v1, migration 168 — 2026-09-18)

`POST /api/gateway/v1/messages` — metered Anthropic Messages proxy for SELF-HOSTED
instances. Auth: `ocrm_gw_` key via `Authorization: Bearer` or `x-api-key` (SHA-256 at
rest, 30s cache); CSRF-exempt, sessionless, 60/min per key, 1MB body, model allowlist,
`max_tokens ≤ 8192`, streaming/tools rejected with clear 400s (v1). The org's full AI
billing verdict runs BEFORE the upstream call (past_due grace / halted / hard cap →
402 with the verdict code); usage meters into `ai_usage_events` (`endpoint='gateway'`,
2× upcharge) exactly like hosted; response carries `X-OpenCRM-Charged-USD`. Prompt and
completion content are never logged. 503 when the platform key is unconfigured.

Key management (`canManageOrgBilling`; minting requires `ai_billing_status ∈
(active, comped)` else 402 `AI_BILLING_REQUIRED_FOR_GATEWAY`): `GET/POST
/api/billing/ai/gateway-keys` (plaintext shown once), `DELETE
/api/billing/ai/gateway-keys/:id` (busts the proxy cache). UI: the "AI Gateway" card
on `/settings#billing`.

Self-host client side: set `OPENCRM_AI_GATEWAY_KEY` (+ optional
`OPENCRM_AI_GATEWAY_URL`, default `https://app.theopencrm.com/api/gateway`) — used
when no org BYO key and no platform `ANTHROPIC_API_KEY`; the local free-tier quota is
exempted (the gateway bills and caps) and `GET /api/ai/status` reports
`billing.status: 'gateway'`.

## Extension platform additions (2026-09-17)

Plugins: GET /api/plugins/library now returns per-entry installed/active status for the caller org; POST /api/plugins/from-template and POST /api/plugins/library/:slug/install accept { activate: true } for atomic install+activate (services/extensionInstall.js). Event + schedule triggers: see PLUGIN_SDK_REFERENCE.md Triggers.

Analytics beacon: POST /api/metrics/pageview (public, CSRF-exempt, 60/15min/IP, always 204) - normalized path + referrer host only, no visitor ids. Admin dashboard: GET /api/admin/traffic (super-admin).

Client errors: POST /api/client-errors (+ /csp) - public, rate-limited 10/15min/IP, logs-only (GCP Error Reporting shape).

## CSV import (`/api/import`)

| Method | Path | Notes | Source |
|---|---|---|---|
| GET | `/api/import/presets` | Switcher-migration preset descriptors (HubSpot / Salesforce) for the wizard. | `importRoutes.js` |
| POST | `/api/import/parse` | `multipart/form-data` with `file`. Returns `{ headers, totalRows, preview, rows }`. 10MB limit. | `importRoutes.js:22` |
| POST | `/api/import/contacts` | `{ rows, mapping, preset? }`. Auto-matches `company_name` to existing companies; `owner_email` mapping assigns owner by org-user email. | `importRoutes.js:53` |
| POST | `/api/import/companies` | `{ rows, mapping, preset? }`. | `importRoutes.js:112` |
| POST | `/api/import/deals` | `{ rows, mapping, preset? }`. Optional per-row `deal_type`; `owner_email` supported. | `importRoutes.js` |

`preset: 'hubspot' | 'salesforce'` applies that platform's standard-export column
mapping server-side (user mapping keys override), translates default stage names onto
the org's effective pipeline (unmapped stages → pipeline default + per-row warning),
and matches owners by email. Execute responses include `warnings[]` alongside
`errors[]`. Switcher runbook: `docs/MIGRATING_FROM_HUBSPOT_SALESFORCE.md`. The wizard
also auto-detects HubSpot/Salesforce/Pipedrive column names generically.

---

## Public contact form (`/api/contact`)

| Method | Path | Notes | Source |
|---|---|---|---|
| POST | `/api/contact` | `{ name, email, company?, message, interest? }`. Public. Sends email to admin if SMTP configured. | `contactFormRoutes.js:20` |

---

## Webhooks inbound (`/api/webhooks`) — requires `webhooks_enabled`

| Method | Path | Auth | Notes | Source |
|---|---|---|---|---|
| POST | `/api/webhooks/teams?org=N` | `X-Teams-Secret` | `TEAMS_WEBHOOK_SECRET` env. CSRF-exempt. | `webhookRoutes.js:55` |
| POST | `/api/webhooks/zoom?org=N` | `x-zm-signature` (HMAC-SHA256) | `ZOOM_WEBHOOK_SECRET_TOKEN`. Handles Zoom URL-validation handshake. CSRF-exempt. | `webhookRoutes.js:91` |
| POST | `/api/webhooks/generic?org=N&secret=...` | query-param shared secret | `GENERIC_WEBHOOK_SECRET`. CSRF-exempt. | `webhookRoutes.js:141` |
| GET | `/api/webhooks/meetings?related_type=deal&related_id=N` | yes | List ingested meetings. | `webhookRoutes.js:174` |

---

## QuickBooks Online (`/api/quickbooks`) — requires `quickbooks_enabled`

| Method | Path | Auth | Notes | Source |
|---|---|---|---|---|
| GET | `/api/quickbooks/status` | yes | `{ configured, connected, environment, realmId, lastSync... }`. | `quickbooksRoutes.js:13` |
| POST | `/api/quickbooks/connect` | yes | Returns `{ authUrl }`. | `quickbooksRoutes.js:38` |
| GET | `/api/quickbooks/callback` | public (OAuth) | Intuit redirect target. | `quickbooksRoutes.js:50` |
| POST | `/api/quickbooks/disconnect` | yes | | `quickbooksRoutes.js:73` |
| POST | `/api/quickbooks/invoice/:dealId` | yes | Manually create QB invoice for a deal. | `quickbooksRoutes.js:81` |

---

## Automation engine (`/api/automation`) — requires `automation_enabled`

| Method | Path | Notes | Source |
|---|---|---|---|
| GET | `/api/automation/rules` | List rule ids + descriptions. | `automationRoutes.js:10` |
| POST | `/api/automation/run` | Manually fire all rules. | `automationRoutes.js:14` |
| GET | `/api/automation/runs` | Recent fires from `automation_runs`. | `automationRoutes.js:23` |

**Org-configurable rules (`/api/automation-rules`):** CRUD on `{ name, trigger, conditions, action, enabled }` (zod-validated, shared with the chat `propose_automation_rule` tool). Triggers: `deal_stage_is`, `deal_idle_days`, `task_overdue`, and **`custom_date_offset`** (2026-09-14) — conditions `{ entity: deals|companies|contacts, field_name (must be a date-type org field, else 400), offset_days (negative = before) }`, dedupe per record × rule × date, 30-day catch-up horizon. Actions: `create_task`, `notify`, `set_hot_flag`, **`create_task_and_notify`**; task title supports `{name}`/`{date}`/`{field}` templates and routes to the record owner. Source: `routes/automationRuleRoutes.js`, `schemas/automationRules.js`.

**Playbooks (`/api/playbooks`, migrations 123 + 158):** POST/PUT accept `trigger_kind: 'lifecycle_stage'(default)|'deal_stage'` + `trigger_deal_type?`; deal-stage playbooks fire once per playbook × deal (partial-unique dedupe on `playbook_runs`) when a deal enters the trigger stage — from the stage PATCH, stage-changing PUT, and the AI actions-apply path. Deal-stage values validate against the org's effective pipeline(s) for the filtered deal type.

---

## Security flows (`/api/security`)

| Method | Path | Auth | Notes | Source |
|---|---|---|---|---|
| POST | `/api/security/email/send-verification` | yes | Issue 24h verification token. | `securityFlowRoutes.js:32` |
| POST | `/api/security/email/verify` | public | `{ token }`. | `securityFlowRoutes.js:62` |
| GET | `/api/security/2fa/status` | yes | | `securityFlowRoutes.js:86` |
| POST | `/api/security/2fa/enroll` | yes | `{ secret, otpauthUrl, qrDataUrl }`. | `securityFlowRoutes.js:95` |
| POST | `/api/security/2fa/verify-enroll` | yes | `{ code }` → 8 single-use recovery codes. | `securityFlowRoutes.js:122` |
| POST | `/api/security/2fa/disable` | yes | | `securityFlowRoutes.js:150` |
| POST | `/api/security/password-reset/request` | public | `{ email }`. ALWAYS the same generic 200 (no enumeration; Google-only accounts get a "sign in with Google" email instead of a token). 5/15min per IP + 3/15min per account. CSRF-exempt. | `securityFlowRoutes.js` |
| POST | `/api/security/password-reset/confirm` | public | `{ token, password }`. Hashed 30-min single-use tokens; full password policy incl. history/HIBP; invalidates the user's other outstanding tokens; audits `password.reset`. 400 codes: `RESET_TOKEN_INVALID\|EXPIRED\|USED`. 10/15min per IP. CSRF-exempt. | `securityFlowRoutes.js` |

Admin-only operational security reports live under `/api/admin/security/*`
(`adminRoutes.js`). (The unmounted legacy `securityRoutes.js` was deleted 2026-09-14.)

---

## Admin (`/api/admin`)

`adminMiddleware` required. Additional permissions per row.

| Method | Path | Permission | Notes | Source |
|---|---|---|---|---|
| GET | `/api/admin` | admin | Summary widget. | `adminRoutes.js:16` |
| GET | `/api/admin/users` | admin | Paginated. `page`, `limit`, `email`, `plan`. | `adminRoutes.js:48` |
| GET | `/api/admin/users/:id` | admin | | `adminRoutes.js:100` |
| PUT | `/api/admin/users/:id` | admin | Audit-logged. | `adminRoutes.js:123` |
| DELETE | `/api/admin/users/:id` | `manage_users` | Hard delete + cascade. | `adminRoutes.js:172` |
| GET | `/api/admin/admins` | admin | | `adminRoutes.js:211` |
| POST | `/api/admin/admins` | `manage_admins` | `{ user_id, role }`. | `adminRoutes.js:237` |
| PUT | `/api/admin/admins/:id` | `manage_admins` | | `adminRoutes.js:283` |
| DELETE | `/api/admin/admins/:id` | `manage_admins` | | `adminRoutes.js:324` |
| GET | `/api/admin/audit-logs` | admin | Filters: `action`, `userId`. | `adminRoutes.js:358` |
| GET | `/api/admin/audit-logs/export/csv` | admin | CSV export. | `adminRoutes.js:389` |
| POST | `/api/admin/security/run-checks` | admin | | `adminRoutes.js:405` |
| GET | `/api/admin/security/status` | admin | | `adminRoutes.js:418` |
| GET | `/api/admin/security/checks` | admin | | `adminRoutes.js:431` |
| GET | `/api/admin/access-requests?status=pending_approval` | admin | | `adminRoutes.js:449` |
| POST | `/api/admin/access-requests/:id/approve` | `approve_access` | Approve + email user. | `adminRoutes.js:464` |
| POST | `/api/admin/access-requests/:id/reject` | `approve_access` | `{ reason? }`. | `adminRoutes.js:508` |
| POST | `/api/admin/users/:id/suspend` | `manage_users` | `{ reason? }`. | `adminRoutes.js:536` |
| POST | `/api/admin/users/:id/reactivate` | `manage_users` | | `adminRoutes.js:557` |
| GET | `/api/admin/organizations` | admin | List orgs cross-tenant. | `adminRoutes.js:583` |
| PUT | `/api/admin/organizations/:id/profile` | `manage_users` | `{ profile: 'generic' \| 'zang' \| 'jcp' }` (`rin` planned — stage set wired, backend still spec). | `adminRoutes.js:597` |
| POST | `/api/admin/provision-org` | super_admin | Provision a new org (same code path as the `scripts/provision-org.js` CLI). | `adminRoutes.js:689` |
| GET | `/api/admin/system/health` | admin | Operational health snapshot. | `adminRoutes.js:624` |
| POST | `/api/admin/demo/seed` | admin | `{ profile }`. Generates ~15 deals. | `demoRoutes.js:8` |
| POST | `/api/admin/demo/wipe` | admin | Removes all `[demo]`-tagged records. | `demoRoutes.js:24` |
| GET | `/api/admin/feature-flags/flags` | super_admin | Global flag list. | `adminFeatureFlagRoutes.js:33` |
| GET | `/api/admin/feature-flags/flags/:orgId` | super_admin | Per-org overrides. | `adminFeatureFlagRoutes.js:50` |
| PUT | `/api/admin/feature-flags/flags/:orgId/:name` | super_admin | `{ value }`. | `adminFeatureFlagRoutes.js:61` |
| DELETE | `/api/admin/feature-flags/flags/:orgId/:name` | super_admin | Clear an override (revert to global). | `adminFeatureFlagRoutes.js:79` |
| GET | `/api/security/audit` | admin | | `securityRoutes.js:10` |
| POST | `/api/security/run-checks` | admin | | `securityRoutes.js:20` |
| GET | `/api/security/checks` | admin | | `securityRoutes.js:30` |
| GET | `/api/security/report` | admin | | `securityRoutes.js:41` |
| GET | `/api/accessibility/audit` | admin | | `accessibilityRoutes.js:10` |
| GET | `/api/accessibility/report` | admin | | `accessibilityRoutes.js:35` |
| GET | `/api/accessibility/checklist` | admin | | `accessibilityRoutes.js:66` |
| POST | `/api/accessibility/mark-resolved` | admin | | `accessibilityRoutes.js:106` |
| GET | `/api/compliance/status` | admin | | `complianceRoutes.js:11` |
| GET | `/api/compliance/playstore` | admin | | `complianceRoutes.js:21` |
| GET | `/api/compliance/gdpr` | admin | | `complianceRoutes.js:40` |
| GET | `/api/compliance/data-privacy` | admin | | `complianceRoutes.js:50` |
| POST | `/api/compliance/update-evidence` | admin | | `complianceRoutes.js:60` |
| GET | `/api/compliance/report` | admin | | `complianceRoutes.js:78` |

---

## Admin — platform integrations (`/api/admin/platform-integrations`)

Super-admin. DB-backed OAuth-credential store (Drive today; reusable for Gmail /
Stripe / Teams / Zoom). Secrets are encrypted at rest with
`DRIVE_TOKEN_ENCRYPTION_KEY`. The DB-backed source wins over the legacy env-var
path when both are present. Mounted at `index.js:535`
(`platformIntegrationsRoutes.js`). See `PLATFORM_INTEGRATIONS_SPEC.md`.

## Admin — per-org AI model (`/api/admin/ai-model`)

Super-admin. Read/set the Claude model an org's copilot uses (persisted in
`org_ai_model`, migration `096`). Mounted at `index.js:641`
(`adminAiModelRoutes.js`).

## Admin — org activity (`/api/admin/org-activity`)

Super-admin cross-tenant activity feed. Mounted at `index.js:649`
(`orgActivityRoutes.js`).

---

## Deal intel — Google Drive (`/api/drive`, `/api/deals/:id/*`) — requires `drive_intel_enabled`

Per-deal Drive-folder linking + AI intel summaries. All routes gated by
`drive_intel_enabled`. See `DRIVE_INTEL_SPEC.md`.

| Method | Path | Notes | Source |
|---|---|---|---|
| — | `/api/drive/*` | OAuth connect/status/disconnect for the org's Drive connection. | `driveAuthRoutes.js` (`index.js:587`) |
| — | `/api/drive/folders` | Folder search. | `driveFolderRoutes.searchRouter` (`index.js:588`) |
| — | `/api/deals/:id/drive-folder` | Link/unlink a Drive folder to a deal. | `driveFolderRoutes` (`index.js:589`) |
| — | `/api/deals/:id/intel` | Deal-intel summaries + suggestions from linked Drive files. | `dealIntelRoutes` (`index.js:590`) |

## Deal intel — Gmail (`/api/gmail`, `/api/deals/:id/*`) — requires `gmail_intel_enabled`

Per-deal Gmail-thread linking + AI intel summaries. All routes gated by
`gmail_intel_enabled`.

| Method | Path | Notes | Source |
|---|---|---|---|
| — | `/api/gmail/*` | OAuth connect/status/disconnect for the org's Gmail connection. | `gmailAuthRoutes.js` (`index.js:606`) |
| — | `/api/gmail/threads` | Thread search. | `gmailThreadRoutes.searchRouter` (`index.js:607`) |
| — | `/api/deals/:id/gmail-threads` | Link/unlink a Gmail thread to a deal. | `gmailThreadRoutes` (`index.js:608`) |
| — | `/api/deals/:id/gmail-intel` | Deal-intel summaries from linked Gmail threads. | `dealGmailIntelRoutes` (`index.js:609`) |

---

## V2 financial endpoints (`/api/v2/...`)

V2 dual-write surface used during the migration from embedded line-items to
normalized child tables. Used in parallel with the legacy `/api/quotes` etc.;
the `services/v2DualWrite.js` keeps both stores consistent. Full CRUD for:

| Resource | Base path | Source |
|---|---|---|
| RFQs (with line items, versions) | `/api/v2/rfqs` | `routes/v2/rfqRoutes.js` |
| Purchase orders (line items, versions) | `/api/v2/purchase-orders` | `routes/v2/purchaseOrderRoutes.js` |
| Invoices (line items, versions) | `/api/v2/invoices` | `routes/v2/invoiceRoutes.js` |
| Invoice allocations | `/api/v2/invoice-allocations` | `routes/v2/invoiceAllocationRoutes.js` |

Each follows the same shape: `GET /` (list), `GET /:id`, `POST /`, `PUT /:id`,
`DELETE /:id`, plus `POST /:id/line-items`, `PUT /:id/line-items/:lid`,
`DELETE /:id/line-items/:lid`, `POST /:id/versions`. Auth required.

---

## Test-only auth (`/api/auth/test`) — dev / staging only

Mounted only when `NODE_ENV !== 'production'`.

| Method | Path | Notes | Source |
|---|---|---|---|
| POST | `/api/auth/test-login` | `{ email }` — instant login as a seed user, no password. Used in tests. | `testAuthRoutes.js:51` |
| GET | `/api/auth/test-users` | Lists seed users. | `testAuthRoutes.js:148` |

---

## Things that are deliberately not endpoints

Stored as JSONB or arrays inside other tables:
- **Quote line items** — child of `quote.id`, exposed via `GET /api/quotes/:id`
  (returns embedded `line_items`). For the normalized variant see `/api/v2/...`.
- **Quote revisions** — same; embedded in the quote response.
- **Delivery checklist** — JSONB column on `deals.delivery_checklist`. Edit via
  `PUT /api/deals/:id`.
- **User permissions array** — `admin_users.permissions[]`. Set via
  `PUT /api/admin/admins/:id`.
- **Chat tool results** — Claude's tool calls run inside the request handling
  loop for `POST /api/ai/chat`; you don't call those URLs directly. See
  `CHAT_TOOLS_REFERENCE.md`.

---

## How to add a new endpoint (the pattern)

1. Add migration (next 3-digit prefix in `backend/migrations/`).
2. Create `backend/routes/<resource>Routes.js` with `qs(req)` helper at the
   top, standard CRUD shape.
3. Mount in `backend/index.js`.
4. Add a section to this file (under the appropriate heading), cite
   `<file>:<line>` for the implementation.
5. Optionally add a `pages/<Resource>.js` and a tab to `Nav.js`.
