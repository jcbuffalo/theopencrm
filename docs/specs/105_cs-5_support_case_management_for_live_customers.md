# CS-5 — Support / Case Management for Live Customers

**Status:** Spec only — not yet implemented.
**Priority:** P2 (per `NEXT_STEPS.md` → "Customer Relationship Management (post-sale / customer success)" → CS-5).
**Effort:** ~3–4 days.
**Gating flag:** `customer_success_enabled` (module category, default `false`). The
entire `/api/cases` surface and the `/cases` page are gated; the optional
SLA-breach automation rule self-skips for orgs without the flag.
**Author:** scoping pass, 2026-06-23.

---

## 0. Problem statement (from NEXT_STEPS.md)

> "Issues" (`routes/issueRoutes.js`) are *deal-delivery* issues (Zang
> red/yellow/green, blocking flag) tied to deals — not customer support cases with
> status/SLA/resolution over the life of an account.
>
> **Acceptance:** Log a support case against an account, track it open→resolved
> with an owner and due date, see it on the CS-1 account timeline.

We want a first-class **support case** object that lives at the **account
(`company_id`) level** — not the deal-delivery `issues` table — so a live customer
can have support tickets that span the whole relationship: a status lifecycle
(`open → in_progress → waiting_on_customer → resolved → closed`), a priority, an
owner, a due date / SLA target, resolution capture, and visibility on the CS-1
account-360 timeline.

**Why a new `cases` table rather than reusing `issues`:** `issues`
(migration `040`) is a Zang *deal-delivery* concept — `related_type` / `related_id`
point at a deal/quote/submittal, `urgency` is the Zang red/yellow/green band, and
`blocks_workflow` gates the delivery pipeline. Bolting "customer support ticket"
semantics onto that row would overload `urgency`/`status` and force every
`issueRoutes.js` consumer to learn about account-level cases. A clean `cases`
table keeps both concepts crisp and lets the CS-1 timeline union them as distinct
`type` entries.

