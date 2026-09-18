# Plugin SDK Reference — The Open CRM

**Audience:** plugin authors and any LLM (including Claude Code) generating plugin code for the platform.
**Source of truth:** `backend/services/pluginSdk.js` and `backend/services/pluginRunner.js`. If this doc and those files disagree, the code wins — open an issue and update the doc.
**Related:** `THREAT_MODEL.md` §5 ("The plugin sandbox specifically"), `PLUGIN_PLATFORM_VISION.md`.

---

## What is a plugin?

A plugin is a **stateless JavaScript function** that receives an `input` object and a `crm` namespace and returns a result. It executes inside a fresh `isolated-vm` v8 Isolate — a sandbox with no filesystem, no network, no Node.js modules, no `process`, no `Buffer`, no timers, no `console`. Every DB-touching call goes through the `crm` namespace, every such call is automatically scoped to the calling org's `org_id`, and the entire run is hard-capped on wall-clock, memory, query count, task-creation count, and AI-call count. The one deliberate exception to "no network" is `crm.ai.complete` — a host-bridged, **metered and billing-gated** Claude completion (see the AI section below); the plugin still never touches the network itself.

A run begins when the platform invokes `pluginRunner.run()` (`backend/services/pluginRunner.js:344`); the plugin's source comes from `plugins.source_code`, the runner spins an isolate, the prelude installs `crm`, the user code runs, the result is read back, and the isolate is disposed. The plugin cannot persist anything across runs except through the DB via `crm`.

---

## Quotas at a glance

| Limit | Value | Constant | Source |
|---|---|---|---|
| Isolate CPU per run | 5 s | `RUN_TIMEOUT_MS` | `pluginRunner.js:70` |
| Total wall clock per run (host-side) | 15 s base | `HARD_WALL_CLOCK_MS` | `pluginRunner.js:81` |
| Wall-clock extension per upstream AI call | +15 s (granted at call time) | `AI_CALL_WALL_CLOCK_EXTENSION_MS` | `pluginRunner.js:93` |
| Absolute wall-clock ceiling | 45 s | `MAX_TOTAL_WALL_CLOCK_MS` | `pluginRunner.js:94` |
| Compile timeout | 1 s | `COMPILE_TIMEOUT_MS` | `pluginRunner.js:69` |
| Heap | 128 MB | `MEMORY_LIMIT_MB` | `pluginRunner.js:68` |
| DB-touching SDK calls per run | 50 | `MAX_QUERIES_PER_RUN` | `pluginSdk.js:74` |
| `createTask` calls per run | 10 | `MAX_TASKS_CREATED_PER_RUN` | `pluginSdk.js:82` |
| Upstream AI calls per run (`crm.ai.complete`) | 2 | `MAX_AI_CALLS_PER_RUN` | `pluginSdk.js:56` |
| AI `max_tokens` (default / cap) | 512 / 1024 | `AI_DEFAULT_MAX_TOKENS` / `AI_MAX_TOKENS_CAP` | `pluginSdk.js:57-58` |
| AI prompt length | 8192 chars | `AI_MAX_PROMPT_CHARS` | `pluginSdk.js:59` |
| AI `system` length | 2048 chars | `AI_MAX_SYSTEM_CHARS` | `pluginSdk.js:60` |
| Max rows returned by any `list*` | 500 | `MAX_ROWS` | `pluginSdk.js:40` |
| Per-statement Postgres timeout | 2 s | `PLUGIN_STATEMENT_TIMEOUT` | `pluginSdk.js:91` |
| Output payload byte cap | 64 KB | `MAX_OUTPUT_BYTES` | `pluginRunner.js:95` |
| Log buffer | 200 lines | inline | `pluginSdk.js` (`pushLog`) |
| Log line size | 2 KB | inline | `pluginSdk.js` (`pushLog`) |
| Concurrent runs per org (per process) | 5 | `MAX_CONCURRENT_RUNS_PER_ORG` | `pluginRunner.js:111` |
| Monthly runs per org | tier-dependent | `quotaEnforcer.TIER_QUOTAS[tier].plugin_runs_per_org_per_month` | `pluginRunner.js` (`checkPluginQuota`) |

