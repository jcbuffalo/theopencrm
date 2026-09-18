# CS-3 — Renewals Pipeline / Recurring-Revenue View

**Status:** 🔴 Not started · **Priority:** P1 · **Effort:** ~3 days
**Roadmap source:** `NEXT_STEPS.md` → "Customer Relationship Management (post-sale / customer success)" → **CS-3**
**Gating flag:** `customer_success_enabled` (module, default `false`) — same flag CS-1/CS-2 introduce.
**Spec author note:** This spec is self-contained. It assumes the `customer_success_enabled` flag may already be added to `services/featureFlags.js` by CS-1/CS-2; if not, this spec adds it (see §1). CS-3 does **not** hard-depend on CS-1 or CS-2 shipping first — the Renewals board renders standalone. The only CS-2 touch-point (joining account health onto the board) is an **optional LEFT JOIN** that no-ops to `NULL` when `account_health_snapshots` does not yet exist.

---

## Problem statement

Today `service_contracts` (migration `046_phase4_5_completeness.sql`) carries `end_date`, `renewal_notice_days`, `monthly_amount`, `status` ('active'/…), `customer_id`, `deal_id`. The automation rule `service_contract_renewal_due` (in `services/automation.js`) only fires a renewal **task** when a contract is inside its notice window. There is:

- no renewal **stage flow** (`upcoming → at_risk → renewed / churned`),
- no first-class **annual contract value** (only `monthly_amount`),
- no **churn reason** capture,
- no link from a renewed contract to its **successor** contract,
- no **board UI** or **90-day forecast**.

CS-3 adds a renewal lifecycle on top of the existing `service_contracts` row, a summary/forecast endpoint, a Renewals board page, and an automation extension that flips a contract to `at_risk` inside its window when the account has gone quiet.

---

## 1. Files to touch

### Backend — new
- `backend/migrations/095_renewals.sql` — adds renewal columns to `service_contracts` (see §3).
- `backend/test/renewals.test.js` — endpoint happy-path + scoping tests (see §6).

### Backend — modified
- `backend/routes/serviceContractRoutes.js`
  - Add `GET /api/service-contracts/renewals` (summary + forecast). **Must be declared BEFORE the existing `PUT /:id` / `DELETE /:id` are irrelevant, but it MUST be declared before any `/:id` GET** — there is currently no `GET /:id`, but register `/renewals` above `router.put('/:id', …)` to be safe against future `/:id` GET additions and to keep all collection-level routes grouped.
  - Add `POST /api/service-contracts/:id/renewal-transition` (move a contract between renewal stages, capturing value / successor / churn reason).
  - Extend the existing `SELECT sc.*` in `GET /` so the new columns ride along automatically (they already will via `sc.*`); add an optional `renewal_stage` query filter.
- `backend/schemas/serviceContracts.js`
  - Extend `createSchema` / `updateSchema` with `renewal_stage`, `annual_value`, `churn_reason`, `renewed_contract_id`.
  - Add a new `renewalTransitionSchema` (validates `to_stage`, optional `annual_value`, `churn_reason`, `renewed_contract_id`).
