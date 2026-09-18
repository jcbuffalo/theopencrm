# CS-10 — Customer-Facing Portal / Collaboration

**Status:** 🔴 Not started · **Priority:** P3 · **Effort:** ~L (1–2 weeks) — the largest CS item
**Roadmap source:** `NEXT_STEPS.md` → "Customer Relationship Management (post-sale / customer success)" → **CS-10**
**Gating flag:** `customer_success_enabled` (module category, default `false`) — the shared CS-* flag introduced by CS-1/CS-2/CS-3.
**Hard dependency:** **CS-1 (account model)**. CS-10 exposes a *read-mostly* external view of an account; it assumes the `companies`-as-account anchor and the 360 roll-up from CS-1 exist. It is **soft-dependent** on CS-2 (health is hidden externally), CS-3 (renewals), and CS-5 (cases) — those surfaces appear in the portal *if present* but CS-10 does not require them.
**Author:** scoping pass, 2026-06-23.

---

## 0. Problem statement (from NEXT_STEPS.md)

> **CS-10. Customer-facing portal / collaboration 💡 🔴 (P3)**
> **Why:** Status/documents/approvals are all internal-facing; the relationship is
> one-directional. **Effort:** ~L (1–2 weeks). Largest item; defer until CS-1..6
> prove the account model. Token-scoped read surface reusing the signed-URL doc
> pattern.

Today every artifact a customer might want to see — deal status, shared documents,
quotes/submittals awaiting their sign-off, open issues — lives behind the internal
JWT-authenticated SPA. The customer has no window in. Communication is one-directional
(we email them; they reply in their own inbox, which only lands back in the CRM if the
Gmail-sync integration is on). CS-10 adds a **token-scoped, externally-reachable portal**:
a magic-link-authenticated page where a named contact at a customer account can see a
**curated, read-mostly** view of *their* account — deals, documents (via short-lived
signed URLs), and items pending their approval — plus a thin **collaboration** layer
(comment on a thread; approve/reject a submittal or quote). No customer login/password,
no customer accounts table — authentication is a per-contact bearer token delivered by
email, exactly mirroring the established public-token pattern.

### Design philosophy (so another engineer doesn't over-build)

CS-10 reuses **three patterns that already exist in this codebase** rather than inventing
new infrastructure:

1. **Token-in-URL public auth**, exactly like `GET /api/emails/unsubscribe/:token`
   (`routes/emailRoutes.js` lines 93–129) and the CS-7 survey-response route — but a
   portal session token is **per-contact, revocable, and longer-lived** (default 30 days),
   so it gets its own table and a tiny session-resolver middleware rather than a one-shot
   lookup.
2. **Short-lived signed-URL document downloads**, exactly like
   `GET /api/documents/:id/download` (`routes/documentRoutes.js` lines 49–110) via
   `services/storage.getSignedDownloadUrl(objectPath, { expiresInSeconds: 900 })`. The
   portal never streams a blob and never exposes a GCS path; it issues a 15-minute signed
   URL only after the token + share check passes.
3. **Org-scoping via the resolved token**, not `qs(req)`. The portal has no `req.userId` /
   `req.orgId` from a JWT. Instead the **session-resolver middleware** loads the token row,
   sets `req.portal = { orgId, contactId, companyId, scopes }`, and **every portal query
   filters on `req.portal.orgId` AND the explicit allow-list of shared resource ids** — the
   structural equivalent of `qs(req)`, but driven by the token's grant, not a logged-in user.

### Deliberate scope limits

- **Read-mostly.** The customer can: view shared deals/documents/approvals, **download** a
  shared document, **post a comment** on a shared thread, and **approve/reject** an item
  explicitly routed to them. They **cannot** create deals, edit CRM records, upload arbitrary
  files (a single approval-attachment upload is the one write-of-a-file path, see §4), or
  see anything not explicitly shared. The grant is allow-list, never "everything for the
  company."
- **No customer user accounts / no password.** Auth is the emailed magic-link token only.
  Revocation = flip `portal_access.status` to `revoked`.
- **Sharing is explicit and internal-driven.** An internal user picks *which* deals/documents/
  approvals a given external contact can see. There is no "auto-share the whole account."
- **One portal session table, one shares table, one comments table, one approvals table.**
  No generic ACL engine.
- **Server-rendered shell + a lightweight token-scoped SPA bundle is out of scope.** The
  portal is its own **server-rendered HTML app** served by the backend (same approach as the
  unsubscribe/survey pages, just multi-page), styled inline. This keeps the external attack
  surface off the authenticated SPA entirely and avoids shipping a second React build. (See
  §5 for why, and the explicit alternative considered.)

---

## 1. Files to touch

### Backend — new files

