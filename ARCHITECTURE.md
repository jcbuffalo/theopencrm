# ARCHITECTURE — The Open CRM

What happens between the user's browser and Postgres. Companion docs: [`API.md`](./API.md) for endpoint shapes, [`CHAT_TOOLS_REFERENCE.md`](./CHAT_TOOLS_REFERENCE.md) for the copilot tools, [`CONTRACTOR_ONBOARDING.md`](./CONTRACTOR_ONBOARDING.md) for the codebase tour, [`SECURITY_REVIEW.md`](./SECURITY_REVIEW.md) for the threat model.

## Deployment topology

```
                                  ┌──────────────────────────────┐
   Browser                        │   GCP project: xfte-platform │
   (app.theopencrm.com)           │   Region: us-central1        │
        │                         └──────────────────────────────┘
        │ HTTPS (TLS 1.3, Google-managed cert)
        ▼
 ┌─────────────────────┐         ┌─────────────────────────────────┐
 │ Cloud Run           │  CORS   │ Cloud Run                       │
 │ synccrm-frontend    │ ──────▶ │ synccrm-backend                 │
 │ React SPA + Express │  cookie │ Express + pg pool (max 20)      │
 │ serves static build │  auth   │ Mounts every /api/* route       │
 └─────────────────────┘         └────────────────┬────────────────┘
                                                  │
                  ┌───────────────────────────────┼──────────────────────────────┐
                  ▼                               ▼                              ▼
        ┌──────────────────┐         ┌───────────────────────┐         ┌──────────────────┐
        │  Cloud SQL       │         │  Anthropic            │         │  Google Cloud    │
        │  Postgres        │         │  api.anthropic.com    │         │  Storage         │
        │  xfte-postgres   │         │  (Claude — sonnet 4.6)│         │  bucket: docs    │
        │  /lightweight_crm│         └───────────────────────┘         └──────────────────┘
        │  via /cloudsql/  │
        │  unix socket     │         ┌───────────────────────┐         ┌──────────────────┐
        └──────────────────┘         │  SendGrid / Gmail SMTP│         │  Twilio (SMS)    │
                                     │  (nodemailer)         │         │  optional        │
                                     └───────────────────────┘         └──────────────────┘
                                                  │
                                                  ▼
                                     ┌───────────────────────┐         ┌──────────────────┐
                                     │  Stripe (billing      │         │  Cloud Logging   │
                                     │  + webhook signed)    │         │  (stdout-fed)    │
                                     └───────────────────────┘         └──────────────────┘
```

- The frontend service is a thin static-asset server that also serves the React SPA (`frontend/server.js`). It has no DB access.
- The backend is the only thing that touches Postgres. Cloud SQL connection is a unix socket mounted via Cloud Run's Cloud SQL connector (`backend/db.js:30-34`).
- All third-party services degrade gracefully: missing env vars → service returns `{ configured: false }` and callers surface a "not configured" message instead of a 500.

## Middleware chain (request lifecycle)

Everything below lives in `backend/index.js` in the listed order. The order is load-bearing — moving any of these flips a security guarantee.

1. **Boot-time env validation** (`index.js:21-29`). Before `app.listen`, `services/envValidation.js:validateEnv()` throws if `JWT_SECRET`, `CSRF_SECRET`, `COOKIE_SECRET`, `JWT_REFRESH_SECRET`, `JWT_2FA_SECRET`, etc. are missing in production. Container exits with code 1 → Cloud Run withholds traffic from the bad revision. **Fail at deploy, not mid-pitch.**

2. **Helmet** (`index.js:41-55`). CSP locks `script-src` to `'self' + accounts.google.com + apis.google.com`; `frame-ancestors 'none'`; `object-src 'none'`. HSTS + `X-Content-Type-Options: nosniff` come from helmet defaults.

3. **CORS** (`index.js:62-92`). Allowlist = `localhost:3000/3001` + everything in `FRONTEND_URL` (comma-split) + a regex match for `*-vknejwwyra-uc.a.run.app`. `credentials: true` (cookie-bearing). `allowedHeaders` includes `X-CSRF-Token` for the double-submit pattern and `Authorization` for the transitional Bearer fallback.

4. **Global rate limit** (`index.js:95-106`). 500 req/15min/IP, except `/health`. Plus two stricter limiters mounted later: `authLimiter` (30/15min on `/api/auth/*`) and `aiLimiter` (60/15min on `/api/ai/*` and `/api/plugins`).

