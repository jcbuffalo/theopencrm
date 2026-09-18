# Threat Model — The Open CRM

**Scope:** application-layer threat model for the multi-tenant CRM platform deployed on Cloud Run + Cloud SQL Postgres. Covers tenant isolation, the plugin runtime (`backend/services/pluginRunner.js`, `backend/services/pluginSdk.js`), authentication, and the highest-risk data flows.

**Companion docs (do not duplicate; consult for depth):**
- `SECURITY_REVIEW.md` — controls inventory, gap acknowledgement, procurement-questionnaire posture
- `ARCHITECTURE.md` — system topology, service boundaries
- `RUNBOOK.md` — incident response procedures
- `OBSERVABILITY.md` — audit/log surfaces useful for forensics
- `DATA_MODEL.md` — table-level schema and `org_id` enforcement points

**Update cadence:** re-review this doc before any change to `backend/services/pluginRunner.js`, `backend/services/pluginSdk.js`, the `crm` SDK surface, the CSRF middleware in `backend/index.js`, `authMiddleware` in `backend/auth.js`, or any new public (CSRF-exempt) route.

---

## 1. Trust Boundaries

```
+---------------------------------------------------------------------------+
|                              UNTRUSTED                                    |
|                                                                           |
|  +----------------+   +----------------+   +-------------------------+    |
|  | Public web     |   | Customer-      |   | Plugin source code      |    |
|  | (anon visitor) |   | uploaded files |   | (authored by tenant     |    |
|  |                |   | (GCS objects)  |   |  admin, hostile by      |    |
|  |                |   |                |   |  default)               |    |
|  +-------+--------+   +--------+-------+   +------------+------------+    |
|          |                     |                        |                 |
+----------|---------------------|------------------------|-----------------+
           |                     |                        |
   --------v------- TLS + CSP    | virus-scan + signed-   | source stored
   CSRF double-submit            | URL only               | in plugins.source_code,
   authMiddleware (JWT)          |                        | compiled into a fresh
   rate limits                   |                        | v8 Isolate per call
           |                     |                        |
+----------v---------------------v------------------------v-----------------+
|                          TRUSTED-TENANT                                   |
|                                                                           |
|  Authenticated org user (req.userId, req.orgId set by authMiddleware       |
|  at backend/auth.js:250-270)                                              |
|                                                                           |
|  Plugin SDK closure (pluginSdk.buildContext at pluginSdk.js:240) —        |
|  org_id is bound at sandbox-build time; plugin code never sees,           |
|  names, or passes org_id.                                                 |
|                                                                           |
|  qs(req) pattern (e.g. routes/dealRoutes.js:38) is the ONLY tenant        |
|  boundary in the data layer.                                              |
+---------------------------+---------------------------------+-------------+
                            |                                 |
                  super_admin promotion required       deploy via Cloud Build
                  (admin_users table; manual SQL)      with explicit gcloud auth
                            |                                 |
+---------------------------v---------------------------------v-------------+
|                       TRUSTED-PLATFORM                                    |
|                                                                           |
|   Platform operator (gcloud + Secret Manager + Cloud SQL psql)            |
|   super_admin user (admin_users.role = 'super_admin')                     |
|   Deploy pipeline (Cloud Build → Cloud Run)                               |
+---------------------------------------------------------------------------+
```

**What crosses each boundary:**

- **Untrusted → Trusted-tenant.** A JWT in either the `authToken` cookie or `Authorization: Bearer …` header (`backend/auth.js:240`). The token is verified with pinned `HS256` and a per-environment `JWT_SECRET`. CSRF state-changing requests must additionally echo the double-submit `csrfToken` cookie via the `X-CSRF-Token` header (`backend/index.js:204-228`).
- **Plugin source → Trusted-tenant context.** Source compiles inside an `isolated-vm` Isolate (`backend/services/pluginRunner.js:499-503`). The only path back into the host is the `crm` namespace, whose every function is closed over the caller's `orgId` (`backend/services/pluginSdk.js:240-372`).
- **Trusted-tenant → Trusted-platform.** Only via manual SQL promotion into `admin_users` — there is no in-app self-service path for super_admin.

---

## 2. Asset Inventory

