# Debug Playbook — self-service troubleshooting via `/chat`

When something looks wrong in The Open CRM — a plugin didn't run, an email
didn't go out, a saved view looks empty — the fastest path to an answer is the
in-app copilot at **`/chat`**. With **Debug mode** on, the copilot has direct
read access to your org's audit log, plugin runs, email send history, saved
views, and custom-field config. It's the same data your admin would dig out
of the database — surfaced in plain English.

This playbook lists the 13 most common situations, what to ask Claude, what
a good answer looks like, and when to escalate.

## How to use this playbook

1. Open `/chat` while signed in to The Open CRM.
2. Toggle the **Debug mode** pill near the starter prompts. The pill is on
   when it shows a colored fill. Starter prompts swap to four debugging
   templates ("Why isn't my last plugin run showing results?", etc.).
3. Paste one of the prompts below — or your own variation — and read the
   reply. The copilot will tell you which lookups it ran ("Looked up: recent
   plugin failures, inspect plugin run.") so you can sanity-check the source.
4. If the answer is empty / wrong / unconvincing, follow the **Escalate**
   guidance for that scenario. Always copy the chat transcript when filing a
   ticket — support uses it to find the audit row quickly.

Debug mode is rate-limited to 40 messages/minute (vs. 20/minute in normal
mode), and you can send up to 200 chat messages per 24 hours total. Both caps
reset rolling, not at midnight.

---

## 1. "My plugin isn't running"

**Symptom:** You expect a plugin to fire on a schedule or trigger, but the
results aren't showing up. The `/plugins/:id` page shows the plugin enabled,
but recent runs are missing or marked failed.

**Ask Claude (debug mode):**
> "Why isn't plugin 7 running? Show me failures in the last 24 hours."

**Good answer looks like:**
- Lists 1+ rows from `recent_plugin_failures` with status (e.g.
  `budget_exceeded`, `sandbox_unavailable`, `timed_out`, `failed`), error
  message, and run id.
- Drills into the worst-looking one via `inspect_plugin_run` and quotes the
  `error_message` and `log_lines`.
- Names the likely cause ("query budget exceeded — 50 DB calls").

**Bad answer looks like:**
- "Your plugin might have an error." (No row ids, no specifics — Claude
  didn't actually call the diagnostic tools.)

**Escalate when:** all recent runs have status `sandbox_unavailable` (that's
a platform-level fault, not your config). Copy the run id and the chat
transcript into a support ticket; the platform team will need to check the
isolated-vm install on the backend.

---

## 2. "I'm not getting notification emails"

**Symptom:** You enabled task-assigned or weekly-summary notifications but
nothing shows up in your inbox.

**Ask Claude (debug mode):**
> "Why am I not getting notification emails? Check my settings and platform
> config."

**Good answer looks like:**
- Lists your `notification_preferences` (which channels are on for which
  triggers).
- Names your `effective_notification_email` (whichever of your override or
  login email is being used).
- Calls out platform-level state from the `hints[]` array: "No SENDGRID or
  SMTP set on the platform — emails fall back to console-only," or "SMS is
  off globally because Twilio credentials aren't configured."
- If your preferences are on AND the platform is wired AND you don't have a
  recent `email.sent` audit row → the trigger never fired (which is its own
  thing — see scenario 6).

**Escalate when:** the platform reports `email_configured: true` and your
preferences look right but no `email.sent` audit rows appear for you in 7+
days. There's a wiring gap between the trigger source (task assigned, etc.)
and `services/notificationDispatcher.js`. Mention "notification dispatcher
not firing" in the ticket.

---

## 3. "My saved view shows no results"

**Symptom:** A saved view (deals/contacts/etc. with custom filters) suddenly
shows zero rows. You think you did this last week and it had a dozen.

**Ask Claude (debug mode):**
> "Show me saved view 23 — what filters does it actually have?"

**Good answer looks like:**
- Reads the row and quotes the `filter_spec` JSON.
- Points out the suspect filter (a date that's now in the past; a stage you
  renamed; an owner who left the org).
- Optionally calls `try_api` against the list endpoint with those filters to
  confirm an empty result.

**Bad answer looks like:** Vague "your filters might be too narrow" with no
specific keys.

**Escalate when:** the filter spec looks correct AND `try_api` confirms the
list endpoint returns zero rows — meaning the data really is missing.
Probably a separate problem (deleted records, cross-org confusion). Pivot to
scenarios 5 or 8.

---

## 4. "AI search returned weird filters"

**Symptom:** You typed something like "deals from Acme over $50K from last
quarter" into the search bar and the page either returned everything, nothing,
or the wrong subset.

**Ask Claude (debug mode):**
> "Show me my recent `ai.conversational_search` audit events — what did the
> model translate my query to?"

**Good answer looks like:**
- Lists recent rows from `recent_audit_events` with `event_prefix='ai.'` and
  `target_type='ai_search'`.
- The `meta` payload includes the raw query, the resolved `filter`, and any
  `droppedKeys`.
- Spots the disconnect ("your query mentioned Acme but the filter spec didn't
  include a customer filter — the model dropped it because customer name
  isn't a supported filter key").

**Escalate when:** the model is consistently dropping a filter dimension your
team needs (e.g. customer-name search on deals). Note the dropped key and
file an enhancement request — extending the allowlist is a backend change in
`SEARCH_CATALOG` (`backend/services/ai.js`).

---

## 5. "My bulk operation didn't apply"

**Symptom:** You bulk-edited 50 deals from a list page, the success toast
fired, but reloading shows the change applied to only some rows (or none).

**Ask Claude (debug mode):**
> "Show me my last few `bulk.update` audit events on deals."

**Good answer looks like:**
- Returns the audit rows (event `bulk.update`, `target_type='deals'`).
- The `meta` includes the full `ids[]` list and the `patch` object.
- Spots the mismatch ("you sent 50 ids but the patch is empty `{}` — nothing
  to apply") or ("you patched `stage='WON'` but `WON` isn't a valid stage —
  the per-row validator rejected each one").

**Escalate when:** the audit row shows the patch was applied with the
expected ids, but the rows really don't reflect the change. There's a
trigger or constraint silently reverting the column. Capture the audit row
id and file a ticket.

---

## 6. "Can't sign in after a deploy"

**Symptom:** You sign in, get bounced back to the login page. Or you sign in
fine but every API call returns 401.

**Ask Claude (debug mode):** This one usually fails in chat because
chat itself requires auth. Instead:

1. Open a private/incognito browser window and sign in fresh.
2. If that works, **clear your auth cookies for the original tab** — old
   `authToken` cookies from before the deploy can become invalid if the JWT
   signing key rotated.
3. If neither works, ask another admin to run in chat (debug mode):
   > "Show me failed `auth.login.fail` events in the last hour."

**Good answer looks like:** An `auth.login.fail` audit row with your user id
and a hint in `meta` ("user suspended", "user pending approval",
"password_history_violation", etc.).

**Escalate when:** there's no `auth.login.fail` row in the audit log but you
genuinely can't sign in. The request isn't reaching the backend (CDN cache, a
proxy stripping cookies, a CORS mismatch). File a ticket with browser dev-tools
network capture.

---

## 7. "An email I sent isn't showing as opened"

**Symptom:** You sent a customer email through the in-CRM composer; you
expect to see "opened" but it's been hours.

**Ask Claude (debug mode):**
> "Show me my last 10 email sends to contact 415 — did any of them open?"

**Good answer looks like:**
- Returns rows from `email_send_history` filtered to that contact.
- For each row reports `sent_at`, `opened_at` (null if not opened),
  `provider_dispatched`, and `unsubscribed_at`.
- Points out the relevant gotchas: "the email shows
  `provider_dispatched=false` — that means SMTP wasn't configured at send
  time, only logged to console," or "the recipient is in the unsubscribe
  list."

**Escalate when:** `provider_dispatched=true` (real send) AND no
`opened_at` for 48+ hours — most likely the tracking-pixel route
(`/api/emails/track/:id.gif`) is being blocked by their email client (very
common; Gmail's image proxy hides the open event). Not really an escalation
— inform sales that "no open" isn't proof of no read.

---

## 8. "A custom field I added isn't showing up"

**Symptom:** You created a custom field on deals via the admin page, but the
field doesn't appear on the deal detail screen — or it appears but never
saves a value.

**Ask Claude (debug mode):**
> "What custom fields does my workspace have on deals? Show me sample values
> from recent deals."

**Good answer looks like:**
- Returns the field definitions (id, name, label, type, options, required,
  position).
- Returns 5 sample `custom_fields` JSONB blobs from recent deals.
- Spots the issue: "your field is `account_tier` but the sample rows all
  have `accountTier` — frontend probably writes camelCase but the def is
  snake_case, mismatch," or "no recent deals have the field populated yet —
  it'll appear on the next save."

**Escalate when:** definitions look correct AND a sample row clearly has the
expected key but the UI still doesn't render the field. The frontend's
`<CustomFieldRenderer>` may need a code change for an exotic type. File a
ticket with the field definition row attached.

---

## 9. "I can't tell which audit row matches the action I just took"

**Symptom:** You did something (deleted a deal, sent an RFQ, ran a plugin)
and want to confirm it landed in the audit log — or you need the row id to
file a ticket.

**Ask Claude (debug mode):**
> "Show me my last 20 audit events. I'm looking for an action I took a few
> minutes ago — probably an RFQ send or a record delete."

**Good answer looks like:**
- Returns rows with `time`, `event`, `success`, `target_type`, `target_id`,
  and a snippet of `meta`.
- You can identify your action by the timestamp and event name (e.g.
  `vendor_rfq.sent`, `record.deleted`).

**Escalate when:** the audit row is missing — meaning the action either
didn't reach the backend or the handler didn't fire its audit write. Capture
the timestamp range and file a ticket; the platform team will reproduce.

---

## 10. "An API call I'm making from a script gets a weird response"

**Symptom:** You're hitting `/api/deals?stage=TRIAGE` from a script and the
response doesn't match what the UI shows you. You suspect your script is
sending the wrong filter or hitting a different scope.

**Ask Claude (debug mode):**
> "Run GET /api/deals?stage=TRIAGE for me and show me the first chunk of the
> response."

**Good answer looks like:**
- Uses the `try_api` tool to replay the exact GET inside your session.
- Returns the HTTP status + first 2KB of body.
- Notes the discrepancy with what your script sees ("status 200, 5 rows
  here; if your script gets zero, check it's sending the auth cookie and the
  CSRF header isn't required for GET — only POST/PUT/DELETE").

**Escalate when:** the response inside chat matches what your script sees
but doesn't match the UI. There's a UI bug. Capture both responses and file
a ticket.

---

## 11. "I'm seeing an error code I don't understand"

**Symptom:** A red toast or a JSON error response surfaces a code like
`PLUGIN_QUERY_BUDGET_EXCEEDED` or `CHAT_DAILY_CAP` and you don't know what
to do about it.

**Ask Claude (debug mode or normal mode):**
> "What does PLUGIN_QUERY_BUDGET_EXCEEDED mean? Where would I fix it?"

**Good answer looks like:**
- A one-paragraph explanation ("the plugin exceeded its per-run DB query
  budget — 50 calls — refactor to batch queries or filter earlier").
- A pointer to the responsible source file.

**Escalate when:** the error code isn't in the recognized list (the copilot
will say `recognized: false`) AND it doesn't appear anywhere in the public
docs. File a ticket with the exact string — known codes are kept in
`backend/routes/aiRoutes.js` `ERROR_HINTS`.

---

## 12. "I think a teammate's notifications are misconfigured"

**Symptom:** A teammate complains they're not getting alerts. You're an
admin and want to check their settings without bothering them.

**Ask Claude (debug mode):**
> "Show me the notification diagnostic for user 412."

**Good answer (super-admins only) looks like:**
- Returns user 412's preferences, `effective_notification_email`,
  `notification_phone`, and recent notification events.
- Flags any gap.

**If you're NOT a super-admin:** the tool returns `not_authorized` for any
user_id other than yours. The copilot will say so in plain English. The
right escalation path is to ask the user to run the same check on themselves
(scenario 2).

---

## 13. "I want to try a curated template"

**Symptom:** You've seen the plugin library at `/plugins/library` and want to
try one of the curated templates ("Daily stalled-deal digest", "30-day vendor
price validation", etc.) without writing code.

**Step-by-step:**
1. Open **`/plugins/library`** and find a template card. Click **"Use this
   template"**.
2. The card briefly shows "✓ Copied — opening chat…" and the page redirects
   to `/chat`. Behind the scenes the template was cloned into your workspace
   as a **draft** (it won't fire until you activate it).
3. The copilot opens with an auto-seeded question: "I just copied the
   `<template name>` template into my workspace as a draft (plugin id N).
   It's turned off right now. Walk me through what it does in plain English,
   and ask me what I'd like to change." — and submits it for you.
4. The reply will:
   - Call `describe_plugin` to read the spec back in plain English (what it
     does, when it runs, what data it touches).
   - Offer a chip "Open plugin" that jumps to the editor at `/plugins/N`.
   - Ask you what you'd like to change.
5. Customize via chat ("change the schedule to weekdays at 8am", "make it
   target VENDOR_QUOTING deals instead of all stages") or open the plugin
   page and edit directly.
6. When you're happy, ask the copilot **"run my `<plugin name>` plugin"** to
   trigger it once via `run_plugin`. The reply carries a "View run" chip that
   lands you on the new **runs viewer** at `/plugins/N/runs` with the freshly-
   created run pre-expanded so you can see exactly what happened.
7. The runs viewer shows the run with a friendly status badge ("Worked",
   "Didn't finish", "Hit a limit") rather than the raw enum. The status
   filter pill row lets you narrow to runs that worked or runs that didn't.
   Hover the "DB queries" column header for the safety-cap explainer.

**Good copilot answer to step 3 looks like:**
- One paragraph in plain English: "This plugin watches for deals moving to
  `INVOICED`. When that happens, it creates a task to send a customer
  experience survey 14 days later." (No JSON. No code.)
- An "Open plugin" chip.
- A closing question like "What would you like to tweak — the timing, the
  task title, or something else?"

**Bad copilot answer:**
- Dumps the raw `spec_json` shape. (The `describe_plugin` tool deliberately
  withholds source code; if the reply leaks code, that's a defect — file a
  bug citing the chat transcript.)
- "I can't help with that." (The tool failed to fire; check that
  `plugins_enabled` is on for your org at `/admin/feature-flags`.)

**Escalate when:** the template clone returns a 500 / 422 from
`/api/plugins/from-template`. That's a curator-side issue (someone added a
bad library entry); copy the chat transcript and the template slug into a
support ticket.

---

## What support needs from you when you escalate

When the playbook doesn't get you to an answer, file a support ticket with:

1. **Approximate timestamp** (or timestamp range) of the action that misbehaved.
2. **The chat transcript** — copy the messages from `/chat`, including
   Claude's reply that says "Looked up: ..." so support knows which tools
   were invoked.
3. **Any audit row ids** Claude surfaced (e.g. `plugin_runs.id = 8401`).
4. **Your user id and org id** — visible at `/settings#profile`. Reduces the
   "what tenant are we in" loop by one round trip.
5. **The `X-Request-Id` header** if you have it from a network capture — it
   uniquely identifies the offending HTTP request in the backend logs.

The faster support can pinpoint the row, the faster you get a fix. Almost
every escalation we've handled to date involved either a misconfigured
trigger (notifications, automations) or a definitions/data drift the
copilot's diagnostic tools surface in seconds — so try the playbook first.