5. **Body parsers** (`index.js:137-138`). `express.json({ limit: '10mb' })` and `express.urlencoded`. **Note:** the Stripe webhook route bypasses this by mounting `express.raw({type:'application/json'})` at the router level (`backend/routes/billingRoutes.js:40`) — router-scoped middleware runs first, so the raw bytes survive for signature verification.

6. **Cookie parser** (`index.js:146`). Signed with `COOKIE_SECRET`. Reads the `authToken` cookie + the `__Host-psifi.x-csrf-token` cookie.

7. **CSRF (double-submit)** (`index.js:172-227`). `csrf-csrf` mints two cookies:
   - `__Host-psifi.x-csrf-token` (signed, httpOnly) — server-side secret
   - `csrfToken` (readable from JS) — what the frontend echoes back as `X-CSRF-Token`
   An attacker on another origin cannot read `csrfToken` to forge the header. The middleware runs only on state-changing methods and **only for non-exempt paths** (`isCsrfExempt`, `index.js:183-193`). Exempt: GET/HEAD/OPTIONS, login/register/google-signin/2FA-verify, the Stripe webhook (`stripe-signature` is the proof of authenticity), `/api/webhooks/*` (HMAC-signed by third parties), `/api/invites/*`, `/api/emails/unsubscribe/*`, `/api/emails/track/*.gif`, `/api/contact`, `/api/request-access`, `/api/security/email/verify`.

8. **Trust proxy** (`index.js:235`). `app.set('trust proxy', 1)` — Cloud Run is exactly one hop. This is the difference between `req.ip` resolving to the real client and to Google's load balancer.

9. **Request context** (`index.js:237-238`, source: `backend/middleware/requestContext.js`). Per-request:
   - Read or mint `X-Request-Id` (8-byte hex). Echo back in response header.
   - `req.requestId = id`
   - `req.log = logger.child({ requestId })` — every subsequent log line on this request is correlated.
   - On `res.finish`, emit one structured `request` log line with method/path/status/durationMs/userId/orgId/ip.

10. **Health endpoints** (`index.js:244-303`). `/health` (cheap, 200 always), `/health/deep` (real DB query, GCS list, email config check, AI config check). Use `/health/deep` in deploy scripts to verify a fresh revision before shifting traffic.

11. **Route registration** (`index.js:417-577`). Order matters because of three things:
    a. `authLimiter` is mounted only on `/api/auth` to cap credential stuffing (`index.js:419`).
    b. `requireFeature(<flag>)` from `backend/middleware/featureGate.js` precedes the gated route mount (`/api/quotes`, `/api/v2/*`, `/api/ai/*`, `/api/plugins`, etc.).
    c. `aiLimiter` precedes `/api/ai/*` and `/api/plugins` (which has `from-prompt` that burns Claude).

12. **Inside each route**: `authMiddleware` (from `backend/auth.js:250-275`) reads the `authToken` cookie (preferred) or `Authorization: Bearer …` (transitional fallback). Verifies HS256 JWT with audience pinning, looks up `users.org_id` + `users.org_role`, attaches to `req`. Token lookup precedence is documented in `backend/auth.js:229-248`.

13. **Org-scoping inside handlers** is the `qs(req)` helper, declared per route file (e.g. `backend/routes/dealRoutes.js:38`):
    ```js
    function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }
    ```
    Every SELECT / UPDATE / DELETE uses `WHERE <col> = $<n>` with the tuple. **This is the cross-tenant isolation invariant.** No route should construct a query that touches a tenant-scoped table without `qs(req)`.

14. **Audit emit** (after the work succeeds). Routes call `audit.fromReq(req, { event, targetType, targetId, meta, success })` from `backend/services/audit.js`. Writes to `audit_log` table. Failures are caught + logged via the structured logger — never break the originating request.

15. **Error handler** (`index.js:582-596`). Calls `req.log.error('unhandled_error', ...)` then returns `{success:false, message, requestId}`. `requestId` is included so the customer can quote it.

16. **404** (`index.js:599-601`). Same shape minus `requestId`.

## Plugin sandbox boundary

Plugins (user-authored or Claude-authored JS) run in `isolated-vm` v8 Isolates. The boundary is the most security-critical seam in the codebase. See `backend/services/pluginRunner.js:1-39` for the canonical comments; the model:

- **One Isolate per call.** Fresh heap. The Isolate is `dispose()`-d in `finally{}`. Nothing persists across invocations through the runtime — only through DB writes via the SDK.
- **What crosses the boundary.** The HOST injects exactly two things: (a) the v8 default globals (Math, JSON, Date, Promise, …) and (b) a `crm` object backed by `ivm.Reference.applySyncPromise`. The SDK functions execute in the HOST with full DB access. **Every SDK query is bound to `req.orgId` server-side** (`backend/services/pluginSdk.js`) — the plugin cannot supply `org_id`.
- **What does NOT cross.** No `fetch`/`http`/`process`/`require`/`Buffer`/`setTimeout`/`setInterval`/`setImmediate`/`console`. None of Node's runtime is reachable.
- **Resource caps.** `MEMORY_LIMIT_MB = 128`, `COMPILE_TIMEOUT_MS = 1000`, `RUN_TIMEOUT_MS = 5000`. A timeout calls `isolate.dispose()` — hard kill.
- **Quota caps** before the Isolate spins. Per-org monthly cap from `quotaEnforcer.TIER_QUOTAS`. Per-process concurrent cap `MAX_CONCURRENT_RUNS_PER_ORG = 5` (`pluginRunner.js:80`). Per-run DB-query budget of 50.
- **Kill switches.** Per-plugin (`plugins.status = 'suspended'`), per-org (feature flag `plugins_enabled = false`), per-platform (env `PLUGIN_RUNTIME_DISABLED=1`).
- **Audit.** Every run, regardless of outcome, writes one `audit_log` row with `event = 'plugin.run'` plus a `plugin_runs` row capturing `cpu_ms`, `db_queries`, `input_payload`, `output_payload`, `log_lines`, `status`. (`memory_peak_bytes` was dropped in migration 081 — isolated-vm doesn't expose peak heap after `dispose()` so the column was always 0.)

## v2 dual-write seam

There are v2 routes (confirmed: `backend/routes/v2/rfqRoutes.js`, `purchaseOrderRoutes.js`, `invoiceRoutes.js`, `invoiceAllocationRoutes.js`, mounted at `/api/v2/*` in `index.js:536-543`). All four are gated by the per-org `phase2_entities` feature flag. They sit alongside — not replacing — the v1 surface (`/api/quotes`, `/api/vendor-quotes`).

The dual-write hook layer is `backend/services/v2DualWrite.js`. The contract (from its header comment):
- Called inside the v1 route's existing transaction (`pool.connect()` + `BEGIN`).
- Idempotent (queries for the v2 record before inserting).
- Throws on real error → caller's `BEGIN` rolls back the v1 write too.
- Gated by per-org flag `v2_dual_write_enabled`. Default off.

Flipping the flag back to false stops new dual-writes; existing v2 rows are preserved but go stale. A nightly reconcile script (not in this scope; see `services/v2DualWrite.js` header) backfills.

## Chat-first copilot loop

Source: `backend/services/ai.js:603-713` (`runChatTurn`).

```
1. Anthropic call with system prompt + tools array + messages.
2. If response has no tool_use blocks → emit text reply, record usage, return.
3. Else: append assistant message, execute each tool server-side via the
   caller's runTool() (which closes over req.orgId — model-supplied orgId is
   never trusted), append tool_result blocks as user message, loop.
4. Cap at MAX_TOOL_ITERATIONS = 5. If we hit the cap, return code='MAX_ITERATIONS'.
```

Tools: 7 sales tools (list_deals, get_deal, list_overdue_tasks, list_dormant_deals, list_hot_deals, summarize_attention, draft_email_for_deal) + 9 debug-surface tools (recent_audit_events, inspect_plugin_run, recent_plugin_failures, email_send_history, notification_diagnostic, saved_view_info, custom_field_status, try_api, explain_error) + 3 super-admin-only tools (inspect_org, inspect_user, cross_org_recent_errors). Tool definitions live in the `CHAT_TOOLS` array in `services/ai.js:351-586`. Every tool is **hard-scoped to `req.orgId`** in the runner (`backend/routes/aiRoutes.js` invokes `runChatTurn` with a `runTool` closure that injects the orgId before dispatching). Super-admin tools additionally check `req.adminRole`.

Every chat turn emits `audit_log.event = 'ai.chat_message'`. Every debug-tool invocation emits `ai.debug_tool_invoked`.

## Cross-tenant isolation — the invariants

These are the things that, if violated, leak data across tenants. Every code change must preserve them.

1. **`org_id` on every tenant-scoped table.** Migration 033 added `org_id` to the original CRM tables (`users`, `companies`, `contacts`, `deals`, `activities`, `tasks`, `pipelines`). Every table created since (`quotes`, `vendor_quotes`, `submittals`, `change_orders`, `issues`, `documents`, `service_contracts`, `saved_filters`, `appreciation_queue`, `automation_runs`, `survey_invitations`, `meeting_logs`, `addresses`, `company_roles`, `rfqs`/lines/versions, `purchase_orders`/lines/versions, `invoices`/lines/versions, `invoice_allocations`, `plugins`, `plugin_runs`, `plugin_quota_usage`, `org_field_definitions`, `saved_views`, `chat_sessions`, `email_templates`, `email_sends`, `email_unsubscribes`, `usage_meter`) carries `org_id`.

   **Exceptions** (intentionally not org-scoped):
   - `users`, `admin_users`, `organizations`, `org_invites` — identity tables.
   - `audit_log`, `audit_logs` — global, but every row carries `org_id` for filtering.
   - `migrations`, `security_checks`, `accessibility_audits`, `playstore_compliance`, `account_deletions`, `user_password_history`, `quickbooks_connections` (carries org_id but has special owner semantics), `qb_oauth_state`.

2. **`qs(req)` everywhere.** Every CRUD route file declares `function qs(req)` and uses it. If you write a new route, you must too.

3. **Plugin SDK closes over orgId.** `backend/services/pluginSdk.js` is invoked with `{ orgId }` baked in by the runner before being exposed to the Isolate. The Isolate never sees `orgId` as input.

4. **Chat tool dispatcher closes over orgId.** Same pattern. `runTool` in the route handler is the only point of trust.

5. **Audit-log writes record orgId.** Even when the action is global (super-admin), the actor's `orgId` is captured so cross-tenant queries can be forensically tracked.

## Feature flags

Source: `backend/services/featureFlags.js` + the `requireFeature` middleware in `backend/middleware/featureGate.js`. Storage: `organizations.features` JSONB (`migration 056`). Flat object of `{ name: boolean }`.

Read path: `featureFlags.hasFeature(orgId, name)` with a 30-second in-process cache (per-pod). Write path: `setFeature(orgId, name, value)` does `jsonb_set` and invalidates the cache entry.

The admin surface is `POST/PUT/DELETE /api/admin/feature-flags/...` (`backend/routes/adminFeatureFlagRoutes.js`, mounted at `index.js:545`). Known flag names are enumerated in `services/featureFlags.js:KNOWN_FLAGS` with category (`platform | module | tier`), description, default — adding a flag without registering it there means the admin UI won't surface it.

Module gates wrapped on route mounts (every entry in `index.js:466-560`): `quotes_enabled`, `vendor_quotes_enabled`, `submittals_enabled`, `change_orders_enabled`, `documents_enabled`, `reports_enabled`, `quickbooks_enabled`, `automation_enabled`, `webhooks_enabled`, `ai_features_enabled`, `plugins_enabled`. Platform gates inside route handlers: `phase2_entities`, `v2_dual_write_enabled`.

If `req.orgId` is null (legacy user with no org), `requireFeature` lets the request through — those users only see their own `user_id`-scoped rows via `qs(req)` and there is nobody else to leak to.

## Boot-time + scheduler

`app.listen` (`index.js:669-753`) runs migrations on startup in production (`runMigrationsOnStartup`, lines 607-663). Idempotent — every migration is wrapped in `IF NOT EXISTS` or is keyed by the `migrations` table. The same function reads the `backend/migrations/` directory in lexical order — naming convention is `NNN_description.sql`.

After `listen`, four schedulers boot if `AUTOMATION_ENABLED=true || NODE_ENV=production`:
- `automation.startScheduler` — triggered automation rules (lines 689-695). Default interval 60 min, configurable via `AUTOMATION_INTERVAL_MINUTES`.
- `accountDeletionWorker.startScheduler` (lines 702-708) — processes scheduled deletions past their 7-day window.
- `overdueTaskWorker.startScheduler` (lines 716-723) — notifies on overdue tasks; idempotent via `tasks.last_overdue_notified_at` (migration 074).
- `weeklySummaryWorker.startScheduler` (lines 730-737) — Monday 08:00 UTC.
- `emailRetentionWorker.startScheduler` (lines 745-751) — daily delete of `email_sends > 2y` (GDPR Art. 5(1)(e)).

There is no leader election. See [`RUNBOOK.md` §10](./RUNBOOK.md#10-cron-workers-stuck) for the multi-pod implications.