**Deliberate scope limits (so another engineer doesn't over-build):**
- **No customer-facing portal / email-to-case ingestion.** Cases are logged
  internally by staff. (Inbound channels are CS-10 / CS-7 territory.)
- **SLA is a single `due_at` target + an optional automation breach alert**, not a
  full multi-tier SLA policy engine with business-hours calendars. The
  breach-detection rule is *optional* and mirrors the existing
  `dormant_customer_outreach` automation pattern.
- **Cases link to a `company_id` (the account), with optional `deal_id` and
  `contact_id` for context** — but the canonical pivot is the account, matching
  CS-1's account-360 model.
- **No threaded comments table in this pass.** A free-text `resolution_notes` plus
  the standard `description` cover the demo path; a `case_comments` child table is
  noted as a future extension, not built here.

---

## 1. Files to touch

### Backend — new files
| Path | Purpose |
|---|---|
| `backend/migrations/095_cases.sql` | `CREATE TABLE IF NOT EXISTS cases (...)` — new table, account-scoped support cases. (Next free prefix: `094` is the latest committed migration, so **095** is correct. If CS-1/CS-2/CS-3 land first they take 095/096/...; CS-5 takes the next free number at implementation time.) |
| `backend/routes/caseRoutes.js` | Full CRUD for `/api/cases`, org-scoped via `qs(req)`. Modeled on `backend/routes/issueRoutes.js` (the closest analogue) + `serviceContractRoutes.js` (account-level JOIN shape). |
| `backend/schemas/cases.js` | Zod `createSchema` / `updateSchema`, modeled on `backend/schemas/issues.js` (same `optStr` / `optInt` helpers, `.passthrough()`). |
| `backend/test/cases.test.js` | HTTP integration tests (supertest against a mounted `caseRoutes`); ≥1 happy path per endpoint + org-scope + gating tests. |

### Backend — edited files
| Path | Change |
|---|---|
| `backend/services/featureFlags.js` | Add `customer_success_enabled` to `KNOWN_FLAGS` (category `module`, `defaultValue: false`). **Shared with CS-1/CS-2/CS-3/CS-4 — add once if not already present.** |
| `backend/index.js` | (a) `const caseRoutes = require('./routes/caseRoutes');` in the route-import block (~line 403, after `metricsRoutes`). (b) Mount `app.use('/api/cases', requireFeature('customer_success_enabled'), caseRoutes);` near the other CS / service-contract mounts (~line 523, after `/api/service-contracts`) with a `console.log('✅ Mounted: /api/cases (CS-5, gated by customer_success_enabled)');`. |
| `backend/services/automation.js` | **Optional** — add a `case_sla_breach_alert` rule to the `RULES[]` array (modeled on `dormant_customer_outreach` / `service_contract_renewal_due`): when an open case is past `due_at` and no breach has been recorded, create a high-priority task for the case owner and `recordRun(...)` to dedupe. Uses the existing `alreadyFired` / `recordRun` / `createTaskForOrg` helpers. |
| **CS-1 `backend/routes/accountRoutes.js`** | When CS-1 ships, its `GET /api/accounts/:companyId/360` timeline UNION must add a `{ type: 'case', ... }` branch reading `cases WHERE company_id = $1 AND ${sf} = $`. CS-5 does **not** edit CS-1's file (CS-1 may not exist yet); this is a forward-compat note so the CS-1 author includes cases, and CS-5's acceptance test stubs the union row shape. |

### Frontend — new files
| Path | Purpose |
|---|---|
| `frontend/src/pages/Cases.js` | New page at route `/cases` — a filterable table of cases (status / priority / owner filters) with a create/edit drawer or modal. Modeled on the existing list-page + `DataTable` pattern (see `frontend/src/pages/Companies.js`). Passes `active="cases"` to `<Nav>`. |

### Frontend — edited files
| Path | Change |
|---|---|
| `frontend/src/App.js` | Register the route inside the authenticated block: `const Cases = lazyWithRetry(() => import('./pages/Cases'));` then `<Route path="/cases" element={<Cases />} />`. |
| `frontend/src/components/Nav.js` | Add a `{ to: '/cases', label: 'Cases', key: 'cases' }` link to `NAV_LINKS_ZANG` (and `NAV_LINKS_RIN` when it exists), rendered only when `showAccountManagement` is true. Wire into both desktop (~line 195) and mobile (~line 244) link maps. |
| `frontend/src/stages.js` | Ensure `getStageConfig` returns `showAccountManagement: profile === 'zang' || profile === 'rin'`. **Shared with CS-1/CS-2/CS-4 — add once.** The `/cases` nav link renders only when this is true. |
| `frontend/src/api.js` | Add a `cases` namespace: `list(params)`, `get(id)`, `create(body)`, `update(id, body)`, `remove(id)` wrapping `api.get/post/put/delete('/cases...')`. Follows the `drive` / `gmail` namespace pattern (api.js ~lines 177–310). CSRF header is auto-attached by the existing axios interceptor — no per-call handling. |
| `frontend/src/pages/AccountDetail.js` (CS-1) | Forward-compat: render `type === 'case'` timeline entries with a case badge + link to `/cases?focus=:id`. Note only — built when CS-1 ships. |

**Not touched:** `routes/issueRoutes.js` and `migrations/040_*` stay exactly as
they are — `cases` is a sibling, not a replacement. `_bulkOps.js` is **not** wired
for cases in this pass (no bulk case edit in the MVP).

---

## 2. New env vars + graceful degradation

| Var | Default | Purpose | Degradation |
|---|---|---|---|
| `CASE_SLA_WORKER_MAX_PER_RUN` | `200` | Cap on case rows the *optional* `case_sla_breach_alert` automation rule scans per tick (bounds runtime on large tenants, matches the `LIMIT 200` used by `dormant_customer_outreach`). | Absent → 200. |

**Graceful degradation rules:**
- **No new required env vars.** Nothing here blocks boot
  (`services/envValidation.js` is untouched).
- The SLA-breach rule lives inside `services/automation.js`, which only runs when
  the automation scheduler is started (`automationEnabled` = `NODE_ENV ===
  'production'` or `AUTOMATION_ENABLED === 'true'`). In local dev it stays dormant
  unless opted in — identical to every other automation rule.
- The SLA rule self-skips orgs without `customer_success_enabled`: it either joins
  the flag source in SQL or filters via `featureFlags.hasFeature(orgId, ...)` per
  candidate org (same per-org-flag pattern the other rules use). If the flag is
  off, the rule contributes 0 fired for that org.
- If `customer_success_enabled` is **off**, every `/api/cases` request returns
  **403** at the mount via `requireFeature`, and the `/cases` nav link is hidden
  (`showAccountManagement` false). No partial/silent behavior.
- The case object has **no external integration dependency** (no email, no Stripe,
  no GCS) — it degrades to a pure CRUD surface that works with only the DB.

---

## 3. Migration

**File:** `backend/migrations/095_cases.sql`

`cases` is a **new** table (not a duplicate-table-migration target like
contacts/deals/activities), so a guarded `CREATE TABLE IF NOT EXISTS` is correct
and safe. FKs use `ON DELETE SET NULL` for `deal_id` / `contact_id` /
`assigned_to_user_id` (a case survives the deletion of a linked deal/contact/owner)
and `ON DELETE CASCADE` is **not** used on `company_id` — instead `SET NULL` so a
historical case isn't silently destroyed if the company row is removed (matches
`service_contracts.customer_id` semantics). `org_id` uses `ON DELETE SET NULL` and
`user_id` (creator) uses `ON DELETE CASCADE`, mirroring `issues`.

