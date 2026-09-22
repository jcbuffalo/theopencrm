# Spec 206 — API keys as a control plane: `/api/v1` writes, copilot over keys, events, and the `ocrm` CLI

**Status:** ALL FOUR PARTS SHIPPED 2026-09-22 (backend 00168→00169, frontend 00145→00146; `cli/` on master)
**Driven by:** the owner's dogfood plan — run two businesses (selling the CRM with a partner;
a two-sided construction-media marketplace) *at scale, via API controls from another CLI*.
Ground truth before this spec: `/api/v1` was three read-only endpoints and every write, the
copilot, plugin runs and CSV import sat behind the browser cookie + CSRF.

---

## Part 1 — API keys are a first-class credential (SHIPPED)

**Design choice:** do not build a second, duplicated write API. Make the existing org-scoped
routers accept an API key. One credential, zero drift between "the API" and "the app".

- `auth.js authMiddleware`: no session cookie + a `tocrm_…` key in `Authorization: Bearer`
  or `X-API-Key` → `middleware/apiKeyAuth.resolveApiKey` authenticates the request. A cookie
  session always wins when both are present.
- The key **acts as its creator**: `req.userId` = creator (writes are attributed to them),
  `req.orgId` = key org, `req.orgRole` = the creator's *current* org_role (an admin's key can
  manage webhooks / pipelines). A suspended or deleted creator kills the key (401).
- **Scopes:** `read` keys may only GET/HEAD/OPTIONS; `write` keys may mutate
  (403 `API_KEY_SCOPE` otherwise). Settings → Developer has an "Allow writes" checkbox and an
  Access column.
- **Denylist** (403 `API_KEY_FORBIDDEN_ROUTE`, any scope): `/auth`, `/security`, `/me`
  (except `/api/v1/me`), `/admin`, `/billing`, `/keys`, `/org`, `/team`, `/invites`,
  `/gateway`, `/sso`, `/platform-integrations`, OAuth connectors, `/access-requests`,
  `/contact`, `/request-access`, `/legal`, `/portal`, inbound `/webhooks`. Keys run the CRM;
  they never administer the account.
- **CSRF:** exempt when a key header is present and no auth cookie — a custom header cannot
  be sent cross-site without a CORS preflight, so double-submit has nothing to protect.
- **`/api/v1` façade:** the same routers mounted under a versioned, key-only prefix:
  `companies, contacts, deals, tasks, activities, leads, import, pipelines, my-day,
  notifications, custom-fields, search, webhooks-out, plugins, ai`, plus `/api/v1/me`.
  Feature gates and the AI billing gate apply exactly as in the browser. Keys also work on
  the plain `/api/*` spelling; `/api/v1` is the documented one.

**Tests:** `backend/test/apiKeySurface.test.js` (fallback auth, scope, revoked / unknown /
suspended-creator / DB-error fail-closed, denylist, CSRF signal).

## Part 2 — Copilot over a key (SHIPPED with Part 1; contract below)

`POST /api/v1/ai/chat` (message → reply + `proposals`), `POST /api/v1/ai/actions/apply`
(apply a proposal), `GET /api/v1/ai/chat/sessions`. Nothing new to build server-side beyond
Part 1; what ships here is the documented request/response contract and CLI verbs
(`ocrm ask`, `ocrm apply`). AI usage is metered to the key's org like any chat call.

Contract (all under `/api/v1/ai`, key with `write` for apply):
```
POST /chat                    { message, session_id? }
  → { session_id, reply, actions: [{ kind, label, prompt?, proposal? }, …] }
POST /actions/apply           { proposal }          # confirm-first: only writer
  → { ok|success, message|summary, … } | 400 { error, validation_errors }
GET  /chat/sessions           → the key creator's sessions
GET  /chat/sessions/:id/messages
```
Smoke (owner, with a write key): `ocrm ask "what needs me today?"` then `ocrm apply 1`.

## Part 3 — Events a CLI can react to (SHIPPED)

Outbound webhooks (`/api/v1/webhooks-out`) over a key, and the event catalogue widened from
`deal.created`, `deal.stage_changed` to also cover `deal.updated`, `contact.created`,
`company.created`, `task.completed`, `lead.captured`, `activity.logged`. Signed with the
subscription secret (`X-Signature: sha256=<HMAC-SHA256 of the raw body>`, plus
`X-Webhook-Event`).

## Part 4 — `ocrm` CLI (SHIPPED — `cli/`, 7 tests, `cli/README.md`)

`cli/` — zero-dependency Node CLI. Profiles (`~/.ocrm/config.json`) so one terminal drives
two workspaces: `ocrm login --profile cmn --key tocrm_… --url https://…`, `ocrm use cmn`.
Verbs: `deals|contacts|companies|tasks|activities list|get|create|update|delete`,
`import <csv> --entity deals`, `my-day`, `ask "…"` / `apply`, `plugins run <id>`,
`webhooks add|list|rm|test`, `raw GET /deals?stage=…`. `--json` everywhere for piping.

## Not in scope

- Org switching for one *user* account (a user still belongs to one org); the CLI's
  profiles are the multi-business answer.
- Rate limits stay the existing per-IP / per-org ones; a per-key limit is a follow-up if a
  script misbehaves.
