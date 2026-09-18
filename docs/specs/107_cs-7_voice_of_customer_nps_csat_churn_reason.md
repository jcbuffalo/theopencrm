# CS-7 — Voice-of-Customer: NPS / CSAT / Churn-Reason

**Status:** 🔴 Not started · **Priority:** P3 · **Effort:** ~3 days
**Roadmap source:** `NEXT_STEPS.md` → "Customer Relationship Management (post-sale / customer success)" → **CS-7**
**Gating flag:** `customer_success_enabled` (module category, default `false`) — the shared CS-* flag introduced by CS-1/CS-2/CS-3.
**Author:** scoping pass, 2026-06-23.

---

## 0. Problem statement (from NEXT_STEPS.md)

> **CS-7. Voice-of-customer: NPS / CSAT / churn-reason 💡 🔴 (P3)**
> **Why:** No structured satisfaction signal anywhere. **Effort:** ~3 days.
> **Files:** `surveys` + `survey_responses` tables, a public token-based response
> route (CSRF-exempt like `/unsubscribe/:token`), send via `services/email.js`,
> results on CS-1 timeline + CS-6 reporting. Churn-reason already added in CS-3.

The product has no structured customer-satisfaction signal. We track *what we did*
(activities, emails, deals) but never *how the customer feels*. CS-7 adds a
**voice-of-customer** layer: outbound surveys (NPS, CSAT, or churn-reason),
public token-authenticated response collection, and aggregation into the CS-1
account timeline and CS-6 retention reporting.

### Critical reconciliation with the EXISTING survey scaffold

⚠️ **A survey scaffold already exists and CS-7 must build on it, not duplicate it.**
Confirmed in the codebase:

- **Table `survey_invitations`** (migration `045_phase5_scaffolds.sql`, lines 66–81):
  `(id, user_id, org_id, deal_id, customer_email, survey_token UNIQUE, sent_at,
  responded_at, rating, feedback, created_at)`. This is a **deal-anchored,
  single-rating + free-text** model — no NPS/CSAT/churn typing, no per-account
  link, no question structure.
- **Automation rule `invoiced_queue_survey`** (`services/automation.js` ~line 194):
  on a deal hitting `INVOICED`/`CLOSED_PAID` with a `poc_email`, inserts a
  `survey_invitations` row with a `crypto.randomBytes(32)` token.
- **Automation rule `survey_send_pending`** (`services/automation.js` ~line 370):
  emails any `survey_invitations` row with `sent_at IS NULL` to `customer_email`,
  linking to `${PUBLIC_BASE_URL}/survey/${survey_token}` and stamping `sent_at`.
- **No response route exists.** `grep` confirms there is **no** `/survey/:token`
  frontend page and **no** backend route that records a response. The
  `rating`/`feedback`/`responded_at` columns on `survey_invitations` are written
  by *nothing* today — the link in the survey email currently 404s.

**CS-7's design decision:** introduce a properly-typed **`surveys`** (one row per
sent survey, replacing the role of `survey_invitations` going forward) +
**`survey_responses`** (the structured answer) model, **migrate the legacy
`/survey/:token` URL convention** so the already-shipped `survey_send_pending`
emails resolve, and **retarget the two existing automation rules** to write the
new `surveys` table. The legacy `survey_invitations` table is **left in place**
(no destructive migration) but is no longer the write target. See §3 for the exact
migration and §9 for the rule retarget. This avoids two parallel survey systems.

### Deliberate scope limits (so another engineer doesn't over-build)

- **Three survey types only:** `nps` (0–10), `csat` (1–5), `churn` (reason picker +
  free text). No custom multi-question survey builder. No conditional logic.
- **One-off sends only** (mirrors the email-send-from-CRM scope discipline in
  `routes/emailRoutes.js`): no drip sequences, no reminders, no scheduled cadence
  beyond the existing INVOICED trigger + a new manual "send survey" action.
- **Public response page is server-rendered HTML**, exactly like
  `GET /api/emails/unsubscribe/:token` — no SPA route, no auth, no CSRF. One GET to
  render the form, one POST to record the answer. This keeps the public surface tiny
  and avoids shipping a token-scoped React route.