| Path | Purpose |
|---|---|
| `backend/migrations/110_customer_portal.sql` | New tables: `portal_access`, `portal_shares`, `portal_comments`, `portal_approvals`. All **new** tables → `CREATE TABLE IF NOT EXISTS` is correct (duplicate-table hazard applies only to contacts/deals/activities). No `ALTER` on existing tenant tables. See §3. **Prefix note:** `094` is the latest *committed* migration; the sibling CS specs (103–109) each independently reserve `095`–`097` as "next free." Because CS-10 is the highest-numbered CS item and reuses none of those tables, this spec reserves **110** to match its spec number and avoid colliding with whatever CS-1..9 actually land on. Renumber to the true next-free 3-digit prefix at implementation time if 110 is taken; the file is self-contained and order-independent of the other CS migrations. |
| `backend/routes/portalRoutes.js` | The **public** portal API + server-rendered HTML pages (token-authed, no JWT, CSRF-exempt). Holds the session-resolver middleware. Mounted at `/api/portal`. See §4. |
| `backend/routes/portalAdminRoutes.js` | The **authenticated** (JWT + CSRF + `requireFeature('customer_success_enabled')`) management API an internal user uses to grant/revoke access and choose what to share. Mounted at `/api/portal-admin`. See §4. |
| `backend/services/portalAuth.js` | Token generation (`crypto.randomBytes(32).toString('hex')`), constant-time token comparison helper, and `resolvePortalToken(token)` → loads `portal_access` row, checks `status='active'` + `expires_at > NOW()`, returns the session context. Mirrors the lookup discipline of `routes/emailRoutes.js` unsubscribe + `auth.js` verify. |
| `backend/services/portalShare.js` | Pure helpers: `assertSharedDeal(orgId, contactId, dealId)`, `assertSharedDocument(...)`, `listSharedDeals(...)`, used by both the portal API and tests. Centralizes the allow-list check so it can't be forgotten in a handler. |
| `backend/schemas/portal.js` | zod schemas: `grantSchema`, `shareSchema`, `commentSchema`, `approvalDecisionSchema`. Mirrors `backend/schemas/documents.js` / `serviceContracts.js`. |
| `backend/test/portal.test.js` | Happy-path test per endpoint + token-scoping + revocation + cross-org isolation (see §6). |

### Backend — edited files

| Path | Change |
|---|---|
| `backend/index.js` | (a) Mount **two** routers. The public one is **ungated** at the mount level (the external recipient has no `req.orgId`, so a mount-level `requireFeature` would 403 every portal hit — same split CS-7 documents): `app.use('/api/portal', portalRoutes);` placed near the other public-token mounts (after `/api/emails`, ~line 628). The admin one is gated: `app.use('/api/portal-admin', requireFeature('customer_success_enabled'), portalAdminRoutes);` placed after `/api/service-contracts` (~line 523). (b) Add the portal's public paths to `isCsrfExempt` (line ~185): `if (p.startsWith('/api/portal/')) return true;` next to the existing `/api/emails/unsubscribe/` check (line ~192). **Exception:** the portal's own state-changing endpoints (comment, approve) are protected by the **portal session token in the `X-Portal-Token` header / `portal_token` cookie**, which is itself the anti-CSRF credential — same reasoning as item 7 (`/api/auth/2fa/verify`, "the tempToken itself is the anti-CSRF token") in the `csrfIgnoredRoutes` comment block. (c) Extend the CSRF-exempt comment block (lines ~159–171) with a new item documenting the customer portal. |
| `backend/services/featureFlags.js` | **No change if a prior CS-* item already added `customer_success_enabled` to `KNOWN_FLAGS`.** If CS-10 is the first CS item implemented, add it (module category, `defaultValue: false`) per §2. |
| `backend/services/email.js` | **No code change** — CS-10 calls the existing send path to deliver the magic-link invite. (If a typed helper is desired, add `sendPortalInvite({ to, link, companyName })` mirroring the existing template helpers, but the generic send is sufficient.) |
| `backend/services/audit.js` | Add event constants to the `EVENTS` map: `PORTAL_ACCESS_GRANTED` (`portal.access.granted`), `PORTAL_ACCESS_REVOKED` (`portal.access.revoked`), `PORTAL_LOGIN` (`portal.login`), `PORTAL_DOCUMENT_DOWNLOAD` (`portal.document.download`), `PORTAL_COMMENT_POSTED` (`portal.comment.posted`), `PORTAL_APPROVAL_DECISION` (`portal.approval.decision`). |

### Frontend — new files

| Path | Purpose |
|---|---|
| `frontend/src/pages/PortalAdmin.js` (route `/accounts/:id` tab, **not** a new top-level route) | The internal "Portal Access" panel inside CS-1's AccountDetail page: list/grant/revoke contacts, choose shared deals & documents, see pending approvals. If CS-1's `AccountDetail.js` is not yet built, this becomes a standalone `frontend/src/pages/PortalAdmin.js` at route `/accounts/:id/portal` (still inside the authenticated block). |

### Frontend — edited files

| Path | Change |
|---|---|
| `frontend/src/api.js` | Add a `portalAdmin` namespace: `listAccess(companyId)`, `grant(companyId, body)`, `revoke(accessId)`, `listShares(companyId)`, `share(companyId, body)`, `unshare(shareId)`, `listApprovals(companyId)`. Mirror the `drive`/`gmail` namespace pattern (`api.js` lines ~177–310). **No client for the public portal** — that is server-rendered HTML served by the backend, not part of the SPA. |
| `frontend/src/pages/AccountDetail.js` (CS-1) | Add a "Customer Portal" section/tab rendering `PortalAdmin` content. Render only when `showAccountManagement` is true (the `stages.js` toggle CS-1 adds). |
| `frontend/src/stages.js` | **No CS-10-specific change** — relies on the `showAccountManagement` toggle CS-1/CS-3 already add to `getStageConfig()` (true for `zang`/`rin`, false for `generic`/`jcp`). |
| `frontend/src/components/Nav.js` | **No new nav link** — the portal-admin surface lives inside the account page; the external portal is reached by emailed link, never from the internal nav. |

