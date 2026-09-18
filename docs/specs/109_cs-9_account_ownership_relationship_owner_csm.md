# CS-9 — Account Ownership (Relationship Owner / CSM)

**Status:** 🟡 Partial (column scaffolding pattern exists; feature not built) · **Priority:** P3 · **Effort:** ~0.5–1 day
**Roadmap source:** `NEXT_STEPS.md` → "Customer Relationship Management (post-sale / customer success)" → **CS-9**
**Gating flag:** `customer_success_enabled` (module, default `false`) — the same flag CS-1…CS-8 introduce.
**Spec author note:** This spec is self-contained. It assumes `customer_success_enabled` may already be added to `services/featureFlags.js` by an earlier-shipped CS item (CS-1/CS-2/CS-3 …); if not, this spec adds it (idempotent — exactly one entry total, see §1). CS-9 has **no hard dependency** on any other CS item shipping first. The only soft touch-points are: (a) it routes at-risk/renewal automation to the new owner, reusing rules that already exist in `services/automation.js` (`dormant_customer_outreach`, `service_contract_renewal_due`); and (b) if CS-1's `AccountDetail.js` page exists, the owner picker is surfaced there too. Both degrade cleanly when those pieces are absent.

---

## Problem statement

The roadmap entry (`NEXT_STEPS.md` line 424):

> **CS-9. Account ownership (relationship owner / CSM)** — Deals carry a salesman; accounts don't clearly carry a *post-sale* relationship owner. Effort ~0.5–1 day. Files: `ALTER TABLE companies ADD COLUMN IF NOT EXISTS relationship_owner_id INTEGER`; owner picker on `Companies.js` / CS-1; route at-risk/renewal tasks to the owner in `services/automation.js`.

Today attribution lives in three different places, none of which is a clear **post-sale relationship owner**:

- `deals.salesman_id` (migration `036_company_type_and_deal_extras.sql`) — the **sales rep** who worked the *deal*. Per-deal, pre-sale-centric.
- `companies.owner_id` (migration `068_saved_views_and_owners.sql`) — a generic **record owner** written by the bulk-assign action ("Change owner"). Semantically the person who *holds the record*, not necessarily the person responsible for the ongoing relationship.
- Automation rules that create renewal / dormant-outreach tasks (`services/automation.js`) currently fall back to `deals.salesman_id` or the org owner (`c.last_salesman_id || c.user_id`). So after a sale, follow-up work routes to the *original salesman*, not to whoever owns the *relationship* now.