**Timeout interplay (why an AI call doesn't kill your run):** the 5-second `RUN_TIMEOUT_MS` meters CPU *inside* the isolate only — time parked in a bridged `crm.*` host call (a Postgres query, a Claude completion) does not count against it. The 15-second host-side wall clock is what bounds total elapsed time; each `crm.ai.complete` call that actually goes upstream extends that deadline by 15 s at the moment the call starts (via the runner's `extendWallClockForAiCall`, `pluginRunner.js:657`), never past the 45 s absolute ceiling. Net: 15 s base + 15 s × (up to 2 AI calls) = worst case exactly 45 s; runs that never touch AI keep the unchanged 15 s cap.

---

## The `crm` namespace

All functions are async and **must be `await`-ed**. Every function is closed over the caller's `orgId`; you cannot pass an `org_id` in any argument — the field is silently dropped from patches by `sanitizePatch` (`pluginSdk.js:182-200`) and from filters by `sanitizeFilter` (`pluginSdk.js:166-180`).

### Reads

Each read counts **1** against the per-run query budget.

#### `crm.getDeal(id)` / `crm.getContact(id)` / `crm.getCompany(id)` / `crm.getTask(id)`

```js
const deal = await crm.getDeal(42);
// → { id, title, stage, phase, amount, probability, ... } or null
```

**Args:** `id` (positive integer). Coerced via `Number(id)`; non-integers throw `id must be a positive integer` (`pluginSdk.js:202-208`).
**Returns:** the row (subset of columns from the read allowlist), or `null` if not found in the caller's org.
**Errors:** invalid id, query budget exceeded.

#### `crm.listDeals(filter)` / `crm.listContacts(filter)` / `crm.listCompanies(filter)` / `crm.listTasks(filter)`

```js
const stale = await crm.listDeals({ stage: 'NEGOTIATION', owner_id: 7 });
// → array of rows, max 500 (MAX_ROWS), ordered by id DESC
```

**Args:** `filter` (plain object). Unknown keys are silently dropped; only primitives/null are accepted as values. Allowed filter keys per table:

| Table | Allowed filter keys |
|---|---|
| `deals` | `stage`, `phase`, `contact_id`, `company_id`, `owner_id`, `status` |
| `contacts` | `status`, `company_id`, `owner_id` |
| `companies` | `type`, `status`, `owner_id` |
| `tasks` | `status`, `contact_id`, `deal_id`, `priority`, `assigned_to` |

Source: `FILTER_ALLOWLISTS` at `pluginSdk.js:90-95`.

**Columns returned** (the read allowlists, `pluginSdk.js:108-127` — the SDK never does `SELECT *`):

| Table | Returned columns |
|---|---|
| `deals` | `id, title, stage, phase, amount, probability, expected_close_date, hot_flag, owner_id, status, contact_id, company_id, customer_id, vendor_id, last_activity_at, created_at, updated_at` |
| `contacts` | `id, first_name, last_name, email, phone, job_title, company_id, owner_id, status, created_at, updated_at` |
| `companies` | `id, name, industry, website, type, status, owner_id, created_at, updated_at` |
| `tasks` | `id, title, description, status, priority, due_date, assigned_to, contact_id, deal_id, created_at, updated_at` |

**Returns:** array (possibly empty). Max length 500.
**Errors:** query budget exceeded.

### Writes

#### `crm.updateDeal(id, patch)` / `crm.updateContact(id, patch)` / `crm.updateCompany(id, patch)` / `crm.updateTask(id, patch)`

```js
await crm.updateDeal(42, { stage: 'CLOSED_WON', amount: 50000 });
// → updated row or null if not found in the caller's org
```

**Args:** `id` (positive integer), `patch` (plain object — not array). Unknown keys are silently dropped. Allowed patch keys per table:

| Table | Allowed patch keys |
|---|---|
| `deals` | `stage`, `amount`, `probability`, `expected_close_date`, `hot_flag`, `owner_id`, `status`, `notes` |
| `contacts` | `owner_id`, `company_id`, `status` |
| `companies` | `owner_id`, `type`, `status` |
| `tasks` | `assigned_to`, `status`, `due_date`, `priority` |

Source: `UPDATE_ALLOWLISTS` at `pluginSdk.js:80-85`. The list mirrors `routes/_bulkOps.js` — the plugin attack surface and the bulk-operations attack surface are identical by design.

`updated_at` is set to `CURRENT_TIMESTAMP` automatically (`pluginSdk.js:307-308`).

**Returns:** the full row after update, or `null` if the id was not found in the caller's org.
**Errors:** `patch must be a plain object`, `No allowed fields in patch. Allowed for <table>: …` (when every key is dropped), invalid id, query budget exceeded.
**Query budget cost:** 1.

#### `crm.createTask(data)`

```js
await crm.createTask({
  title: 'Follow up with acme',
  description: 'They asked us to check in next week.',
  due_date: '2026-05-21',     // ISO date string or null
  status: 'open',              // one of: open, in_progress, completed, cancelled
  priority: 'high',            // one of: low, medium, high, urgent
  contact_id: 17,              // optional, must be positive int if present
  deal_id: 42,                 // optional, must be positive int if present
});
```

**Args:** `data` (object). `title` is required and is truncated to 500 chars (`pluginSdk.js:341`). `description` is truncated to 5000 chars. Unknown `status` falls back to `'open'`; unknown `priority` falls back to `'medium'`. `user_id` on the inserted row is `NULL` (the task is owned by the plugin, not a human).
**Returns:** the inserted row (full row).
**Errors:** `createTask: data must be an object`, `createTask: title is required`, invalid `contact_id`/`deal_id`, task budget exceeded, query budget exceeded.
**Budget cost:** 1 against the task budget AND 1 against the query budget. `chargeTask` runs first; if it throws, the query counter is not incremented (`pluginSdk.js:349-354`).

**Note: no creation surface for deals, contacts, or companies.** Only `createTask` exists in v1. This is deliberate — see the comment above `createTask` in `pluginSdk.js`.

### AI

#### `crm.ai.complete({ prompt, max_tokens?, system? })`

The sandbox's only AI surface — a **metered, billing-gated** Claude completion executed on the host (`pluginSdk.js:466`, bridged as `__host_aiComplete` in `pluginRunner.js`). The plugin never sees a network primitive; the host routes the call through `services/ai.callClaude` with `endpoint: 'plugin-run'`, so every upstream call automatically lands an org-attributed `ai_usage_events` row (with the platform's 2× upcharge when the deployment key is used) plus the `usage_meter` aggregate. **There is no un-metered way for a plugin to burn tokens.**

```js
const ai = await crm.ai.complete({
  prompt: 'Summarize these deals in three bullets:\n' + lines.join('\n'),
  max_tokens: 400,               // optional; default 512, hard cap 1024
  system: 'You are terse.',      // optional; truncated to 2048 chars
});
if (ai.ok) {
  await crm.createTask({ title: 'Brief', description: ai.text });
} else {
  // ai.configured === false → AI isn't set up for this workspace
  // ai.blocked === true     → billing verdict / quota says no right now
  // otherwise               → upstream API error (ai.message has details)
}
```

**Args:** `prompt` (required string, ≤ 8192 chars), `max_tokens` (optional positive integer, default 512, capped at 1024), `system` (optional string, truncated to 2048 chars).

**Returns** (never throws for configuration/billing/API outcomes — only for invalid args, the AI budget, or the time budget):
- `{ ok: true, text, tokens: { input_tokens, output_tokens }, model }` — success.
- `{ ok: false, configured: false, message }` — AI isn't configured for the org (no org BYO key, no platform key, no gateway key). The platform-standard graceful-degradation shape.
- `{ ok: false, configured: true, blocked: true, code, message }` — the org may not burn AI right now. The billing verdict is the **same** `evaluateAiBilling` the HTTP routes enforce (`middleware/requireAiBilling.js`), evaluated inside the call path — so an autonomous scheduled/triggered run can never bypass billing state, an expired trial, past-due lockout, an admin halt, the monthly hard cap, or the AI quota (`code: 'QUOTA_EXCEEDED'`).
- `{ ok: false, configured: true, code, message }` — upstream API error.