> **Why two backend routers (`/api/portal` public, `/api/portal-admin` authenticated):**
> the public one runs with **zero JWT context** and self-scopes from the resolved token;
> the admin one runs the standard `authMiddleware` + `qs(req)` + `requireFeature`. Keeping
> them in separate files makes the "this file never trusts a JWT / this file always requires
> one" boundary structural and easy to review, exactly like the Drive/Gmail auth-vs-deal
> split in `index.js` lines 546–572.

---

## 2. New env vars + graceful degradation

**No new *required* env vars.**

| Var | Already exists? | Role in CS-10 | Degradation |
|---|---|---|---|
| `PUBLIC_BASE_URL` | Yes — `services/automation.js` line 19 (`process.env.PUBLIC_BASE_URL \|\| 'https://app.theopencrm.com'`). | Builds the magic-link in the portal invite email and the canonical portal base URL. | Falls back to the hard-coded production URL, exactly as today. The portal HTML pages are served by the **backend** origin, so the link is `${PUBLIC_BASE_URL or backend URL}/api/portal/...`; see note below. |
| `PORTAL_BASE_URL` | **New, optional.** | If set, overrides the host used to build portal links so a custom subdomain (e.g. `https://portal.theopencrm.com`) can front the backend's `/api/portal/*` routes. | **Unset → falls back to the backend's own origin** (derived the same way `emailRoutes.js` line ~398 derives the backend URL for unsubscribe/pixel links). No throw. |
| `GMAIL_USER`+`GMAIL_APP_PASSWORD` / `SENDGRID_API_KEY` | Optional (see CLAUDE.md). | Transport for the portal magic-link invite via `services/email.js`. | `email.isConfigured()` is `false` → the grant endpoint still **creates** the `portal_access` row and **returns the magic link in the API response** so the internal user can copy/paste it manually. `invite_sent_at` stays NULL. **No throw.** |
| `GCS_DOCUMENTS_BUCKET` / GCS service-account | Optional (see CLAUDE.md). | Signed-URL document downloads. | `storage` is lazy-init; if a document is a legacy DB blob the portal streams it inline exactly like `documentRoutes.js` lines 74–79; if signed-URL generation fails the portal returns a 500 with a `requestId` (mirrors `documentRoutes.js` line 70) rather than leaking the path. |
| `DRIVE_TOKEN_ENCRYPTION_KEY` | Optional master key (see CLAUDE.md). | **Not used.** Portal session tokens are random opaque strings stored as-is (like `email_unsubscribes.token`), not encrypted secrets. They are revocable and short-lived, so the hashing/encryption ceremony of integration refresh tokens is unnecessary. (If the security review later wants tokens stored hashed, store `sha256(token)` in `portal_access.token_hash` and compare hashes — noted as a hardening option, not required for v1.) |

**Graceful degradation summary:** CS-10 introduces no integration that can hard-fail at
boot. With no email transport, access is granted and the link is returned for manual
delivery. With no GCS, documents fall back to DB-blob streaming. With
`customer_success_enabled` off, the **admin** endpoints 403 but **already-issued portal
links keep working** (a customer mid-collaboration must not be locked out by an admin flag
flip; revocation is the explicit kill-switch, not the feature flag).

**Feature-flag registration (only if no prior CS-* item added it):**

```js
// services/featureFlags.js — KNOWN_FLAGS, "MODULES" section
{
  name: 'customer_success_enabled',
  category: 'module',
  description: 'Post-sale customer-success surface: account 360, health, renewals, '
    + 'support cases, and the customer-facing portal (token-scoped external '
    + 'collaboration). Keeps generic/jcp profiles lean; intended for zang/rin.',
  defaultValue: false,
},
```

---

## 3. Migrations

**File:** `backend/migrations/110_customer_portal.sql` (see prefix note in §1). Migrations
auto-run on production boot in numeric-string order; a broken `.sql` blocks the deploy
(Cloud Run keeps the prior revision) — test locally with `NODE_ENV=production npm start`
and watch the migration log.

**Safety:** all four tables are **new** → `CREATE TABLE IF NOT EXISTS` is correct. No
`ALTER` on `contacts`/`deals`/`activities`/`companies`. Every table carries `org_id` so the
session-resolver scope clause can filter structurally.

