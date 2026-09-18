# CS-4 — Recurring Tasks / Touch Cadences

**Status:** Spec only — not yet implemented.
**Priority:** P2 (per `NEXT_STEPS.md` → "Customer Relationship Management (post-sale / customer success)" → CS-4).
**Effort:** ~2–3 days.
**Gating flag:** `customer_success_enabled` (module category, default `false`). Recurrence is added to the *existing* `/api/tasks` surface; the recurrence-specific endpoint and the regeneration worker are gated by this flag. The base task CRUD stays ungated.
**Author:** scoping pass, 2026-06-23.

---

## 0. Problem statement (from NEXT_STEPS.md)

> Tasks are one-off; only fixed automation thresholds nudge. No "touch every account quarterly."
> (Confirmed: no `recurring`/`RRULE`/`cadence` anywhere.)

We want a user to be able to mark a task as recurring with a simple cadence
(`every_n_days` / `weekly` / `monthly` / `quarterly`), and have the system spawn
the next occurrence when the task is completed (or, as a backstop, via a daily
worker). The cadence must be visible and editable on the task form.

**Deliberate scope limits (so another engineer doesn't over-build):**
- **No full RFC-5545 RRULE engine.** We store a small, validated JSON cadence
  object, not an `RRULE` string. The migration column is named generically
  (`recurrence_rule TEXT, per NEXT_STEPS.md`) but we store our own compact JSON
  in it so a future RRULE upgrade is a parse change, not a migration.
- **Completion-triggered spawn is the primary mechanism.** The daily worker is a
  backstop for tasks that were completed while the worker process was down, and
  it is the *only* path for cadences anchored to a fixed schedule rather than to
  completion. Both paths funnel through one pure `nextOccurrence()` function and
  one idempotent `spawnNext()` so there is a single source of truth.
- **Recurrence is a property of a task chain, not a separate entity.** Each
  occurrence is a normal `tasks` row; `recurrence_parent_id` links every spawned
  occurrence back to the *original* (chain root) task.

---

## 1. Files to touch

### Backend — new files
| Path | Purpose |
|---|---|
| `backend/migrations/095_recurring_tasks.sql` | `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence_rule TEXT, ADD COLUMN IF NOT EXISTS recurrence_parent_id INTEGER` + supporting index. (Next free prefix: 094 is latest.) |
| `backend/services/recurrence.js` | Pure, dependency-free helpers: `parseRule(text)`, `validateRule(obj)`, `nextOccurrence(rule, fromDate)`. No DB, no I/O — unit-testable in isolation. |
| `backend/services/recurringTaskWorker.js` | Background worker: daily `tick()` / `startScheduler()` / `stopScheduler()` triple modeled exactly on `backend/services/overdueTaskWorker.js`. Backstop spawner for completed-but-unspawned recurring tasks. |
| `backend/test/recurrence.test.js` | Unit tests for the pure `recurrence.js` helpers. |
| `backend/test/recurring-tasks.test.js` | HTTP + worker integration tests (supertest against a mounted `taskRoutes`, plus a direct `recurringTaskWorker.tick()` call). |

### Backend — edited files
| Path | Change |
|---|---|
| `backend/schemas/tasks.js` | Add `recurrence` field to `createSchema` and `updateSchema` (zod object validating the cadence shape; `null` clears recurrence). Keep `.passthrough()`. |
| `backend/routes/taskRoutes.js` | (a) Accept + persist `recurrence_rule` on POST/PUT. (b) When a PUT transitions a recurring task's `status` to `done`, synchronously call `recurrence.spawnNext()` and return the spawned child id in the response. (c) Add `GET /:id/recurrence-series` (gated). All queries keep the `qs(req)` org-scope. |
| `backend/services/featureFlags.js` | Add `customer_success_enabled` to `KNOWN_FLAGS` (module, default `false`). Shared with the other CS-* items — add once if not already present from CS-1/CS-2/CS-3. |
| `backend/index.js` | (a) Mount the new recurrence sub-route behind `requireFeature('customer_success_enabled')` — note the existing base `/api/tasks` mount stays ungated; only the `/recurrence-series` reader is gated, achieved by an in-router guard (see §4). (b) Register `recurringTaskWorker.startScheduler()` in the worker block (~line 815, after the overdue-task worker), guarded by `automationEnabled`. |

### Frontend — edited files
| Path | Change |
|---|---|
| `frontend/src/pages/Tasks.js` | Add a recurrence picker to `TaskForm` (cadence type + interval + an "ends" option). Show a small "↻ repeats quarterly" badge on recurring task rows. Read `me.org_profile` config (`showAccountManagement` from `getStageConfig`) to decide whether to render the picker. |
| `frontend/src/stages.js` | Add `showAccountManagement` boolean to the `getStageConfig` return object (`profile === 'zang' || profile === 'rin'`). Shared with CS-1; add once. The recurrence picker renders only when this is true. |
| `frontend/src/api.js` | Add `tasks.recurrenceSeries(id)` helper (or inline `api.get('/tasks/:id/recurrence-series')`); recurrence on create/update flows through the existing `api.post('/tasks')` / `api.put('/tasks/:id')` calls — no new client object strictly required. |

**Not touched:** `_bulkOps.js` (recurrence is intentionally *not* a bulk-editable
column — leave the allowlist `['assigned_to','status','due_date','priority']` as
is). `notificationDispatcher.js` (a spawned occurrence with an `assigned_to`
inherits the existing assignment-notification path automatically through the
normal INSERT).

---

## 2. New env vars + graceful degradation

| Var | Default | Purpose | Degradation |
|---|---|---|---|
| `RECURRING_TASK_WORKER_INTERVAL_MINUTES` | `60` | How often the backstop worker ticks. | Absent → 60 min. |
| `RECURRING_TASK_WORKER_MAX_PER_RUN` | `500` | Cap on spawns per tick (bounds runtime on large tenants; identical to `OVERDUE_WORKER_MAX_PER_RUN`). | Absent → 500. |

**Graceful degradation rules:**
- **No new required env vars.** Nothing here blocks boot.
- The worker only starts when `automationEnabled` is true
  (`NODE_ENV === 'production'` or `AUTOMATION_ENABLED === 'true'`) — same gate as
  every other worker in `index.js`. In local dev it stays dormant unless opted in.
- The **completion-triggered spawn** in `taskRoutes.js` runs regardless of the
  worker (it is in-request), so recurrence works even if the worker never starts.
  If `recurrence.spawnNext()` throws, the failure is caught and logged; the PUT
  still returns 200 with the parent's `done` state (a missed spawn is recoverable
  by the daily worker — never break the user's "mark done" action).
- If `customer_success_enabled` is **off** for the org, recurrence fields are
  accepted-but-ignored is **not** acceptable (silent data) — instead the
  recurrence picker is hidden in the UI for non-CS profiles, and the
  `/recurrence-series` reader returns 403 via `requireFeature`. The base task
  POST/PUT still *persists* a `recurrence_rule` if one is sent (so an org that
  later flips the flag on keeps its data), but the spawn worker scopes its scan
  to orgs that have the flag enabled (see §4 worker note).

---

## 3. Migration

**File:** `backend/migrations/095_recurring_tasks.sql`

Critical constraint from the survey: `tasks` is a duplicate-table-migration
target (012/024). **Never** bare-`CREATE`/`ALTER` without `IF NOT EXISTS`.

```sql
-- 095 — CS-4: recurring tasks / touch cadences.
--
-- Adds two nullable columns to `tasks`:
--   recurrence_rule      — compact JSON cadence (our own shape, NOT RFC-5545
--                          RRULE — see services/recurrence.js). NULL == one-off.
--   recurrence_parent_id — FK to the ORIGINAL (chain-root) task this occurrence
--                          was spawned from. NULL on the root task itself.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS so re-running is a no-op. `tasks` is a
-- duplicate-table-migration target (012/024) — bare ALTER without the guard is
-- unsafe.

BEGIN;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS recurrence_rule TEXT;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS recurrence_parent_id INTEGER;

-- Partial index: only recurring rows (root + occurrences) participate, keeping
-- the index small on tenants whose tasks are overwhelmingly one-off. Supports
-- the worker's "find recurring tasks that need a next occurrence" scan and the
-- /recurrence-series reader.
CREATE INDEX IF NOT EXISTS idx_tasks_recurrence_parent_id
  ON tasks(recurrence_parent_id)
  WHERE recurrence_parent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_recurrence_rule
  ON tasks(id)
  WHERE recurrence_rule IS NOT NULL;

COMMIT;
```

**Sequencing note:** 095 only touches `tasks`, which already exists, so it has no
ordering dependency on CS-1/CS-2/CS-3 migrations. If those land first they take
092a/093.../095 etc.; CS-4 simply takes the next free number at implementation
time. As of this writing 094 is the latest committed migration, so **095** is
correct.

### Stored cadence shape (`recurrence_rule` JSON)

```jsonc
{
  "type": "every_n_days" | "weekly" | "monthly" | "quarterly",
  "interval": 1,            // integer >= 1. For every_n_days = number of days.
                            // For weekly/monthly/quarterly = number of those units.
  "anchor": "completion" | "due_date",  // what the next due_date is computed from
  "ends": {                 // optional; omit/null = never ends
    "after_occurrences": 12 // OR
    // "on_date": "2027-01-01"
  } | null
}
```

`anchor: "completion"` → next `due_date` = completion date + interval.
`anchor: "due_date"` → next `due_date` = previous `due_date` + interval (keeps a
fixed calendar cadence even if the user completes late). Default `"completion"`.

---

## 4. API endpoints

All routes under `/api/tasks` already require auth (`router.use(authMiddleware)`)
and org-scope via `qs(req) → [sf, sv]`. Existing CRUD shapes are unchanged except
the additive `recurrence` field on the request/response bodies.

### 4.1 `POST /api/tasks` (existing — additive)
- **Auth:** authMiddleware. Org-scoped on insert (`org_id`/`user_id`).
- **Feature gate:** none (base CRUD stays open; recurrence field persists even if
  flag off, per §2).
- **Request (additive field):**
  ```jsonc
  {
    "title": "Quarterly check-in — Acme",
    "due_date": "2026-07-01",
    "assigned_to": 42,
    "recurrence": {            // optional; null/omit = one-off
      "type": "quarterly",
      "interval": 1,
      "anchor": "completion",
      "ends": { "after_occurrences": 8 }
    }
  }
  ```
- **Server behavior:** zod validates `recurrence` via `taskSchemas`; the route
  serializes it with `JSON.stringify(recurrence)` into `recurrence_rule`.
  `recurrence_parent_id` is left NULL — a freshly created recurring task is its
  own chain root.
- **Response 201:** the created row, now including `recurrence_rule` (string) and
  `recurrence_parent_id` (null).

### 4.2 `PUT /api/tasks/:id` (existing — additive + spawn trigger)
- **Auth + scope:** unchanged (`WHERE id = $ AND ${sf} = $`).
- **Request:** same body as POST; `recurrence: null` clears recurrence; omitting
  `recurrence` leaves it unchanged (COALESCE semantics, matching the existing
  field handling).
- **Spawn-on-complete:** if the PUT sets `status = 'done'` AND the *prior* row had
  a non-null `recurrence_rule` AND the cadence has not reached its `ends`
  condition, the route calls `recurrence.spawnNext({ pool, task, completedAt })`
  synchronously *after* the UPDATE succeeds and before responding.
  - The prior status + rule are read in the same pre-UPDATE SELECT the route
    already does for `assigned_to` (extend that query to also select `status`,
    `recurrence_rule`, `due_date`, `recurrence_parent_id`).
  - Guard against double-spawn: only spawn when prior status `!= 'done'` (so
    re-saving an already-done task does not spawn again).
  - Spawn failure is caught and logged (`logger.warn('recurring_spawn_failed', …)`);
    the PUT still returns 200.
- **Response 200:**
  ```jsonc
  {
    ...updatedTaskRow,
    "spawned_task_id": 9876   // present only when a next occurrence was created
  }
  ```

### 4.3 `GET /api/tasks/:id/recurrence-series` (new — gated)
- **Method/path:** `GET /api/tasks/:id/recurrence-series`
- **Auth:** authMiddleware.
- **Feature gate:** `requireFeature('customer_success_enabled')` — applied
  per-route inside `taskRoutes.js` (see mount note) so it returns **403** for orgs
  without the flag.
- **Scope:** resolves the chain root (the row whose `recurrence_parent_id IS NULL`
  for this chain — either `:id` itself or its `recurrence_parent_id`), then
  returns all tasks where `id = root OR recurrence_parent_id = root`, all
  `AND ${sf} = $` org-scoped.
- **Response 200:**
  ```jsonc
  {
    "root_id": 1234,
    "rule": { "type": "quarterly", "interval": 1, "anchor": "completion", "ends": null },
    "occurrences": [
      { "id": 1234, "due_date": "2026-07-01", "status": "done",  "is_root": true },
      { "id": 9876, "due_date": "2026-10-01", "status": "open",  "is_root": false }
    ]
  }
  ```
- **404** if the task isn't found in the caller's org scope.

**Mount note (index.js):** `/api/tasks` is mounted ungated today. To gate only
the new reader without splitting the router, apply `requireFeature(...)` *inside*
`taskRoutes.js` on the specific `router.get('/:id/recurrence-series', requireFeature('customer_success_enabled'), handler)`
line. Keep the new sub-route registered **before** the generic `GET /:id` is not
required (Express matches the longer literal path first), but register
`/:id/recurrence-series` before `/:id` anyway for clarity, mirroring the
bulk-routes-before-`/:id` ordering already in the file.

### 4.4 Worker (not an HTTP endpoint) — `recurringTaskWorker.tick()`
- Daily backstop. Scans for recurring tasks that are `done`, belong to an org
  with `customer_success_enabled`, and whose chain has **no** open successor yet
  (i.e., completion-triggered spawn was missed). For each, calls the same
  `recurrence.spawnNext()`. Idempotent: the "no open successor" predicate is the
  dedupe — a chain that already has its next occurrence is skipped. Capped at
  `RECURRING_TASK_WORKER_MAX_PER_RUN`.
- Org-flag scoping: the scan joins to the feature-flag source
  (`services/featureFlags.hasFeature` is per-call; the worker instead filters in
  SQL against the flags table the flag registry writes to — follow the same
  pattern `automation.js` uses to scope its rules per org). If a simple SQL join
  is awkward, the worker may load enabled-org ids via `featureFlags` once per tick
  and `WHERE org_id = ANY($enabledOrgIds)`.

---

## 5. UI surface

**Page:** `frontend/src/pages/Tasks.js` (existing). No new route.

1. **Recurrence picker in `TaskForm`** (rendered only when
   `getStageConfig(profile).showAccountManagement` is true):
   - A "Repeats" `<select>`: `Does not repeat` (default) · `Every N days` ·
     `Weekly` · `Monthly` · `Quarterly`.
   - When not "Does not repeat", show an interval number input (`Every [N]
     {days|weeks|months|quarters}`), an anchor toggle (`from completion date` /
     `keep fixed schedule` → maps to `anchor`), and an optional "Ends after [N]
     occurrences" input.
   - Form state holds a `recurrence` object; `submit()` sends `recurrence` (or
     `null` when "Does not repeat") in the existing POST/PUT payload.
   - Editing an existing recurring task hydrates the picker from
     `JSON.parse(task.recurrence_rule)`.
2. **Row badge:** on each task row in the list, if `task.recurrence_rule` is
   present, render a small badge `↻ {humanize(rule)}` (e.g. "↻ quarterly") next to
   the existing status/priority badges.
3. **Series peek (optional, low-cost):** clicking the badge can open the
   `/recurrence-series` reader in a small drawer/modal showing the occurrence
   list. This is nice-to-have; the badge alone satisfies "cadence is visible."

**Profiles:** picker + badge appear for `zang` / `rin` (CS-enabled) profiles only.
For `generic` / `jcp`, `showAccountManagement` is false → no picker, and any
recurrence already on a row simply renders as a normal task (forward-compatible).

---

## 6. Tests (>= 1 happy path per endpoint)

Test runner: `vitest run` (from `backend/`). Follow the existing pattern — patch
the live `require('../db')` pool with `vi.fn()` mocks (see
`backend/test/me.test.js`, `backend/test/gmailSummary.test.js`), mount the router
on a tiny Express app with `cookie-parser` + a generated auth cookie
(`generateToken`, `AUTH_COOKIE_NAME` from `../auth`).

### `backend/test/recurrence.test.js` (pure unit)
- `nextOccurrence` for `every_n_days` (interval 14, anchor completion) →
  completion + 14 days.
- `nextOccurrence` for `quarterly` (anchor due_date) → prior due_date + 3 months.
- `validateRule` rejects `interval: 0`, unknown `type`, and bad `ends`.
- `ends.after_occurrences` reached → `nextOccurrence`/`spawnNext` decision returns
  "no spawn".

### `backend/test/recurring-tasks.test.js` (HTTP + worker)
- **POST happy path:** `POST /tasks` with a `recurrence` object → 201, response
  includes `recurrence_rule` (JSON string) and `recurrence_parent_id: null`.
  Assert the INSERT params carried the serialized rule.
- **PUT spawn-on-complete happy path:** seed a recurring task (mock the pre-UPDATE
  SELECT returning prior `status:'open'`, a `recurrence_rule`, a `due_date`); `PUT
  /tasks/:id` with `{ status: 'done' }` → 200, body has `spawned_task_id`; assert a
  second INSERT (the child) was issued with the computed next `due_date` and
  `recurrence_parent_id` = root id.
- **PUT no double-spawn:** prior status already `done` → `PUT {status:'done'}`
  returns 200 with **no** `spawned_task_id` and no child INSERT.
- **PUT clears recurrence:** `PUT /tasks/:id` with `recurrence: null` → 200,
  `recurrence_rule` set to NULL; completing it later does not spawn.
- **GET /:id/recurrence-series happy path (flag ON):** mock root + one child rows
  → 200, `occurrences.length === 2`, `root_id` correct, `is_root` flags correct.
- **GET /:id/recurrence-series gated (flag OFF):** `requireFeature` → 403.
- **Org-scope guard:** `GET /:id/recurrence-series` for an id outside the caller's
  org (mock SELECT returns 0 rows) → 404; assert the SQL carried `AND org_id = $`
  / `AND user_id = $`.
- **Worker happy path:** call `recurringTaskWorker.tick()` directly with a mocked
  pool returning one completed recurring task whose chain has no open successor →
  asserts one child INSERT; second `tick()` with the successor now present →
  no INSERT (idempotent).

### Frontend (optional, if a frontend test harness is wired)
- Render `TaskForm` with a `zang` profile context → recurrence picker present;
  with `generic` → absent. (Frontend tests are not currently part of the backend
  `vitest run` suite; treat as nice-to-have unless a frontend test setup exists.)

---

## 7. Acceptance criteria (observable / demo-able)

1. **Create recurring:** On a CS-enabled org (`zang`/`rin`), creating a task with
   "Repeats: Quarterly" persists; reopening the task shows the picker pre-filled
   with quarterly.
2. **Spawn on completion:** Marking that quarterly task **done** immediately
   creates a new open task with the same title, `recurrence_rule`, and a
   `due_date` three months out, linked via `recurrence_parent_id`. The list shows
   the new occurrence without a page reload after `load()`.
3. **Visible cadence:** Recurring task rows show a `↻ quarterly` badge; one-off
   tasks show none.
4. **Editable cadence:** Changing the cadence to "Monthly" (or "Does not repeat")
   on the parent updates `recurrence_rule`; subsequent completions follow the new
   cadence (or stop, when cleared).
5. **Ends condition honored:** A cadence with `ends.after_occurrences: 2` stops
   spawning after the second occurrence completes.
6. **No double-spawn:** Re-saving an already-done recurring task does not create a
   duplicate occurrence.
7. **Backstop worker:** With the worker enabled, a recurring task that was
   completed while the worker was the only path (e.g., completion-spawn was
   simulated to fail) gets its next occurrence created on the next daily tick, and
   re-running the tick does not duplicate it.
8. **Gating:** On a `generic`/`jcp` org the recurrence picker is hidden and
   `GET /api/tasks/:id/recurrence-series` returns 403.
9. **Org isolation:** A user in org A cannot read org B's recurrence series
   (`/recurrence-series` for a foreign id returns 404; the chain query is
   org-scoped via `qs(req)`).
10. **No boot regression:** Backend boots with no new required env vars;
    migration 095 is idempotent (re-run is a no-op); the worker only starts when
    `automationEnabled` is true.