```sql
-- 095 — CS-5: account-level support / case management.
--
-- A `case` is a customer-support ticket that lives at the ACCOUNT level
-- (company_id), distinct from `issues` (migration 040), which are Zang
-- deal-DELIVERY problems tied to a deal/quote/submittal. Cases track a support
-- lifecycle over the life of a customer relationship: open → in_progress →
-- waiting_on_customer → resolved → closed, with a priority, an owner, an
-- optional SLA target (due_at), and resolution capture.
--
-- New table — CREATE TABLE IF NOT EXISTS is safe (NOT a duplicate-table-migration
-- target). Every tenant query org-scopes via qs(req); company_id is the canonical
-- pivot for the CS-1 account-360 timeline.

BEGIN;

CREATE TABLE IF NOT EXISTS cases (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,        -- creator
  org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,         -- the account (canonical pivot)
  deal_id INTEGER REFERENCES deals(id) ON DELETE SET NULL,                -- optional deal context
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,          -- optional reporter/contact
  subject VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(50),                                                    -- e.g. 'billing','technical','onboarding','other'
  priority VARCHAR(20) DEFAULT 'normal',                                   -- 'low' | 'normal' | 'high' | 'urgent'
  status VARCHAR(30) DEFAULT 'open',                                       -- 'open' | 'in_progress' | 'waiting_on_customer' | 'resolved' | 'closed'
  assigned_to_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,     -- case owner
  due_at TIMESTAMP,                                                        -- SLA target (optional)
  sla_breached_at TIMESTAMP,                                               -- stamped by the optional automation rule
  resolution_notes TEXT,
  resolved_at TIMESTAMP,
  closed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexed on every column the list endpoint filters / sorts by.
CREATE INDEX IF NOT EXISTS idx_cases_org_id        ON cases(org_id);
CREATE INDEX IF NOT EXISTS idx_cases_company_id    ON cases(company_id);     -- CS-1 account-360 join
CREATE INDEX IF NOT EXISTS idx_cases_deal_id       ON cases(deal_id);
CREATE INDEX IF NOT EXISTS idx_cases_status        ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_priority      ON cases(priority);
CREATE INDEX IF NOT EXISTS idx_cases_assigned_to   ON cases(assigned_to_user_id);
CREATE INDEX IF NOT EXISTS idx_cases_due_at        ON cases(due_at);

COMMIT;
```

**Sequencing note:** 095 has no ordering dependency on the CS-1/CS-2/CS-3
migrations — it only creates a new table and references `companies` / `deals` /
`contacts` / `users` / `organizations`, all of which already exist. It can land in
any order relative to the other CS migrations; it simply takes the next free
3-digit prefix at implementation time.

**Status / priority / category values** are stored as open `VARCHAR` (not a PG
enum) to match the codebase convention (`issues.status`, `issues.urgency` are
free-text; see the comment block in `schemas/issues.js`). The UI offers fixed
dropdowns; the schema does not 400 on an unknown value at the API edge.

---

## 4. API endpoints

New router `backend/routes/caseRoutes.js`. First line after router creation:
`router.use(authMiddleware);`. Org-scope helper at top:
`function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }`.
The whole router is mounted behind `requireFeature('customer_success_enabled')` in
`index.js`, so **every** endpoint below returns **403** for orgs without the flag.
Bodies validated by `backend/schemas/cases.js` via the shared
`validateBody(schema)` middleware (`backend/middleware/validate`).