```sql
-- CS-10 — Customer-facing portal / collaboration.
--
-- Four new tables, all org-scoped, all idempotent (re-run = no-op):
--
--   portal_access    — one row per (org, contact) external grant. Holds the
--                      opaque session token (emailed magic-link), status, and
--                      expiry. This is the customer's "login" — revocable.
--   portal_shares    — the allow-list. One row per (access OR company-wide-for-
--                      contact, resource_type, resource_id) the internal user
--                      has chosen to expose. resource_type ∈ deal|document.
--   portal_comments  — the thin collaboration layer. A comment posted EITHER by
--                      an internal user OR by the external contact, attached to a
--                      shared deal. author_type distinguishes the two.
--   portal_approvals — items explicitly routed to the customer for sign-off
--                      (a quote, a submittal, a generic document). Carries the
--                      decision + optional decision note + optional attachment.
--
-- Bounds (status enums, resource_type enum) are enforced in the app layer (zod),
-- matching the codebase preference for zod over CHECK constraints (see schemas/).

BEGIN;

CREATE TABLE IF NOT EXISTS portal_access (
  id              BIGSERIAL    PRIMARY KEY,
  org_id          INTEGER      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id      INTEGER      NOT NULL REFERENCES companies(id)     ON DELETE CASCADE,
  contact_id      INTEGER      REFERENCES contacts(id)               ON DELETE SET NULL,
  recipient_email VARCHAR(254) NOT NULL,
  token           VARCHAR(64)  NOT NULL UNIQUE,    -- 32-byte hex = 64 chars; opaque magic-link
  status          VARCHAR(12)  NOT NULL DEFAULT 'active', -- active | revoked | expired
  scopes          JSONB        NOT NULL DEFAULT '["view","comment","approve"]'::jsonb,
  expires_at      TIMESTAMPTZ  NOT NULL,           -- default NOW() + 30 days, set in app layer
  invite_sent_at  TIMESTAMPTZ,                     -- NULL until the email actually goes out
  last_seen_at    TIMESTAMPTZ,                     -- stamped on each resolved portal request
  granted_by      INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  updated_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_portal_access_org_company
  ON portal_access(org_id, company_id);
CREATE INDEX IF NOT EXISTS idx_portal_access_token
  ON portal_access(token);
CREATE INDEX IF NOT EXISTS idx_portal_access_active
  ON portal_access(status) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS portal_shares (
  id            BIGSERIAL    PRIMARY KEY,
  org_id        INTEGER      NOT NULL REFERENCES organizations(id)   ON DELETE CASCADE,
  access_id     BIGINT       NOT NULL REFERENCES portal_access(id)   ON DELETE CASCADE,
  resource_type VARCHAR(12)  NOT NULL,             -- 'deal' | 'document'
  resource_id   INTEGER      NOT NULL,             -- deals.id or documents.id
  shared_by     INTEGER      REFERENCES users(id)  ON DELETE SET NULL,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (access_id, resource_type, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_portal_shares_access
  ON portal_shares(access_id);
CREATE INDEX IF NOT EXISTS idx_portal_shares_org_resource
  ON portal_shares(org_id, resource_type, resource_id);

CREATE TABLE IF NOT EXISTS portal_comments (
  id           BIGSERIAL    PRIMARY KEY,
  org_id       INTEGER      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id      INTEGER      NOT NULL REFERENCES deals(id)         ON DELETE CASCADE,
  access_id    BIGINT       REFERENCES portal_access(id)          ON DELETE SET NULL, -- NULL when author is internal
  author_type  VARCHAR(10)  NOT NULL,              -- 'internal' | 'customer'
  author_user_id INTEGER    REFERENCES users(id)   ON DELETE SET NULL,  -- set when internal
  author_label VARCHAR(254),                       -- contact email / name when customer
  body         TEXT         NOT NULL,
  created_at   TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portal_comments_deal
  ON portal_comments(org_id, deal_id, created_at);

CREATE TABLE IF NOT EXISTS portal_approvals (
  id             BIGSERIAL    PRIMARY KEY,
  org_id         INTEGER      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  access_id      BIGINT       NOT NULL REFERENCES portal_access(id) ON DELETE CASCADE,
  resource_type  VARCHAR(16)  NOT NULL,            -- 'quote' | 'submittal' | 'document'
  resource_id    INTEGER      NOT NULL,            -- quotes.id / submittals.id / documents.id
  title          VARCHAR(255) NOT NULL,            -- denormalized label shown in the portal
  status         VARCHAR(12)  NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  decision_note  TEXT,
  attachment_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL, -- optional signed doc the customer uploads
  requested_by   INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  decided_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ  DEFAULT NOW(),
  updated_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_portal_approvals_access
  ON portal_approvals(access_id);
CREATE INDEX IF NOT EXISTS idx_portal_approvals_org_status
  ON portal_approvals(org_id, status);

COMMENT ON TABLE portal_access   IS 'CS-10 external portal grants. One row per (org, contact); token is the emailed magic-link. Revoke = status=revoked. See backend/routes/portalRoutes.js.';
COMMENT ON TABLE portal_shares   IS 'CS-10 allow-list: which deals/documents a given portal_access can see. No row = no access.';
COMMENT ON TABLE portal_comments IS 'CS-10 collaboration: comments on a shared deal, by internal user or external contact (author_type).';
COMMENT ON TABLE portal_approvals IS 'CS-10 items routed to the customer for sign-off (quote/submittal/document). Decision captured here, not on the source row.';

COMMIT;
```

**Notes:**
- `portal_approvals.status` is the **portal-side** decision record. CS-10 deliberately does
  **not** write the customer's approval back onto `quotes`/`submittals` source rows — those
  have their own internal status state-machines (`submittals_enabled` workflow, etc.). The
  internal user reviews the captured decision and applies it through the existing module UI.
  This avoids a cross-module write that would couple CS-10 to the Zang submittal lifecycle.
- `portal_shares.resource_id` is intentionally **not** a hard FK (resource_type-polymorphic),
  mirroring the existing `issues.related_type`/`related_id` and `documents.related_type`/
  `related_id` polymorphic-link convention (migration `040`). Integrity is enforced in the
  app layer by `services/portalShare.js`, which verifies the row exists and is org-scoped
  before inserting a share.

---

## 4. API endpoints

