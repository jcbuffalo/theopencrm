# CS-8 — Calendar / Meeting Object (extend `meeting_logs`)

**Status:** Spec only — not yet implemented.
**Priority:** P3 (per `NEXT_STEPS.md` → "Customer Relationship Management (post-sale / customer success)" → CS-8).
**Effort:** ~3 days.
**Gating flag:** `customer_success_enabled` (module category, default `false`). The
new `/api/meetings` write/list surface and the `/meetings` page are gated. The
**existing** inbound webhook receivers (`/api/webhooks/teams`, `/api/webhooks/zoom`)
and the existing read-only `GET /api/webhooks/meetings` are **left untouched** and
remain ungated — CS-8 *extends* `meeting_logs`, it does not gate the integration
ingestion path.
**Author:** scoping pass, 2026-06-23.

---

## 0. Problem statement (from NEXT_STEPS.md)

> **Why:** QBRs, check-ins, renewal calls have no first-class home; no calendar
> sync. **Effort:** ~3 days (note `meeting_logs` already exists via the Teams/Zoom
> webhooks — extend rather than duplicate). **Files:** promote `meeting_logs` to a
> schedulable `meetings` object linked to `company_id`; surface on CS-1.

Today `meeting_logs` (migration `045_phase5_scaffolds.sql`) is a **passive log** of
meetings that *already happened*: the Teams/Zoom webhook receivers in
`backend/routes/webhookRoutes.js` (`insertMeetingLog(...)`) INSERT a row after a
call ends, and the read-only `GET /api/webhooks/meetings` surfaces them on the deal
timeline. There is **no way to schedule** an upcoming QBR / check-in / renewal call,
no link to the **account** (`company_id`), no owner, no status (`scheduled →
completed → canceled`), and no agenda/notes captured by a CSM ahead of the call.

CS-8 **promotes `meeting_logs` to a schedulable, account-linked meeting object**
by:
1. Adding the columns needed to *schedule* a meeting (start/end, status, agenda,
   owner, account/contact links, a meeting `kind` such as `qbr`/`check_in`/
   `renewal_call`), all via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (the table
   already exists, so a bare `CREATE TABLE` would be wrong here).
2. Adding a new authenticated, org-scoped, CS-gated CRUD surface `/api/meetings`
   for staff to create / list / update / cancel meetings.
3. Surfacing meetings on a new `/meetings` page (upcoming + past) and — forward
   compat — as a `type:'meeting'` entry on the CS-1 account-360 timeline.

