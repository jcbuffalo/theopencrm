# CS-6 — Retention-Centric Reporting (Renewal Rate, Churn, NRR)

**Status:** 🔴 Not started · **Priority:** P2 · **Effort:** ~2 days (additive to existing reports)
**Roadmap source:** `NEXT_STEPS.md` → "Customer Relationship Management (post-sale / customer success)" → **CS-6**
**Gating flag:** `customer_success_enabled` (module category, default `false`) — the shared CS-* flag introduced by CS-1/CS-2/CS-3.
**Author:** scoping pass, 2026-06-23.

---

## 0. Problem statement (from NEXT_STEPS.md)

> Reports (`routes/metricsRoutes.js`, `pages/Reports.js`) are acquisition-centric
> (hit rate, pipeline value, per-salesman/vendor). No churn, renewal rate, NRR, or
> installed-base health.

The existing `GET /api/metrics/reports` endpoint and `frontend/src/pages/Reports.js`
answer "are we *winning* deals?" — hit rate, EOY projection, per-vendor/per-salesman
leaderboards, pipeline funnel. There is **no** surface that answers "are we *keeping*
the customers we won?": renewal rate, gross/net churn, **Net Revenue Retention (NRR)**,
and how the installed base trends green/yellow/red over time.

CS-6 adds one new **read-only** metrics endpoint (`GET /api/metrics/retention`) and one
new **Retention** tab to the existing Reports page. It introduces **no new tables** and
**no new tenant-table columns** — it aggregates over data that CS-3 (renewals on
`service_contracts`) and CS-2 (`account_health_snapshots`) already produce, degrading
gracefully when either is absent.

### Deliberate scope limits (so another engineer doesn't over-build)

- **No migration.** CS-6 is pure aggregation over existing columns. (The 09x prefix
  requirement in the checklist is satisfied trivially: §3 documents that no migration
  is required and why.)
- **Read-only.** No POST/PUT/DELETE, no automation rule, no worker. One GET endpoint.
- **Renewals data is the spine.** Renewal rate / churn / NRR are all computed from
  `service_contracts` (the CS-3 `renewal_stage`, `annual_value`, `monthly_amount`,
  `end_date`, `churn_reason` fields). Health distribution comes from CS-2's
  `account_health_snapshots`. CS-6 ships and renders **before** either of those if
  they aren't present yet — it just shows zeros / an empty-state for the missing block.

---

## 1. Files to touch

### Backend — new files

| Path | Purpose |
|---|---|
| `backend/test/retention.test.js` | Happy-path + scoping + graceful-degradation tests for the one new endpoint (see §6). |

### Backend — edited files

| Path | Change |
|---|---|
| `backend/routes/metricsRoutes.js` | Add `GET /api/metrics/retention` handler (see §4). Reuses the file's existing `qs(req)`, `windowClause`, `currentRange`, `priorRange`, `bucketGranularity`, `toISODate`, `VALID_WINDOWS`, `ISO_DATE_RE` helpers — do not duplicate them. Add a route-level `requireFeature('customer_success_enabled')` (import from `../middleware/featureGate`) on **only this route** so the existing `/dashboard`, `/reports`, `/salesman`, `/vendor-performance` routes stay ungated. |
| `backend/index.js` | **No change required.** `/api/metrics` is already mounted (gated by `requireFeature('reports_enabled')` per CLAUDE.md). The new sub-route's CS gate is applied in-router (above), so no mount edit is needed. Document this so the implementer doesn't add a second mount. |

> **Why no mount edit:** `metricsRoutes` is mounted once under `/api/metrics`. Adding a
> second `requireFeature` at the mount point would gate *all* of Reports behind
> `customer_success_enabled`, breaking the existing zang/jcp Reports page. The CS gate
> therefore lives as route-level middleware on the single new handler.

### Frontend — edited files