Two route files. The **public** file (`portalRoutes.js`) has **no `authMiddleware`**; it uses
a `portalSession` resolver middleware that loads the token and sets
`req.portal = { accessId, orgId, companyId, contactId, scopes }`. **Every public query filters
on `req.portal.orgId` AND a `portal_shares` allow-list check** — the structural equivalent of
`qs(req)`. The **admin** file (`portalAdminRoutes.js`) uses the standard
`router.use(authMiddleware)` + `qs(req)` + per-route `requireFeature('customer_success_enabled')`.

The portal session token travels in the `X-Portal-Token` request header (set by the portal's
own server-rendered pages) or a `portal_token` cookie set on first magic-link visit. The token
in the magic-link URL (`?t=<token>`) is accepted on the **initial** GET to bootstrap the cookie,
then dropped from subsequent links.

```
resource_type (shares)    ∈ { 'deal', 'document' }
resource_type (approvals) ∈ { 'quote', 'submittal', 'document' }
portal_access.status      ∈ { 'active', 'revoked', 'expired' }
approval decision         ∈ { 'approved', 'rejected' }
```

### Public portal — token-authed, no JWT, CSRF-exempt (`/api/portal/*`)

#### `GET /api/portal/?t=:token`  (and `GET /api/portal/` with `portal_token` cookie)
- **Auth:** portal token only. Resolves via `portalAuth.resolvePortalToken`. Sets the
  `portal_token` cookie (`HttpOnly; Secure; SameSite=Lax; Max-Age=…`) on first hit and
  302-redirects to the cookie-only URL to strip the token from the address bar (mirrors
  good magic-link hygiene). Stamps `portal_access.last_seen_at`, emits `PORTAL_LOGIN`.
- **Behavior:** server-rendered **dashboard** HTML — account name, the list of shared deals
  (title + stage label only; never internal-only fields like `salesman_id`, `vendor_id`,
  `ai_*`, `notes`), a documents list, and a "pending your approval" list. Unknown/revoked/
  expired token → neutral "this link is no longer valid" page, **HTTP 200, no leak** (same
  discipline as `/api/emails/unsubscribe/:token`).
- **Response:** `text/html`.

#### `GET /api/portal/deals/:dealId`
- **Auth:** portal token. **Authorization:** `portalShare.assertSharedDeal(orgId, accessId, dealId)`
  — 404 (not 403) if the deal isn't in this token's allow-list, so a probe can't enumerate.
- **Behavior:** server-rendered deal detail showing **only** a curated projection of `deals`
  (`title`, `stage` → human label via the org's stage config, `expected_close_date`,
  `closed_date`), the shared documents attached to that deal, the comment thread
  (`portal_comments WHERE deal_id=$1 AND org_id=$2`), and any approvals routed to this access.
  **Explicit field allow-list** — the SELECT names columns; it never `SELECT *` from `deals`.
- **Response:** `text/html`.

#### `GET /api/portal/documents/:documentId/download`
- **Auth:** portal token. **Authorization:** the document id must be in this access's
  `portal_shares` (resource_type='document') **or** attached to a shared deal. 404 otherwise.
- **Behavior:** **identical to `documentRoutes.js` lines 49–84** — prefer GCS signed URL
  (`storage.getSignedDownloadUrl(objectPath, { expiresInSeconds: 900, filename })`, 302
  redirect), fall back to DB-blob inline stream. Emits `PORTAL_DOCUMENT_DOWNLOAD` audit
  event. Never exposes `gcs_object_path`.
- **Response:** `302` to a signed URL, or the blob inline.

#### `POST /api/portal/deals/:dealId/comments`
- **Auth:** portal token (token = anti-CSRF credential; route is in the CSRF-exempt prefix).
  Requires `'comment'` in `req.portal.scopes`. Validated by `commentSchema` (`body` 1–4000 chars).
- **Authorization:** `assertSharedDeal`.
- **Behavior:** inserts `portal_comments (org_id, deal_id, access_id, author_type='customer',
  author_label=<contact email>, body)`. Emits `PORTAL_COMMENT_POSTED`. **Side effect:**
  best-effort `notificationDispatcher` to the deal's `salesman_id` (fire-and-forget, never
  blocks) so the internal owner knows the customer replied — reuses the dispatcher CS-1..6
  already wired into `activityRoutes.js`/`taskRoutes.js`.
- **Response 201:** `{ ok: true, comment: { id, body, created_at, author_type } }` (JSON; the
  portal page also re-renders, but the endpoint returns JSON so the page's inline fetch can
  append without a full reload).

#### `POST /api/portal/approvals/:approvalId/decision`
- **Auth:** portal token; requires `'approve'` scope; CSRF-exempt (token-authed). Validated
  by `approvalDecisionSchema` (`decision ∈ {approved,rejected}`, `note?` ≤2000).
- **Authorization:** the approval row's `access_id` must equal `req.portal.accessId`. 404 else.
- **Behavior:** sets `portal_approvals.status`, `decision_note`, `decided_at=NOW()` in a single
  UPDATE guarded by `status='pending'` (idempotent — re-deciding a decided approval returns the
  existing state, no double-write). Optional single attachment upload (multer memory storage,
  ≤10MB) stored via `storage.uploadBuffer` and linked as `attachment_document_id` (this is the
  *one* customer file-write path; it creates a `documents` row scoped to the org with
  `related_type='portal_approval'`). Emits `PORTAL_APPROVAL_DECISION`. Fires a notification to
  `requested_by`.
