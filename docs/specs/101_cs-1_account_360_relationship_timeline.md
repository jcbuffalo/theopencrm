# CS-1 — Account-level 360 / Relationship Timeline

**Status:** ✅ Backend shipped (branch `feat/customer-success-foundation`). This spec documents what actually shipped in `backend/routes/accountRoutes.js` and `backend/test/account-360.test.js`, plus the not-yet-built frontend follow-ups.

**Roadmap source:** `NEXT_STEPS.md` → "Customer Relationship Management (post-sale / customer success)" → CS-1 (P1).

**Why:** Comms (Gmail), activities, tasks, and issues all attach to *deals*. After Closed-Won there is no surface that aggregates everything happening with an account across all its deals and people. CS-1 is the roll-up that the rest of the CS foundation (CS-2 health, CS-3 renewals) hangs off of.

---

## 1. Files to touch

**Shipped (backend):**
- `backend/routes/accountRoutes.js` — the `GET /api/accounts/:companyId/360` route. Self-contained: declares its own `qs(req)` helper, mounts `authMiddleware` at the router level, issues 6 org-scoped read queries, merges them into one timeline.
- `backend/index.js` — `require('./routes/accountRoutes')` (line ~404) and the mount `app.use('/api/accounts', requireFeature('customer_success_enabled'), accountRoutes)` (line ~526). **The feature gate lives at the mount, not inside the route.**
- `backend/test/account-360.test.js` — happy-path + 404-cross-org test (see §6).

**Reads (existing tables, no schema change in this ticket):**
- `companies` (header + rollup columns `first_deal_at` / `last_deal_at`)
- `deals` (scoped by `customer_id = :companyId`)
- `activities`, `tasks` (scoped by `deal_id IN (...) OR contact_id IN (...)`)
- `issues` (scoped by `related_type = 'deal' AND related_id IN (...)`)
- `deal_gmail_summaries` (latest row per `thread_link_id` via `DISTINCT ON`)

**Not yet built (frontend follow-ups, see §8):**
- `frontend/src/pages/AccountDetail.js` (route `/accounts/:id`)
- Link from `frontend/src/pages/Companies.js` rows.
- `frontend/src/stages.js` — `showAccountManagement` toggle on `getStageConfig`.

---

## 2. New env vars

None. CS-1 introduces no env vars and degrades only via the feature flag (§4).

---

## 3. Migrations

None for CS-1 itself. CS-1 is a read-only roll-up over pre-existing tables. (The sibling tickets did add `095_account_health.sql` and `096_renewals.sql`; CS-1 touches neither.)

---

## 4. API endpoint

### `GET /api/accounts/:companyId/360`

- **Auth:** `authMiddleware` (router-level) → JWT in httpOnly cookie / `Authorization: Bearer` fallback.
- **Feature gate:** `requireFeature('customer_success_enabled')` at the `index.js` mount. Orgs without the flag get the gate's standard rejection before the route runs. The route file itself has no gate (so the test mounts it bare — see §6).
- **Org-scoping:** every query filters by `qs(req)` → `[sf, sv]` where `sf` is `org_id` (or `user_id` fallback). The deal/contact id-set sub-selects are themselves `${sf} = $2` scoped, so a caller cannot reach another org's data by passing a foreign `companyId`.
- **Path param:** `companyId` is `parseInt(..., 10)`; non-integer → **400** `{ error: 'Invalid company id' }`.

**Query order (load-bearing — the test mocks `pool.query` in exactly this sequence):**

1. `authMiddleware` — `SELECT org_id, org_role, status FROM users` (issued by middleware, not the route).
2. **Company header** — `SELECT ... FROM companies WHERE id = $1 AND ${sf} = $2`. Zero rows → **404** `{ error: 'Account not found' }`.
3. **Deals** — `SELECT ... FROM deals WHERE customer_id = $1 AND ${sf} = $2 ORDER BY updated_at DESC`.
4. **Activities** — `WHERE ${sf} = $2 AND (deal_id IN (deals sub-select) OR contact_id IN (contacts sub-select)) ORDER BY COALESCE(activity_date, created_at) DESC`.
5. **Tasks** — same scoping shape; `ORDER BY COALESCE(due_date, created_at) DESC`.
6. **Issues** — `WHERE ${sf} = $2 AND related_type = 'deal' AND related_id IN (deals sub-select) ORDER BY created_at DESC`. `related_id` is aliased `AS deal_id`.
7. **Gmail summaries** — `SELECT DISTINCT ON (thread_link_id) ... FROM deal_gmail_summaries WHERE ${sf} = $2 AND deal_id IN (deals sub-select) ORDER BY thread_link_id, generated_at DESC` (latest summary per thread).

**Response shape (200):**

```json
{
  "header": {
    "company": {
      "id": 99, "name": "...", "industry": "...", "website": null,
      "location": null, "employee_count": null, "annual_revenue": null,
      "status": "active", "type": "customer", "owner_id": null,
      "first_deal_at": null, "last_deal_at": null, "notes": null,
      "created_at": "...", "updated_at": "..."
    },
    "last_touch": "2026-06-20T15:00:00.000Z",
    "open_task_count": 0,
    "open_issue_count": 0,
    "open_deal_count": 0
  },
  "timeline": [
    {
      "type": "activity",
      "id": 501,
      "timestamp": "2026-06-20T15:00:00.000Z",
      "title": "Kickoff call",
      "detail": "Discussed onboarding",
      "meta": { "activity_type": "call", "outcome": "positive", "deal_id": null, "contact_id": 12 }
    }
  ]
}
```