**Budget:** max **2 upstream calls per run** (`MAX_AI_CALLS_PER_RUN`). Only calls that pass the configured + billing checks charge the budget — a fallback loop in an unconfigured org can call `crm.ai.complete` freely and just keeps getting `{ configured: false }`. The 3rd upstream-bound call throws `PluginAiBudgetExceeded` (code `PLUGIN_AI_BUDGET_EXCEEDED`), which ends the run with `status='error'` and the message `Plugin exceeded the per-run AI call budget of 2 crm.ai.complete calls.`

**Wall clock:** each upstream call grants the run +15 s of host-side wall clock (45 s absolute ceiling) — see the timeout-interplay note under Quotas. AI latency does not burn the 5 s isolate CPU budget.

**Query budget cost:** 0 — an AI call is not a DB call.

**Logging:** every upstream call appends one run-log line — `crm.ai.complete: model=… input_tokens=… output_tokens=… billing=… charged=… call=n/2` — model + token counts + billing mode only, **never the prompt or completion content**. Blocked/failed attempts log a one-line reason (`crm.ai.complete blocked: …`).

**Authoring contract (library standard):** always branch on the result — put `ai.text` into your task/description when `ok`, and degrade to embedding the copilot brief (the prompt a human can paste into `/chat`) when `configured === false` or `blocked === true`. Never `throw` on a not-ok AI result.

### Logging

#### `crm.log(message)`

```js
crm.log('Processed 47 deals');
crm.log({ count: 47, sample: deals.slice(0, 3) });  // objects are JSON-stringified
```

**Args:** any value. Non-strings are `JSON.stringify`-ed. Each line is truncated to 2048 bytes. After 200 lines, further calls are **silently dropped** (`pluginSdk.js:367`).
**Returns:** undefined. Synchronous — does not need `await`.
**Errors:** none. Calls beyond the 200-line cap are no-ops.
**Budget cost:** 0. Does not count against the query or task budget.

The log lines are persisted to `plugin_runs.log_lines` (a `TEXT[]` column added in `backend/migrations/069_plugin_runs_logs.sql:33`) and shown in the run-history UI.

### Argument shapes summary

- **Filter values:** `null` or `string` / `number` / `boolean`. No nested objects, no arrays (`pluginSdk.js:175-176`).
- **Patch values:** same — `null` or primitive. No nested objects, no arrays (`pluginSdk.js:192-193`).
- **ids:** positive integers. Anything else throws.
- **`input` to your plugin:** any JSON-serializable value. The runner does `JSON.stringify(input)` before embedding into the user script (`pluginRunner.js:556`).

---

## Error codes (the runner's terminal statuses)

The runner classifies the catch on every failed run into one of these. The classification logic lives in `pluginRunner.js:575-603`. The `status` is also written into `plugin_runs.status` and gated by the CHECK constraint widened in migrations `069`, `075`, `077`.