- **Response 200:** `{ ok: true, approval: { id, status, decided_at } }`.

### Admin (internal) — JWT + CSRF + `requireFeature('customer_success_enabled')` (`/api/portal-admin/*`)

`qs(req)` is `function qs(req){ return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }`
at the top of `portalAdminRoutes.js`. Every query interpolates `${sf} = $n`.

#### `POST /api/portal-admin/access`
- **Auth:** JWT + CSRF + flag. Validated by `grantSchema`.
- **Request:**
  ```json
  {
    "company_id": 42,                 // required, must belong to caller's org
    "contact_id": 7,                  // optional, must belong to org + that company
    "recipient_email": "buyer@acme.com", // required (defaults from contact if omitted)
    "scopes": ["view","comment","approve"], // optional, subset of the three
    "expires_in_days": 30,            // optional, default 30, max 180
    "send_now": true                  // optional, default true
  }
  ```
- **Behavior:** verifies `company_id` (and `contact_id` if given) belong to the org
  (`SELECT 1 ... WHERE id=$1 AND ${sf}=$2` → 400 on cross-org). Generates a
  `crypto.randomBytes(32)` token, inserts `portal_access` with `expires_at = NOW() + interval`,
  `granted_by = req.userId`. If `send_now` and `email.isConfigured()`, emails the magic-link
  (`${PORTAL_BASE_URL or backend origin}/api/portal/?t=<token>`) and stamps `invite_sent_at`.
  Emits `PORTAL_ACCESS_GRANTED`.
- **Response 201:** the `portal_access` row **including the magic-link** (so an admin can copy
  it when email is unconfigured).

#### `GET /api/portal-admin/access?company_id=:id`
- **Auth:** JWT + flag. **Behavior:** lists `portal_access` rows for the company, org-scoped
  (`WHERE ${sf}=$1 AND company_id=$2`), with derived `is_active` and `last_seen_at`. Token is
  **not** returned in the list (only on create) to limit exposure.
- **Response 200:** array of access rows (no raw token).

#### `POST /api/portal-admin/access/:id/revoke`
- **Auth:** JWT + CSRF + flag. **Behavior:** `UPDATE portal_access SET status='revoked',
  updated_at=NOW() WHERE id=$1 AND ${sf}=$2 RETURNING id`. 404 if not in scope. Emits
  `PORTAL_ACCESS_REVOKED`. Idempotent.
- **Response 200:** `{ ok: true, id }`.

#### `GET /api/portal-admin/shares?company_id=:id` · `POST /api/portal-admin/shares` · `DELETE /api/portal-admin/shares/:id`
- **Auth:** JWT + (CSRF on POST/DELETE) + flag. Validated by `shareSchema`.
- **POST request:** `{ access_id, resource_type: 'deal'|'document', resource_id }`. Behavior:
  verifies the `access_id` is org-scoped AND the `resource_id` exists and is org-scoped
  (via `services/portalShare.js`) → 400 on cross-org/missing; inserts a `portal_shares` row
  (`ON CONFLICT (access_id, resource_type, resource_id) DO NOTHING`). **GET** lists shares for
  the company's accesses. **DELETE** removes a share (`WHERE id=$1 AND ${sf}=$2`).
- **Response:** 201 on create, 200 array on list, 200 `{ok:true}` on delete.

#### `GET /api/portal-admin/approvals?company_id=:id` · `POST /api/portal-admin/approvals`
- **Auth:** JWT + (CSRF on POST) + flag. **POST request:**
  `{ access_id, resource_type: 'quote'|'submittal'|'document', resource_id, title }`.
  Behavior: verifies access + resource org-scope; inserts a `portal_approvals` row
  `status='pending'`, `requested_by=req.userId`. **GET** lists approvals for the company with
  their current decision state (so the internal user sees what the customer signed off).
- **Response:** 201 on create, 200 array on list.

> **No customer-facing JSON API beyond the portal HTML pages + the two POST collaboration
> endpoints.** The customer never gets a generic "list my deals" JSON endpoint that could be
> scripted against — everything they see is rendered server-side from the allow-list, which
> keeps the external attack surface to the four `/api/portal/*` routes above.

---

## 5. UI surface

CS-10 has **two surfaces**: the external portal (server-rendered, backend-served) and the
internal admin panel (SPA, inside the account page).

### A. External customer portal (server-rendered HTML, served by the backend)

- Served directly by `portalRoutes.js` as HTML strings, **the same technique** as
  `GET /api/emails/unsubscribe/:token` (`emailRoutes.js` lines 93–129): inline `<style>`, a
  centered `.card`/`.container` layout, no external assets, no React. A small shared
  `renderShell(title, bodyHtml)` helper in `portalRoutes.js` wraps every page (header with the
  account name + a "secure portal" badge, footer with a contact-the-sender line).
- **Pages:** (1) dashboard (`GET /api/portal/`), (2) deal detail with comment thread + a
  textarea that POSTs a comment via inline `fetch` (carrying `X-Portal-Token` from the cookie),
  (3) document download (302 to signed URL — no page), (4) an approval card with
  Approve/Reject buttons + optional note + optional file input that POST the decision.