### 4.1 `GET /api/cases`
- **Auth:** authMiddleware + `requireFeature('customer_success_enabled')`.
- **Query params (all optional):** `status`, `priority`, `category`,
  `company_id`, `deal_id`, `assigned_to_user_id`, `overdue` (`'true'` → only cases
  with `due_at < NOW()` and status not in `resolved`/`closed`).
- **Scope:** `WHERE c.${sf} = $1` plus any provided filters (parameterized,
  `params.length + 1` indexing — identical to `issueRoutes.js` GET).
- **Sort:** `ORDER BY CASE c.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN
  'normal' THEN 3 ELSE 4 END, c.due_at NULLS LAST, c.created_at DESC` (urgent +
  soonest-due first).
- **Response 200:** array of case rows, each LEFT JOINed to `users` (owner
  email/name) and `companies` (account name):
  ```jsonc
  [
    {
      "id": 17, "company_id": 7, "company_name": "Acme Corp",
      "deal_id": null, "contact_id": 42,
      "subject": "Login broken after SSO migration",
      "category": "technical", "priority": "high",
      "status": "in_progress",
      "assigned_to_user_id": 3, "assigned_to_email": "csm@org.com", "assigned_to_name": "Dana CSM",
      "due_at": "2026-06-30T17:00:00Z", "sla_breached_at": null,
      "resolution_notes": null, "resolved_at": null, "closed_at": null,
      "created_at": "2026-06-23T14:00:00Z", "updated_at": "2026-06-23T14:05:00Z"
    }
  ]
  ```

### 4.2 `GET /api/cases/:id`
- **Auth/gate:** as above.
- **Scope:** `WHERE id = $1 AND ${sf} = $2`.
- **Response 200:** single case row (same shape as a list element).
- **404:** `{ "error": "Case not found" }` when not in the caller's org scope.

### 4.3 `POST /api/cases`
- **Auth/gate:** as above. Body validated by `cases.createSchema`.
- **Request:**
  ```jsonc
  {
    "company_id": 7,                 // required (account pivot)
    "subject": "Login broken after SSO migration",   // required
    "description": "Customer reports 500 on /sso/handoff since Tuesday.",
    "deal_id": null,
    "contact_id": 42,
    "category": "technical",
    "priority": "high",              // default 'normal'
    "status": "open",                // default 'open'
    "assigned_to_user_id": 3,
    "due_at": "2026-06-30T17:00:00Z"
  }
  ```
- **Server behavior:** `INSERT INTO cases (user_id, org_id, company_id, deal_id,
  contact_id, subject, description, category, priority, status,
  assigned_to_user_id, due_at) VALUES (...) RETURNING *`. `user_id` = `req.userId`,
  `org_id` = `req.orgId || null`. Defaults applied in SQL/JS for `priority` /
  `status` exactly as `issueRoutes.js` does (`priority || 'normal'`,
  `status || 'open'`).
- **Response 201:** the created row.
- **Validation:** `subject` required (≥1 char, ≤255); `company_id` required
  (positive int). 400 with the zod error shape (`{ success:false, error, fields[] }`)
  on failure.

### 4.4 `PUT /api/cases/:id`
- **Auth/gate:** as above. Body validated by `cases.updateSchema`.
- **Request:** any subset of the editable fields (`subject`, `description`,
  `category`, `priority`, `status`, `assigned_to_user_id`, `due_at`,
  `resolution_notes`, `company_id`, `deal_id`, `contact_id`). COALESCE semantics —
  omitted fields are left unchanged (matching `issueRoutes.js` PUT).
- **Status-transition side effects (in the handler, mirroring `issueRoutes.js`'s
  `resolved_at` stamping):**
  - When `status` transitions to `resolved` → set `resolved_at = CURRENT_TIMESTAMP`
    (only if not already set).
  - When `status` transitions to `closed` → set `closed_at = CURRENT_TIMESTAMP`.
  - Reopening (status back to `open`/`in_progress`) clears `resolved_at` /
    `closed_at` to NULL.
  - Always `updated_at = CURRENT_TIMESTAMP`.
- **Scope:** `WHERE id = $ AND ${sf} = $ RETURNING *`.
- **Response 200:** updated row. **404** when not in scope.

### 4.5 `DELETE /api/cases/:id`
- **Auth/gate:** as above.
- **Scope:** `DELETE FROM cases WHERE id = $1 AND ${sf} = $2 RETURNING *`.
- **Response 200:** `{ "message": "Case deleted" }`. **404** when not in scope.