- `backend/services/automation.js`
  - Extend the `service_contract_renewal_due` rule: in addition to creating the task, flip `renewal_stage` to `at_risk` when the contract is inside its notice window, is still `renewal_stage='upcoming'`, and the linked account has had **no activity in 30 days** (derived from `deals.updated_at` / `activities.activity_date` on the customer's deals — do **not** trust `companies.last_deal_at`, per the survey gotcha). Dedup via `alreadyFired('service_contract_renewal_at_risk', 'service_contract', sc.id, 30)`.
- `backend/services/featureFlags.js`
  - Add the `customer_success_enabled` flag to `KNOWN_FLAGS` **if CS-1/CS-2 have not already added it** (idempotent — only one entry total). See §1 snippet below.
- `backend/index.js`
  - Gate the service-contracts mount on the new flag **only for CS-enabled profiles** is **not** desired (zang already uses `/api/service-contracts` un-gated today — see line 522). To avoid breaking the existing zang Contracts page, do **NOT** wrap the existing `/api/service-contracts` mount in `requireFeature`. Instead, gate **only the new sub-routes** at the router level (see §4 note). The new `GET /renewals` and `POST /:id/renewal-transition` handlers call `requireFeature('customer_success_enabled')` as route-level middleware inside `serviceContractRoutes.js`.

### Frontend — new
- `frontend/src/pages/Renewals.js` — Kanban board by `renewal_stage`, route `/renewals` (see §5).

### Frontend — modified
- `frontend/src/App.js` — register the lazy-loaded `/renewals` route inside the authenticated block.
- `frontend/src/components/Nav.js` — add a `{ to: '/renewals', label: 'Renewals', key: 'renewals' }` link, rendered only when `showAccountManagement` is true.
- `frontend/src/stages.js` — add `showAccountManagement` to the `getStageConfig` return (true for `zang` and future `rin`; false for `generic`/`jcp`). (CS-1 may already add this; if so, reuse it — do not duplicate.)
- `frontend/src/api.js` — add a `renewals` (or extend a `serviceContracts`) namespace object (see §4 / §5).

---

## 2. New env vars + graceful degradation

**No new required env vars.** CS-3 is pure CRM data on Postgres.

- **`customer_success_enabled` feature flag** (per-org, in `organizations.features` JSONB, default `false`): when off, `GET /api/service-contracts/renewals` and `POST /api/service-contracts/:id/renewal-transition` return **403** via `requireFeature`. The existing un-gated CRUD on `/api/service-contracts` is unchanged so the current zang Contracts page keeps working.
- **CS-2 dependency is soft:** the `GET /renewals` board response includes an account `health_band` per contract via a `LEFT JOIN` to `account_health_snapshots` (latest snapshot per `company_id`). If that table does not exist yet (CS-2 not shipped), the query path must degrade gracefully — guard with a `to_regclass('account_health_snapshots') IS NOT NULL` check executed once at request time, and omit the join (return `health_band: null`) when absent. This keeps CS-3 shippable before CS-2.
- **Automation worker:** the `service_contract_renewal_due` extension only runs when `automation_enabled` is on for the org and the scheduler is running (`AUTOMATION_ENABLED=true` locally, auto-on in production). When automation is off, contracts simply never auto-flip to `at_risk`; users can still transition them manually. No crash, no required config.

---

## 3. Migration — `backend/migrations/095_renewals.sql`

Next available prefix: **095** (latest existing is `094_deal_gmail_summaries.sql`).

`service_contracts` was created with a bare `CREATE TABLE IF NOT EXISTS` in `046` (not one of the duplicate-table tables, so plain `ALTER … ADD COLUMN IF NOT EXISTS` is safe), but use `IF NOT EXISTS` regardless for re-run safety per project convention.

```sql
-- CS-3 (migration 095): renewals pipeline on top of service_contracts.
--
-- service_contracts (046) already carries end_date, renewal_notice_days,
-- monthly_amount, status, customer_id, deal_id. This migration adds the
-- renewal *lifecycle* fields the Renewals board + forecast endpoint need.
--
-- renewal_stage drives the board columns. It is INDEPENDENT of the existing
-- `status` column: `status` = active/expired/cancelled (lifecycle of the
-- contract document); `renewal_stage` = where this contract sits in the
-- renewal motion. A live contract can be status='active', renewal_stage='upcoming'.
--
-- annual_value is a FIRST-CLASS field (not monthly_amount * 12) per the survey
-- gotcha — some contracts bill annually with no monthly figure, and expansion
-- changes ARR without changing the monthly line. Nullable; the forecast endpoint
-- COALESCEs annual_value, then monthly_amount * 12, then 0 for display only.
--
-- renewed_contract_id points at the SUCCESSOR contract created when a renewal
-- closes as renewed (self-FK). Lets the board show the renewal chain.
--
-- IDEMPOTENT: re-running is a no-op.

BEGIN;

ALTER TABLE service_contracts
  ADD COLUMN IF NOT EXISTS renewal_stage VARCHAR(20) DEFAULT 'upcoming';

ALTER TABLE service_contracts
  ADD COLUMN IF NOT EXISTS annual_value NUMERIC(15, 2);

ALTER TABLE service_contracts
  ADD COLUMN IF NOT EXISTS churn_reason TEXT;

ALTER TABLE service_contracts
  ADD COLUMN IF NOT EXISTS renewed_contract_id INTEGER
    REFERENCES service_contracts(id) ON DELETE SET NULL;

ALTER TABLE service_contracts
  ADD COLUMN IF NOT EXISTS renewal_stage_changed_at TIMESTAMP;

-- Backfill: anything still active with a future-or-null end_date starts 'upcoming';
-- contracts already past end_date with no renewal recorded fall to 'churned' so the
-- board doesn't show an expired contract as "upcoming". Only touch NULL stages.
UPDATE service_contracts
   SET renewal_stage = CASE
         WHEN status <> 'active' THEN 'churned'
         WHEN end_date IS NOT NULL AND end_date < CURRENT_DATE THEN 'churned'
         ELSE 'upcoming'
       END
 WHERE renewal_stage IS NULL;

CREATE INDEX IF NOT EXISTS idx_service_contracts_renewal_stage
  ON service_contracts(renewal_stage);

-- Forecast queries filter by org + stage + end_date window; composite helps.
CREATE INDEX IF NOT EXISTS idx_service_contracts_org_renewal
  ON service_contracts(org_id, renewal_stage, end_date);

COMMIT;
```

**Valid `renewal_stage` values (enforced in app layer, not a DB CHECK, matching the project's loose-enum style):** `upcoming`, `at_risk`, `renewed`, `churned`.

### `featureFlags.js` snippet (add only if CS-1/CS-2 has not)

```js
{
  name: 'customer_success_enabled',
  category: 'module',
  description: 'Post-sale / customer-success surface: account 360 (CS-1), account health (CS-2), and the renewals pipeline / recurring-revenue board (CS-3). Default off — keeps generic/jcp lean; zang/rin enable it.',
  defaultValue: false,
},
```

---

## 4. API endpoints

All routes live in `backend/routes/serviceContractRoutes.js`, which already does `router.use(authMiddleware)` and `function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }`. The two **new** routes additionally apply `requireFeature('customer_success_enabled')` as route-level middleware (import `requireFeature` from `../middleware/featureGate`).

> **Org-scoping is mandatory on every query.** Each handler reads `const [sf, sv] = qs(req);` and every `WHERE` includes `sc.${sf} = $n`. The self-FK on `renewed_contract_id` must also be org-scoped when set (verify the successor contract belongs to the same scope before writing it).

### 4.1 `GET /api/service-contracts/renewals`

- **Auth:** `authMiddleware` + `requireFeature('customer_success_enabled')`.
- **Query params (all optional):**
  - `window_days` (int, default `90`, clamped 1–365) — forecast horizon.
- **Behaviour:** returns per-stage counts + summed value, plus a list of contracts due within `window_days`, plus a small monthly forecast series. Value = `COALESCE(annual_value, monthly_amount * 12, 0)`.
- **Response 200:**

```json
{
  "window_days": 90,
  "by_stage": {
    "upcoming":  { "count": 12, "value": 348000.00 },
    "at_risk":   { "count": 3,  "value": 96000.00 },
    "renewed":   { "count": 27, "value": 810000.00 },
    "churned":   { "count": 4,  "value": 52000.00 }
  },
  "forecast_window": {
    "due_count": 9,
    "due_value": 271000.00,
    "at_risk_value": 96000.00
  },
  "forecast_series": [
    { "month": "2026-07", "due_count": 3, "due_value": 84000.00 },
    { "month": "2026-08", "due_count": 4, "due_value": 120000.00 },
    { "month": "2026-09", "due_count": 2, "due_value": 67000.00 }
  ],
  "contracts": [
    {
      "id": 41,
      "name": "ACV Annual Support",
      "customer_id": 7,
      "customer_name": "Northwind",
      "deal_id": 88,
      "renewal_stage": "at_risk",
      "status": "active",
      "end_date": "2026-08-15",
      "days_to_end": 53,
      "annual_value": 96000.00,
      "monthly_amount": 8000.00,
      "computed_value": 96000.00,
      "churn_reason": null,
      "renewed_contract_id": null,
      "health_band": "yellow"
    }
  ]
}
```

- `health_band` is `green|yellow|red|null` — `null` when `account_health_snapshots` does not exist (CS-2 not shipped) or no snapshot for the customer.
- `contracts[]` is limited to contracts whose `end_date` is within `window_days` of today **OR** whose `renewal_stage = 'at_risk'` (so at-risk items always surface even if dated further out), ordered `end_date ASC NULLS LAST`. Cap at 500 rows.
- `by_stage` aggregates **all** of the org's contracts (not windowed) so the board shows full column totals.

### 4.2 `POST /api/service-contracts/:id/renewal-transition`

- **Auth:** `authMiddleware` + `requireFeature('customer_success_enabled')`.
- **Request body** (validated by `renewalTransitionSchema`):

```json
{
  "to_stage": "renewed",
  "annual_value": 102000.00,
  "churn_reason": null,
  "renewed_contract_id": 57
}
```

- **Validation rules:**
  - `to_stage` required, one of `upcoming | at_risk | renewed | churned`.
  - When `to_stage = 'churned'`, `churn_reason` is **required** (non-empty after trim) → 400 `{ "error": "churn_reason is required when churning a contract" }` if missing.
  - `renewed_contract_id` (optional) only meaningful when `to_stage = 'renewed'`; when provided, the handler verifies that successor contract exists **within the same `qs(req)` scope** (404 `{ "error": "Successor contract not found" }` if not).
  - `annual_value` optional numeric ≥ 0.
- **Behaviour:** `UPDATE service_contracts SET renewal_stage = $to_stage, renewal_stage_changed_at = NOW(), annual_value = COALESCE($annual_value, annual_value), churn_reason = (CASE WHEN $to_stage='churned' THEN $churn_reason ELSE churn_reason END), renewed_contract_id = COALESCE($renewed_contract_id, renewed_contract_id), updated_at = NOW() WHERE id = $id AND ${sf} = $sv RETURNING *`. Also when `to_stage='renewed'` or `'churned'`, set `status` appropriately is **out of scope** — keep `status` untouched (renewal_stage is the independent lifecycle); document this so the operator knows expired-doc handling stays manual.
- **Response 200:** the updated contract row (`RETURNING *`).
- **404:** `{ "error": "Contract not found" }` when the row is not in scope.

### 4.3 `GET /api/service-contracts?renewal_stage=at_risk` (extend existing list)

- The existing `GET /` already exists. Add one optional filter: `if (renewal_stage) { query += ' AND sc.renewal_stage = $n'; ... }`. No new auth — the existing list route is **not** flag-gated (zang relies on it today). The new `renewal_stage` column is exposed via the existing `sc.*` automatically.

### Frontend API client (`frontend/src/api.js`)

```js
export const renewals = {
  // GET /api/service-contracts/renewals?window_days=90
  summary: (windowDays = 90) =>
    api.get('/service-contracts/renewals', { params: { window_days: windowDays } }).then((r) => r.data),

  // GET /api/service-contracts?renewal_stage=...
  listByStage: (stage) =>
    api.get('/service-contracts', { params: stage ? { renewal_stage: stage } : {} }).then((r) => r.data),

  // POST /api/service-contracts/:id/renewal-transition
  transition: (id, payload) =>
    api.post(`/service-contracts/${id}/renewal-transition`, payload).then((r) => r.data),
};
```

CSRF is handled automatically by the axios interceptor in `api.js` (state-changing requests get `X-CSRF-Token`).

---

## 5. UI surface

### New page `frontend/src/pages/Renewals.js` (route `/renewals`)

- **Gating:** rendered only for profiles where `getStageConfig(profile).showAccountManagement` is true (zang / rin). The nav link is hidden otherwise; if a user hits `/renewals` directly on a non-CS profile the backend sub-routes 403 and the page shows the standard "feature not enabled" empty state.
- **Layout:** a four-column Kanban board mirroring the Deals board feel but **without drag-reorder** (a transition modal is clearer for value/reason capture). Columns: **Upcoming · At Risk · Renewed · Churned**, each driven by `renewals.listByStage(stage)` (or a single fetch grouped client-side).
  - **Column header:** stage label + count + summed `computed_value` (formatted currency).
  - **Card:** contract `name`, `customer_name`, `end_date` + `days_to_end` (red text when ≤ 30 or negative), `computed_value`, and a CS-2 health dot (`health_band`) when present.
  - **At Risk column** styling: amber left-border / badge.
- **Header summary strip** (from `renewals.summary(90)`): total ARR under management, count + value due in next 90 days, at-risk value, and a small `recharts` `BarChart` of `forecast_series` (months on X, `due_value` on Y) — recharts is already a dependency used by `pages/Reports.js`.
- **Transition action:** each card has a "Move…" affordance opening a modal with:
  - stage selector (`upcoming/at_risk/renewed/churned`),
  - `annual_value` numeric input (prefilled with `computed_value`),
  - when `churned`: a required `churn_reason` textarea,
  - when `renewed`: an optional successor-contract picker (search existing contracts for the same customer) writing `renewed_contract_id`.
  - Submits via `renewals.transition(id, payload)`, then refetches the board.
- **`active` nav key:** pass `active="renewals"` to `<Nav />`.

### `frontend/src/App.js`

```jsx
const Renewals = lazyWithRetry(() => import('./pages/Renewals'));
// inside the authenticated block:
<Route path="/renewals" element={<Renewals />} />
```

### `frontend/src/components/Nav.js`

Add to the nav arrays a conditional entry (only when `showAccountManagement`). Simplest: append `{ to: '/renewals', label: 'Renewals', key: 'renewals' }` to `NAV_LINKS_ZANG` (zang has `showAccountManagement = true`) and, when CS-1's `showAccountManagement` toggle is added, filter generically. For this spec, adding it to `NAV_LINKS_ZANG` satisfies the only currently-shipped CS-enabled profile.

### `frontend/src/stages.js`

Add `showAccountManagement: true` to the `zang` config return (and the future `rin`), `showAccountManagement: false` to `generic` and `jcp`. If CS-1 already added this key, do nothing.

---

## 6. Tests — `backend/test/renewals.test.js`

Use the project's vitest convention (globals `describe`/`test`/`expect`/`vi`; `pool.query` mocked, `services/ai` not needed here). Follow the handler-level style of `test/bulk-ops.test.js` where practical, or spin a supertest app like `test/me.test.js` — at minimum one happy path **per new endpoint** plus scoping/validation guards.

1. **`GET /api/service-contracts/renewals` happy path** — mock `pool.query` to return aggregate rows + a contract list; assert the response shape has `by_stage`, `forecast_window`, `forecast_series`, `contracts[]`, and that `computed_value` falls back to `monthly_amount * 12` when `annual_value` is null.
2. **`GET /renewals` org-scoping** — assert every SQL string passed to `pool.query` contains the scope predicate (`org_id = $` or `user_id = $`) and that `req.orgId` (not any client input) supplies the scope value.
3. **`GET /renewals` CS-2 graceful degradation** — when the `to_regclass('account_health_snapshots')` probe returns null, assert the join is omitted and every contract has `health_band: null` (no thrown error).
4. **`POST /:id/renewal-transition` happy path (renewed)** — `to_stage='renewed'`, `annual_value` set; assert `UPDATE service_contracts` SQL sets `renewal_stage` and `renewal_stage_changed_at`, scoped by `qs`, and returns the updated row.
5. **`POST /:id/renewal-transition` churn-reason guard** — `to_stage='churned'` with no `churn_reason` → 400, `pool.query` not called for the UPDATE.
6. **`POST /:id/renewal-transition` invalid stage** — `to_stage='bogus'` → 400 from `renewalTransitionSchema`.
7. **`POST /:id/renewal-transition` not-found** — UPDATE returns `rowCount: 0` (out of scope) → 404.
8. **`requireFeature` gate** — a request from an org without `customer_success_enabled` is rejected with 403 before any DB write (can be asserted at the middleware level or via the flag mock).

Run: `cd backend && npm test`.

---

## 7. Acceptance criteria (observable / demo-able)

1. With `customer_success_enabled` on for a zang org, **/renewals** renders a four-column board (Upcoming / At Risk / Renewed / Churned); each column shows a live count and summed value.
2. The header strip shows total ARR under management, count + value due in the next 90 days, at-risk value, and a recharts bar chart of the monthly renewal forecast.
3. A contract with `annual_value` set shows that figure; one with only `monthly_amount` shows `monthly_amount × 12` — both confirmable against the same numbers returned by `GET /api/service-contracts/renewals`.
4. Moving a card to **Renewed** (optionally selecting a successor contract) persists `renewal_stage='renewed'`, `renewed_contract_id`, and any updated `annual_value`; the card moves columns on refetch.
5. Moving a card to **Churned** requires a churn reason (the modal blocks submit / backend returns 400 without one); after submit the reason is stored in `service_contracts.churn_reason`.
6. A contract inside its `renewal_notice_days` window whose account has had no activity in 30 days is automatically flipped to **At Risk** by the extended `service_contract_renewal_due` automation rule on the next tick, and is **not** re-flipped on subsequent ticks (dedup via `automation_runs`).
7. With `customer_success_enabled` **off**, `GET /api/service-contracts/renewals` and `POST /api/service-contracts/:id/renewal-transition` return **403**, while the existing `/api/service-contracts` CRUD (and the zang Contracts page) continue to work unchanged.
8. A user in org A can never see or transition org B's contracts via any of the new routes (org-scoping verified in tests #2 and #7).
9. CS-3 ships and demos correctly **before** CS-2: when `account_health_snapshots` does not exist, the board renders with no health dots and no errors (`health_band: null`).
10. `npm test` passes, including the new `backend/test/renewals.test.js` suite (≥1 happy path per new endpoint).

---

## Open decisions / notes for the implementer

- **`status` vs `renewal_stage` stay independent.** This spec deliberately does **not** auto-mutate `status` on renewal transitions; expired-document handling remains the existing manual/`status` path. Revisit if Zang ops wants "churned ⇒ status=cancelled" coupling.
- **Drag-and-drop** is intentionally out of scope for v1 (the transition modal captures value + churn reason that a bare drag can't). @dnd-kit is available if a later iteration wants it.
- **Forecast series granularity** is monthly within `window_days`; if Zang wants quarterly, bucket by quarter in the same SQL `date_trunc`.
- **CS-2 join** is a soft, probe-guarded LEFT JOIN so migration ordering (095 here vs CS-2's health snapshot migration) cannot break this endpoint regardless of which ships first.