| Status | Trigger | Source |
|---|---|---|
| `success` (alias `ok`) | Run completed and returned a value | `pluginRunner.js:567` |
| `error` | Generic uncaught throw from user code; message captured (truncated to 4096 chars). **Also the status for an exceeded AI-call budget** (code `PLUGIN_AI_BUDGET_EXCEEDED` → normalized message, no dedicated status value) | `pluginRunner.js` (classifier) |
| `timeout` | Run exceeded the isolate CPU budget (`RUN_TIMEOUT_MS`, 5 s) or the host-side wall clock (15 s base, +15 s per AI call, 45 s ceiling) | `pluginRunner.js` (classifier) |
| `memory_exceeded` | Heap exceeded `MEMORY_LIMIT_MB` (128 MB) | `pluginRunner.js:591-593` |
| `killed` | `isolate.dispose()` happened mid-execution (only reachable via host-side cancel; rare) | `pluginRunner.js:597-599` |
| `quota_exceeded` | Monthly plugin-run quota exhausted; isolate never spun | `pluginRunner.js:454-466` |
| `query_budget_exceeded` | Plugin attempted a 51st DB-touching SDK call | `pluginSdk.js:64-69`, classified at `pluginRunner.js:577-583` |
| `task_budget_exceeded` | Plugin attempted an 11th `createTask` | `pluginSdk.js:71-76`, classified at `pluginRunner.js:584-590` |
| `concurrent_limit_exceeded` | Org already had 5 in-flight runs on this process; isolate never spun; HTTP 429 | `pluginRunner.js:404-429` |
| `rejected` | Plugin not found / not active / no source code; or `PLUGIN_RUNTIME_DISABLED=1`; or sandbox not loaded (`sandbox_unavailable`); or bad args | `pluginRunner.js:367-396, 476-496` |
| `running` | Initial state in `plugin_runs.status` while the run is in flight; not a terminal value | `pluginRunner.js:267` |

---

## Globals NOT available

Removed by the prelude after host references are bridged in (`pluginRunner.js:209-211`):

- `console` — use `crm.log()`. `console.log` is undefined inside the isolate; calling it throws `ReferenceError`.
- `setTimeout`, `setInterval`, `setImmediate`, `clearTimeout`, `clearInterval`, `clearImmediate`, `queueMicrotask` — there is no way to schedule work. Your code runs to completion within 5 s wall-clock or it is killed.
- `fetch`, `XMLHttpRequest`, `WebSocket` — no network. Plugins are pure compute + DB-via-SDK + the metered `crm.ai.complete` bridge (which runs on the HOST — the isolate itself still has zero network access).
- `Buffer` — no binary types.
- `process` — no env access, no `process.exit`, no `process.cwd`.
- `require`, `module.require`, `import` (dynamic) — there is no module loader. A polyfill of `module.exports` is allowed *only* for the "the user code assigned `module.exports.run`" detection (`pluginRunner.js:240`).

Available v8 globals (intentionally): `Math`, `JSON`, `Date`, `Promise`, `Array`, `Object`, `String`, `Number`, `Boolean`, `RegExp`, `Map`, `Set`, `WeakMap`, `WeakSet`, `Symbol`, `Error`, `TypeError`, the iteration protocol — anything that is part of the JS language proper.

---

## Lifecycle of a run