- **Aggregation is read-only.** CS-7 exposes the data; CS-6's `/api/metrics/retention`
  (already specced) folds CSAT/NPS/churn-reason counts in as an additive block —
  CS-7 ships its own `GET /api/surveys/summary` for the standalone account/admin view
  and a per-company list for the CS-1 timeline.

---

## 1. Files to touch

### Backend — new files

| Path | Purpose |
|---|---|
| `backend/migrations/095_surveys.sql` | New `surveys` + `survey_responses` tables; backfill-safe. See §3. (Next available prefix — `094` is latest.) |
| `backend/routes/surveyRoutes.js` | Authenticated CRUD/list/summary + the **public** `GET/POST /api/surveys/respond/:token` (CSRF-exempt, no auth) for response collection. Pattern: public routes register *before* `router.use(authMiddleware)`, mirroring `routes/emailRoutes.js` lines 59–136. |
| `backend/schemas/surveys.js` | zod schemas: `createSurveySchema`, `respondSchema` (validates by survey type — NPS 0–10 int, CSAT 1–5 int, churn reason enum + free text). Mirrors `backend/schemas/serviceContracts.js`. |
| `backend/test/surveys.test.js` | Happy-path test per endpoint + org-scoping + public-route token tests (see §6). |

### Backend — edited files

| Path | Change |
|---|---|
| `backend/index.js` | (a) Mount the router: `app.use('/api/surveys', surveyRoutes);` placed **after** `/api/service-contracts` (line ~522) and **before** `/api/filters`. **Do not** wrap the mount in `requireFeature` — the public `respond/:token` sub-route must stay reachable without a feature lookup (the recipient has no org context). The CS gate is applied **per-route inside the file** on the authenticated handlers only (see §4). (b) Add `'/api/surveys/respond'`-prefixed paths to the CSRF-exempt logic in `isCsrfExempt` (line ~185): add `if (p.startsWith('/api/surveys/respond/')) return true;` next to the existing `/api/emails/unsubscribe/` check (line ~192). (c) Update the CSRF-exempt comment block (lines ~159–171) to document item 11: public survey response. |
| `backend/services/automation.js` | Retarget `invoiced_queue_survey` (~line 194) and `survey_send_pending` (~line 370) to write/read the new `surveys` table instead of `survey_invitations`. The email link stays `${PUBLIC_BASE_URL}/api/surveys/respond/${token}` (note: now a **backend** path, not the old `/survey/:token` SPA path that was never built). See §9. |
| `backend/services/featureFlags.js` | **No change if CS-1/CS-2/CS-3 already added `customer_success_enabled` to `KNOWN_FLAGS`.** If this is the first CS-* item implemented, add it (module category, `defaultValue: false`) per the snippet in §2. |

### Frontend — edited files