- **Why server-rendered, not a token-scoped SPA route:** a React route would force shipping
  the entire authenticated bundle (and its API client) to an unauthenticated external user,
  enlarging the attack surface and risking accidental access to internal endpoints. Server
  HTML keeps the external surface to exactly the four routes in §4. The trade-off (no rich
  client interactivity) is acceptable for a read-mostly status/approval portal. **Alternative
  considered and rejected:** a separate minimal SPA build under `frontend-portal/` — more
  infra (second Cloud Run build, second `server.js`) than a P3 item warrants.

### B. Internal admin panel (SPA, gated by `showAccountManagement`)

- Lives as a **"Customer Portal" tab/section inside CS-1's `AccountDetail.js`**. Lists granted
  contacts (status, last-seen, expiry), a "Grant access" form (email + scope checkboxes +
  expiry), per-access "what's shared" pickers (multi-select of the account's deals and
  documents → `portal-admin/shares`), a "Request approval" action (pick a quote/submittal/
  document → routes it to a contact), and a read-only view of decisions the customer has made.
- Renders only when `getStageConfig(profile).showAccountManagement` is true (`zang`/`rin`).
- **If CS-1's `AccountDetail.js` does not exist yet**, ship a standalone
  `frontend/src/pages/PortalAdmin.js` at `/accounts/:id/portal` (inside the authenticated
  block in `App.js`, lazy-loaded via `lazyWithRetry`); the feature is fully exercisable through
  the `portalAdmin` API namespace regardless.
- **Nav:** no new top-level nav link (the panel lives inside the account page; the external
  portal is reached only by emailed link).

---

## 6. Tests

**File:** `backend/test/portal.test.js`, Vitest + supertest, following the
`backend/test/me.test.js` harness (mount the routers on a bare Express app, patch the live
`pool.query`/`pool.connect`, stub `audit`, `services/email`, and `services/storage`). At least
one happy path per endpoint, plus the token-scoping, revocation, and cross-org cases that are
load-bearing for an externally-reachable feature.

| # | Endpoint | Assertion |
|---|---|---|
| 1 | `POST /api/portal-admin/access` | Valid `company_id` in org → 201; row has `status='active'`, 64-hex token, `expires_at ≈ NOW()+30d`; response includes the magic-link; `invite_sent_at` set when email stubbed-configured, NULL when unconfigured. |
| 2 | `POST /api/portal-admin/access` | `company_id` belonging to **another** org → 400 (cross-org guard); assert the validation `SELECT` carried `${sf}=$2`. |
| 3 | `POST /api/portal-admin/access` | bad `scopes` (`["delete"]`) or `expires_in_days` > 180 → 400 from `grantSchema`. |
| 4 | `GET /api/portal-admin/access` | returns only this org's rows; **token field absent** from each row → 200. |
| 5 | `POST /api/portal-admin/access/:id/revoke` | in-scope id → 200 `{ok:true}`, status flips to `revoked`; out-of-scope id → 404. |
| 6 | `POST /api/portal-admin/shares` | share a deal that **is** in the org → 201; share a deal from **another** org → 400 (portalShare guard). |
| 7 | `GET /api/portal/?t=<token>` | active token → 200 `text/html` dashboard listing only shared resources; sets `portal_token` cookie; stamps `last_seen_at`. Unknown/revoked/expired token → 200 neutral "no longer valid" page (**not** 404, no leak). |
| 8 | `GET /api/portal/deals/:dealId` | a deal **in** the token's `portal_shares` → 200 HTML with the curated field projection (assert internal fields like `salesman_id`/`notes` are **absent** from the output); a deal **not** shared (even within the same company) → 404. |
| 9 | `GET /api/portal/documents/:id/download` | shared doc with `gcs_object_path` → 302 to a signed URL (storage stubbed); unshared doc → 404. Assert `PORTAL_DOCUMENT_DOWNLOAD` audit fired. |
| 10 | `POST /api/portal/deals/:dealId/comments` | valid body with a token lacking `'comment'` scope → 403; with the scope on a shared deal → 201, inserts one `portal_comments` row (`author_type='customer'`); assert **no JWT/CSRF** required (no auth cookie, no `X-CSRF-Token`). |
| 11 | `POST /api/portal/approvals/:id/decision` | `decision='approved'` on a pending approval owned by this access → 200, status flips, `decided_at` set; re-deciding → 200 idempotent (no second write); an approval owned by a **different** access → 404. |
| 12 | revocation enforcement | after `POST /access/:id/revoke`, the **same token** on `GET /api/portal/` → 200 neutral "no longer valid" page; on `POST .../comments` → 403/neutral (no insert). |
| 13 | feature gate | `GET /api/portal-admin/access` with `customer_success_enabled` off → 403 (real `requireFeature` + features mock `{}`); **but** `GET /api/portal/?t=<token>` with the flag off → still 200 (public portal is ungated — an already-issued link must keep working). |
| 14 | expiry | a token whose `expires_at < NOW()` → portal pages render the neutral "no longer valid" page; `resolvePortalToken` returns null. |

Run with `npm test` from `backend/`.

---

## 7. Acceptance criteria (observable / demo-able)

1. **Grant + invite:** With `customer_success_enabled` on, an internal user opens an account →
   "Customer Portal" → "Grant access" → enters a customer email → submits. A `portal_access`
   row is created and (when email is configured) an invite email lands containing a
   `…/api/portal/?t=<token>` magic-link. When email is **not** configured, the link is shown in
   the UI for manual copy — no error.