### 4.6 (Optional) automation rule — not an HTTP endpoint
- `case_sla_breach_alert` in `services/automation.js` `RULES[]`:
  - Scan `SELECT id, org_id, user_id, company_id, assigned_to_user_id, subject,
    due_at FROM cases WHERE status NOT IN ('resolved','closed') AND due_at IS NOT
    NULL AND due_at < NOW() AND sla_breached_at IS NULL LIMIT $CASE_SLA_WORKER_MAX_PER_RUN`.
  - Per row: skip orgs without `customer_success_enabled`; skip if
    `alreadyFired('case_sla_breach_alert', 'case', id, 30)`; else
    `createTaskForOrg(org_id, assigned_to_user_id || user_id, { title: 'SLA breach:
    <subject>', due_date: today, priority: 'high' })`, `UPDATE cases SET
    sla_breached_at = NOW() WHERE id = $`, and `recordRun('case_sla_breach_alert',
    { orgId, targetType:'case', targetId:id })`.
  - Returns `{ fired, scanned }` like every other rule.

---

## 5. UI surface

**New page:** `frontend/src/pages/Cases.js` at route `/cases`. Visible only for
CS-enabled profiles (`showAccountManagement` true → `zang` / `rin`). No change to
`generic` / `jcp` navigation.

1. **List view** — a `DataTable` (the existing component used by `Companies.js`)
   with columns: `Subject`, `Account` (company_name, links to `/accounts/:id` once
   CS-1 ships), `Priority` (colored badge: urgent=red, high=amber, normal=slate,
   low=gray), `Status` (badge), `Owner` (assigned_to_name), `Due`
   (`due_at`, with a red "Overdue" pill when past due and unresolved). Default
   sort matches the API (urgent + soonest-due first).
2. **Filter bar** — dropdowns for Status, Priority, Owner, and an "Overdue only"
   toggle; these map to the `GET /api/cases` query params. Reuse the filter
   styling already on `Companies.js` / `Deals.js`.
3. **Create / edit drawer or modal** — fields: Subject (required), Account
   picker (required — autocomplete over `/api/companies`), Contact picker
   (optional, filtered to the chosen account), Deal picker (optional), Category,
   Priority, Status, Owner (user picker over org members), Due date/time,
   Description, and Resolution notes (shown when status is `resolved`/`closed`).
   Submits through the new `api.cases.create` / `api.cases.update`.
4. **Nav link** — `Cases` entry in `NAV_LINKS_ZANG` (and `NAV_LINKS_RIN`),
   rendered only when `showAccountManagement` is true; `Cases.js` passes
   `active="cases"` to `<Nav>` so the link highlights.
5. **CS-1 timeline (forward-compat):** when CS-1's `AccountDetail.js` exists, a
   `type:'case'` entry renders with a case-badge and a link to
   `/cases?focus=:id`. `Cases.js` reads a `?focus=:id` query param to open that
   case's drawer on load.

**Profiles:** page + nav + create drawer appear for `zang` / `rin` only. For
`generic` / `jcp`, `showAccountManagement` is false → no nav link; a direct
navigation to `/cases` renders, but every `/api/cases` call returns 403, so the
page shows an "Account management isn't enabled for this workspace" empty state
(reuse the existing feature-gated empty-state component pattern).

---

## 6. Tests (>= 1 happy path per endpoint)

Test runner: `vitest run` (from `backend/`). Follow the established pattern — patch
the live `require('../db')` pool with `vi.fn()` mocks (see `backend/test/me.test.js`),
mount `caseRoutes` on a tiny Express app with `cookie-parser` + a generated auth
cookie (`generateToken`, `AUTH_COOKIE_NAME` from `../auth`). Because the router is
gated by `requireFeature` only at the `index.js` mount (not inside the router),
the unit tests mount `caseRoutes` **directly** (exercising handler logic) and add a
**separate** gating test that mounts it behind a stubbed `requireFeature` to assert
the 403. Stub `audit.record` / `audit.fromReq` to no-ops if the route emits audit
rows (as `bulk-ops.test.js` and `me.test.js` do).

**File:** `backend/test/cases.test.js`

- **POST happy path:** mock authMiddleware org lookup + the INSERT
  `RETURNING *`; `POST /cases` with `{ company_id, subject, priority:'high' }` →
  **201**, body has the new `id`, `status:'open'` default, `priority:'high'`.
  Assert the INSERT params carried `user_id`, `org_id`, `company_id`, `subject`.