1. **Arg normalization** — both call shapes (`run({pluginId, orgId, ...})` and `run(pluginId, input, ctx)`) collapse into one internal options object (`pluginRunner.js:344-365`).
2. **Validate ids** — non-integer `pluginId` or `orgId` → `status='rejected', reason='bad_args'` (`pluginRunner.js:367-369`).
3. **Platform kill switch** — if `PLUGIN_RUNTIME_DISABLED=1`, return immediately with `runtime_disabled` (`pluginRunner.js:371-374`).
4. **Sandbox availability** — if `isolated-vm` failed to load at boot, create a `plugin_runs` row with `status='rejected', reason='sandbox_unavailable'` and audit-log (`pluginRunner.js:376-396`).
5. **Concurrency check** — if the org has ≥ 5 in-flight runs on this process, create a rejection row with `status='concurrent_limit_exceeded'` and return HTTP 429 (`pluginRunner.js:404-429`).
6. **Increment the per-org in-flight counter** (`pluginRunner.js:430`).
7. **Create the `plugin_runs` row** in `'running'` state — always, even for failed attempts (`pluginRunner.js:262-276, 433-435`).
8. **Quota check** — verify the org has monthly-run budget; if not, finalize with `status='quota_exceeded'` and return (`pluginRunner.js:452-469`).
9. **Load the plugin row** — `SELECT … FROM plugins WHERE id = ? AND org_id = ?`. Cross-org access is structurally blocked (`pluginRunner.js:471-475`).
10. **Verify plugin is active and has source** — otherwise `status='rejected'` (`pluginRunner.js:483-496`).
11. **Spin the isolate** — `new ivm.Isolate({ memoryLimit: 128, inspector: false })` (`pluginRunner.js:499-503`).
12. **Build the org-scoped SDK** — `pluginSdk.buildContext({ orgId, logBuffer, counters })`, install each function under `__host_<name>` (`pluginRunner.js:516-543`).
13. **Compile + run the prelude** — installs `crm`, deletes the raw host refs and dangerous globals (1 s compile timeout) (`pluginRunner.js:546-550`).
14. **Compile + run the user script** — wrapped in an async IIFE; awaited with `promise: true` so the user's `await` chains are captured within the 5 s wall-clock (`pluginRunner.js:557-561`).
15. **Read `globalThis.__pluginResult`** — JSON-roundtripped, capped at 64 KB (`pluginRunner.js:565-566, 319-330`).
16. **Classify any thrown error** — typed `.code` first, then message-regex fallback (`pluginRunner.js:575-603`).
17. **Dispose the isolate** — always, in `finally` (`pluginRunner.js:607-612`).
18. **Decrement the per-org in-flight counter** — always, in `finally` (`pluginRunner.js:619-622`).
19. **Finalize the `plugin_runs` row** — write status, error message, output payload, log lines, db_queries, cpu_ms (`pluginRunner.js:629-643`).
20. **Meter usage** for billing — `plugin_runs` + `plugin_run_ms` (`pluginRunner.js:646-648`).
21. **Audit-log the run** (`pluginRunner.js:650-667`).

---

## Authoring tips

- **Keep runs short.** The budgets are real: 5 s of isolate CPU, 15 s of total wall clock (extended +15 s per upstream AI call, 45 s ceiling). DB round-trips count against the wall clock, not the CPU budget.
- **Use AI sparingly and degrade honestly.** `crm.ai.complete` is metered against the org (2 upstream calls per run, 1024-token cap). Always handle `{ configured: false }` and `{ blocked: true }` by falling back — e.g. embed the prompt as a "copilot brief" in the task you create — never by throwing.
- **Batch reads.** A single `crm.listDeals({owner_id: 7})` is one query. Looping `crm.getDeal(id)` over a list of ids is N queries — you'll burn the 50-budget fast.
- **Don't log PII.** `crm.log()` lines persist into `plugin_runs.log_lines`. Anyone with run-view rights in the org can read them. That is a side-channel — see `THREAT_MODEL.md` §5.
- **Use `crm.log`, never `console.log`.** `console` is undefined inside the sandbox; the call throws `ReferenceError`.
- **Pure logic only.** No network, no filesystem, no timers. Everything you need is `input` + `crm`.
- **Return a value.** Either set `globalThis.__pluginResult = …` directly, or export `module.exports = { run({crm, input}) { … } }` and the runner will await your function and use its return as the result (`pluginRunner.js:245-250`).
- **Mind the input cap.** Input is JSON-serialized into the script body. Very large inputs grow the compile cost; the per-run wall-clock is shared with compile.
- **Don't rely on map iteration order across runs.** Each run is a fresh isolate.
- **Catch errors you can handle.** Unhandled throws end the run with `status='error'`; if that's not what you want, wrap the throwing call.

---

## Examples

### 1. Tag stale deals

```js
// Mark deals untouched for > 30 days as 'stale'.
module.exports = {
  async run({ crm, input }) {
    const thresholdDays = (input && input.days) || 30;
    const cutoff = Date.now() - thresholdDays * 24 * 60 * 60 * 1000;

    // ONE read for the whole list. Cheap on the budget.
    const open = await crm.listDeals({ status: 'open' });
    let tagged = 0;
    for (const d of open) {
      const last = d.last_activity_at ? new Date(d.last_activity_at).getTime() : 0;
      if (last < cutoff) {
        // 1 write per stale deal. Budget = 50 reads/writes total. Cap your input.
        await crm.updateDeal(d.id, { status: 'stale' });
        tagged++;
        if (tagged >= 45) break;  // leave headroom for the budget check
      }
    }
    crm.log(`Tagged ${tagged} stale deals (cutoff ${thresholdDays} days).`);
    return { tagged };
  },
};
```