| Asset | Where it lives | Why we protect it |
|---|---|---|
| Customer PII (contacts.email, contacts.phone, companies, deals.notes) | Postgres tables `contacts`, `companies`, `deals`, `activities` | GDPR Art. 15/17/20, CCPA; trust |
| Tenant data isolation | Every CRUD route relies on `qs(req)` (`backend/routes/dealRoutes.js:38` and 9 other route files) | Confidentiality across tenants |
| Audit log integrity | `audit_log` table, append-only via DB trigger (`backend/migrations/048_audit_log_immutability.sql:18-26`) | Tamper-evident incident forensics; SOC 2 CC7.2 |
| AI-API spend | `usage_meter` table; budget-aware caller in `services/ai.js` | Bill-shock from a hostile or buggy tenant |
| Password hashes | `users.password_hash`, bcrypt cost-12 | Credential confidentiality |
| JWT / CSRF / cookie secrets | `JWT_SECRET`, `JWT_REFRESH_SECRET`, `JWT_2FA_SECRET`, `CSRF_SECRET`, `COOKIE_SECRET` (Secret Manager → env) | Session integrity; boot-time env validation crashes if any are missing or default (`backend/services/envValidation.js`) |
| Plugin source code | `plugins.source_code` | Tenant IP; compromised reads could leak business logic across orgs |

---

## 3. Threat Actors

| Actor | Capability | Most likely goal |
|---|---|---|
| (a) Untrusted public | Anonymous HTTP, no session | Account takeover, credential stuffing, data exfil from any unauth surface |
| (b) Malicious authenticated tenant user | Valid JWT for some `orgId`; cannot mint cross-org tokens | Reach another tenant's data through a broken `qs(req)` or via a plugin escape |
| (c) Malicious plugin author | Ships JavaScript into our process. **Most novel actor.** | Sandbox escape, query-budget abuse, log-channel exfiltration, lateral data access within their own org |
| (d) Compromised tenant admin | Stolen credential of an admin in some org | Mass-export, settings tamper, plugin authoring under stolen identity |
| (e) Compromised operator | Holds Cloud Run / Cloud SQL credentials | Bypass the application entirely; access the raw DB |

---

## 4. STRIDE Walkthrough

Format: **Control** | **Gap** | **Reference**.

### (a) Untrusted public

- **Spoofing.** HS256-pinned JWT verification (`backend/auth.js:125,153,161`); boot-time refusal to start with the placeholder secret (`backend/services/envValidation.js`). **Gap:** JWT is also accepted from `localStorage`-echoed `Authorization` headers — `SECURITY_REVIEW.md` §1.3 lists this as MEDIUM. *Documented in `SECURITY_REVIEW.md`.*
- **Tampering.** CSRF double-submit on every non-exempt mutating route (`backend/index.js:204-228`). **Gap:** the exempt list is broad (login, register, webhooks, public forms) — exempt routes have their own anti-CSRF (signature, tempToken, or pre-session state) but the list is large enough that adding a new public route requires deliberate review.
- **Repudiation.** Audit log is append-only at the DB trigger level. **Gap:** none for app-issued events; out-of-band SQL runs by an operator are recorded only if the operator opts in.
- **Information disclosure.** Helmet defaults + strict CSP (`backend/index.js:39-53`), per-IP rate limits on auth routes (`backend/middleware/rateLimits.js`). **Gap:** error pages occasionally surface stack traces in non-prod — confirmed not in prod via `NODE_ENV` gate.
- **DoS.** Cloud Run autoscaling absorbs request bursts; per-IP and per-user rate limits cap auth-route abuse. **Gap:** no global concurrency or request-budget limit per anonymous IP across all routes.
- **Elevation of privilege.** No anonymous path to `super_admin`; admin_users requires manual SQL insert.

### (b) Malicious authenticated tenant user

- **Spoofing.** Cannot mint a JWT for a different `orgId`; `req.orgId` is loaded from the DB on every request (`backend/auth.js:267`), not trusted from the token claim.
- **Tampering.** Every CRUD route narrows by `qs(req)` (`backend/routes/dealRoutes.js:38` and 9 sibling route files). **Gap:** the discipline is app-layer only; there is no Postgres-level RLS. A future route that forgets `qs(req)` is a tenant-leak. *Mitigation: pattern is uniform and grep-auditable. Listed as a residual risk in §6.*
- **Repudiation.** Every state-changing route writes an `audit_log` row.
- **Information disclosure.** The `qs(req)` filter + FK CASCADE on `org_id` (`backend/migrations/033_add_org_id_to_users_and_data.sql:4-9`) prevent cross-org reads.
- **DoS.** Per-user rate limits; per-org plugin concurrency cap of 5 (`pluginRunner.js:80`); per-org monthly plugin-run quota (`pluginRunner.js:105-132`).
- **Elevation of privilege.** `org_role` is checked in route guards; `org_admin` cannot grant `super_admin`. **Gap:** the `org_admin → super_admin` separation is enforced in code paths but is not currently fuzz-tested.

