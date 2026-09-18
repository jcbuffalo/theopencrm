# Spec 200 — Chat copilot uplevel: actions + accurate capability brain

**Goal:** realize "do (almost) anything from chat." Today the copilot is read/advisory
only and, when it can't do something, *improvises generic, often-wrong advice* (e.g.
suggesting IMAP/BCC for email import — features we don't have). Two thrusts:

1. **Action/write tools** — let chat change CRM data via a **confirm-first** flow.
2. **Accurate capability brain** — ground the copilot in real features/links/limits so
   it stops guessing and instead acts or hands back a precise link + steps.

**Decisions (owner, 2026-06-26):** confirm-first proposals (no silent LLM writes);
v1 actions = update deals, create tasks, log activities, create/update contacts &
companies; ship the capability brain regardless.

---

## 1. Action/write tools (confirm-first)

Model the flow on the **existing, proven pattern** for org customizations
(`backend/routes/aiRoutes.js:212` — propose → `validateProposal` → confirm → apply in a
transaction). Reuse its shape; do not invent a new one.

### Tools (added to `CHAT_TOOLS` in `backend/services/ai.js`)
The model calls these to **propose** a change. The handler **validates only and returns
a proposal — it never writes.**

- `propose_update_deal(deal_id, { stage?, amount?, hot_flag?, expected_close_date?, append_note? })`
- `propose_create_task({ title, due_date?, priority?, deal_id?, contact_id? })`
- `propose_log_activity({ type, deal_id?, contact_id?, title?, note?, activity_date? })`
- `propose_upsert_contact({ id?, first_name?, last_name?, email?, phone?, company_id?, job_title?, status? })`
- `propose_upsert_company({ id?, name?, industry?, phone?, location?, type?, status? })`

Each tool input schema uses `additionalProperties:false`. The model is told (system
prompt) to **read first** (`get_deal`/`list_deals`/etc.) to resolve names→ids and current
values before proposing.

### Handler behavior (`buildChatToolRunner`, `aiRoutes.js`)
For each `propose_*`:
1. `logDebugInvocation`-style audit isn't enough — log `ai.action_proposed`.
2. Validate against an **allowlist** (`backend/services/chatActions.js`, new):
   - entity + op (`create`/`update`) + per-entity writable-field allowlist + type checks.
   - stage must be valid for the org profile (reuse `stages`/`stageTransitions`).
   - any referenced `deal_id`/`contact_id`/`company_id` must belong to the caller's org
     (pre-flight `SELECT 1 ... WHERE id=$1 AND ${sf}=$2`).
3. Return `{ proposal: { id, entity, op, target_id, fields, summary } }` — **no write.**
   `summary` is a human sentence ("Move *Acme retrofit* PROPOSAL → NEGOTIATION").

### Confirm card (host UI)
Extend `buildActionsFromToolCalls` (`aiRoutes.js:~1200`) to emit a new chip kind
`apply_action` carrying the validated proposal. `frontend/src/pages/Chat.js` renders a
**confirm card** (summary + Apply / Cancel). Nothing is written on render.

### Apply endpoint (the only writer)
`POST /api/ai/actions/apply` (new, in `aiRoutes.js`), gated by `ai_features_enabled` +
auth + CSRF:
- Body `{ proposal }`. **Re-validate server-side** with the same `chatActions` validators
  (never trust the client/model echo).
- Execute the org-scoped INSERT/UPDATE in a transaction via `qs(req)`.
- Write `audit_log` event `ai.action_applied` with `{ entity, op, target_id, fields }`.
- Return the new/updated row. (Undo: out of scope for v1; deals/tasks/contacts already
  editable in UI. Note in response that it's auditable.)

### Guardrails
- Confirm-first: no `propose_*` ever writes.
- Org-scoped everywhere via `qs(req)`; referenced ids ownership-checked.
- Allowlisted fields only — model can't set arbitrary columns.
- Every applied write audit-logged. Bounded by existing `MAX_TOOL_ITERATIONS`.

---

## 2. Accurate capability brain

**New file `backend/services/chatCapabilities.js`** — a registry of what the product can
do, keyed by topic, each entry: `{ status: 'live'|'config'|'roadmap'|'unsupported',
summary, where (route/admin path), gating (feature flag), how (steps) }`. Seed it from
`PRICING_AND_FEATURES.md` + `featureFlags.js` KNOWN_FLAGS + the route list. Examples:
- email import from external mailbox → `unsupported` (+ point to Gmail thread sync).
- gmail thread sync → `config`, flag `gmail_intel_enabled`, where `/admin/feature-flags`,
  needs Google verification.
- CSV import → `live`, where `/import`.
- QuickBooks → `config`, `/admin/integrations`, needs QB creds.

**New tool `how_do_i(topic_or_question)`** → returns the matched capability entry (status +
where + steps), or `{ status:'unknown' }`.

**System-prompt changes (`CHAT_SYSTEM_PROMPT`, `ai.js:359`):**
- Add: "You can also MAKE CHANGES via propose_* tools (the user confirms before anything
  is written). Read current state first, then propose."
- Add a hard rule: "NEVER invent features, settings sections, integrations, or setup
  steps. For any 'can I / how do I' question, call `how_do_i`. If status is unsupported or
  unknown, say so honestly and point to the real page or `/handoff` — do not guess (no
  IMAP/BCC-style improvisation)."

---

## 3. Capabilities summary message

Update the chat's self-described capabilities (frontend starter text / any
`What I can do` block in `Chat.js`) to reflect: can now update deals, create tasks, log
activities, add/edit contacts & companies (with confirm), and gives accurate links for
the rest. Drop the blanket "can't make changes to your CRM data."

---

## Tests
- `chatActions` validators: allowlist enforcement, stage validity, org-ownership rejection,
  bad-field rejection. (mocked pool)
- `propose_*` tools return a proposal and **do not write** (assert no INSERT/UPDATE issued).
- `POST /api/ai/actions/apply`: happy path writes + audit row; rejects cross-org target;
  rejects non-allowlisted field; re-validates (ignores tampered client echo).
- `how_do_i`: returns grounded entry for a known topic; honest unknown otherwise.

## Acceptance
- In chat: "move the Acme retrofit to negotiation" → confirm card → Apply → deal stage
  updated, audit row written, chat confirms.
- "create a task to call Beta tomorrow" → confirm card → Apply → task created.
- "how do I import my old emails?" → accurate answer (external import unsupported; Gmail
  thread sync is the real option, gated, here's the page) — **no invented IMAP/BCC steps.**
- No `propose_*` path writes without an explicit Apply.

## Out of scope (v1)
Sending email directly (draft exists; send-after-confirm is a fast follow), quotes/vendor
workflow writes, bulk operations, undo. Cross-org safety + audit are NOT optional.