### 2. Create a follow-up task on stage transition to `FOLLOW_UP`

```js
// Triggered by the automation engine when a deal stage changes.
// input = { dealId, previousStage, newStage }
module.exports = {
  async run({ crm, input }) {
    if (!input || input.newStage !== 'FOLLOW_UP') {
      return { skipped: true, reason: 'not_a_follow_up_transition' };
    }
    const deal = await crm.getDeal(input.dealId);
    if (!deal) return { skipped: true, reason: 'deal_not_found' };

    const due = new Date();
    due.setDate(due.getDate() + 7);

    const task = await crm.createTask({
      title: `Follow up on "${deal.title}"`,
      description: `Auto-created by plugin when stage moved to FOLLOW_UP.`,
      due_date: due.toISOString().slice(0, 10),
      priority: deal.hot_flag ? 'high' : 'medium',
      deal_id: deal.id,
      contact_id: deal.contact_id || null,
    });
    crm.log(`Created task ${task.id} for deal ${deal.id}`);
    return { taskId: task.id };
  },
};
```

### 3. Summarize a deal (returns a string)

```js
// Returns a one-line summary of a deal + its open tasks. No writes, pure read.
module.exports = {
  async run({ crm, input }) {
    const deal = await crm.getDeal(input.dealId);
    if (!deal) return 'deal not found';
    const tasks = await crm.listTasks({ deal_id: deal.id, status: 'open' });
    return `Deal ${deal.id} "${deal.title}" — stage ${deal.stage}, ` +
           `amount $${deal.amount || 0}, ${tasks.length} open task(s).`;
  },
};
```

### 4. AI-drafted follow-up brief (metered, graceful fallback)

```js
// On closed-won, create a thank-you task. With AI on, the note is drafted
// into the task; with AI off/blocked, the task carries the copilot brief.
module.exports = {
  async run({ crm, input }) {
    const deal = await crm.getDeal(input.dealId);
    if (!deal) return { skipped: true };
    const brief = `Write a short, warm thank-you note about the signed deal "${deal.title}".`;
    const ai = await crm.ai.complete({ prompt: brief + ' Output the note only.', max_tokens: 300 });
    await crm.createTask({
      title: `Send thank-you: ${deal.title}`,
      description: ai.ok
        ? 'AI draft (review before sending):\n' + ai.text
        : 'Copilot brief (paste into chat to draft it): ' + brief,
      deal_id: deal.id,
      priority: 'high',
    });
    return { drafted: ai.ok };
  },
};
```

---

## Declarative `spec_json.actions` are metadata, not an execution plan

The runner executes **only `source_code`** — it never interprets `spec_json.actions`. The action list (`create_task`, `set_field`, `claude_complete`, …) exists so `describe_plugin` and the library UI can explain a plugin's behavior without exposing raw source. In particular, a `claude_complete` action does **not** make the runner call Claude: runnable AI behavior comes from `source_code` calling `await crm.ai.complete({...})`, and the declarative entry should mirror what the source actually does. (Validator source of truth: `backend/services/pluginSpecValidator.js` `ACTION_KINDS`.)

---

## Common authoring mistakes

**Blowing the query budget with a tight loop.**

```js
// BAD: 1 list + N gets = N+1 queries. With 100 deals you exceed the 50 budget.
const deals = await crm.listDeals({ status: 'open' });
for (const d of deals) {
  const fresh = await crm.getDeal(d.id);   // ← redundant — list* already returns these columns
  if (fresh.amount > 10000) await crm.updateDeal(d.id, { hot_flag: true });
}
```

**Fix:** the `list*` allowlist returns all the columns you need; skip the per-row `getDeal`.