### (c) Malicious plugin author — see §5 for the dedicated treatment.

### (d) Compromised tenant admin

- **Spoofing.** Same JWT verification as any user; rotation requires a password reset that invalidates refresh tokens (`backend/migrations/065_user_password_history.sql` + `services/hibp.js`).
- **Tampering.** Admin can modify tenant data legitimately; audit_log is the only post-hoc detection. **Gap:** no in-app anomaly alerting on bulk operations.
- **Repudiation.** Every admin action is in `audit_log` (append-only trigger).
- **Information disclosure.** Mass-export endpoints exist (`/api/me/export`) but are throttled. **Gap:** no rate limit specifically on cross-entity bulk reads.
- **DoS.** Plugin quota + concurrency caps apply to admin-triggered runs.
- **Elevation of privilege.** Admin cannot self-promote to super_admin in-app.

### (e) Compromised operator

- This actor is outside the application's trust boundary. Mitigations live in IAM, Secret Manager, and Cloud SQL Auth Proxy logging. **Gap:** application has no detection for operator-side SQL writes; we depend on Cloud Audit Logs and `RUNBOOK.md` incident response.

---

## 5. The Plugin Sandbox Specifically

This is the most novel attack surface in the codebase — the only place where untrusted code runs in-process. Treat every claim here as load-bearing.

**Engine.** Each invocation creates a fresh `ivm.Isolate` (`backend/services/pluginRunner.js:499-503`). No state survives `isolate.dispose()` (always called in `finally`, `pluginRunner.js:607-612`). The native `isolated-vm` module is loaded lazily at boot; if it fails to load, `run()` returns `status='rejected', reason='sandbox_unavailable'` rather than silently running unsandboxed code (`pluginRunner.js:51-59, 378-396`).

**What is blocked.** The prelude installs `crm` as a frozen global, then deletes every other host-injected reference and every dangerous v8 global (`pluginRunner.js:209-211`):

> `console`, `setTimeout`, `setInterval`, `setImmediate`, `clearTimeout`, `clearInterval`, `clearImmediate`, `queueMicrotask`, `fetch`, `XMLHttpRequest`, `WebSocket`, `Buffer`, `process`

`require()` and Node's `module` system are never injected to begin with (the isolate has no module loader). The plugin sees only the v8 language surface (Math, JSON, Date, Promise, Array, Object) plus `crm`.

**What is bounded.**

| Limit | Value | Where enforced |
|---|---|---|
| DB-touching SDK calls per run | 50 | `pluginSdk.js:42` (`MAX_QUERIES_PER_RUN`), checked in `chargeQuery()` at line 260 |
| `createTask` calls per run | 10 | `pluginSdk.js:50` (`MAX_TASKS_CREATED_PER_RUN`), checked in `chargeTask()` at line 271 |
| Wall-clock | 5 s | `pluginRunner.js:63` (`RUN_TIMEOUT_MS`), passed to `userScript.run` line 561 |
| Compile timeout | 1 s | `pluginRunner.js:62` (`COMPILE_TIMEOUT_MS`) |
| Heap | 128 MB | `pluginRunner.js:61` (`MEMORY_LIMIT_MB`) |
| Input payload | structured-cloneable, serialized to JSON in-line | `pluginRunner.js:556` — no explicit byte cap on input; effectively bounded by HTTP body limits |
| Output payload | 64 KB | `pluginRunner.js:64` (`MAX_OUTPUT_BYTES`); over-cap returns `{_truncated:true,preview}` |
| List query rows | 500 | `pluginSdk.js:34` (`MAX_ROWS`) |
| Log buffer | 200 lines × 2 KB each | `pluginSdk.js:367-370` |
| Concurrent runs per org | 5 | `pluginRunner.js:80` (`MAX_CONCURRENT_RUNS_PER_ORG`); 6th run gets HTTP 429 + `status='concurrent_limit_exceeded'` |
| Per-statement Postgres timeout | 2 s | `pluginSdk.js:59` (`PLUGIN_STATEMENT_TIMEOUT`), applied via `SET LOCAL statement_timeout` inside each scoped transaction |

**What is still possible.**