**Deliberate scope limits (so another engineer doesn't over-build):**
- **No live two-way calendar sync in this pass.** A *one-way* `.ics` export per
  meeting (download + an `ICS` feed token) is the "calendar" deliverable; live
  Google/Microsoft Graph two-way sync is explicitly deferred (see §2 — it reuses
  the existing in-app integration-credential machinery from `089_platform_integrations.sql`
  / `services/driveAuth.js`, but is **out of scope** for CS-8 MVP and called out as
  a follow-up).
- **No new table.** We extend `meeting_logs` in place. The webhook-ingested rows
  (`source IN ('teams','zoom')`) and the staff-scheduled rows (`source = 'manual'`,
  `status = 'scheduled'`) coexist in one table; the new columns default to NULL /
  back-compatible values so existing webhook rows are unaffected.
- **No invitee emailing / RSVP tracking.** Participants stay a free-text string
  (the existing `participants TEXT` column). Sending calendar invites to attendees
  is deferred with the two-way-sync follow-up.

---

## 1. Files to touch

### Backend — new files
| Path | Purpose |
|---|---|
| `backend/migrations/097_meetings_schedulable.sql` | `ALTER TABLE meeting_logs ADD COLUMN IF NOT EXISTS ...` to promote the log to a schedulable object (see §3). **Next free prefix:** `094` is the latest committed migration; CS-1/2/3/4/5 sibling specs reserve `095`/`096` in parallel, so CS-8 takes **097** (the next free 3-digit prefix at implementation time). |
| `backend/routes/meetingRoutes.js` | Authenticated, org-scoped CRUD for `/api/meetings`. Modeled on `backend/routes/issueRoutes.js` (closest analogue: status lifecycle + `qs(req)` scoping) and `serviceContractRoutes.js` (account-level JOIN shape). Also serves the per-meeting `.ics` download and the token ICS feed. |
| `backend/schemas/meetings.js` | Zod `createSchema` / `updateSchema`, modeled on `backend/schemas/issues.js` (same `optStr` / `optInt` / `optNum` helpers, `.passthrough()`). |
| `backend/services/icsFeed.js` | Pure helper that serializes a meeting row (or rows) to RFC-5545 VEVENT text. No external dependency (hand-rolled string builder — the stack has no ICS lib and one isn't warranted). Exports `meetingToVEvent(row)` and `meetingsToCalendar(rows, { calName })`. |
| `backend/test/meetings.test.js` | HTTP integration tests (supertest against a mounted `meetingRoutes`); ≥1 happy path per endpoint + org-scope guards + gating test + an `.ics` content assertion. |

### Backend — edited files
| Path | Change |
|---|---|
| `backend/services/featureFlags.js` | Add `customer_success_enabled` to `KNOWN_FLAGS` (category `module`, `defaultValue: false`). **Shared with CS-1..CS-6 — add once if not already present.** |
| `backend/index.js` | (a) `const meetingRoutes = require('./routes/meetingRoutes');` in the route-import block (~lines 374–410, after `metricsRoutes`/`serviceContractRoutes`). (b) Mount `app.use('/api/meetings', requireFeature('customer_success_enabled'), meetingRoutes);` near the other CS / service-contract mounts (~line 523, after `/api/service-contracts`) with `console.log('✅ Mounted: /api/meetings (CS-8, gated by customer_success_enabled)');`. (c) **CSRF exemption** for the public token ICS feed: add `'/api/meetings/feed'` (prefix match) to the `csrfIgnoredRoutes` list (~lines 172–184) — the feed is a `GET` consumed by external calendar clients that can't send a CSRF header. (GET is not CSRF-protected anyway, but the route is also auth-exempt via token — see §4.7 — so document it alongside the other token feeds.) |
| `backend/routes/webhookRoutes.js` | **No behavioral change required.** Optional one-liner: in `insertMeetingLog(...)` set the new `status` column to `'completed'` and `kind` to `'integration'` for ingested rows so they sort correctly in the new `/meetings` "past" view. If the column defaults (see §3) already produce that, skip the edit. |
| `backend/services/automation.js` | **Optional** — add a `meeting_followup_task` rule to `RULES[]` (modeled on `service_contract_renewal_due` / `dormant_customer_outreach`): when a `status='scheduled'` meeting's `end_at` has passed and it has no follow-up recorded, create a normal-priority "Log notes / follow-up: &lt;title&gt;" task for the meeting owner and `recordRun(...)` to dedupe. Uses the existing `alreadyFired` / `recordRun` / task-creation helpers. |
| **CS-1 `backend/routes/accountRoutes.js`** | When CS-1 ships, its `GET /api/accounts/:companyId/360` timeline UNION must add a `{ type: 'meeting', ... }` branch reading `meeting_logs WHERE company_id = $1 AND ${sf} = $`. CS-8 does **not** edit CS-1's file (it may not exist yet); this is a forward-compat note so the CS-1 author includes meetings. |

### Frontend — new files
| Path | Purpose |
|---|---|
| `frontend/src/pages/Meetings.js` | New page at route `/meetings` — an "Upcoming" + "Past" split list of meetings (kind / status / owner filters) with a create/edit drawer or modal and a per-meeting "Add to calendar (.ics)" button. Modeled on the existing list-page + `DataTable` pattern (see `frontend/src/pages/Companies.js`). Passes `active="meetings"` to `<Nav>`. |

### Frontend — edited files
| Path | Change |
|---|---|
| `frontend/src/App.js` | Register the route inside the **authenticated** block (~lines 122–169): `const Meetings = lazyWithRetry(() => import('./pages/Meetings'));` then `<Route path="/meetings" element={<Meetings />} />`. |
| `frontend/src/components/Nav.js` | Add a `{ to: '/meetings', label: 'Meetings', key: 'meetings' }` link to `NAV_LINKS_ZANG` (and `NAV_LINKS_RIN` when it exists), rendered only when `showAccountManagement` is true. Wire into both desktop (~line 195) and mobile (~line 244) link maps. |
| `frontend/src/stages.js` | Ensure `getStageConfig` returns `showAccountManagement: profile === 'zang' || profile === 'rin'`. **Shared with CS-1/CS-2/CS-4/CS-5 — add once.** The `/meetings` nav link renders only when this is true. |
| `frontend/src/api.js` | Add a `meetings` namespace: `list(params)`, `get(id)`, `create(body)`, `update(id, body)`, `cancel(id)`, and a non-axios `icsUrl(id)` helper returning the per-meeting `.ics` download URL. Follows the `drive` / `gmail` / `gmailThreads` namespace pattern (api.js ~lines 177–310). CSRF header is auto-attached by the existing axios interceptor — no per-call handling. |
| `frontend/src/pages/AccountDetail.js` (CS-1) | Forward-compat: render `type === 'meeting'` timeline entries with a meeting badge + a "Add to calendar" link. Note only — built when CS-1 ships. |

**Not touched:** the existing webhook ingestion path
(`POST /api/webhooks/teams`, `POST /api/webhooks/zoom`) and the existing
`GET /api/webhooks/meetings` reader keep working exactly as today; CS-8 only **adds
columns** to their shared table and **adds** a new authenticated surface.

---

## 2. New env vars + graceful degradation

| Var | Default | Purpose | Degradation |
|---|---|---|---|
| `MEETING_ICS_FEED_SECRET` | *(unset)* | HMAC secret used to mint/verify the per-org ICS feed token (`/api/meetings/feed?token=...`). When unset, the **token feed self-disables** (the endpoint returns 404 and the "Subscribe in your calendar" UI affordance is hidden), but the **per-meeting one-off `.ics` download still works** (it's auth-cookie protected, not token protected). | Absent → token feed 404; everything else works. |
| `MEETING_FOLLOWUP_WORKER_MAX_PER_RUN` | `200` | Cap on rows the *optional* `meeting_followup_task` automation rule scans per tick (bounds runtime; matches the `LIMIT 200` used by `dormant_customer_outreach`). | Absent → 200. |

**Graceful degradation rules:**
- **No new *required* env vars.** Nothing here blocks boot
  (`services/envValidation.js` is untouched; `MEETING_ICS_FEED_SECRET` is optional).
- **Two-way calendar sync is NOT in this pass.** If a future follow-up adds live
  Google Calendar sync, it reuses the in-app integration-credential machinery
  (`089_platform_integrations.sql`, `DRIVE_TOKEN_ENCRYPTION_KEY`,
  `services/driveAuth.js`) — credentials stored per-org, encrypted, with the
  env-var path as a back-compat fallback. CS-8 ships the **one-way `.ics`** path,
  which has **zero external dependency** and degrades to pure DB CRUD.
- If `customer_success_enabled` is **off**, every `/api/meetings` request returns
  **403** at the mount via `requireFeature`, and the `/meetings` nav link is hidden
  (`showAccountManagement` false). No partial/silent behavior.
- The optional `meeting_followup_task` rule lives inside `services/automation.js`,
  which only runs when the scheduler is started (`automationEnabled = NODE_ENV ===
  'production' || AUTOMATION_ENABLED === 'true'`). It self-skips orgs without
  `customer_success_enabled` (per-org flag check, same pattern as the other rules),
  contributing 0 fired for those orgs.

---

## 3. Migration

**File:** `backend/migrations/097_meetings_schedulable.sql`

`meeting_logs` is an **existing** table (created in `045_phase5_scaffolds.sql`), so
this migration uses **`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`** exclusively — a
bare `CREATE TABLE` would be wrong, and although `meeting_logs` is *not* one of the
duplicate-table-migration targets (contacts/deals/activities), the `IF NOT EXISTS`
guard keeps the migration idempotent on re-run (the startup runner treats
"already exists" as benign and re-runs the whole file on every boot).

New columns and their meaning (all nullable / defaulted so the existing webhook rows
remain valid):

```sql
-- 097 — CS-8: promote meeting_logs from a passive integration LOG into a
-- schedulable, account-linked MEETING object (QBRs, check-ins, renewal calls).
--
-- meeting_logs already exists (045_phase5_scaffolds.sql) and is populated by the
-- Teams/Zoom webhook receivers (routes/webhookRoutes.js). We EXTEND it in place —
-- ADD COLUMN IF NOT EXISTS only, never CREATE TABLE — so ingested rows keep
-- working while staff can now SCHEDULE meetings against an account (company_id).
--
-- New rows created by /api/meetings use source='manual', status='scheduled'.
-- Webhook-ingested rows keep source IN ('teams','zoom') and (via the new default)
-- status='completed'.

BEGIN;

-- Account / context links (company_id is the canonical CS-1 account-360 pivot).
ALTER TABLE meeting_logs ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE meeting_logs ADD COLUMN IF NOT EXISTS deal_id    INTEGER REFERENCES deals(id)     ON DELETE SET NULL;
ALTER TABLE meeting_logs ADD COLUMN IF NOT EXISTS contact_id INTEGER REFERENCES contacts(id)  ON DELETE SET NULL;

-- Ownership + categorization.
ALTER TABLE meeting_logs ADD COLUMN IF NOT EXISTS owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE meeting_logs ADD COLUMN IF NOT EXISTS kind   VARCHAR(30);   -- 'qbr' | 'check_in' | 'renewal_call' | 'kickoff' | 'integration' | 'other'
ALTER TABLE meeting_logs ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'completed'; -- 'scheduled' | 'completed' | 'canceled'

-- Scheduling window. occurred_at already exists (start of an ingested call);
-- start_at/end_at are the planned window for a SCHEDULED meeting. For ingested
-- rows occurred_at remains the source of truth; for scheduled rows start_at is.
ALTER TABLE meeting_logs ADD COLUMN IF NOT EXISTS start_at TIMESTAMP;
ALTER TABLE meeting_logs ADD COLUMN IF NOT EXISTS end_at   TIMESTAMP;
ALTER TABLE meeting_logs ADD COLUMN IF NOT EXISTS location TEXT;          -- room / call URL / address
ALTER TABLE meeting_logs ADD COLUMN IF NOT EXISTS agenda   TEXT;          -- pre-meeting agenda
ALTER TABLE meeting_logs ADD COLUMN IF NOT EXISTS notes    TEXT;          -- post-meeting notes (distinct from existing `summary`)

-- Bookkeeping.
ALTER TABLE meeting_logs ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE meeting_logs ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMP;
ALTER TABLE meeting_logs ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Indexes for the new list/filter/sort paths.
CREATE INDEX IF NOT EXISTS idx_meeting_logs_company   ON meeting_logs(company_id);   -- CS-1 account-360 join
CREATE INDEX IF NOT EXISTS idx_meeting_logs_owner     ON meeting_logs(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_meeting_logs_status    ON meeting_logs(status);
CREATE INDEX IF NOT EXISTS idx_meeting_logs_start_at  ON meeting_logs(start_at);
CREATE INDEX IF NOT EXISTS idx_meeting_logs_org_start ON meeting_logs(org_id, start_at);

COMMIT;
```

**Notes on column choices:**
- Reuse the existing columns rather than duplicating them: `title VARCHAR(500)`,
  `participants TEXT`, `recording_url TEXT`, `summary TEXT`, `source VARCHAR(50)`,
  `external_id`, `duration_minutes`, `org_id`, `user_id`, `occurred_at`,
  `created_at`, `related_type` / `related_id`, `raw_payload` all already exist in
  `045`. CS-8 only adds the *scheduling* + *account-link* + *ownership* columns.
- `status` defaults to `'completed'` so that **existing webhook rows** (which have
  no status today) read as past/completed in the new UI without a backfill.
  New scheduled meetings explicitly INSERT `status='scheduled'`.
- `start_at` (planned) vs `occurred_at` (the existing "this happened at" column):
  the API normalizes a single `when` value for the UI as
  `COALESCE(start_at, occurred_at)` so both ingested and scheduled rows sort on one
  axis.
- Values for `kind` / `status` are open `VARCHAR` (not PG enums), matching the
  codebase convention (`issues.status`, `meeting_logs.source` are free-text). The
  UI offers fixed dropdowns; the schema does not 400 on an unknown value at the
  API edge.

**Sequencing note:** 097 has no ordering dependency on the CS-1..CS-6 migrations —
it only ALTERs an existing table and references `companies` / `deals` / `contacts`
/ `users`, all of which already exist. It takes the next free 3-digit prefix at
implementation time.

---

## 4. API endpoints

New router `backend/routes/meetingRoutes.js`. First line after router creation:
`router.use(authMiddleware);` **except** the token ICS feed (§4.7), which is
mounted before `authMiddleware` because external calendar clients can't send the
auth cookie. Org-scope helper at top:
`function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }`.
The whole router is mounted behind `requireFeature('customer_success_enabled')` in
`index.js`, so **every** endpoint below (including the token feed) is reachable only
for CS-enabled orgs. Bodies validated by `backend/schemas/meetings.js` via the
shared `validateBody(schema)` middleware (`backend/middleware/validate`).

All list/read queries `LEFT JOIN users u ON u.id = m.owner_user_id` (owner
email/name) and `LEFT JOIN companies c ON c.id = m.company_id` (account name).

### 4.1 `GET /api/meetings`
- **Auth:** authMiddleware + `requireFeature('customer_success_enabled')`.
- **Query params (all optional):** `status` (`scheduled`/`completed`/`canceled`),
  `kind`, `company_id`, `deal_id`, `owner_user_id`,
  `window` (`upcoming` → `COALESCE(start_at, occurred_at) >= NOW() AND status =
  'scheduled'`; `past` → everything else), `from` / `to` (ISO timestamps bounding
  `COALESCE(start_at, occurred_at)`), `limit` (default 100, capped 200).
- **Scope:** `WHERE m.${sf} = $1` plus any provided filters (parameterized,
  `params.length + 1` indexing — identical to `issueRoutes.js` GET).
- **Sort:** `upcoming` → `COALESCE(m.start_at, m.occurred_at) ASC` (soonest first);
  otherwise `COALESCE(m.start_at, m.occurred_at) DESC NULLS LAST, m.created_at DESC`.
- **Response 200:** array of meeting rows:
  ```jsonc
  [
    {
      "id": 51, "company_id": 7, "company_name": "Acme Corp",
      "deal_id": null, "contact_id": 42,
      "title": "Q3 QBR — Acme Corp",
      "kind": "qbr", "status": "scheduled",
      "owner_user_id": 3, "owner_email": "csm@org.com", "owner_name": "Dana CSM",
      "start_at": "2026-07-15T17:00:00Z", "end_at": "2026-07-15T18:00:00Z",
      "when": "2026-07-15T17:00:00Z",            // COALESCE(start_at, occurred_at)
      "location": "https://meet.example.com/acme-qbr",
      "participants": "Dana CSM, Acme buyer",
      "agenda": "Adoption review, renewal runway, expansion.",
      "notes": null, "summary": null, "recording_url": null,
      "source": "manual", "duration_minutes": null,
      "occurred_at": null, "canceled_at": null,
      "created_at": "2026-06-23T14:00:00Z", "updated_at": "2026-06-23T14:00:00Z"
    }
  ]
  ```

### 4.2 `GET /api/meetings/:id`
- **Auth/gate:** as above.
- **Scope:** `WHERE m.id = $1 AND m.${sf} = $2`.
- **Response 200:** single meeting row (same shape as a list element).
- **404:** `{ "error": "Meeting not found" }` when not in the caller's org scope.

### 4.3 `POST /api/meetings`
- **Auth/gate:** as above. Body validated by `meetings.createSchema`.
- **Request:**
  ```jsonc
  {
    "title": "Q3 QBR — Acme Corp",   // required
    "company_id": 7,                 // required (account pivot)
    "kind": "qbr",                   // default 'check_in'
    "start_at": "2026-07-15T17:00:00Z",  // required for a scheduled meeting
    "end_at": "2026-07-15T18:00:00Z",
    "owner_user_id": 3,
    "deal_id": null,
    "contact_id": 42,
    "location": "https://meet.example.com/acme-qbr",
    "participants": "Dana CSM, Acme buyer",
    "agenda": "Adoption review, renewal runway, expansion."
  }
  ```
- **Server behavior:** `INSERT INTO meeting_logs (user_id, org_id, source, status,
  kind, title, company_id, deal_id, contact_id, owner_user_id, start_at, end_at,
  location, participants, agenda, created_by) VALUES (...) RETURNING *`.
  `user_id`/`created_by` = `req.userId`, `org_id` = `req.orgId || null`,
  `source = 'manual'`, `status = 'scheduled'` (defaults applied in JS/SQL exactly
  as `issueRoutes.js` applies its defaults).
- **Response 201:** the created row (with the JOINed `company_name` / owner fields,
  via a follow-up SELECT or `RETURNING` + JOIN).
- **Validation:** `title` required (≥1 char, ≤500); `company_id` required (positive
  int); `start_at` required and parseable timestamp; if `end_at` present it must be
  ≥ `start_at`. 400 with the zod error shape (`{ success:false, error, fields[] }`)
  on failure.

### 4.4 `PUT /api/meetings/:id`
- **Auth/gate:** as above. Body validated by `meetings.updateSchema`.
- **Request:** any subset of the editable fields (`title`, `kind`, `status`,
  `start_at`, `end_at`, `owner_user_id`, `company_id`, `deal_id`, `contact_id`,
  `location`, `participants`, `agenda`, `notes`, `summary`, `recording_url`).
  COALESCE semantics — omitted fields are left unchanged (matching `issueRoutes.js`
  PUT).
- **Status-transition side effects (in the handler):**
  - When `status` transitions to `canceled` → set `canceled_at = CURRENT_TIMESTAMP`.
  - When `status` transitions to `completed` → set `occurred_at =
    COALESCE(occurred_at, start_at, CURRENT_TIMESTAMP)` so completed scheduled
    meetings get a concrete "happened at" timestamp; clear `canceled_at` to NULL.
  - Reverting to `scheduled` clears `canceled_at`.
  - Always `updated_at = CURRENT_TIMESTAMP`.
- **Scope:** `WHERE id = $ AND ${sf} = $ RETURNING *`.
- **Response 200:** updated row. **404** when not in scope.

### 4.5 `DELETE /api/meetings/:id`
- **Auth/gate:** as above. Hard delete (matches `issueRoutes.js` / `serviceContractRoutes.js`).
- **Scope:** `DELETE FROM meeting_logs WHERE id = $1 AND ${sf} = $2 RETURNING *`.
- **Response 200:** `{ "message": "Meeting deleted" }`. **404** when not in scope.
- **Note:** the UI prefers `PUT { status:'canceled' }` (soft cancel) over DELETE for
  scheduled meetings; DELETE exists for hard removal of a mistakenly-created row.

### 4.6 `GET /api/meetings/:id.ics`
- **Auth/gate:** authMiddleware + `requireFeature('customer_success_enabled')`.
  (Cookie-auth protected — this is the in-app "Add to calendar" download.)
- **Scope:** `WHERE id = $1 AND ${sf} = $2`.
- **Behavior:** builds an RFC-5545 VCALENDAR/VEVENT via
  `icsFeed.meetingToVEvent(row)` — `UID = meeting-<id>@theopencrm.com`,
  `DTSTART`/`DTEND` from `start_at`/`end_at` (or `occurred_at` +
  `duration_minutes`), `SUMMARY = title`, `DESCRIPTION = agenda` + `location`,
  `STATUS` mapped (`scheduled→CONFIRMED`, `canceled→CANCELLED`,
  `completed→CONFIRMED`).
- **Response 200:** `Content-Type: text/calendar; charset=utf-8`,
  `Content-Disposition: attachment; filename="meeting-<id>.ics"`, body = the
  serialized calendar. **404** when not in scope.

### 4.7 `GET /api/meetings/feed?token=<t>`
- **Auth:** **token, not cookie.** Mounted *before* `authMiddleware` inside the
  router; still behind `requireFeature` at the `index.js` mount. The org is derived
  from the token, **never** from a query param. Added to `csrfIgnoredRoutes` (it's
  a GET consumed by external calendar apps).
- **Token:** `token = <orgId>.<HMAC-SHA256(orgId, MEETING_ICS_FEED_SECRET)>`
  (base64url). Verified with `crypto.timingSafeEqual`. The mint endpoint is
  §4.8.
- **Degradation:** if `MEETING_ICS_FEED_SECRET` is unset → **404** (feed disabled).
- **Behavior:** loads upcoming + recently-past `status IN ('scheduled','completed')`
  meetings for the token's org (`WHERE org_id = $1 AND COALESCE(start_at,
  occurred_at) >= NOW() - INTERVAL '60 days'`, capped 500) and returns
  `icsFeed.meetingsToCalendar(rows, { calName: 'The Open CRM — Meetings' })`.
- **Response 200:** `Content-Type: text/calendar; charset=utf-8`, the multi-VEVENT
  calendar so a user can *subscribe* (read-only) from Google/Apple/Outlook.

### 4.8 `POST /api/meetings/feed-token`
- **Auth/gate:** authMiddleware + `requireFeature('customer_success_enabled')`.
- **Behavior:** mints (does not persist) and returns the caller-org's feed token +
  the full subscribe URL. Returns `{ enabled:false }` (200) when
  `MEETING_ICS_FEED_SECRET` is unset so the UI can hide the affordance.
- **Response 200:**
  ```jsonc
  { "enabled": true,
    "token": "7.aZ9...",
    "url": "https://synccrm-backend-...run.app/api/meetings/feed?token=7.aZ9..." }
  ```

### 4.9 (Optional) automation rule — not an HTTP endpoint
- `meeting_followup_task` in `services/automation.js` `RULES[]`:
  - Scan `SELECT id, org_id, user_id, owner_user_id, company_id, title FROM
    meeting_logs WHERE status = 'scheduled' AND COALESCE(end_at, start_at) <
    NOW() LIMIT $MEETING_FOLLOWUP_WORKER_MAX_PER_RUN`.
  - Per row: skip orgs without `customer_success_enabled`; skip if
    `alreadyFired('meeting_followup_task', 'meeting', id, 30)`; else create a
    normal-priority task `{ title: 'Log notes / follow-up: <title>', due_date:
    today, assigned_to: owner_user_id || user_id }` for the meeting's org, and
    `recordRun('meeting_followup_task', { orgId, targetType:'meeting', targetId:id })`.
  - Returns `{ fired, scanned }` like every other rule.

---

## 5. UI surface

**New page:** `frontend/src/pages/Meetings.js` at route `/meetings`. Visible only
for CS-enabled profiles (`showAccountManagement` true → `zang` / `rin`). No change
to `generic` / `jcp` navigation.

1. **Two-section list** — an **Upcoming** section (`window=upcoming`, soonest first)
   above a **Past** section (`window=past`, most-recent first), each a `DataTable`
   (the existing component used by `Companies.js`) with columns: `When`
   (`COALESCE(start_at, occurred_at)`, with a "Today" / "Tomorrow" relative pill),
   `Title`, `Account` (company_name, links to `/accounts/:id` once CS-1 ships),
   `Kind` (badge: qbr / check-in / renewal-call / kickoff / integration),
   `Status` (badge: scheduled=blue, completed=green, canceled=slate), `Owner`
   (owner_name).
2. **Filter bar** — dropdowns for Kind, Status, Owner; reuse the filter styling
   already on `Companies.js` / `Deals.js`. These map to the `GET /api/meetings`
   query params.
3. **Create / edit drawer or modal** — fields: Title (required), Account picker
   (required — autocomplete over `/api/companies`), Contact picker (optional,
   filtered to the chosen account), Deal picker (optional), Kind, Start (date+time,
   required), End (date+time), Owner (user picker over org members), Location,
   Participants (free text), Agenda, and — when editing a past/completed meeting —
   Notes + Summary + Recording URL. Submits through `api.meetings.create` /
   `api.meetings.update`. A "Cancel meeting" action sends `update(id, { status:
   'canceled' })`.
4. **"Add to calendar (.ics)"** — a per-row/per-drawer button linking to
   `api.meetings.icsUrl(id)` (`GET /api/meetings/:id.ics`) that downloads the event.
5. **"Subscribe in your calendar"** — a settings affordance that calls
   `POST /api/meetings/feed-token`; if `enabled:false` it's hidden, otherwise it
   shows the copyable feed URL (§4.7).
6. **Nav link** — `Meetings` entry in `NAV_LINKS_ZANG` (and `NAV_LINKS_RIN`),
   rendered only when `showAccountManagement` is true; `Meetings.js` passes
   `active="meetings"` to `<Nav>` so the link highlights.
7. **CS-1 timeline (forward-compat):** when CS-1's `AccountDetail.js` exists, a
   `type:'meeting'` entry renders with a meeting badge, the kind, and an
   "Add to calendar" link.

**Profiles:** page + nav + drawer appear for `zang` / `rin` only. For `generic` /
`jcp`, `showAccountManagement` is false → no nav link; a direct navigation to
`/meetings` renders, but every `/api/meetings` call returns 403, so the page shows
an "Account management isn't enabled for this workspace" empty state (reuse the
existing feature-gated empty-state component pattern).

---

## 6. Tests (>= 1 happy path per endpoint)

Test runner: `vitest run` (from `backend/`). Follow the established pattern — patch
the live `require('../db')` pool with `vi.fn()` mocks (see `backend/test/me.test.js`),
mount `meetingRoutes` on a tiny Express app with `cookie-parser` + a generated auth
cookie (`generateToken`, `AUTH_COOKIE_NAME` from `../auth`). Because the router is
gated by `requireFeature` only at the `index.js` mount (not inside the router), the
unit tests mount `meetingRoutes` **directly** (exercising handler logic) and add a
**separate** gating test that mounts it behind a stubbed `requireFeature` to assert
the 403. Stub `audit.record` / `audit.fromReq` to no-ops if the route emits audit
rows (as `me.test.js` does).

**File:** `backend/test/meetings.test.js`

- **POST happy path:** mock authMiddleware org lookup + the INSERT `RETURNING *`;
  `POST /meetings` with `{ title, company_id, kind:'qbr', start_at:'2026-07-15T17:00:00Z' }`
  → **201**, body has new `id`, `source:'manual'`, `status:'scheduled'`,
  `kind:'qbr'`. Assert the INSERT params carried `user_id`, `org_id`, `company_id`,
  `title`, `start_at`.
- **POST validation (missing title):** `POST /meetings` without `title` → **400**,
  body `success:false`, `fields[]` non-empty; assert no INSERT was issued.
- **POST validation (end before start):** `start_at` > `end_at` → **400**.
- **GET list happy path:** mock SELECT returning two rows; `GET /meetings?status=scheduled`
  → **200**, array length 2; assert the SQL carried `AND m.org_id = $` (or
  `user_id`) and the `status = $` filter.
- **GET list upcoming window:** `GET /meetings?window=upcoming` → assert the SQL
  added a `COALESCE(start_at, occurred_at) >= NOW()` clause + `status='scheduled'`
  and ordered ASC.
- **GET :id happy path:** mock SELECT returning one row → **200**, correct `id`.
- **GET :id org-scope guard:** mock SELECT returning 0 rows (foreign id) → **404**;
  assert the SQL carried `AND org_id = $` / `AND user_id = $`.
- **PUT happy path + complete stamp:** mock SELECT (prior `status:'scheduled'`) +
  UPDATE `RETURNING *`; `PUT /meetings/:id` with `{ status:'completed', notes:'good call' }`
  → **200**, body `status:'completed'`; assert the UPDATE set `occurred_at =
  COALESCE(...)`.
- **PUT cancel stamp:** `PUT { status:'canceled' }` → assert `canceled_at` set.
- **PUT org-scope guard:** UPDATE affects 0 rows (foreign id) → **404**.
- **DELETE happy path:** DELETE `RETURNING *` one row → **200**,
  `{ message:'Meeting deleted' }`; assert `WHERE id = $ AND <scope> = $`.
- **DELETE org-scope guard:** 0 rows → **404**.
- **`.ics` download:** `GET /meetings/:id.ics` with a mocked row → **200**,
  `Content-Type` includes `text/calendar`, body contains `BEGIN:VCALENDAR`,
  `BEGIN:VEVENT`, `UID:meeting-<id>@`, `SUMMARY:<title>`, `END:VCALENDAR`.
- **Feed token mint (enabled):** with `MEETING_ICS_FEED_SECRET` set,
  `POST /meetings/feed-token` → **200**, `enabled:true`, `token` matches
  `^<orgId>\.`, `url` ends with the token.
- **Feed token mint (disabled):** with the secret unset → **200**, `enabled:false`,
  no token leaked.
- **Feed (token):** with the secret set, mint a token then `GET /meetings/feed?token=<t>`
  → **200**, `text/calendar`, multi-VEVENT body; a tampered token → **404/401**;
  with the secret unset → **404**.
- **Gating:** mount `meetingRoutes` behind a `requireFeature('customer_success_enabled')`
  whose flag source is stubbed `false` → any request returns **403**; stubbed
  `true` → passes through.
- **(Optional) automation rule:** if `meeting_followup_task` is implemented, an
  `services/automation.test.js`-style test: mock pool returning one past, scheduled,
  flag-enabled meeting → assert one task INSERT + one `automation_runs` INSERT;
  second run (`alreadyFired` true) → no re-fire.

---

## 7. Acceptance criteria (observable / demo-able)

1. **Schedule a meeting against an account:** On a CS-enabled org (`zang`/`rin`), a
   user opens `/meetings`, clicks "New meeting", picks **Acme Corp** as the account,
   sets kind = QBR and a start time, and saves. The meeting appears in the
   **Upcoming** section with the account name, kind badge, and `Scheduled` status.
2. **Add to calendar:** Clicking "Add to calendar (.ics)" downloads a valid
   `meeting-<id>.ics` that imports into Google/Apple/Outlook with the correct
   title, start/end, and agenda in the description.
3. **Subscribe feed (when configured):** With `MEETING_ICS_FEED_SECRET` set, the
   "Subscribe in your calendar" affordance shows a feed URL; subscribing in a
   calendar client shows the org's upcoming meetings (read-only). With the secret
   unset, the affordance is hidden and `/api/meetings/feed` returns 404.
4. **Lifecycle scheduled → completed / canceled:** Marking a meeting `Completed`
   (with notes) moves it to the **Past** section and stamps `occurred_at`; marking
   one `Canceled` stamps `canceled_at` and shows a canceled badge.
5. **Owner + filters:** A meeting can be assigned an owner (owner column shows their
   name); Kind / Status / Owner filters change the list to match (backed by the
   `GET /api/meetings` query params).
6. **Existing webhook rows still work:** Teams/Zoom-ingested rows
   (`source IN ('teams','zoom')`) appear in the **Past** section with their
   recording/summary intact — migration 097 added columns with safe defaults and
   did **not** break `POST /api/webhooks/teams|zoom` or `GET /api/webhooks/meetings`.
7. **Account-360 visibility (with CS-1):** Once CS-1 is in place, opening the
   account that owns the meeting shows it as a `meeting` entry on the unified
   account-360 timeline, time-ordered with activities/tasks/deals/emails.
8. **Gating:** On a `generic`/`jcp` org the `Meetings` nav link is absent and every
   `/api/meetings` request returns **403**.
9. **Org isolation:** A user in org A cannot read, update, delete, or `.ics`-export
   org B's meetings — `GET/PUT/DELETE /api/meetings/:id` and `/api/meetings/:id.ics`
   for a foreign id return **404**; the feed token derives its org server-side and
   never trusts a query param; every query is org-scoped via `qs(req)`.
10. **No boot regression:** Backend boots with no new *required* env vars; migration
    097 is idempotent (re-run is a no-op — `ADD COLUMN IF NOT EXISTS` + `CREATE
    INDEX IF NOT EXISTS`); the `/api/meetings` mount and the optional automation
    rule add no startup-blocking behavior.
11. **Follow-up nudge (optional rule):** With automation enabled and the rule
    implemented, a scheduled meeting whose `end_at` passes generates exactly one
    normal-priority "Log notes / follow-up" task for the meeting owner and does not
    re-fire on subsequent automation ticks.