```js
// GOOD: 1 list + only-needed updates.
const deals = await crm.listDeals({ status: 'open' });
for (const d of deals) {
  if (d.amount > 10000) await crm.updateDeal(d.id, { hot_flag: true });
}
```

**Using `console.log`.**

```js
console.log('hello');  // ReferenceError: console is not defined — the run fails with status='error'.
```

**Fix:** `crm.log('hello')`.

**Trying to fetch.**

```js
const r = await fetch('https://example.com/api');  // ReferenceError: fetch is not defined.
```

**Fix:** plugins have no network. Pre-fetch data on the host side and pass it in `input`, or build a backend route that fronts the third-party API. (For AI specifically, use `crm.ai.complete` — the one sanctioned, metered bridge.)

**Setting `org_id` in a patch.**

```js
await crm.updateDeal(42, { org_id: 99, stage: 'CLOSED_WON' });
// `org_id` is not in UPDATE_ALLOWLISTS — it is silently dropped. stage still updates.
```

**Fix:** never reference `org_id`. It is bound at sandbox-build time.

**Passing arrays as filter values.**

```js
await crm.listDeals({ stage: ['NEW', 'NEGOTIATION'] });   // array value — silently dropped from filter.
// → returns ALL deals (no stage filter applied).
```

**Fix:** the filter sanitizer accepts only scalars. Issue separate `listDeals` calls (mindful of the 50-query budget) or filter in JS after one list.

**Forgetting `await`.**

```js
crm.updateDeal(42, { stage: 'CLOSED_WON' });  // floating promise.
return 'done';   // run ends; promise may not have resolved; update may or may not commit.
```

**Fix:** every `crm.*` function except `crm.log` is async — always `await`.

**Creating too many tasks in a loop.**

```js
const deals = await crm.listDeals({ status: 'open' });
for (const d of deals) {
  await crm.createTask({ title: `Review ${d.title}`, deal_id: d.id });
}
// → after the 10th createTask, status='task_budget_exceeded'.
```

**Fix:** create tasks selectively (e.g. only for hot deals), or batch into fewer summary tasks.


---

## Triggers (event engine, migration 164 — 2026-09-17)

Active plugins auto-run when their `trigger_event` fires:

| Event | Fires when | Payload highlights |
|---|---|---|
| `deal.created` | a deal is created | id, title, stage, deal_type, amount |
| `deal.stage_changed` | a deal enters a new stage (PATCH/PUT/AI apply) | id, title, stage, prev_stage, deal_type, amount |
| `contact.created` / `company.created` / `lead.created` / `case.created` | record creation (leads: manual + public form) | record core fields |
| `task.overdue` | the overdue worker finds a newly-overdue task (once per task per day) | task id, title, due_date, assigned_to |
| `quote.sent` | a quote transitions to (or is created as) `sent` | quote id, public_id, deal_id |
| `schedule.hourly` / `schedule.daily` | the schedule worker's leased tick (daily = once per UTC day) | `{ trigger: { event, date } }` |

Semantics: dispatch is post-commit and fire-and-forget (a failing plugin can
never fail the originating write); `trigger_filter_json` is AND-ed
field-equality against the payload; per-(plugin, entity, transition) dedupe
prevents double-fires; runs are recorded with `trigger_kind`
`'event'`/`'schedule'`; **triggered runs execute in the confirm-first preview
posture** — SDK writes become proposals for Apply — UNLESS the plugin's
`run_mode='autonomous'` (migration 167, owner/admin opt-in per plugin):
then a SUCCESSFUL run's proposals are auto-applied through the exact same
validated apply machinery (`services/pluginActions.applyRunProposals`);
failed/partial runs never commit, every cap still applies, and each write
is audited with `autonomous: true`;
after 5 consecutive execution failures the plugin auto-pauses
(`status='errored'`) and org admins are notified. `last_triggered_at` is
stamped on every attempt. Authoring-accepted events without a dispatch site
yet: `deal.updated`, `invoice.paid`, `task.completed`, `schedule.weekly`.