| Path | Change |
|---|---|
| `frontend/src/api.js` | Add a `surveys` namespace: `list(params)`, `create(body)`, `summary(params)`, `forCompany(companyId)`. Mirror the `drive`/`gmail` namespace pattern (api.js lines ~177–310). No client code for the public response page — that is server-rendered HTML, not part of the SPA. |
| `frontend/src/pages/AccountDetail.js` | (CS-1's page) Add a "Voice of Customer" section to the account header/timeline: latest NPS/CSAT score badge + churn-reason (if churned) + a "Send survey" button (POST `/api/surveys`). Render only when `showAccountManagement` is true. **If CS-1 is not yet implemented, this edit is deferred** — the data is fully usable via `GET /api/surveys?company_id=` regardless. |
| `frontend/src/pages/Reports.js` | (CS-6's page) **No edit required by CS-7 itself.** CS-6's `/api/metrics/retention` already plans a VoC block; CS-7 only guarantees the underlying `survey_responses` rows exist. Document the join key (`survey_responses` → `surveys.company_id`) so CS-6 can aggregate. |

> **Why the mount is ungated but the routes are gated:** `requireFeature` does a
> per-request org-features lookup keyed on `req.orgId`. The public `respond/:token`
> recipient is unauthenticated and has no `req.orgId`, so a mount-level gate would
> 403 every survey response. The authenticated management routes each carry their own
> `requireFeature('customer_success_enabled')` middleware. This is the same split
> CS-6 documents for `/api/metrics/retention`.

---

## 2. New env vars + graceful degradation

**No new required env vars.**

| Var | Already exists? | Role in CS-7 | Degradation |
|---|---|---|---|
| `PUBLIC_BASE_URL` | Yes — `services/automation.js` line 19 (`process.env.PUBLIC_BASE_URL \|\| 'https://app.theopencrm.com'`). | Builds the public survey link in outbound emails. | Falls back to the hard-coded production URL, same as today. |
| `GMAIL_USER`+`GMAIL_APP_PASSWORD` / `SENDGRID_API_KEY` | Optional (see CLAUDE.md). | Transport for survey emails via `services/email.js`. | `email.isConfigured()` is `false` → the `survey_send_pending` rule short-circuits (`skipped: 'email_not_configured'`), already the existing behavior. A survey row is still created and can be answered via a manually-shared link; `sent_at` stays NULL. **No throw.** |

**Graceful degradation summary:** CS-7 introduces no integration that can hard-fail.
With no email transport, surveys are created but not auto-emailed (matching the shipped
`survey_send_pending` behavior). With `customer_success_enabled` off, the authenticated
management endpoints 403 but the **public response route still works** (a survey already
sent must always be answerable, even if an admin later toggles the flag off).

**Feature-flag registration (only if no prior CS-* item added it):**

```js
// services/featureFlags.js — KNOWN_FLAGS, "MODULES" section
{
  name: 'customer_success_enabled',
  category: 'module',
  description: 'Post-sale customer-success surface: account 360, health, renewals, '
    + 'support cases, and voice-of-customer surveys (NPS/CSAT/churn). Keeps generic/jcp '
    + 'profiles lean; intended for zang/rin.',
  defaultValue: false,
},
```

---

## 3. Migrations

**File:** `backend/migrations/095_surveys.sql` (next available prefix; `094` is the
latest — confirmed via directory listing). Migrations auto-run on production boot in
numeric-string order.

**Safety:** `surveys` and `survey_responses` are **new** tables → `CREATE TABLE IF NOT
EXISTS` is correct here (the duplicate-table hazard applies only to
contacts/deals/activities). No `ALTER` on any existing tenant table. The legacy
`survey_invitations` table is **not dropped** (no destructive migration — historical
INVOICED-survey rows stay queryable).

```sql
-- CS-7 — Voice-of-Customer surveys (NPS / CSAT / churn-reason).
--
-- Supersedes the role of the legacy survey_invitations table (migration 045)
-- with a typed model. survey_invitations is intentionally left in place (no
-- destructive migration); the invoiced_queue_survey / survey_send_pending
-- automation rules are retargeted to write `surveys` in the same PR (CS-7 §9).
--
-- Two tables:
--   surveys           — one row per survey SENT (or queued). Carries the type,
--                       the org/company/deal links, the recipient email, the
--                       send token (unique, embedded in the email link), and
--                       send/respond timestamps. company_id is the account-level
--                       anchor CS-7 needs that survey_invitations lacked.
--   survey_responses  — the structured answer. One row per response (a survey
--                       is single-response; the UNIQUE(survey_id) enforces it).
--                       nps_score 0–10, csat_score 1–5, churn_reason enum-ish
--                       text, free-text comment. Only the column matching the
--                       survey type is populated; the others stay NULL.
--
-- IDEMPOTENT: re-running is a no-op.

BEGIN;

CREATE TABLE IF NOT EXISTS surveys (
  id              BIGSERIAL    PRIMARY KEY,
  org_id          INTEGER      REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         INTEGER      REFERENCES users(id)         ON DELETE SET NULL,
  company_id      INTEGER      REFERENCES companies(id)     ON DELETE SET NULL,
  deal_id         INTEGER      REFERENCES deals(id)         ON DELETE SET NULL,
  contact_id      INTEGER      REFERENCES contacts(id)      ON DELETE SET NULL,
  survey_type     VARCHAR(10)  NOT NULL,            -- 'nps' | 'csat' | 'churn'
  recipient_email VARCHAR(254) NOT NULL,
  token           VARCHAR(64)  NOT NULL UNIQUE,     -- 32-byte hex = 64 chars
  status          VARCHAR(12)  NOT NULL DEFAULT 'queued', -- queued|sent|responded
  sent_at         TIMESTAMPTZ,
  responded_at    TIMESTAMPTZ,
  created_by      INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  updated_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_surveys_org_created
  ON surveys(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_surveys_company
  ON surveys(company_id) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_surveys_deal
  ON surveys(deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_surveys_token
  ON surveys(token);
CREATE INDEX IF NOT EXISTS idx_surveys_unsent
  ON surveys(status) WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS survey_responses (
  id           BIGSERIAL    PRIMARY KEY,
  survey_id    BIGINT       NOT NULL UNIQUE REFERENCES surveys(id) ON DELETE CASCADE,
  org_id       INTEGER      REFERENCES organizations(id) ON DELETE CASCADE,
  nps_score    SMALLINT,    -- 0..10, populated when survey_type='nps'
  csat_score   SMALLINT,    -- 1..5,  populated when survey_type='csat'
  churn_reason VARCHAR(40), -- populated when survey_type='churn' (see enum in §4)
  comment      TEXT,        -- free-text, all types
  responded_at TIMESTAMPTZ  DEFAULT NOW(),
  source_ip    VARCHAR(45)  -- inet string for abuse triage; nullable
);

CREATE INDEX IF NOT EXISTS idx_survey_responses_org
  ON survey_responses(org_id, responded_at DESC);

COMMENT ON TABLE surveys IS
  'CS-7 voice-of-customer surveys. Supersedes survey_invitations (045). One row per sent/queued survey; see backend/routes/surveyRoutes.js.';
COMMENT ON TABLE survey_responses IS
  'CS-7 structured survey answers. One row per survey (UNIQUE(survey_id)). Only the column matching surveys.survey_type is populated.';

COMMIT;
```

**Bounds enforced in the app layer, not the DB** (matches the codebase's preference
for zod over CHECK constraints — see `schemas/`): `nps_score` 0–10, `csat_score` 1–5,
`churn_reason` ∈ the §4 enum. The DB keeps `SMALLINT`/`VARCHAR` only.

---

## 4. API endpoints

`qs(req)` is `function qs(req){ return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }` at the top of `surveyRoutes.js`. **Every authenticated query interpolates `${sf} = $n` with `sv` — no exceptions.** The churn-reason enum used by validation and the response form:

```
churn_reason ∈ { 'price', 'missing_features', 'switched_competitor',
                 'poor_support', 'no_longer_needed', 'budget_cut', 'other' }
```

### Public (no auth, CSRF-exempt) — response collection

#### `GET /api/surveys/respond/:token`
- **Auth:** none. CSRF-exempt (added to `isCsrfExempt`). Token in URL is the only credential.
- **Registered before** `router.use(authMiddleware)` in `surveyRoutes.js`.
- **Behavior:** looks up `surveys WHERE token = $1`. Returns a **server-rendered HTML
  form** (Content-Type `text/html`), shaped by `survey_type` (NPS 0–10 button row;
  CSAT 1–5 stars; churn reason `<select>` + comment). If the survey is already
  `status='responded'`, render a "thanks, already received" page. **Never leak whether
  a token is real** — an unknown token renders a generic neutral page (same pattern as
  `/api/emails/unsubscribe/:token`, emailRoutes.js lines 93–129). Always HTTP 200.
- **Response:** `text/html`.

#### `POST /api/surveys/respond/:token`
- **Auth:** none. CSRF-exempt. Validated by `respondSchema`.
- **Request (form-encoded or JSON), by type:**
  - NPS: `{ nps_score: 0..10, comment?: string }`
  - CSAT: `{ csat_score: 1..5, comment?: string }`
  - Churn: `{ churn_reason: <enum>, comment?: string }`
- **Behavior (single transaction):** resolve token → if not found or already
  responded, render the neutral "thank you" page (idempotent, no error leak); else
  insert one `survey_responses` row (scoped `org_id` copied from the survey row),
  set `surveys.status='responded'`, `surveys.responded_at=NOW()`. Stores `source_ip`
  from `req.ip`. Emits a best-effort audit event `survey.responded`.
  **If `surveys.survey_type='churn'` and the survey is deal-linked, also copy the
  reason into `deals`/`service_contracts.churn_reason` is NOT done here** — CS-3 owns
  the contract `churn_reason`; CS-7 keeps the response authoritative and leaves CS-6/CS-1
  to join. (Documented to avoid a double-write.)
- **Response:** `text/html` confirmation page. Always HTTP 200 on a well-formed body;
  HTTP 400 + HTML only on a body that fails `respondSchema` (e.g. NPS score 11).

### Authenticated (CS-gated) — management & aggregation

All below carry `requireFeature('customer_success_enabled')` as route-level middleware
and run after `router.use(authMiddleware)`.

#### `POST /api/surveys`
- **Auth:** cookie JWT + CSRF + `requireFeature('customer_success_enabled')`. Validated by `createSurveySchema`.
- **Request:**
  ```json
  {
    "survey_type": "nps",            // 'nps' | 'csat' | 'churn'  (required)
    "recipient_email": "a@b.com",    // required, ≤254, EMAIL_RX
    "company_id": 42,                // optional, must belong to the org
    "deal_id": 9,                    // optional, must belong to the org
    "contact_id": 7,                 // optional, must belong to the org
    "send_now": true                 // optional, default true
  }
  ```
- **Behavior:** validates `company_id`/`deal_id`/`contact_id` belong to the caller's
  scope (`SELECT 1 ... WHERE id=$1 AND ${sf}=$2`) → 400 if any is cross-org. Generates a
  `crypto.randomBytes(32).toString('hex')` token. Inserts a `surveys` row with
  `org_id=req.orgId`, `user_id=created_by=req.userId`, `status='queued'`. If `send_now`
  and `email.isConfigured()`, sends immediately via `services/email.js` and sets
  `status='sent'`, `sent_at=NOW()`; otherwise leaves it `queued` for `survey_send_pending`.
- **Response 201:** the created `surveys` row (no token in the body beyond what the
  creator needs — token is returned so an admin can copy a manual link).

#### `GET /api/surveys`
- **Auth:** JWT + `requireFeature('customer_success_enabled')`.
- **Query params:** `company_id?`, `deal_id?`, `survey_type?`, `status?`, `limit?` (default 100, max 500).
- **Behavior:** `SELECT s.*, r.nps_score, r.csat_score, r.churn_reason, r.comment,
  r.responded_at FROM surveys s LEFT JOIN survey_responses r ON r.survey_id = s.id
  WHERE s.${sf} = $1 [filters] ORDER BY s.created_at DESC LIMIT n`. All filters AND-ed
  onto the scope clause.
- **Response 200:** array of survey rows with the joined response fields (NULL until answered).

#### `GET /api/surveys/summary`
- **Auth:** JWT + `requireFeature('customer_success_enabled')`.
- **Query params:** `company_id?` (scope to one account), `window?` (`30d|90d|365d|all`, default `365d`).
- **Behavior:** org-scoped aggregate:
  ```json
  {
    "nps": { "promoters": 4, "passives": 2, "detractors": 1, "score": 43, "responses": 7 },
    "csat": { "avg": 4.2, "responses": 11, "distribution": { "1":0,"2":1,"3":1,"4":3,"5":6 } },
    "churn": { "responses": 3, "by_reason": { "price": 2, "switched_competitor": 1 } },
    "response_rate": { "sent": 30, "responded": 21, "rate": 0.7 }
  }
  ```
  NPS `score` = `round((promoters − detractors) / responses * 100)`; promoter ≥ 9,
  detractor ≤ 6. All counts AND `s.${sf}=$1`. Empty/zeroed blocks when no data —
  never 404.
- **Response 200:** object above.

#### `DELETE /api/surveys/:id`
- **Auth:** JWT + CSRF + `requireFeature('customer_success_enabled')`.
- **Behavior:** `DELETE FROM surveys WHERE id=$1 AND ${sf}=$2 RETURNING id` (cascade
  removes the response). 404 if not in scope.
- **Response 200:** `{ ok: true, id }`.

> **No PUT.** A survey is immutable once created (you don't edit a sent NPS prompt).
> Correction = delete + recreate.

---

## 5. UI surface

CS-7 has **two surfaces**: an internal admin/account view (SPA) and the external
recipient view (server-rendered HTML).

### A. Recipient response page (server-rendered, no SPA)

- Rendered by `GET /api/surveys/respond/:token` directly from `surveyRoutes.js` as an
  HTML string — **exactly the pattern** of `GET /api/emails/unsubscribe/:token`
  (emailRoutes.js lines 93–129): inline `<style>`, a single `.card`, no external assets.
- Three form variants keyed on `survey_type`:
  - **NPS:** "How likely are you to recommend us? (0–10)" — an 11-button row, POSTs `nps_score`.
  - **CSAT:** "How satisfied were you?" — 1–5 selectable, POSTs `csat_score`.
  - **Churn:** "What's the main reason you're leaving?" — `<select>` of the §4 enum + optional comment.
- POST target is the same path; on success renders a "Thanks for your feedback" card.
  Already-answered tokens render the same thank-you (idempotent, no leak).

### B. Internal surfaces (SPA, gated by `showAccountManagement`)

- **`frontend/src/pages/AccountDetail.js`** (CS-1's page): a "Voice of Customer" card in
  the account header showing the latest NPS/CSAT badge and churn-reason if churned, plus
  a **"Send survey"** button opening a small modal (pick type + recipient → `surveys.create`).
  Survey rows also appear inline on the account timeline (a `{type:'survey', ...}` entry),
  joined from `GET /api/surveys?company_id=`.
- **`frontend/src/pages/Reports.js`** (CS-6's Retention tab): CS-6 already plans the VoC
  rollup; CS-7 only guarantees the rows. No CS-7-owned edit to Reports.js.
- **Nav:** no new nav link. CS-7 is surfaced *inside* the account page, not as a top-level
  destination — so `Nav.js` / `stages.js` need no CS-7-specific change beyond the
  `showAccountManagement` toggle CS-1/CS-3 already add.

If CS-1's `AccountDetail.js` does not yet exist when CS-7 is built, surface B-internal is
deferred and the feature is still fully exercisable via the API + the public response page.

---

## 6. Tests

**File:** `backend/test/surveys.test.js`, Vitest + supertest, following the
`backend/test/me.test.js` harness (mount the router on a bare Express app, patch the live
`pool.query`/`pool.connect`, stub `audit` and `services/email`). At least one happy path
per endpoint, plus the org-scoping and public-token cases that are load-bearing for this
feature.

| # | Endpoint | Assertion |
|---|---|---|
| 1 | `POST /api/surveys` | NPS survey created → 201, row has `survey_type='nps'`, `status` is `sent` (email stubbed configured) or `queued` (stubbed unconfigured), token is 64-hex. |
| 2 | `POST /api/surveys` | `company_id` belonging to **another** org → 400 (cross-org guard); verify the validation `SELECT` used `${sf}=$2`. |
| 3 | `POST /api/surveys` | `survey_type='bogus'` → 400 from `createSurveySchema`. |
| 4 | `GET /api/surveys` | returns only this org's rows (mock returns a mix; assert the WHERE clause carried the scope param) → 200, array, joined response fields present/NULL. |
| 5 | `GET /api/surveys/summary` | NPS rollup math: mock 9,10,6,3 → promoters 2, detractors 2, score 0; CSAT avg correct; empty churn block present → 200. |
| 6 | `DELETE /api/surveys/:id` | in-scope id → 200 `{ok:true}`; out-of-scope id → 404. |
| 7 | `GET /api/surveys/respond/:token` | valid token → 200 `text/html` containing the type-appropriate form; unknown token → 200 neutral page (no leak, **not** 404). |
| 8 | `POST /api/surveys/respond/:token` | valid NPS body (score 8) → 200 HTML, inserts one `survey_responses` row, flips `surveys.status='responded'`; assert no auth/CSRF was required (no auth cookie set in the request). |
| 9 | `POST /api/surveys/respond/:token` | `nps_score: 11` → 400 (respondSchema bound); already-responded token → 200 idempotent thank-you, **no** second `survey_responses` insert. |
| 10 | feature gate | `GET /api/surveys` with `customer_success_enabled` off → 403 (mount the route with the real `requireFeature` and a features mock returning `{}`); **but** `GET /api/surveys/respond/:token` with the flag off → still 200 (public route is ungated). |

Run with `npm test` from `backend/`.

---

## 7. Acceptance criteria (observable / demo-able)

1. **Send:** With `customer_success_enabled` on, an admin opens an account →
   "Send survey" → picks NPS → enters a recipient → submits. A `surveys` row is created
   (`status='sent'` when email is configured; the email contains a
   `${PUBLIC_BASE_URL}/api/surveys/respond/<token>` link).
2. **Respond (public):** Opening that link in a logged-out browser renders the NPS form
   (no login, no CSRF). Submitting a score records a `survey_responses` row, flips the
   survey to `responded`, and shows a thank-you page. Re-opening the link shows
   "already received" — no duplicate response.
3. **Account rollup:** The account's "Voice of Customer" card now shows the latest NPS
   score and the survey appears on the account timeline (CS-1 surface; API-verifiable via
   `GET /api/surveys?company_id=` if CS-1 is not yet built).
4. **Summary math:** `GET /api/surveys/summary` returns correct NPS/CSAT/churn aggregates
   for the org (verifiable against the seeded responses).
5. **Churn capture:** A `churn`-type survey response records the reason from the §4 enum;
   it is queryable for CS-6's retention reporting.
6. **Org isolation:** A user in org A can neither list, summarize, nor delete org B's
   surveys; attempting to attach a cross-org `company_id` on create returns 400.
7. **Graceful degradation:** With no email transport configured, creating a survey still
   succeeds (`status='queued'`) and the public link still works when shared manually —
   no error is thrown anywhere.
8. **Legacy continuity:** The previously-dead `survey_send_pending` automation emails now
   resolve to a working response page (the retargeted rules write `surveys`, and the link
   points at the real backend route) — no orphaned 404 survey links.

---

## 8. Out of scope (explicitly deferred)

- Custom multi-question survey builder / conditional branching.
- Reminder / drip resends; scheduled recurring satisfaction cadences (CS-4 owns recurrence).
- In-app (logged-in) survey widgets; CS-7 is email-out / public-respond only.
- Writing `churn_reason` back onto `service_contracts`/`deals` (CS-3 owns that column;
  CS-7's response is authoritative and joined by reporting).
- A dedicated `/admin` analytics dashboard beyond `GET /api/surveys/summary` + the CS-1
  card and CS-6 tab.

---

## 9. Automation-rule retarget (detail)

The two existing rules in `services/automation.js` are repointed to the `surveys` table
in the **same PR** so there is one survey system, not two. Both keep their
`alreadyFired`/`recordRun` dedupe (rule ids unchanged so historical `automation_runs`
dedupe rows still apply).

- **`invoiced_queue_survey`** (~line 194): change the INSERT from `survey_invitations`
  to:
  ```sql
  INSERT INTO surveys (org_id, user_id, deal_id, company_id, recipient_email,
                       survey_type, token, status)
  SELECT d.org_id, d.user_id, d.id, d.customer_id, d.poc_email,
         'csat', $token, 'queued'
  ...
  ```
  (INVOICED → a CSAT survey, anchored to both the deal and its `customer_id` company —
  the account anchor the legacy table lacked.) Keep the `crypto.randomBytes(32)` token.
- **`survey_send_pending`** (~line 370): change the SELECT to read
  `surveys WHERE status = 'queued'` (instead of `survey_invitations WHERE sent_at IS NULL`),
  send the email with the link `${PUBLIC_BASE_URL}/api/surveys/respond/${token}`, then
  `UPDATE surveys SET status='sent', sent_at=NOW() WHERE id=$1`. Keep the
  `email.isConfigured()` short-circuit.

`survey_invitations` (045) is left in the schema untouched (no data migration; old rows
remain readable) but receives no new writes. A follow-up cleanup migration can drop it
once the team confirms no reporting reads it — **not** part of CS-7.

---

## 10. Implementation order (suggested)

1. `095_surveys.sql` → run locally (`NODE_ENV=production npm start`, watch migration log).
2. `schemas/surveys.js` (zod) + `routes/surveyRoutes.js` (public routes first, then
   `authMiddleware`, then gated management routes).
3. Mount + CSRF-exempt + comment update in `index.js`.
4. Retarget the two automation rules (§9).
5. `frontend/src/api.js` `surveys` namespace; AccountDetail.js card (if CS-1 exists).
6. `backend/test/surveys.test.js`; `npm test`.
7. Manual demo against the §7 criteria.