- **POST validation:** `POST /cases` without `subject` → **400**, body
  `success:false`, `fields[]` non-empty; assert no INSERT was issued.
- **GET list happy path:** mock the SELECT returning two rows; `GET /cases?status=open`
  → **200**, array length 2; assert the SQL carried `AND c.org_id = $` (or
  `user_id`) and the `status = $` filter.
- **GET list overdue filter:** `GET /cases?overdue=true` → assert the SQL added
  `due_at < NOW()` and a status exclusion clause.
- **GET :id happy path:** mock SELECT returning one row → **200**, correct `id`.
- **GET :id org-scope guard:** mock SELECT returning 0 rows (foreign id) → **404**;
  assert the SQL carried `AND org_id = $` / `AND user_id = $`.
- **PUT happy path + resolve stamp:** mock SELECT (prior row `status:'open'`) +
  UPDATE `RETURNING *`; `PUT /cases/:id` with `{ status:'resolved', resolution_notes:'fixed' }`
  → **200**, body `status:'resolved'`; assert the UPDATE set `resolved_at =
  CURRENT_TIMESTAMP`.
- **PUT close stamp:** `PUT { status:'closed' }` → assert `closed_at` set.
- **PUT reopen clears stamps:** prior `status:'resolved'`; `PUT { status:'open' }`
  → assert `resolved_at`/`closed_at` set to NULL.
- **PUT org-scope guard:** UPDATE affects 0 rows (foreign id) → **404**.
- **DELETE happy path:** DELETE `RETURNING *` one row → **200**,
  `{ message:'Case deleted' }`; assert `WHERE id = $ AND <scope> = $`.
- **DELETE org-scope guard:** 0 rows → **404**.
- **Gating:** mount `caseRoutes` behind a `requireFeature('customer_success_enabled')`
  whose flag source is stubbed to `false` → any request returns **403**; stubbed to
  `true` → passes through to the handler.
- **(Optional) automation rule:** if `case_sla_breach_alert` is implemented, a
  `services/automation.test.js`-style test: mock pool returning one overdue,
  un-breached, flag-enabled case → assert one task INSERT, one `cases SET
  sla_breached_at` UPDATE, one `automation_runs` INSERT; second run (now
  `sla_breached_at` set / `alreadyFired` true) → no re-fire.

---

## 7. Acceptance criteria (observable / demo-able)

1. **Log a case against an account:** On a CS-enabled org (`zang`/`rin`), a user
   opens `/cases`, clicks "New case", picks **Acme Corp** as the account, enters a
   subject + priority, and saves. The case appears in the list with the account
   name, priority badge, and `Open` status.
2. **Lifecycle open → resolved:** Editing the case to `In progress`, then
   `Resolved` (with resolution notes) updates the status badge; `resolved_at` is
   stamped (visible as a "Resolved on …" line). Marking it `Closed` stamps
   `closed_at`. Reopening clears both.
3. **Owner + due date:** A case can be assigned to an org member (owner column
   shows their name) and given a due date; cases past due and unresolved show a red
   "Overdue" pill and float to the top of the list.
4. **Filtering:** Status / Priority / Owner filters and the "Overdue only" toggle
   change the list to match (backed by the `GET /api/cases` query params).
5. **Account-360 visibility (with CS-1):** Once CS-1 is in place, opening the
   account that owns the case shows the case as a `case` entry on the unified
   account-360 timeline, time-ordered with activities/tasks/deals/emails.
6. **Gating:** On a `generic`/`jcp` org the `Cases` nav link is absent and every
   `/api/cases` request returns **403**.
7. **Org isolation:** A user in org A cannot read, update, or delete org B's cases
   — `GET/PUT/DELETE /api/cases/:id` for a foreign id returns **404**; every query
   is org-scoped via `qs(req)`.
8. **SLA breach alert (optional rule):** With automation enabled and the rule
   implemented, an open case whose `due_at` passes generates exactly one
   high-priority "SLA breach" task for the case owner, stamps `sla_breached_at`,
   and does not re-fire on subsequent automation ticks.
9. **No boot regression:** Backend boots with no new required env vars; migration
   095 is idempotent (re-run is a no-op — `CREATE TABLE IF NOT EXISTS` +
   `CREATE INDEX IF NOT EXISTS`); the `/api/cases` mount and (optional) automation
   rule add no startup-blocking behavior.