| Path | Change |
|---|---|
| `frontend/src/api.js` | Add a `metrics.retention(window, from, to)` helper (or extend the existing metrics namespace) — see §4. |
| `frontend/src/pages/Reports.js` | Add a `{ id: 'retention', label: 'Retention', hint: '…' }` entry to the `TABS` array (line ~644), a `<RetentionTab data={retentionData} />` render branch (line ~692), and a separate fetch for `/metrics/retention` (the retention block has its own response shape, so it is fetched independently of the `/metrics/reports` call rather than folded into it). Gate the tab so it renders only when `showAccountManagement` is true (from `getStageConfig`). |
| `frontend/src/stages.js` | Reuse the `showAccountManagement` boolean added by CS-1/CS-3 (`true` for `zang`/`rin`, `false` for `generic`/`jcp`). Add it only if no prior CS-* spec has — do not duplicate. |

---

## 2. New env vars + graceful degradation

**No new env vars.** CS-6 is pure aggregation on Postgres.

Graceful degradation is the central design constraint, because CS-6 reads tables/columns
owned by CS-2 and CS-3, which may not have shipped:

1. **`customer_success_enabled` off (per-org, `organizations.features` JSONB):**
   `GET /api/metrics/retention` returns **403** (`code: FEATURE_DISABLED`) via
   `requireFeature`. The Retention tab is hidden in the UI for non-CS profiles, and the
   backend gate is the hard guarantee.
2. **CS-3 not shipped (no `renewal_stage` / `annual_value` / `churn_reason` columns on
   `service_contracts`):** the handler probes once with
   `to_regclass('service_contracts')` and, for the renewal columns, a column-existence
   check (see §4.2). If `service_contracts` exists but lacks `renewal_stage`, the
   renewal-rate / churn / NRR blocks return zeroed structures with
   `"renewals_available": false`; the FE shows an empty-state card ("Renewals data not
   yet configured — see CS-3"). No 500.
3. **CS-2 not shipped (no `account_health_snapshots` table):** the health-distribution
   block probes `to_regclass('account_health_snapshots')`; when null it returns
   `"health_available": false` with an empty `health_distribution`. The FE hides the
   health chart. No 500.
4. **`reports_enabled` off:** the entire `/api/metrics` mount is already gated by
   `requireFeature('reports_enabled')` — an org needs both `reports_enabled` and
   `customer_success_enabled` to reach `/retention`. This is intentional (Retention is a
   report).

---

## 3. Migration

**None.** CS-6 introduces no tables and no columns.

- The checklist's "next available 09x prefix" requirement is satisfied by this explicit
  statement: CS-6 is read-only aggregation over columns already created by migration
  `046_phase4_5_completeness.sql` (`service_contracts`: `end_date`,
  `renewal_notice_days`, `monthly_amount`, `status`, `customer_id`, `deal_id`,
  `created_at`), by CS-3's renewals migration (`renewal_stage`, `annual_value`,
  `churn_reason`, `renewed_contract_id`, `renewal_stage_changed_at`), and by CS-2's
  `account_health_snapshots` (`org_id`, `company_id`, `score`, `band`, `signals`,
  `computed_at`).
- If, during implementation, a covering index is found to help (e.g. the existing
  `idx_service_contracts_end_date` / CS-3's `idx_service_contracts_org_renewal` are
  sufficient for the windowed scans), **no new index is needed**. Should profiling later
  show a hot path, the next free prefix at that time (currently the filesystem latest is
  `094`; CS-2/CS-3/CS-4 specs claim `095`/`096`) should be used — but this is explicitly
  **out of scope for CS-6**.

---

## 4. API endpoint

### 4.1 `GET /api/metrics/retention`

- **Auth:** `authMiddleware` (file-level) + `requireFeature('reports_enabled')` (mount-level,
  existing) + `requireFeature('customer_success_enabled')` (route-level, new).
- **Org-scoping:** `const [sf, sv] = qs(req);` at the top of the handler; every query's
  `WHERE` includes `sc.${sf} = $1` (or `s.${sf} = $1` for the health-snapshot query).
  The scope value comes from `req.orgId` / `req.userId` only — never from a query param.
- **Query params (all optional, validated by the file's existing `VALID_WINDOWS` /
  `ISO_DATE_RE`):**
  - `window` — one of `7d | month | quarter | ytd | all | custom` (default `ytd`).
  - `from`, `to` — `YYYY-MM-DD`, required when `window=custom`; `from <= to`. Same
    validation block as `/reports` (lines 279–288) — reuse it.