CS-9 introduces a first-class, distinct **`relationship_owner_id`** on `companies` — the post-sale CSM / account owner — exposes a picker to set it, surfaces it on the company list + account 360 header, and re-routes the existing renewal/dormant automation to the relationship owner when one is set (falling back to the current behaviour when it isn't). It is **deliberately separate** from `companies.owner_id` (record owner) and `deals.salesman_id` (sales rep) — see the gotcha in the survey: *"TASKS.ASSIGNED_TO vs DEALS.SALESMAN_ID: different columns"* — the same care applies here.

---

## 1. Files to touch

### Backend — new
| File | Role |
|---|---|
| `backend/migrations/095_account_ownership.sql` | `ALTER TABLE companies ADD COLUMN IF NOT EXISTS relationship_owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL` + index. **Next free prefix:** `094_deal_gmail_summaries.sql` is the latest committed migration. Sibling CS specs (CS-3/CS-5/CS-7 reserve `095`, CS-8 reserves `097`) all pick "the next free 3-digit prefix at implementation time." CS-9 takes the **next free number** when it actually lands — written here as `095`; if `095`/`096`/`097` are already taken by sibling CS migrations at merge time, bump to the next free 3-digit prefix and update the `console.log` / filename accordingly. Numbers must never be reused. |
| `backend/test/accountOwnership.test.js` | Endpoint happy-path + scoping + validation tests (see §6). |

### Backend — modified
| File | Change |
|---|---|
| `backend/routes/companyRoutes.js` | (a) Add `relationship_owner_id` to the `SELECT` for `GET /` and `GET /:id` (already rides along via `SELECT *`, but the list endpoint should also `LEFT JOIN users` to return `relationship_owner_name` / `relationship_owner_email` for display — see §4.1). (b) Add `relationship_owner_id` handling to `POST /` and `PUT /:id` (COALESCE-style partial update). (c) Add a new `PATCH /:id/owner` convenience route to set/clear just the relationship owner (see §4.3). (d) Add `relationship_owner_id` to the bulk-PATCH `allowlist` array so the existing "Change owner" bulk bar can also bulk-assign relationship owners (see §4.4). |
| `backend/schemas/companies.js` | Add `relationship_owner_id` (`optInt`-style: int-or-null, optional) to both `createSchema` and `updateSchema`. The schemas already `.passthrough()`, so the column would not 400 if omitted — but add it explicitly so the value is *validated as an int-or-null* rather than passed through unchecked. Add a new `ownerPatchSchema` for `PATCH /:id/owner`. |
| `backend/services/automation.js` | Re-route the two post-sale rules to the relationship owner when set: in `dormant_customer_outreach`, prefer `c.relationship_owner_id` over `last_salesman_id`/`user_id` as the task owner; in `service_contract_renewal_due`, look up the contract's customer's `relationship_owner_id` and prefer it over `sc.user_id` as the task owner. Fallback chain stays intact so behaviour is unchanged when no relationship owner is set. (See §4.5.) |
| `backend/services/featureFlags.js` | Add the `customer_success_enabled` flag to `KNOWN_FLAGS` **only if no earlier CS item already added it** (exactly one entry total). See §1 snippet. |

> **No `index.js` mount change is required.** `/api/companies` is already mounted and is **not** flag-gated (it is core CRM used by `generic`/`jcp`/`zang` alike). CS-9 does **not** wrap the company routes in `requireFeature` — that would break vanilla CRM. Instead, the **one new route that is CS-specific** (`PATCH /:id/owner`) applies `requireFeature('customer_success_enabled')` as route-level middleware (see §4.3). The plain `relationship_owner_id` field on `POST`/`PUT`/bulk is harmless for non-CS orgs (just an extra nullable column they never populate), so it stays un-gated to keep the routes uniform.

### Frontend — modified
| File | Change |
|---|---|
| `frontend/src/api.js` | Add `org.members()` helper if one does not already exist (wraps `GET /api/org` → `.members`), and a `companies.setRelationshipOwner(id, userId)` helper wrapping `PATCH /api/companies/:id/owner` (see §5). |
| `frontend/src/pages/Companies.js` | Add a **"Relationship Owner"** column to `baseColumns` (rendered only when `getStageConfig(profile).showAccountManagement` is true), showing the owner's name (or "—" / "Unassigned"). Add an inline owner picker (dropdown of org members) on the company form / row action. |
| `frontend/src/components/CompanyForm.js` *(or the inline form rendered by `Companies.js` — confirm the actual form component name at implementation)* | Add a "Relationship Owner" `<select>` populated from org members, bound to `relationship_owner_id`. |
| `frontend/src/stages.js` | Ensure `getStageConfig` returns `showAccountManagement` (true for `zang` / future `rin`; false for `generic` / `jcp`). If an earlier CS item already added this toggle, reuse it — do not duplicate. |
| `frontend/src/pages/AccountDetail.js` *(only if CS-1 has shipped this page)* | Show the relationship owner in the account header card with an inline picker. If CS-1 has not shipped, **skip this file** — CS-9 still ships standalone on `Companies.js`. |

---

## 2. New env vars + graceful degradation

**No new env vars.** CS-9 is pure CRM data on Postgres.

- **`customer_success_enabled` feature flag** (per-org, in `organizations.features` JSONB, default `false`): when off, the new `PATCH /api/companies/:id/owner` route returns **403** via `requireFeature`, and the frontend hides the "Relationship Owner" column / picker (gated by `showAccountManagement`). The column existing in the DB is inert for non-CS orgs.
- **Automation degradation:** the re-routing in `dormant_customer_outreach` / `service_contract_renewal_due` only changes *which user the task is assigned to*. When `relationship_owner_id` is `NULL` (the default for every existing row), the existing fallback chain (`last_salesman_id || user_id`, or `sc.user_id`) is used — so behaviour is **identical** to today for any account without a relationship owner. The automation worker itself runs only when `automation_enabled` is on and the scheduler is running (`AUTOMATION_ENABLED=true` locally / auto-on in production); when off, nothing breaks — owners are still settable manually.
- **Owner picker data source:** the picker reads org members from `GET /api/org`. For a user **without** an org (`req.orgId` is null, the `qs(req)` falls back to `user_id`), `GET /api/org` returns 404 and the picker degrades to showing only the current user / hiding itself. This matches how the existing bulk "Change owner" action behaves for org-less users.

---

## 3. Migration — `backend/migrations/095_account_ownership.sql`

`companies` is one of the **duplicate-table-migration** roots is **not** an issue here in the bare-`CREATE TABLE` sense — but per project convention every column add on `companies` uses `ADD COLUMN IF NOT EXISTS` regardless (and the startup runner treats "already exists" as benign). Do **not** issue a bare `CREATE TABLE`/`ALTER … ADD COLUMN` without the guard.

```sql
-- CS-9 (migration 095): post-sale relationship owner (CSM) on companies.
--
-- DISTINCT from two existing attribution columns — do NOT conflate:
--   * companies.owner_id  (migration 068) — generic RECORD owner, written by the
--                          bulk "Change owner" action.
--   * deals.salesman_id   (migration 036) — the SALES REP on a specific deal.
--   * companies.relationship_owner_id (THIS migration) — the post-sale CSM /
--                          account relationship owner. Drives renewal/dormant
--                          task routing once set.
--
-- Nullable, FK to users with ON DELETE SET NULL so removing a user doesn't
-- cascade-delete the company (matches owner_id / salesman_id semantics).
--
-- IDEMPOTENT: re-running is a no-op.

BEGIN;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS relationship_owner_id INTEGER
    REFERENCES users(id) ON DELETE SET NULL;

-- Indexed for the "accounts I own" filter and the automation lookup that joins
-- a contract's customer to its relationship owner.
CREATE INDEX IF NOT EXISTS idx_companies_relationship_owner_id
  ON companies(relationship_owner_id);

COMMIT;
```

**No backfill.** Existing rows keep `relationship_owner_id = NULL`; the automation fallback chain (§4.5) preserves today's behaviour for them. (Operators may *optionally* seed `relationship_owner_id = owner_id` for existing accounts via a one-off `UPDATE`, but that is a business decision, not part of this migration — record owner ≠ relationship owner.)

### `featureFlags.js` snippet (add only if no earlier CS item has)

```js
{
  name: 'customer_success_enabled',
  category: 'module',
  description: 'Post-sale / customer-success surface: account 360 (CS-1), account health (CS-2), renewals (CS-3), and account ownership / relationship owner (CS-9). Default off — keeps generic/jcp lean; zang/rin enable it.',
  defaultValue: false,
},
```

---

## 4. API endpoints

All routes live in `backend/routes/companyRoutes.js`, which already does `router.use(authMiddleware)` and `function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }`. Only the **new** `PATCH /:id/owner` route additionally applies `requireFeature('customer_success_enabled')` (import `requireFeature` from `../middleware/featureGate`).

> **Org-scoping is mandatory on every query.** Each handler reads `const [sf, sv] = qs(req);` and every `WHERE` includes `${sf} = $n`. When `relationship_owner_id` is set, the handler **must verify the target user is in the same org** before writing (see §4.3) so a caller can't assign an account to a user in another org.

### 4.1 `GET /api/companies` (extend existing list)

- **Auth:** `authMiddleware` (existing — un-gated).
- **Change:** the existing `SELECT * FROM companies WHERE ${sf} = $1` becomes a `LEFT JOIN` to `users` to attach a display name for the relationship owner. Keep all existing filters (`search`, `industry`, `status`, `type`) intact.

```sql
SELECT c.*,
       ro.name  AS relationship_owner_name,
       ro.email AS relationship_owner_email
FROM companies c
LEFT JOIN users ro ON ro.id = c.relationship_owner_id
WHERE c.${sf} = $1
  -- ... existing filters re-pointed at c.<col> ...
ORDER BY c.created_at DESC
```

- **New optional query param:** `relationship_owner_id` (int) — when present, `AND c.relationship_owner_id = $n` (the "accounts I own" filter). A literal value of `unassigned` maps to `AND c.relationship_owner_id IS NULL`.
- **Response 200:** array of company rows, each now carrying `relationship_owner_id` (int|null), `relationship_owner_name` (string|null), `relationship_owner_email` (string|null). All existing fields unchanged (additive).

### 4.2 `POST /api/companies` and `PUT /api/companies/:id` (extend existing)

- **Auth:** `authMiddleware` (existing — un-gated).
- **Change:** accept optional `relationship_owner_id` in the body (validated int-or-null by the schema). On write, **validate the user is in scope** (see §4.3 validation) — reject with 400 `{ "error": "relationship_owner_id must reference a user in your organization" }` if it does not. `POST` inserts it; `PUT` does `relationship_owner_id = COALESCE($n, relationship_owner_id)` **except** an explicit `null` must clear it — since COALESCE can't distinguish "omitted" from "explicit null", follow the existing `custom_fields` pattern: treat `undefined` (key absent) as "leave unchanged" and an explicit `null` as "clear." Implementation: only include the column in the `SET` clause when the key is present in `req.body`.
- **Response:** the full company row (existing `RETURNING *`), now including `relationship_owner_id`.

### 4.3 `PATCH /api/companies/:id/owner` (new — CS-gated convenience route)

A focused route for the picker so the UI doesn't round-trip the whole company on every owner change.

- **Auth:** `authMiddleware` + `requireFeature('customer_success_enabled')`.
- **Route ordering:** declare it **after** the existing `router.patch('/bulk', …)` and **alongside** the other `/:id` routes (Express matches `/bulk` first because it is literal; `/:id/owner` is more specific than `/:id` so order among them is unambiguous). Mirrors the survey note about mounting `/:id/*` sub-routes after the collection routes.
- **Request body** (validated by `ownerPatchSchema`):

```json
{ "relationship_owner_id": 42 }
```
or to clear:
```json
{ "relationship_owner_id": null }
```

- **Validation rules:**
  - `relationship_owner_id` required key; value is an integer **or** `null`.
  - When non-null: the target user must exist **within the same org scope**. Verify with:
    ```sql
    SELECT 1 FROM users WHERE id = $1 AND org_id = $2   -- when req.orgId
    -- or, for org-less users:
    SELECT 1 FROM users WHERE id = $1 AND id = $2        -- only self
    ```
    If not found → 400 `{ "error": "relationship_owner_id must reference a user in your organization" }`.
- **Behaviour:**
  ```sql
  UPDATE companies
     SET relationship_owner_id = $1, updated_at = CURRENT_TIMESTAMP
   WHERE id = $2 AND ${sf} = $3
   RETURNING *
  ```
- **Response 200:** the updated company row (`RETURNING *`), with `relationship_owner_id` set/cleared.
- **404:** `{ "error": "Company not found" }` when the row is not in scope (`rowCount === 0`).

### 4.4 Bulk owner assignment (extend existing `PATCH /api/companies/bulk`)

- The existing bulk route already supports `owner_id`/`type`/`status` via `buildBulkUpdate({ allowlist: ['owner_id', 'type', 'status'] })`. Add `'relationship_owner_id'` to that `allowlist` array so the bulk-action bar can mass-assign relationship owners. No new route. `_bulkOps.js` already org-scopes the `WHERE` via `qs`.
- **Note:** unlike `PATCH /:id/owner`, the bulk path does **not** currently do the cross-org user-existence check (it only allowlists columns). If we want the same guard on bulk, add a one-line existence check in the bulk handler for the `relationship_owner_id` value before applying; otherwise the FK constraint (`REFERENCES users(id)`) still prevents a non-existent user id, but **not** a cross-org-but-valid user id. **Recommendation:** add the existence-in-scope check to bulk too (cheap, one query). Document the decision in the implementation PR.

### 4.5 Automation re-routing (`services/automation.js` — no new endpoint)

Two existing rules change *who the task is assigned to*, preferring the relationship owner:

**`dormant_customer_outreach`** — extend the existing SELECT to also fetch `c.relationship_owner_id`, then prefer it:
```sql
SELECT c.id AS customer_id, c.name AS customer_name, c.org_id, c.user_id, c.last_deal_at,
       c.relationship_owner_id,
       (SELECT salesman_id FROM deals WHERE customer_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_salesman_id
FROM companies c
WHERE c.type = 'customer'
  AND c.last_deal_at IS NOT NULL
  AND c.last_deal_at < NOW() - INTERVAL '180 days'
LIMIT 200
```
Task owner becomes `c.relationship_owner_id || c.last_salesman_id || c.user_id`.

**`service_contract_renewal_due`** — join the contract's customer to fetch its relationship owner:
```sql
SELECT sc.id, sc.org_id, sc.user_id, sc.name, sc.end_date, sc.renewal_notice_days, sc.customer_id, sc.deal_id,
       cust.relationship_owner_id
FROM service_contracts sc
LEFT JOIN companies cust ON cust.id = sc.customer_id
WHERE sc.status = 'active'
  AND sc.end_date IS NOT NULL
  AND sc.end_date <= CURRENT_DATE + (COALESCE(sc.renewal_notice_days, 30) || ' days')::INTERVAL
  AND sc.end_date >= CURRENT_DATE
LIMIT 200
```
Task owner becomes `sc.relationship_owner_id || sc.user_id` (the existing call passes `sc.user_id`). The `alreadyFired` / `recordRun` dedup is unchanged — re-routing does not change the dedup key.

### Frontend API client (`frontend/src/api.js`)

```js
// reuse existing org namespace; add members() if absent
export const org = {
  // ... existing ...
  get: () => api.get('/org').then((r) => r.data),               // { org, members, pendingInvites }
  members: () => api.get('/org').then((r) => r.data.members),    // [{ id, name, email, org_role }]
};

export const companies = {
  // ... existing ...
  // PATCH /api/companies/:id/owner  — set or clear (userId === null) the relationship owner
  setRelationshipOwner: (id, userId) =>
    api.patch(`/companies/${id}/owner`, { relationship_owner_id: userId }).then((r) => r.data),
};
```
CSRF is handled automatically by the axios interceptor in `api.js` (state-changing requests get `X-CSRF-Token`).

---

## 5. UI surface

### `frontend/src/pages/Companies.js`

- **New column** in `baseColumns` (inject **only when** `getStageConfig(profile).showAccountManagement` is true — read `org_profile` from `useAuth()` context):
  ```js
  { key: 'relationship_owner', label: 'Relationship Owner', width: '16%',
    render: (row) => row.relationship_owner_name || '—' }
  ```
  Adjust the other column widths so the row still sums to ~100% (DataTable tolerates overflow but keep it tidy). The column is **absent entirely** for `generic`/`jcp` (no `showAccountManagement`).
- **Owner picker:** add a "Relationship Owner" `<select>` to the company create/edit form, populated from `org.members()` (id → name). Bind to `relationship_owner_id`; the empty option = "Unassigned" (writes `null`). On a quick inline change (row action), call `companies.setRelationshipOwner(id, userId)` and refetch. On full-form save, the value flows through the existing `POST`/`PUT` body.
- **Filter (optional, nice-to-have):** add an "Owner" filter chip that sets the `relationship_owner_id` query param (`me` → current user id, `unassigned` → the `unassigned` sentinel).

### `frontend/src/pages/AccountDetail.js` (only if CS-1 shipped)

- In the account header card, render the relationship owner with an inline picker (same `org.members()` source + `companies.setRelationshipOwner`). If CS-1 has not shipped, this file does not exist yet — skip; CS-9 ships standalone on the Companies list.

### `frontend/src/stages.js`

- Ensure `getStageConfig` returns `showAccountManagement` (`true` for `zang` and future `rin`; `false` for `generic`/`jcp`). If an earlier CS item already added it, reuse — do not duplicate.

### `frontend/src/components/Nav.js`

- **No nav change.** CS-9 adds no new page. (The Companies page already has a nav link.)

---

## 6. Tests — `backend/test/accountOwnership.test.js`

Use the project's vitest convention (globals `describe`/`test`/`expect`/`vi`; `pool.query` mocked). Follow the handler-level style of `backend/test/bulk-ops.test.js`, or spin a supertest app like `backend/test/me.test.js`. At minimum **one happy path per new/changed endpoint** plus the scoping + validation guards:

1. **`PATCH /:id/owner` happy path (set)** — body `{ relationship_owner_id: 42 }`; mock the in-scope user-existence probe to return a row, then the `UPDATE … RETURNING *` to return the updated company. Assert the `UPDATE companies SET relationship_owner_id = $1 … WHERE id = $2 AND <scope> = $3` SQL is org-scoped and 200 returns the updated row with `relationship_owner_id: 42`.
2. **`PATCH /:id/owner` happy path (clear)** — body `{ relationship_owner_id: null }`; assert no user-existence probe runs (null skips it) and the row is updated to `null`.
3. **`PATCH /:id/owner` cross-org guard** — body references a user **not** in the caller's org (existence probe returns 0 rows) → 400 `relationship_owner_id must reference a user in your organization`; the `UPDATE` is **not** executed.
4. **`PATCH /:id/owner` not found** — UPDATE returns `rowCount: 0` (row out of scope) → 404 `{ error: 'Company not found' }`.
5. **`PATCH /:id/owner` requireFeature gate** — a request from an org without `customer_success_enabled` is rejected with **403** before any DB write (assert at the middleware level or via the flag mock).
6. **`PATCH /:id/owner` org-scoping** — assert the scope value passed to `pool.query` comes from `req.orgId` (server-side), never from client input.
7. **`POST /api/companies` with `relationship_owner_id`** — happy path: in-scope user → row created with the owner set. Invalid (cross-org) → 400.
8. **`PUT /api/companies/:id` clears vs leaves owner** — explicit `null` clears `relationship_owner_id`; key omitted leaves it unchanged (assert the column is not in the `SET` clause when the key is absent).
9. **`GET /api/companies` returns owner display fields** — mock the `LEFT JOIN users` result; assert each row carries `relationship_owner_name` / `relationship_owner_email`; assert the `relationship_owner_id` query param adds the `c.relationship_owner_id = $n` predicate and `unassigned` adds `IS NULL`.
10. **Automation re-routing unit test** — mock the `dormant_customer_outreach` SELECT to return a company with `relationship_owner_id` set; assert `createTaskForOrg` is called with that id as the owner. A second row with `relationship_owner_id = NULL` falls back to `last_salesman_id`. (Mirror for `service_contract_renewal_due` if a fixture is cheap.)
11. **Bulk allowlist** — assert `relationship_owner_id` is now an accepted bulk-patch column and a non-allowlisted column is still rejected.

Run: `cd backend && npm test`.

---

## 7. Acceptance criteria (observable / demo-able)

1. **Migration:** after `095_account_ownership.sql` runs, `companies` has a nullable `relationship_owner_id` column (FK → `users`, `ON DELETE SET NULL`) and an index `idx_companies_relationship_owner_id`. Re-running the migration is a no-op (boot does not fail).
2. **Distinct from existing attribution:** `relationship_owner_id`, `companies.owner_id`, and `deals.salesman_id` are independently settable and visible; setting one does not change the others.
3. **Picker (CS-enabled org):** with `customer_success_enabled` on, the Companies page shows a "Relationship Owner" column and a picker listing the org's members; selecting a member persists it (`GET /api/companies` reflects `relationship_owner_name` on next load); selecting "Unassigned" clears it.
4. **Convenience route:** `PATCH /api/companies/:id/owner` sets/clears the relationship owner in one call and returns the updated row; assigning a user **not** in the caller's org returns 400; an out-of-scope company id returns 404.
5. **Flag gating:** with `customer_success_enabled` **off**, `PATCH /api/companies/:id/owner` returns **403**, and the "Relationship Owner" column/picker do not render for `generic`/`jcp` profiles. Core company CRUD (`GET`/`POST`/`PUT`/`DELETE`) continues to work unchanged for all profiles.
6. **Automation re-routing:** an account with a `relationship_owner_id` set that goes dormant (>180 days) gets its re-engagement task assigned to the **relationship owner** (not the original salesman); a service contract inside its renewal window whose customer has a relationship owner routes the renewal task to that owner. An account with **no** relationship owner behaves exactly as before (task → last salesman / org owner) — confirming zero behaviour change for un-owned accounts. Dedup (`automation_runs`) still prevents duplicate firing.
7. **Bulk assign:** selecting multiple companies and using the "Change owner" bulk action can set `relationship_owner_id` across them in one request, org-scoped.
8. **Org isolation:** a user in org A can never assign an org-A company to an org-B user, nor set the relationship owner on an org-B company, via any route (verified by tests #3, #6 above and #5/#6 in §6).
9. **No regression for vanilla CRM:** `generic` / `jcp` orgs see no new column, no new nav, no behaviour change; the extra DB column sits inert and unused.
10. **`npm test` passes**, including the new `backend/test/accountOwnership.test.js` suite (≥1 happy path per new/changed endpoint).

---

## Open decisions / notes for the implementer

- **Migration number:** written as `095`; bump to the next free 3-digit prefix if `095`–`097` are already claimed by sibling CS migrations at merge time (CS-3/CS-5/CS-7 reserve `095`, CS-8 reserves `097`). Never reuse a number; update the filename and the boot `console.log` to match.
- **`owner_id` vs `relationship_owner_id`:** intentionally **two** columns. `owner_id` is the generic record owner (existing bulk-assign); `relationship_owner_id` is the post-sale CSM that drives renewal/dormant routing. If a future iteration wants to collapse them, that's a product decision — keep them separate for now per the roadmap intent.
- **Backfill is a business decision, not code:** operators may optionally seed `relationship_owner_id = owner_id` (or `= deals.salesman_id`) for existing accounts; this spec ships them `NULL` and relies on the automation fallback so nothing regresses.
- **Cross-org guard on bulk:** the FK prevents non-existent users, but not a valid user from another org. Recommend adding the in-scope existence check to the bulk path too (one cheap query); flagged in §4.4 for the implementer to confirm.
- **Notification dispatcher:** `services/notificationDispatcher.js` is wired into `routes/taskRoutes.js`; tasks created by the re-routed automation already notify their assignee via the existing path — no extra wiring needed for CS-9 (the relationship owner simply becomes the assignee).