1. **v8 zero-day in `isolated-vm`.** A v8 escape would defeat every other control. Mitigation: keep `isolated-vm` pinned and updated; fall back to `PLUGIN_RUNTIME_DISABLED=1` kill switch (`pluginRunner.js:372-374`) if a CVE drops.
2. **In-budget DB exhaustion.** A plugin can issue 50 short queries that each return 500 rows — within budget, but cumulatively heavy. The 2-second per-statement timeout (`pluginSdk.js:59`) caps any single query; the pool itself caps total connections.
3. **Same-org log-line exfiltration.** A plugin can `crm.log()` PII into the `plugin_runs.log_lines` array (`pluginRunner.js:634`). Anyone with `org_role` permission to view that org's plugin runs can read it. This is intra-org — not a cross-tenant leak — but it is a side-channel for an author to ship "private" data into a run log a peer can read.
4. **Output-payload exfiltration to a peer.** Same shape: `output_payload` is JSON the plugin returns. It's visible to any user with run-view rights in the org.
5. **Column-allowlist drift.** If `READ_COLUMN_ALLOWLISTS` (`pluginSdk.js:108-127`) and `UPDATE_ALLOWLISTS` (`pluginSdk.js:80-85`) drift away from `routes/_bulkOps.js`, the plugin surface either grows wider (new tenant-bulk fields become readable here without the same review) or narrower (plugins reject patches that the bulk endpoint accepts). The `_bulkOps.js` comment in `pluginSdk.js:11-14` flags this contract.

---

## 6. Residual Risks Not Yet Mitigated

1. **No DB-level Row Level Security.** Tenant isolation depends on every route using `qs(req)`. A future route that forgets the helper leaks across tenants. *Mitigation: uniform pattern, code review, integration tests in `backend/test/`. RLS is not on the roadmap because it would force every route to set the session GUC and complicate connection pooling.*
2. **No distributed tracing for cross-tenant forensics.** When a tenant reports "I saw something I shouldn't have," we have `audit_log` and `request_id` correlation but no trace stitching across services. *Mitigation: `OBSERVABILITY.md` documents the structured-log fields available for join.*
3. **No leader election on cron workers.** `overdueTaskWorker.js`, `emailRetentionWorker.js`, `weeklySummaryWorker.js`, `accountDeletionWorker.js` run on whatever Cloud Run revision picks up the timer. Multi-replica execution is bounded by idempotency markers (e.g. `tasks.last_overdue_notified_at` from `backend/migrations/074_task_overdue_notified_at.sql`) rather than a lock — duplicate runs are safe but not coordinated.
4. **`__Host-` cookie prefix tradeoffs.** The CSRF secret cookie uses the `__Host-psifi.x-csrf-token` prefix (`backend/index.js:150`), which forces `Secure; Path=/; no Domain`. The user-readable `csrfToken` cookie does *not* use the prefix because the frontend must read it from JS (`backend/index.js:209-215`). An XSS that bypasses our CSP can therefore read `csrfToken`. Mitigation: strict CSP is the primary defense; cookie prefix is the secondary.
5. **`audit_log` is unpartitioned.** Append-only is enforced, but the table grows without bound. *Documented in `MIGRATIONS_PLAYBOOK.md` §"Specific footguns".*
6. **Legacy `saved_filters` table coexists with `saved_views`.** Backfill happened in migration 073 but the legacy table is not dropped. A future plugin SDK extension that exposes either must be reviewed against both.
7. **Legacy EAV `custom_fields` table superseded by per-entity JSONB `custom_fields` columns.** Two systems with the same name; the JSONB columns added in migration 070 are the supported surface. The EAV table from migration 022 still exists and is readable. *Documented in `MIGRATIONS_PLAYBOOK.md` §"Specific footguns".*

---

## 7. Threat-Model Update Cadence

Re-review **this document** before merging any change to:

- `backend/services/pluginRunner.js` — the isolate wiring or any new host-injected reference
- `backend/services/pluginSdk.js` — the `crm` namespace, any new column allowlist entry, any new SDK function
- `backend/index.js` — the CSRF middleware, the CSRF exempt list, or any new public route
- `backend/auth.js` — `authMiddleware`, JWT verification, cookie issuance
- Any new route that is added to the CSRF exempt list
- Any change to the `qs(req)` pattern or any new entity table that does not include `org_id`

The reviewer adds a row to the bottom of this doc with a date, the changed file:line range, and a one-sentence summary of why the change is safe.

---

## 8. Change Log

| Date | Reviewer | Changed surface | Why it's safe |
|---|---|---|---|
| 2026-05-14 | initial author | n/a — document creation | n/a |