- **Window semantics:** the window bounds the *renewal/churn events* counted (a contract
  "renewed" or "churned" **within** the window, keyed on `renewal_stage_changed_at`
  falling back to `end_date`). Health distribution is windowed on
  `account_health_snapshots.computed_at`. The `series` buckets by the same
  `bucketGranularity(window, …)` the rest of the file uses.

#### Metric definitions (must be implemented exactly as written)

Let, **within the selected window**, over the org's `service_contracts`:

- `renewed_count` = contracts whose `renewal_stage = 'renewed'`.
- `churned_count` = contracts whose `renewal_stage = 'churned'`.
- `up_for_renewal` = `renewed_count + churned_count` (contracts that reached a renewal
  decision in the window). Contracts still `upcoming` / `at_risk` are **not** counted in
  the denominator — they haven't reached a decision yet.
- **`renewal_rate`** (logo/count basis) = `round(renewed_count / up_for_renewal * 100)`,
  or `null` when `up_for_renewal = 0`.
- **`churn_count`** = `churned_count` (gross logo churn).
- **`churned_value`** = sum of `computed_value` over churned contracts, where
  `computed_value = COALESCE(annual_value, monthly_amount * 12, 0)` (same fallback as
  CS-3's renewals endpoint — do not assume `monthly_amount * 12`).
- **`renewed_value`** = sum of `computed_value` over renewed contracts.
- **`expansion_value`** = sum over renewed contracts of
  `GREATEST(computed_value(successor) - computed_value(prior), 0)`, where the successor
  is the contract linked via `renewed_contract_id`. When a renewed contract has no
  successor link, expansion contribution is `0`. (Self-join `service_contracts s2 ON
  s2.id = sc.renewed_contract_id AND s2.${sf} = $1` — keep the join org-scoped.)
- **`contraction_value`** = sum over renewed contracts of
  `GREATEST(computed_value(prior) - computed_value(successor), 0)`.
- **Starting base** `base_value` = sum of `computed_value` over all contracts that were
  **active at the window start** (i.e. `start_date <= window.from` and (`end_date` is
  null or `end_date >= window.from`)). When `window=all`, `base_value` is the sum over
  all contracts ever — in that case NRR is reported as `null` (no meaningful prior base).
- **`nrr`** (Net Revenue Retention %, the headline) =
  `round((renewed_value - contraction_value + expansion_value - churned_value + base_value_unchanged) / base_value * 100)`.
  Practically, compute it as
  `round((base_value - churned_value - contraction_value + expansion_value) / base_value * 100)`
  where `base_value` is the starting base; `null` when `base_value = 0`. **Document this
  formula inline in the handler** so the next reader can audit it.
- **`gross_revenue_retention` (GRR)** =
  `round((base_value - churned_value - contraction_value) / base_value * 100)`,
  capped at 100; `null` when `base_value = 0`.

#### Health distribution (CS-2 dependency, soft)

When `account_health_snapshots` exists, take the **latest snapshot per `company_id`**
(window-bounded on `computed_at <= window.to`; if none in-window, latest overall) and
bucket by `band`:

```
health_distribution: { green: <int>, yellow: <int>, red: <int>, unknown: <int> }
```

`unknown` = customer companies (`companies.type = 'customer'`, org-scoped) with no
snapshot. When the table is absent, `health_available: false` and the object is all-zero.

#### Time series

A per-bucket series for the Retention chart, bucketed via the file's
`bucketGranularity` / `pgTruncUnit`, keyed on `renewal_stage_changed_at` (fallback
`end_date`):

```
series: [
  { bucket_start: "2026-01-01", renewed_count, churned_count, renewed_value, churned_value },
  ...
]
```

#### Period-over-period

Reuse `priorRange(window, …)` to compute the equal-length prior window and return a
`prev` block with the same headline scalars (`renewal_rate`, `churn_count`, `nrr`,
`grr`) so the FE can render delta badges (`<DeltaBadge>` already exists in Reports). `prev`
is `null` for `window=all`.

#### Response 200 (shape)

```json
{
  "window": "ytd",
  "range": { "from": "2026-01-01", "to": "2026-06-23" },
  "granularity": "month",
  "renewals_available": true,
  "health_available": true,
  "summary": {
    "up_for_renewal": 31,
    "renewed_count": 27,
    "churn_count": 4,
    "renewal_rate": 87,
    "base_value": 1180000.00,
    "renewed_value": 810000.00,
    "churned_value": 52000.00,
    "expansion_value": 64000.00,
    "contraction_value": 9000.00,
    "nrr": 102,
    "grr": 95
  },
  "churn_reasons": [
    { "reason": "price", "count": 2, "value": 30000.00 },
    { "reason": "switched vendor", "count": 1, "value": 14000.00 },
    { "reason": "out of business", "count": 1, "value": 8000.00 }
  ],
  "health_distribution": { "green": 18, "yellow": 6, "red": 3, "unknown": 4 },
  "series": [
    { "bucket_start": "2026-01-01", "renewed_count": 4, "churned_count": 1, "renewed_value": 120000.00, "churned_value": 8000.00 },
    { "bucket_start": "2026-02-01", "renewed_count": 5, "churned_count": 0, "renewed_value": 150000.00, "churned_value": 0.00 }
  ],
  "prev": {
    "range": { "from": "2025-01-01", "to": "2025-06-23" },
    "renewal_rate": 81,
    "churn_count": 6,
    "nrr": 96,
    "grr": 90
  }
}
```

- `churn_reasons[]` aggregates `service_contracts.churn_reason` (CS-3 column) over churned
  contracts in the window, grouped by the trimmed reason string, `count` + `value`
  (`computed_value`), ordered by `count DESC`. Empty array when the column is absent or
  no churn.
- All money fields are numeric (two-decimal); all rates are integer percents or `null`.

#### Error responses

- **400** — `{ "error": "custom window requires from=YYYY-MM-DD and to=YYYY-MM-DD" }` or
  `{ "error": "from must be on or before to" }` (identical to `/reports`).
- **403** — `requireFeature` (`reports_enabled` or `customer_success_enabled` off).
- **500** — `{ "error": "Failed to compute retention metrics", "detail": "<message>" }`,
  matching the `/reports` catch block; `requestId` correlates the structured log.

### 4.2 Probe / degradation implementation note

Run two cheap probes once per request (before the heavy queries):

```sql
SELECT to_regclass('account_health_snapshots') AS health_tbl,
       to_regclass('service_contracts')        AS sc_tbl,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'service_contracts' AND column_name = 'renewal_stage'
       ) AS has_renewal_stage;
```

- `renewals_available = sc_tbl IS NOT NULL AND has_renewal_stage` — gates the renewal /
  churn / NRR queries (return zeroed summary + empty series/`churn_reasons` when false).
- `health_available = health_tbl IS NOT NULL` — gates the health-distribution query.

This makes CS-6 robust to any deploy ordering relative to CS-2/CS-3.

### Frontend API client (`frontend/src/api.js`)

```js
// extend the existing metrics namespace (or add if none)
export const metrics = {
  // ...existing...
  retention: (window = 'ytd', from = null, to = null) => {
    const params = window === 'custom' ? { window, from, to } : { window };
    return api.get('/metrics/retention', { params }).then((r) => r.data);
  },
};
```

CSRF is irrelevant (GET); auth cookie + `withCredentials` are handled globally in `api.js`.

---

## 5. UI surface

### `frontend/src/pages/Reports.js` — new "Retention" tab

Reports is already a tabbed page (`TABS` array at line ~644, content switch at line ~692,
hero `PeriodSelector` at line ~660). CS-6 follows that exact pattern.

1. **Add the tab** to `TABS`:
   ```js
   { id: 'retention', label: 'Retention', hint: 'Renewal rate, churn, NRR, and installed-base health' },
   ```
   Render the tab button only when `getStageConfig(me.org_profile).showAccountManagement`
   is true (so generic/jcp don't see an empty 403 tab). Pull `me.org_profile` from
   `useAuth()` as the rest of the app does.

2. **Independent fetch.** Because `/metrics/retention` has its own shape, add a second
   `useEffect` that calls `metrics.retention(period, dateFrom, dateTo)` keyed on the same
   `[period, dateFrom, dateTo]` deps as the existing `/metrics/reports` fetch, storing
   into `retentionData` / `retentionError`. Reuse the same `PeriodSelector` value — the
   Retention tab honours the page-level period like every other tab.

3. **Render branch** at line ~692:
   ```jsx
   {tab === 'retention' && <RetentionTab data={retentionData} period={period}
       deltaLabel={deltaLabel(period, dateFrom, dateTo)} />}
   ```

4. **`<RetentionTab>`** (new component, same file or `frontend/src/components/`):
   - **Headline metric cards** with `<DeltaBadge>` (already used on other tabs):
     **NRR**, **Gross Renewal Rate**, **GRR**, **Churn (count + value)**. Each shows the
     current value and a delta vs `prev` (hidden when `prev` is null / `window=all`).
   - **Renewal/churn time series** — a `recharts` chart (recharts is already imported in
     Reports; `LineChart` or stacked `BarChart`) of `series`: renewed vs churned value per
     bucket on the X-axis (`bucket_start`), labelled by `granularity`.
   - **NRR/retention waterfall (lightweight)** — a small stacked bar or a labelled row:
     `base_value → −churned_value → −contraction_value → +expansion_value → ending`,
     so the NRR number is explainable at a glance.
   - **Installed-base health distribution** — a `recharts` `PieChart` (or stacked bar) of
     `health_distribution` (green/yellow/red/unknown). Hidden with an inline note
     ("Account health not yet enabled — see CS-2") when `health_available` is false.
   - **Churn reasons** — a small table of `churn_reasons` (reason · count · value),
     hidden when empty.
   - **Empty-state** when `renewals_available` is false: a single card
     ("Renewals data not yet configured. Enable the Renewals pipeline (CS-3) to populate
     renewal-rate, churn, and NRR metrics."). The tab still renders without error.

5. **`active` nav key** is unchanged — Reports already passes `active="reports"` to `<Nav />`.

No new route, no Nav change (Retention is a tab inside the existing `/reports` page).

---

## 6. Tests — `backend/test/retention.test.js`

Use the project's vitest convention (globals `describe`/`test`/`expect`/`vi`; mock
`pool.query`). At minimum one happy path **for the one new endpoint**, plus scoping and
degradation guards. Model the mock-`pool.query` style on `backend/test/renewals.test.js`
(per CS-3) or the supertest style of `backend/test/me.test.js`.

1. **Happy path** — mock the probe (`renewals_available: true`, `health_available: true`),
   the renewal/churn aggregate, the health-distribution rows, the churn-reason rows, the
   series rows, and the prior-period aggregate. Assert the response has `summary` with
   numeric `renewal_rate`, `nrr`, `grr`, `churn_count`; `health_distribution`;
   `churn_reasons[]`; `series[]`; and `prev`. Assert **`computed_value` falls back to
   `monthly_amount * 12`** when `annual_value` is null (verify by feeding a churned row
   with `annual_value: null, monthly_amount: 1000` and expecting `churned_value: 12000`).
2. **Renewal-rate math** — feed `renewed_count: 27`, `churned_count: 4` and assert
   `renewal_rate === 87` (27/31) and `up_for_renewal === 31`.
3. **NRR math** — feed `base_value`, `churned_value`, `contraction_value`,
   `expansion_value` and assert `nrr`/`grr` match the documented formula exactly.
4. **Divide-by-zero guards** — `up_for_renewal === 0` → `renewal_rate: null`;
   `base_value === 0` → `nrr: null`, `grr: null` (no thrown error / no `NaN`).
5. **Org-scoping** — assert every SQL string passed to `pool.query` contains the scope
   predicate (`org_id = $` or `user_id = $`) and that the scope value bound to `$1` is
   `req.orgId` (not any query param). A request setting a bogus `org_id` query param must
   not change the scope.
6. **CS-3 graceful degradation** — probe returns `has_renewal_stage: false` →
   `renewals_available: false`, zeroed `summary`, empty `series`/`churn_reasons`, HTTP 200
   (assert the renewal aggregate query was **not** issued).
7. **CS-2 graceful degradation** — probe returns `health_tbl: null` →
   `health_available: false`, all-zero `health_distribution`, HTTP 200 (assert the
   health-snapshot query was **not** issued).
8. **`window=custom` validation** — missing/invalid `from`/`to` → 400; `from > to` → 400
   (mirror `/reports`).
9. **`requireFeature` gate** — a request from an org without `customer_success_enabled`
   → 403 `code: FEATURE_DISABLED` before any aggregate query runs.
10. **`window=all` → `prev: null`** and `nrr: null` (no meaningful prior base), HTTP 200.

Run: `cd backend && npm test`.

---

## 7. Acceptance criteria (observable / demo-able)

1. With `customer_success_enabled` **and** `reports_enabled` on for a zang org, the
   **Reports** page shows a new **Retention** tab alongside Sales / Pipeline / Vendors.
2. The Retention tab shows headline cards for **NRR**, **Gross Renewal Rate**, **GRR**,
   and **Churn (count + value)**, each with a period-over-period delta badge that honours
   the hero period selector (7d / month / quarter / ytd / all / custom).
3. The numbers on the cards match `GET /api/metrics/retention?window=<same>` exactly
   (renewal rate = renewed / (renewed + churned), NRR per the documented formula).
4. A renewal/churn time-series chart renders for the selected window at the correct
   granularity (day/week/month), and a health-distribution chart shows the green/yellow/
   red/unknown split of the customer base.
5. Churn reasons (from CS-3's `churn_reason`) appear in a small breakdown when present.
6. With **CS-3 not yet shipped** (no `renewal_stage` column), the tab renders an
   empty-state card and the endpoint returns `renewals_available: false` with zeroed
   metrics — **no 500**.
7. With **CS-2 not yet shipped** (no `account_health_snapshots`), the health chart is
   hidden and the endpoint returns `health_available: false` — **no 500**.
8. With `customer_success_enabled` **off**, `GET /api/metrics/retention` returns **403**,
   while the existing `/api/metrics/reports`, `/dashboard`, `/salesman`, and
   `/vendor-performance` continue to work unchanged (the gate is route-level, not at the
   mount).
9. A user in org A can never see org B's retention numbers via the endpoint
   (org-scoping verified in test #5); a forged `org_id` query param has no effect.
10. `cd backend && npm test` passes, including the new `backend/test/retention.test.js`
    suite (≥1 happy path for the new endpoint plus the scoping/degradation/validation
    guards above).

---

## Open decisions / notes for the implementer

- **Count basis vs. value basis for "renewal rate":** this spec reports renewal rate on a
  **logo/count** basis (`renewed_count / up_for_renewal`) as the headline, with NRR/GRR
  carrying the **value** story. If Zang wants a value-weighted renewal rate too, add a
  `renewal_rate_value = renewed_value / (renewed_value + churned_value)` field to
  `summary` — trivial, same query.
- **Expansion/contraction depend on `renewed_contract_id`** (the CS-3 successor link).
  Until users actually link successors, `expansion_value`/`contraction_value` will be `0`
  and NRR will equal GRR. That is correct behaviour, not a bug — note it in the tab's
  helper text.
- **Window keys on `renewal_stage_changed_at` (CS-3 column) with `end_date` fallback.**
  Old contracts churned before CS-3 shipped won't have a `renewal_stage_changed_at`; the
  `COALESCE(renewal_stage_changed_at, end_date)` keeps them bucketed sensibly.
- **No worker, no automation rule.** Retention metrics are computed on read. If the org
  later wants a snapshotted retention trend independent of live contract edits, that is a
  separate ticket (a `retention_snapshots` table + worker) — explicitly out of CS-6.
- **CS-2 health "latest per company"** uses a `DISTINCT ON (company_id) … ORDER BY
  company_id, computed_at DESC` (Postgres idiom), org-scoped. Mirror whatever CS-2's own
  consumers use if CS-2 ships a helper view.