**Timeline entry contract — every entry has `{ type, id, timestamp, title, detail, meta }`:**

| `type` | `timestamp` source | `title` | `detail` | `meta` keys |
|---|---|---|---|---|
| `activity` | `activity_date \|\| created_at` | activity title | description | `activity_type, outcome, deal_id, contact_id` |
| `task` | `due_date \|\| created_at` | task title | description | `status, priority, due_date, deal_id, contact_id` |
| `deal` | `updated_at \|\| created_at` | deal title | `null` | `stage, phase, amount, expected_close_date, closed_date` |
| `issue` | `created_at` | issue title | description | `category, urgency, status, deal_id, resolved_at` |
| `gmail_summary` | `generated_at` | `"Email thread summary"` (literal) | `summary_md` | `deal_id, thread_link_id, next_step` |

**Sort:** timeline is sorted DESC by `timestamp` in JS after merge; null timestamps coerce to epoch 0 and sink to the bottom.

**Header rollups (computed in JS, not SQL):**
- `open_task_count` — tasks whose `status` (lowercased) is not in `{done, completed, cancelled}`.
- `open_issue_count` — issues whose `status` (lowercased) is not in `{resolved, closed, cancelled}`.
- `open_deal_count` — deals whose `stage` is not in `{closed_won, closed_lost, CLOSED_WON, CLOSED_LOST}` (both casings checked — note stage casing varies by profile per the generic/zang stage graphs).
- `last_touch` — max `timestamp` across the whole merged timeline, ISO string, or `null` when the timeline is empty.

**Error shapes:** `400` invalid id · `404` not found / cross-org · `500` `{ error: 'Failed to fetch account 360' }` on any thrown error (logged as `'Account 360 error:'`).

---

## 5. UI surface

**Backend-only in this ticket.** The endpoint is live and tested; the consuming page is the CS-1 follow-up (§8). No existing page changed.

---

## 6. Tests

`backend/test/account-360.test.js` (Vitest + supertest, globals on). Mounts `accountRoutes` against a bare Express app **without the feature gate** (the gate is exercised at the `index.js` mount, not in the unit), with a fully mocked `pool.query` that resolves one queued response per route query in the documented order.

Two cases:
1. **Happy path** — auth row + company header + empty deals + one activity + empty tasks/issues/summaries → 200; asserts `header.company.id/name`, all three open counts `=0`, `last_touch` equals the activity date, and `timeline` is exactly `[{ type: 'activity', id: 501, title: 'Kickoff call', timestamp: <activityDate> }]`.
2. **Cross-org 404** — auth row + empty company header → 404 (proves the org-scoped header query is the access-control gate).

**Follow-up test gaps (not yet covered):** multi-type timeline merge + DESC ordering; null-timestamp sink-to-bottom; open-count filtering across both stage casings; `400` invalid-id branch; `DISTINCT ON` latest-summary-per-thread behavior.

---

## 7. Acceptance criteria

- ✅ `GET /api/accounts/:companyId/360` returns a header (company + last_touch + open task/issue/deal counts) and a single chronological (DESC) timeline merging activities, tasks, deals, issues, and Gmail thread summaries for the account.
- ✅ Every query is org-scoped; a foreign-org `companyId` returns 404, not another org's data.
- ✅ Route mounted behind `requireFeature('customer_success_enabled')`; orgs without the flag cannot reach it.
- ✅ Happy-path + cross-org tests pass.
- 🔴 **(follow-up)** Open a company in the UI → see every interaction across all its deals in one chronological timeline with last-touch date and open-item counts.

---

## 8. Follow-ups / open work

1. **Frontend `AccountDetail.js`** (route `/accounts/:id`) consuming this endpoint — header card (owner, health from CS-2, open items, last touch) + the timeline. Link from `Companies.js` rows.
2. **`showAccountManagement` toggle** in `frontend/src/stages.js` `getStageConfig` so the nav/links render only for CS-enabled profiles (`zang` / `rin`), keeping `generic` / `jcp` lean.
3. **Scope completeness:** activities/tasks attach by `deal_id` OR `contact_id`; issues are pulled **only** via `related_type = 'deal'`. Issues raised directly against a contact/company (if that ever lands) would be missed — revisit if the issues model grows a company-level relation.
4. **Pagination / windowing:** the timeline is unbounded — every activity/task/deal/issue/summary for the account is fetched and merged in memory. Add a date-window or limit param before large accounts make the payload heavy.
5. **N+1 sub-selects:** the deal/contact id-sets are recomputed as correlated sub-selects in each of the 4 detail queries. Acceptable at current scale; consider resolving the id-sets once (CTE or pre-fetch) if query count becomes a concern.
6. **Test coverage** for the gaps listed in §6.