2. **Customer logs in (no password):** Opening the magic-link in a logged-out browser renders
   the portal dashboard showing **only** the deals/documents the internal user shared — nothing
   else from the account, and no internal-only fields (no salesman, no vendor, no AI scores, no
   internal notes).
3. **Document download:** From the portal, the customer clicks a shared document and gets the
   file via a 15-minute signed URL (or inline blob fallback). A document **not** shared returns
   "not found" — it cannot be reached by guessing an id.
4. **Two-way comment:** The customer posts a comment on a shared deal; it appears in the
   internal account timeline, and the deal's owner gets a (best-effort) notification. An
   internal reply appears back in the portal thread on the customer's next visit.
5. **Approval round-trip:** An internal user routes a quote/submittal for approval; the customer
   sees an "Approve / Reject" card, submits a decision (optionally with a note/attachment); the
   internal user sees the captured decision on the account panel. The source quote/submittal row
   is **not** auto-mutated (decision is reviewed and applied through the existing module).
6. **Revocation kills access immediately:** Clicking "Revoke" on a grant makes the same
   magic-link render "this link is no longer valid" on the very next request; no further
   downloads/comments/approvals succeed with that token.
7. **Org isolation:** A token issued by org A can never see org B's deals/documents/approvals;
   an internal user in org A cannot grant access to or share org B's records (cross-org attempts
   return 400/404). Every portal query filters on the token's `org_id` + the `portal_shares`
   allow-list.
8. **Graceful degradation:** With no email transport, grants still succeed and links are
   returned for manual delivery; with no GCS, documents fall back to inline blob streaming;
   with the feature flag later toggled **off**, already-issued portal links keep working
   (revocation is the kill-switch, not the flag) while the internal admin endpoints 403.
9. **Auditability:** Grant, revoke, portal login, document download, comment, and approval
   decision each emit an `audit_log` row (`portal.*` events), so an operator can reconstruct
   exactly what an external token did.

---

## 8. Out of scope (explicitly deferred)

- Customer self-service account creation, passwords, or SSO — auth is the emailed magic-link
  token only.
- A token-scoped React SPA / second frontend build — the portal is server-rendered HTML.
- Customer-initiated record creation (new deals, arbitrary uploads beyond a single
  approval-attachment), or editing any CRM field.
- Writing the customer's approval decision back onto `quotes`/`submittals` source rows
  (captured in `portal_approvals`; the internal user applies it through the existing module).
- Real-time updates / websockets — the portal is request/response; comments appear on reload.
- Per-resource granular scopes beyond `view`/`comment`/`approve` and the explicit share
  allow-list.
- Hashing portal tokens at rest (`token_hash`) — noted in §2 as a security-review hardening
  option, not required for v1.
- A branded custom-subdomain TLS setup for `PORTAL_BASE_URL` — operator/infra task, not code.

---

## 9. Security review checklist (because this is the only externally-reachable write surface)

- **Token entropy:** `crypto.randomBytes(32)` (256-bit) hex → 64 chars. Stored unique-indexed.
- **No enumeration:** unshared/unknown resource ids and dead tokens all return **404 / neutral
  200**, never 403-with-detail, so an attacker can't distinguish "exists but not yours" from
  "doesn't exist."
- **Scope clause on every query:** the `req.portal.orgId` + `portal_shares` allow-list is the
  `qs(req)` equivalent; `services/portalShare.js` centralizes the check so a handler can't omit it.
- **CSRF:** the portal token in `X-Portal-Token`/`portal_token` cookie is the anti-CSRF
  credential (documented in the `isCsrfExempt` comment block); the cookie is `SameSite=Lax`
  `HttpOnly` `Secure`.
- **Field allow-listing:** portal SELECTs name columns explicitly — never `SELECT *` from
  `deals`/`documents` — so internal-only fields (`salesman_id`, `vendor_id`, `ai_*`, `notes`,
  `cost`) can never leak into a rendered page.
- **Expiry + revocation:** `expires_at` (default 30d, max 180d) and `status='revoked'` are both
  checked in `resolvePortalToken` on every request.
- **Rate limiting:** apply the existing global IP limiter; additionally add a per-token limiter
  on the two POST collaboration routes (reuse the `middleware/rateLimits.js` factory) to blunt
  comment/approval spam from a leaked link.
- **Audit:** every portal action emits a `portal.*` audit event (see §1 `audit.js` edit).

---

## 10. Implementation order (suggested)

1. `110_customer_portal.sql` → run locally (`NODE_ENV=production npm start`, watch the
   migration log) to confirm the four tables create cleanly.
2. `services/portalAuth.js` (token gen + `resolvePortalToken`) and `services/portalShare.js`
   (allow-list asserts) — these are pure and unit-testable first.
3. `schemas/portal.js` (zod) + `routes/portalAdminRoutes.js` (authenticated grant/share/approve
   management).
4. `routes/portalRoutes.js`: session-resolver middleware → public HTML pages → the two POST
   collaboration endpoints.
5. `index.js`: mount both routers (admin gated, public ungated), add the `/api/portal/`
   CSRF-exempt prefix + comment-block item; `audit.js` event constants.
6. `frontend/src/api.js` `portalAdmin` namespace; the "Customer Portal" panel in
   `AccountDetail.js` (or standalone `PortalAdmin.js` if CS-1 isn't built yet).
7. `backend/test/portal.test.js`; `npm test`.
8. Manual demo against the §7 criteria; run the §9 checklist before enabling for any real org.
```