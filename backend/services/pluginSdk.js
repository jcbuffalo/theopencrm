// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Plugin SDK — the narrow surface plugin code can call from inside the
// isolated-vm sandbox.
//
// THREAT MODEL (read this before changing anything in this file):
//   • Plugin authors are untrusted. Treat every argument as hostile.
//   • Every function MUST scope its DB query by the caller's org_id, which
//     is bound at sandbox-build time (see pluginRunner.js) — the plugin
//     never sees, names, or passes org_id. If a plugin author somehow
//     supplies an `org_id` field in a patch object, it must be silently
//     ignored (it's not in the column allowlists).
//   • Update operations must ONLY accept columns from the allowlist below.
//     Allowlists mirror routes/_bulkOps.js so the per-tenant attack surface
//     here is identical to the bulk-operations attack surface that already
//     exists and is already reviewed.
//   • DO NOT return raw pg result objects or anything carrying a connection
//     reference. Return plain rows / arrays only — the bridge `copyInto`s
//     these into the isolate and any non-cloneable property will throw.
//
// CALLING CONVENTION:
//   buildContext(orgId) returns an object of async (orgId-bound) functions.
//   pluginRunner.js wraps each function in `setSync` with a Reference back
//   to JS land, awaiting the async work synchronously from the isolate's
//   point of view (via ivm.Reference.applyIgnored + a custom promise-resolver
//   pattern — actually we use applySync for the synchronous-call ergonomics
//   the plugin author expects).
//
// LIMITS:
//   • list*() functions cap returned rows at MAX_ROWS to prevent a plugin
//     from pulling millions of contacts into the 128MB isolate heap.
//   • Filter objects are validated; unknown keys are stripped.

const pool = require('../db');

const MAX_ROWS = 500; // hard cap on any list*() return

// ---------------------------------------------------------------------------
// crm.ai.complete — the ONLY AI surface inside the sandbox.
//
// Routed through services/ai.callClaude with endpoint='plugin-run', so
// metering (ai_usage_events row, org attribution, the 2× platform upcharge)
// is automatic — a plugin can never burn un-metered tokens. The billing gate
// (middleware/requireAiBilling.evaluateAiBilling) is evaluated INSIDE the
// call path, mirroring what the HTTP routes enforce, so an autonomous
// scheduled/triggered run can never bypass billing state or the monthly hard
// cap. A blocked verdict returns { ok:false, configured:true, blocked:true }
// to the plugin (it never throws the run); AI-unconfigured returns the
// platform-standard { configured: false } shape. Neither of those charges
// the per-run AI budget — the budget counts UPSTREAM Claude calls only.
// ---------------------------------------------------------------------------
const MAX_AI_CALLS_PER_RUN = 2;       // upstream Claude calls per plugin run
const AI_MAX_TOKENS_CAP = 1024;       // hard ceiling on max_tokens
const AI_DEFAULT_MAX_TOKENS = 512;    // default when the plugin doesn't ask
const AI_MAX_PROMPT_CHARS = 8192;     // ~8KB prompt cap
const AI_MAX_SYSTEM_CHARS = 2048;     // system prompt cap

// Required at module scope (not lazily) to match codebase style; there is no
// require cycle (ai.js and requireAiBilling.js never require pluginSdk).
// Called through the module objects so tests can live-stub them.
const aiService = require('./ai');
const aiBilling = require('../middleware/requireAiBilling');
// Called through the module object (featureFlags.hasFeature) so tests can
// live-stub it — same convention as aiService / aiBilling above. hasFeature
// carries its own 30s per-org cache, so the per-call module gate below is
// almost always a Map lookup, not a Postgres round-trip.
const featureFlags = require('./featureFlags');

// Hard cap on the number of DB-touching SDK calls a single plugin run can
// make. Each `crm.getDeal / listDeals / get* / list* / update* / createTask`
// call increments `counters.db_queries` and is checked against this ceiling
// BEFORE the query is issued. The 51st call throws synchronously inside the
// isolate; pluginRunner.js classifies the resulting error as
// status='query_budget_exceeded'.
const MAX_QUERIES_PER_RUN = 50;

// Sub-limit on createTask invocations. Independent of MAX_QUERIES_PER_RUN —
// a plugin run that performs 40 reads + 10 createTasks is at-budget on both
// counters; the 11th createTask call throws even though there's still query
// budget left. Prevents a single plugin run from spawning a runaway pile of
// task rows. The 11th call throws synchronously inside the isolate;
// pluginRunner.js classifies the catch as status='task_budget_exceeded'.
const MAX_TASKS_CREATED_PER_RUN = 10;

// Per-query wall-clock cap inside the plugin sandbox. The pool default
// (services/db.js → statement_timeout: 30000) is for ordinary HTTP handlers
// where 30s is a generous ceiling; a plugin running 50 queries at 30s each
// could still tie up a pool connection for the full 5-second wall clock if
// even one query is slow. We issue SET LOCAL statement_timeout = '2s' inside
// the per-query transaction so any single plugin query that exceeds 2s is
// terminated by Postgres before it starves the pool.
const PLUGIN_STATEMENT_TIMEOUT = '2s';

// Sentinel error class — pluginRunner inspects err.code to map the failure
// to the right run status without doing fragile regex matching on the
// message.
class PluginQueryBudgetExceeded extends Error {
  constructor() {
    super(`Plugin exceeded the per-run DB query budget of ${MAX_QUERIES_PER_RUN}.`);
    this.code = 'PLUGIN_QUERY_BUDGET_EXCEEDED';
  }
}

class PluginTaskBudgetExceeded extends Error {
  constructor() {
    super(`Plugin exceeded the per-run createTask budget of ${MAX_TASKS_CREATED_PER_RUN}.`);
    this.code = 'PLUGIN_TASK_BUDGET_EXCEEDED';
  }
}

// Thrown on the (MAX_AI_CALLS_PER_RUN + 1)th crm.ai.complete call that would
// actually reach the Claude API. Unconfigured / billing-blocked attempts do
// NOT charge this budget (they return a soft { ok:false } shape instead), so
// the sentinel only ever fires for real token-burning attempts.
class PluginAiBudgetExceeded extends Error {
  constructor() {
    super(`Plugin exceeded the per-run AI call budget of ${MAX_AI_CALLS_PER_RUN} crm.ai.complete calls.`);
    this.code = 'PLUGIN_AI_BUDGET_EXCEEDED';
  }
}

// Thrown when a run passes its total wall-clock deadline (set by the runner)
// on the way into a DB-bound SDK call. This is the query-loop self-limit that
// lets a long run stop cleanly — declining to open another pg connection —
// slightly BEFORE the runner's hard host-side Promise.race has to dispose the
// isolate. pluginRunner classifies err.code as status='timeout'.
class PluginTimeBudgetExceeded extends Error {
  constructor() {
    super('Plugin exceeded its total wall-clock time budget.');
    this.code = 'PLUGIN_TIME_BUDGET_EXCEEDED';
  }
}

// Column allowlists for update operations. MUST stay in sync with the
// allowlists in routes/_bulkOps.js callers.
const UPDATE_ALLOWLISTS = {
  deals:     ['stage', 'amount', 'probability', 'expected_close_date', 'hot_flag', 'owner_id', 'status', 'notes'],
  contacts:  ['owner_id', 'company_id', 'status'],
  companies: ['owner_id', 'type', 'status'],
  tasks:     ['assigned_to', 'status', 'due_date', 'priority'],
  // Module objects (2026-09 SDK expansion). Same posture as the four core
  // tables: working-the-record fields only. Status values are validated at
  // the route/API layer, not here — a bogus status writes a bogus string, the
  // same failure mode the bulk-ops surface already accepts.
  leads:     ['status', 'owner_user_id', 'notes'],
  cases:     ['status', 'priority', 'sla_due_at'],
};

// Filter allowlists for list*() functions. Keys not in this set are
// silently dropped; this prevents a plugin from filtering on internal
// columns like `created_by` and inferring cross-tenant data shape.
const FILTER_ALLOWLISTS = {
  deals:     ['stage', 'phase', 'contact_id', 'company_id', 'owner_id', 'status'],
  contacts:  ['status', 'company_id', 'owner_id'],
  companies: ['type', 'status', 'owner_id'],
  tasks:     ['status', 'contact_id', 'deal_id', 'priority', 'assigned_to'],
  // Module objects (2026-09 SDK expansion). Filter keys are REAL column
  // names (they interpolate into the WHERE clause), so leads filter on
  // owner_user_id — not the owner_id shorthand deals use.
  leads:             ['status', 'source', 'owner_user_id'],
  cases:             ['status', 'priority', 'company_id'],
  quotes:            ['status', 'deal_id', 'customer_id'],
  meetings:          ['deal_id', 'company_id'], // + after/before range keys, see RANGE_FILTER_ALLOWLISTS
  service_contracts: ['renewal_stage', 'status', 'customer_id'],
};

// Date-range filter keys, per table. Unlike FILTER_ALLOWLISTS (strict
// equality on a real column), each entry maps a VIRTUAL filter key to a
// (column, operator) pair. Values must be strings Date.parse accepts;
// anything else is silently dropped — the same fail-quiet posture as
// sanitizeFilter. Only meetings has a clean single timestamp axis
// (starts_at) for range semantics today; extend deliberately, one column
// per table, never author-supplied column names.
const RANGE_FILTER_ALLOWLISTS = {
  meetings: {
    after:  { column: 'starts_at', op: '>=' },
    before: { column: 'starts_at', op: '<=' },
  },
};

// Per-org module gating (mirrors the /api mounts in index.js). A read or
// update against a table whose module is OFF for the org DEGRADES — empty
// list / null + one run-log warning — instead of erroring, so a library
// entry installed org-wide keeps running in orgs that disabled the module.
// The gate costs 0 query budget (featureFlags caches per org for 30s).
// Deliberate strictness note: service_contracts' base CRUD mount is ungated,
// but its renewal surface (the fields this SDK exposes) is
// customer_success_enabled — the SDK fails closed on the module flag.
// meetings / tasks / deals / contacts / companies are core: never gated.
const TABLE_FEATURE_FLAGS = {
  leads:             'leads_enabled',
  cases:             'customer_success_enabled',
  quotes:            'quotes_enabled',
  service_contracts: 'customer_success_enabled',
};

// Read column allowlists for get*/list*() functions. MAX_ROWS caps row count
// but a `SELECT *` ships every column — including ones that may be
// sensitive (notes, audit-bearing internals) or just wasteful on wide tables
// (deals especially). The plugin only ever sees the columns listed here;
// anything not in the list is silently never fetched. The 'id' column is
// always implicitly included because the SDK exposes records keyed by id.
//
// Kept narrower than the filter allowlist on purpose: a plugin can filter
// on owner_id but cannot read sensitive owner_id-correlated fields like
// emails / phones of users. If a v2 plugin needs more, widen here — DO NOT
// fall back to SELECT *.
const READ_COLUMN_ALLOWLISTS = {
  deals: [
    'id', 'title', 'stage', 'phase', 'amount', 'probability',
    'expected_close_date', 'hot_flag', 'owner_id', 'status',
    'contact_id', 'company_id', 'customer_id', 'vendor_id',
    'last_activity_at', 'created_at', 'updated_at',
  ],
  contacts: [
    'id', 'first_name', 'last_name', 'email', 'phone', 'job_title',
    'company_id', 'owner_id', 'status', 'created_at', 'updated_at',
  ],
  companies: [
    'id', 'name', 'industry', 'website', 'type', 'status', 'owner_id',
    'created_at', 'updated_at',
  ],
  tasks: [
    'id', 'title', 'description', 'status', 'priority', 'due_date',
    'assigned_to', 'contact_id', 'deal_id', 'created_at', 'updated_at',
  ],
  // leads (migrations 130 + 147): business fields only. email/phone are
  // included (same PII posture as contacts). EXCLUDED on purpose: notes
  // (free-text can carry sensitive detail — same rule as deals.notes),
  // user_id (internal tenancy fallback). converted_* FKs are included so a
  // plugin can follow a converted lead to its contact/deal.
  leads: [
    'id', 'name', 'email', 'phone', 'company_name', 'title', 'source',
    'status', 'score', 'owner_user_id', 'converted_contact_id',
    'converted_deal_id', 'created_at', 'updated_at',
  ],
  // cases (migration 134): description IS the ticket body an automation
  // needs (mirrors tasks.description). EXCLUDED: user_id (internal).
  cases: [
    'id', 'subject', 'description', 'status', 'priority', 'company_id',
    'contact_id', 'owner_user_id', 'sla_due_at', 'resolved_at',
    'created_at', 'updated_at',
  ],
  // quotes (Zang customer quotes — migrations 038/050/149). EXCLUDED on
  // purpose: public_id (externally shareable identifier — never hand an
  // outside-the-org handle to plugin code), portal_response /
  // portal_response_note / portal_response_at (customer-portal columns),
  // notes (free-text), created_by / updated_by / entity_version (audit
  // internals), user_id (internal).
  quotes: [
    'id', 'title', 'status', 'total_amount', 'valid_until',
    'current_revision', 'deal_id', 'customer_id', 'created_at', 'updated_at',
  ],
  // meetings (migration 137). EXCLUDED: notes (free-text meeting notes are
  // the most PII-dense column on the table), external_event_id (internal
  // Google-sync linkage), created_by / user_id (internal).
  meetings: [
    'id', 'title', 'starts_at', 'ends_at', 'company_id', 'deal_id',
    'contact_id', 'location', 'created_at', 'updated_at',
  ],
  // service_contracts (migrations 046 + 096 renewal columns). churn_reason
  // is included — it's the business field renewal automations act on.
  // EXCLUDED: notes (free-text), user_id (internal).
  service_contracts: [
    'id', 'name', 'contract_type', 'status', 'start_date', 'end_date',
    'renewal_notice_days', 'monthly_amount', 'annual_value', 'renewal_stage',
    'churn_reason', 'renewed_contract_id', 'customer_id', 'deal_id',
    'created_at', 'updated_at',
  ],
};

function readColumnsFor(table) {
  const cols = READ_COLUMN_ALLOWLISTS[table];
  if (!cols || cols.length === 0) {
    // Defensive — never fall back to SELECT *. If a new table is wired
    // into the SDK without an allowlist entry, throw at use time so the
    // bug surfaces in tests rather than silently exposing a wide table.
    throw new Error(`pluginSdk: no read-column allowlist for table "${table}"`);
  }
  return cols.join(', ');
}

// entity <-> table maps. The SDK speaks tables; the confirm-first apply layer
// and the audit trail speak entities. Kept here (single source) so the two
// modules can never drift on the mapping.
// leads/cases appear here because they have a WRITE surface (updateLead /
// updateCase → proposals → pluginActions apply). quotes / meetings /
// service_contracts are READ-ONLY in the SDK and deliberately absent — an
// entity missing from TABLE_BY_ENTITY can never pass proposal re-validation,
// so a tampered stored proposal naming them is rejected at apply time.
const ENTITY_BY_TABLE = { deals: 'deal', contacts: 'contact', companies: 'company', tasks: 'task', leads: 'lead', cases: 'case' };
const TABLE_BY_ENTITY = { deal: 'deals', contact: 'contacts', company: 'companies', task: 'tasks', lead: 'leads', case: 'cases' };

// Normalize + validate a createTask payload. Extracted to module scope so the
// confirm-first apply path (services/pluginActions.js) can re-run the SAME
// normalization it captured during preview — the stored proposal is never
// trusted verbatim. Throws on invalid input (missing title, bad id).
function normalizeTaskData(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('createTask: data must be an object');
  }
  const title = String(data.title || '').slice(0, 500);
  if (!title) throw new Error('createTask: title is required');
  const description = data.description ? String(data.description).slice(0, 5000) : null;
  const due_date    = data.due_date || null;
  const status      = ['open', 'in_progress', 'completed', 'cancelled'].includes(data.status) ? data.status : 'open';
  const priority    = ['low', 'medium', 'high', 'urgent'].includes(data.priority) ? data.priority : 'medium';
  const contact_id  = data.contact_id ? assertId(data.contact_id) : null;
  const deal_id     = data.deal_id    ? assertId(data.deal_id)    : null;
  return { title, description, due_date, status, priority, contact_id, deal_id };
}

// Human one-liner for a proposed write, shown on the confirm-first card.
function summarizeProposal(p) {
  if (p.op === 'create' && p.table === 'tasks') {
    const f = p.fields || {};
    return `Create task "${f.title}"${f.due_date ? ` due ${f.due_date}` : ''}${f.deal_id ? ` on deal #${f.deal_id}` : ''}`;
  }
  if (p.op === 'update') {
    const parts = Object.entries(p.fields || {}).map(([k, v]) => `${k} → ${v}`);
    return `Update ${ENTITY_BY_TABLE[p.table] || p.table} #${p.target_id}: ${parts.join(', ')}`;
  }
  return `${p.op} ${p.table}`;
}

// Run a single SQL statement inside a short-lived transaction that has
// SET LOCAL statement_timeout = '2s' applied. This caps any single plugin
// query at 2 seconds of pg work, independent of the 5-second isolate wall
// clock. We use BEGIN/COMMIT (not just SET LOCAL) because SET LOCAL only
// scopes to a transaction; running SET LOCAL on autocommitted statements
// is a no-op.
//
// Released on success and on error (in finally). If the query itself
// errors, we still attempt ROLLBACK before releasing so the connection
// returns to the pool in a clean state.
async function runScopedQuery(sql, params) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '${PLUGIN_STATEMENT_TIMEOUT}'`);
    const r = await client.query(sql, params);
    await client.query('COMMIT');
    return r;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* swallow rollback errors */ }
    throw err;
  } finally {
    client.release();
  }
}

function sanitizeFilter(filter, table) {
  if (!filter || typeof filter !== 'object') return {};
  const allow = new Set(FILTER_ALLOWLISTS[table] || []);
  const out = {};
  for (const k of Object.keys(filter)) {
    if (!allow.has(k)) continue;
    const v = filter[k];
    // Primitive-only filter values. No nested objects, no arrays — that
    // surface is what gets us SQL injection bugs.
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      out[k] = v;
    }
  }
  return out;
}

// Extract the validated date-range fragments for a table from a raw filter
// object. Returns [] when the table has no range keys or none validate. The
// column and operator come from RANGE_FILTER_ALLOWLISTS (never from the
// author); the value is bound as a query parameter.
function sanitizeRange(filter, table) {
  const spec = RANGE_FILTER_ALLOWLISTS[table];
  if (!spec || !filter || typeof filter !== 'object') return [];
  const out = [];
  for (const key of Object.keys(spec)) {
    const v = filter[key];
    if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) continue;
    out.push({ column: spec[key].column, op: spec[key].op, value: v });
  }
  return out;
}

function sanitizePatch(patch, table) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('patch must be a plain object');
  }
  const allow = new Set(UPDATE_ALLOWLISTS[table] || []);
  const out = {};
  for (const k of Object.keys(patch)) {
    if (!allow.has(k)) continue; // silently drop disallowed keys
    const v = patch[k];
    // No nested updates. No arrays. Booleans + scalars + null.
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      out[k] = v;
    }
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`No allowed fields in patch. Allowed for ${table}: ${[...allow].join(', ')}`);
  }
  return out;
}

function assertId(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('id must be a positive integer');
  }
  return n;
}

// Build a list of WHERE clauses from a sanitized filter object (+ optional
// sanitized range fragments from sanitizeRange). Always includes
// `org_id = $1`; additional fragments increment from $2.
function buildWhere(table, filter, ranges = []) {
  const params = [];
  const fragments = ['org_id = $1'];
  let i = 2;
  for (const [k, v] of Object.entries(filter)) {
    if (v === null) {
      fragments.push(`${k} IS NULL`);
    } else {
      params.push(v);
      fragments.push(`${k} = $${i++}`);
    }
  }
  for (const r of ranges) {
    params.push(r.value);
    fragments.push(`${r.column} ${r.op} $${i++}`);
  }
  return { whereSql: fragments.join(' AND '), extraParams: params };
}

/**
 * Build the org-scoped SDK context. The returned object's functions all
 * close over `orgId` and the run-scoped log buffer; the plugin author CANNOT
 * supply their own org_id.
 *
 * @param {object} opts
 * @param {number} opts.orgId  - the org whose data the plugin may touch
 * @param {string[]} opts.logBuffer - in-place array the runner reads after
 *                                    the run completes. crm.log() pushes
 *                                    here.
 * @param {object} opts.counters - in-place counters the runner updates so
 *                                 plugin_runs.db_queries reflects reality.
 * @param {number} [opts.deadline] - optional absolute wall-clock deadline
 *                                    (ms since epoch, as from Date.now()).
 *                                    When set, the next DB-bound SDK call made
 *                                    after the deadline throws
 *                                    PluginTimeBudgetExceeded instead of
 *                                    opening another pg connection. Omitted by
 *                                    callers (e.g. tests) that don't want a
 *                                    time cap.
 * @param {boolean} [opts.dryRun]  - CONFIRM-FIRST mode. When true, the write
 *                                    methods (update-x and createTask) DO NOT
 *                                    touch the DB. Instead they sanitize the write
 *                                    against the same allowlist, push a
 *                                    normalized proposal onto `proposedActions`,
 *                                    and return a SIMULATED post-write row so
 *                                    plugin logic can keep running. The actual
 *                                    write only happens later, after a human
 *                                    Applies it (services/pluginActions.js).
 *                                    Reads are unaffected. Default false.
 * @param {object[]} [opts.proposedActions] - in-place array the runner reads
 *                                    after a dry-run. Each entry:
 *                                    { entity, op, table, target_id, fields,
 *                                      before, summary }.
 * @param {number} [opts.userId]   - the run initiator, when there is one
 *                                    (manual / chat runs). Attributed on
 *                                    ai_usage_events rows and consulted by the
 *                                    billing verdict. Null for scheduled and
 *                                    event-triggered runs.
 * @param {function} [opts.extendDeadline] - callback the AI path invokes just
 *                                    before an upstream Claude call goes out.
 *                                    The runner's implementation grants extra
 *                                    wall-clock headroom (bounded by its
 *                                    absolute ceiling) and returns the NEW
 *                                    absolute deadline (ms since epoch), which
 *                                    replaces the deadline used by every
 *                                    subsequent budget check. Optional — the
 *                                    direct-harness/test path omits it.
 */
function buildContext({ orgId, logBuffer, counters, deadline = null, dryRun = false, proposedActions = null, userId = null, extendDeadline = null }) {
  if (!Number.isInteger(orgId) || orgId <= 0) {
    throw new Error('orgId is required and must be a positive integer');
  }
  if (dryRun && !Array.isArray(proposedActions)) {
    // A dry-run with nowhere to record proposals is a wiring bug — fail loud.
    throw new Error('pluginSdk: dryRun requires a proposedActions array');
  }

  // recordProposal is the ONLY way a dry-run write surfaces. It attaches a
  // human summary and pushes onto the run-scoped buffer. Bounded implicitly by
  // the per-run query budget (each captured write still charges a query), so a
  // plugin can propose at most MAX_QUERIES_PER_RUN writes.
  function recordProposal(p) {
    p.summary = summarizeProposal(p);
    proposedActions.push(p);
  }

  // tasks_created is a NEW counter (independent of db_queries). chargeTask()
  // is called inside createTask BEFORE we even consume the per-run query
  // budget, so a runaway createTask loop trips the task budget first — which
  // is the more actionable error message ("you tried to create too many
  // tasks" vs "you used up your query budget").
  if (typeof counters.tasks_created !== 'number') counters.tasks_created = 0;
  // ai_calls counts UPSTREAM Claude calls made via crm.ai.complete —
  // independent of the query budget (an AI call is not a DB call).
  if (typeof counters.ai_calls !== 'number') counters.ai_calls = 0;

  // The wall-clock deadline is mutable: a crm.ai.complete call about to go
  // upstream asks the runner (via extendDeadline) for latency headroom and
  // stores the returned NEW absolute deadline here, so DB/AI budget checks
  // after a slow-but-legitimate AI wait don't spuriously trip the time limit.
  let deadlineMs = deadline;

  // chargeQuery() is called at the TOP of every DB-bound SDK function before
  // the pg query goes out. It increments first, then validates — so the
  // counter that pluginRunner persists into plugin_runs.db_queries also
  // reflects the over-budget call that tripped the limit (i.e. the 51st
  // attempt is visible in the run row even though it didn't actually run a
  // query). If the limit is exceeded we throw a synchronous error; the
  // isolate sees a thrown promise and the runner's catch block classifies
  // it as 'query_budget_exceeded'.
  function chargeQuery() {
    // Wall-clock self-limit. Checked BEFORE incrementing the query counter so
    // a run that runs out of time doesn't record a phantom over-budget query
    // and, crucially, doesn't open another pg connection past the deadline.
    if (deadlineMs && Date.now() > deadlineMs) {
      throw new PluginTimeBudgetExceeded();
    }
    counters.db_queries += 1;
    if (counters.db_queries > MAX_QUERIES_PER_RUN) {
      throw new PluginQueryBudgetExceeded();
    }
  }

  // chargeTask() is the createTask-specific gate. Increments first, then
  // validates — same "the over-budget call is visible in the counter"
  // semantics as chargeQuery. Throws synchronously; runner classifies the
  // catch as 'task_budget_exceeded'.
  function chargeTask() {
    counters.tasks_created += 1;
    if (counters.tasks_created > MAX_TASKS_CREATED_PER_RUN) {
      throw new PluginTaskBudgetExceeded();
    }
  }

  // chargeAiCall() gates the crm.ai.complete path. Called only when the call
  // is actually about to go upstream (after the configured + billing checks),
  // so unconfigured/blocked fallback loops in library entries never burn the
  // budget or kill the run. Same increment-then-validate semantics as the
  // other charges so the over-budget attempt is visible in the counter.
  function chargeAiCall() {
    if (deadlineMs && Date.now() > deadlineMs) {
      throw new PluginTimeBudgetExceeded();
    }
    counters.ai_calls += 1;
    if (counters.ai_calls > MAX_AI_CALLS_PER_RUN) {
      throw new PluginAiBudgetExceeded();
    }
  }

  // Shared log-buffer writer (same caps as crm.log — 200 lines, 2KB/line).
  function pushLog(message) {
    if (logBuffer.length >= 200) return;
    const s = (typeof message === 'string' ? message : JSON.stringify(message ?? null)).slice(0, 2048);
    logBuffer.push(s);
  }

  // crm.ai.complete({ prompt, max_tokens?, system? }) — see the header block
  // near MAX_AI_CALLS_PER_RUN for the full contract. Returns:
  //   { ok: true, text, tokens: { input_tokens, output_tokens }, model }
  //   { ok: false, configured: false, message }            (AI not configured)
  //   { ok: false, configured: true, blocked: true, code, message }
  //                                                        (billing verdict / quota)
  //   { ok: false, configured: true, code, message }       (upstream API error)
  // Throws (ending the run) only on invalid arguments, the AI-call budget,
  // or the wall-clock time budget.
  async function aiComplete(opts) {
    if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
      throw new Error('ai.complete: options must be an object like { prompt, max_tokens?, system? }');
    }
    const prompt = typeof opts.prompt === 'string' ? opts.prompt : '';
    if (!prompt.trim()) throw new Error('ai.complete: prompt is required');
    if (prompt.length > AI_MAX_PROMPT_CHARS) {
      throw new Error(`ai.complete: prompt exceeds the ${AI_MAX_PROMPT_CHARS}-character cap`);
    }
    let maxTokens = AI_DEFAULT_MAX_TOKENS;
    if (opts.max_tokens !== undefined && opts.max_tokens !== null) {
      const n = Number(opts.max_tokens);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error('ai.complete: max_tokens must be a positive integer');
      }
      maxTokens = Math.min(n, AI_MAX_TOKENS_CAP);
    }
    const system = opts.system !== undefined && opts.system !== null
      ? String(opts.system).slice(0, AI_MAX_SYSTEM_CHARS)
      : undefined;

    // 1. Configured? Same graceful shape as every other AI surface. Checked
    //    before the budget so unconfigured orgs degrade instead of erroring.
    if (!(await aiService.isConfiguredForOrg(orgId))) {
      return {
        ok: false,
        configured: false,
        message: 'AI is not configured for this workspace.',
      };
    }

    // 2. Billing verdict — the SAME evaluation the HTTP routes enforce
    //    (requireAiBilling), run in-path so autonomous/scheduled runs can
    //    never bypass billing state, the trial window, or the hard cap.
    //    A blocked verdict is a soft result, never a thrown run failure.
    const verdict = await aiBilling.evaluateAiBilling({ orgId, userId });
    if (!verdict.allowed) {
      pushLog(`crm.ai.complete blocked: ${verdict.code || verdict.status || 'billing'}`);
      return {
        ok: false,
        configured: true,
        blocked: true,
        code: verdict.code || null,
        message: verdict.message || 'AI billing is not active for this workspace.',
      };
    }

    // 3. Budget — counts only calls that reach this point (real token burn).
    chargeAiCall();

    // 4. Wall-clock headroom for upstream latency, granted by the runner
    //    BEFORE the call goes out so the wait itself can't trip the deadline.
    if (typeof extendDeadline === 'function') {
      const extended = extendDeadline();
      if (typeof extended === 'number' && extended > 0) deadlineMs = extended;
    }

    // 5. The metered call. callClaude records ai_usage_events (org + user
    //    attribution, endpoint='plugin-run', upcharge) and the usage_meter
    //    aggregate internally — metering cannot be skipped from here.
    const result = await aiService.callClaude({
      system,
      messages: [{ role: 'user', content: prompt }],
      maxTokens,
      orgId,
      userId,
      endpoint: 'plugin-run',
    });

    if (result.configured === false) {
      return { ok: false, configured: false, message: result.message || 'AI is not configured.' };
    }
    if (!result.ok) {
      pushLog(`crm.ai.complete failed: ${result.code || result.error || 'unknown_error'}`);
      return {
        ok: false,
        configured: true,
        // QUOTA_EXCEEDED is the in-call quota gate — semantically a block,
        // so plugins can branch on `blocked` alone for their fallback path.
        blocked: result.code === 'QUOTA_EXCEEDED',
        code: result.code || null,
        message: result.error || 'AI call failed.',
      };
    }

    const usage = result.usage || {};
    const tokens = {
      input_tokens: Number(usage.input_tokens || 0),
      output_tokens: Number(usage.output_tokens || 0),
    };
    // One log line per call: model + tokens + whether the platform charged
    // for it (byo_key/gateway rows are $0 locally). NEVER the prompt content.
    pushLog(
      `crm.ai.complete: model=${result.model} input_tokens=${tokens.input_tokens} ` +
      `output_tokens=${tokens.output_tokens} billing=${result.billing_mode} ` +
      `charged=${result.billing_mode === 'platform'} call=${counters.ai_calls}/${MAX_AI_CALLS_PER_RUN}`
    );
    return { ok: true, text: result.text, tokens, model: result.model };
  }

  // Per-call module gate. Returns true for core tables (no flag). For a
  // flag-gated table it resolves the org's effective flag (explicit setting
  // wins, missing key falls back to the profile default — the exact same
  // resolution the /api mount gates use) and, when OFF, logs ONE run-log
  // warning and returns false so the caller can degrade (empty list / null)
  // instead of erroring. Costs 0 query budget — featureFlags caches per org.
  async function moduleEnabled(table) {
    const flag = TABLE_FEATURE_FLAGS[table];
    if (!flag) return true;
    const on = await featureFlags.hasFeature(orgId, flag);
    if (!on) {
      pushLog(`crm: the ${table} module ('${flag}') is disabled for this workspace — returning an empty result.`);
    }
    return on;
  }

  async function getOne(table, id) {
    const nid = assertId(id);
    if (!(await moduleEnabled(table))) return null; // degrade: module OFF, no budget charged
    chargeQuery();
    const cols = readColumnsFor(table);
    const r = await runScopedQuery(
      `SELECT ${cols} FROM ${table} WHERE id = $1 AND org_id = $2 LIMIT 1`,
      [nid, orgId]
    );
    return r.rows[0] || null;
  }

  async function listSome(table, filter) {
    const clean = sanitizeFilter(filter, table);
    const ranges = sanitizeRange(filter, table);
    if (!(await moduleEnabled(table))) return []; // degrade: module OFF, no budget charged
    const { whereSql, extraParams } = buildWhere(table, clean, ranges);
    chargeQuery();
    const cols = readColumnsFor(table);
    const r = await runScopedQuery(
      `SELECT ${cols} FROM ${table} WHERE ${whereSql} ORDER BY id DESC LIMIT ${MAX_ROWS}`,
      [orgId, ...extraParams]
    );
    return r.rows;
  }

  async function updateSome(table, id, patch) {
    const clean = sanitizePatch(patch, table);
    const nid = assertId(id);
    // Module OFF degrades exactly like "row not found in this org" — null,
    // no proposal recorded, no budget charged. Argument validation above
    // still throws (an invalid patch is an authoring bug regardless of flags).
    if (!(await moduleEnabled(table))) return null;

    if (dryRun) {
      // CONFIRM-FIRST: do not write. Read the current (org-scoped) row so the
      // confirm card can show a before/after diff, record the proposal, and
      // return a simulated post-write row so downstream plugin logic runs.
      chargeQuery(); // the before-read still consumes query budget
      const cols = readColumnsFor(table);
      const r = await runScopedQuery(
        `SELECT ${cols} FROM ${table} WHERE id = $1 AND org_id = $2 LIMIT 1`,
        [nid, orgId]
      );
      const before = r.rows[0] || null;
      // Row not in this org → nothing to propose. Mirrors the committed path,
      // which returns null when the scoped WHERE matches nothing.
      if (!before) return null;
      recordProposal({
        entity: ENTITY_BY_TABLE[table],
        op: 'update',
        table,
        target_id: nid,
        fields: clean,
        before,
      });
      return { ...before, ...clean };
    }

    const keys = Object.keys(clean);
    const setSql = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const params = keys.map(k => clean[k]);
    params.push(nid, orgId);
    chargeQuery();
    const r = await runScopedQuery(
      `UPDATE ${table} SET ${setSql}, updated_at = CURRENT_TIMESTAMP
        WHERE id = $${params.length - 1} AND org_id = $${params.length}
        RETURNING *`,
      params
    );
    return r.rows[0] || null;
  }

  return {
    // Reads
    getDeal:      (id) => getOne('deals', id),
    listDeals:    (filter) => listSome('deals', filter),
    getContact:   (id) => getOne('contacts', id),
    listContacts: (filter) => listSome('contacts', filter),
    getCompany:   (id) => getOne('companies', id),
    listCompanies:(filter) => listSome('companies', filter),
    getTask:      (id) => getOne('tasks', id),
    listTasks:    (filter) => listSome('tasks', filter),

    // Module-object reads (2026-09 expansion). Flag-gated per org (see
    // TABLE_FEATURE_FLAGS): a disabled module returns [] / null plus one
    // run-log warning instead of erroring, so library entries degrade.
    getLead:      (id) => getOne('leads', id),
    listLeads:    (filter) => listSome('leads', filter),
    getCase:      (id) => getOne('cases', id),
    listCases:    (filter) => listSome('cases', filter),
    getQuote:     (id) => getOne('quotes', id),
    listQuotes:   (filter) => listSome('quotes', filter),
    getMeeting:   (id) => getOne('meetings', id),
    listMeetings: (filter) => listSome('meetings', filter),
    // No getServiceContract — renewal automations operate on cohorts
    // (renewal_stage / customer_id); a single-row read has no v1 use case.
    listServiceContracts: (filter) => listSome('service_contracts', filter),

    // Writes (column-allowlisted, org-scoped)
    updateDeal:    (id, patch) => updateSome('deals', id, patch),
    updateContact: (id, patch) => updateSome('contacts', id, patch),
    updateCompany: (id, patch) => updateSome('companies', id, patch),
    updateTask:    (id, patch) => updateSome('tasks', id, patch),
    // Module-object writes — same proposal machinery as the four above
    // (dryRun captures a proposal; pluginActions re-validates on Apply).
    updateLead:    (id, patch) => updateSome('leads', id, patch),
    updateCase:    (id, patch) => updateSome('cases', id, patch),

    // Create — only tasks for v1 (the "create follow-up task" automation).
    // Deals/contacts/companies creation is intentionally NOT exposed; it's
    // a more abuse-prone surface and not needed for the v1 automations we
    // want to support.
    createTask: async (data) => {
      const fields = normalizeTaskData(data); // throws on invalid input
      // Charge BOTH counters. chargeTask() runs first so a runaway
      // createTask loop trips the more-specific task budget error before the
      // generic query budget. If chargeTask throws, chargeQuery is never
      // reached, so db_queries doesn't get charged for the rejected call.
      chargeTask();
      chargeQuery();

      if (dryRun) {
        // CONFIRM-FIRST: capture the create instead of executing it. Return a
        // simulated row (id: null — not persisted yet) so plugin logic runs.
        recordProposal({
          entity: 'task',
          op: 'create',
          table: 'tasks',
          target_id: null,
          fields,
          before: null,
        });
        return { id: null, org_id: orgId, ...fields };
      }

      const { title, description, due_date, status, priority, contact_id, deal_id } = fields;
      const r = await runScopedQuery(
        `INSERT INTO tasks (org_id, user_id, contact_id, deal_id, title, description, due_date, status, priority)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [orgId, contact_id, deal_id, title, description, due_date, status, priority]
      );
      return r.rows[0];
    },

    // AI — the metered, billing-gated completion bridge. Exposed BOTH as the
    // nested namespace plugins call (crm.ai.complete) and as the flat
    // `aiComplete` name the runner bridges into the isolate (the prelude
    // rebuilds the nested shape inside the sandbox).
    ai: Object.freeze({ complete: aiComplete }),
    aiComplete,

    // Logging — pushed into the run's log buffer, capped at 200 lines, each
    // line capped at 2KB. Caps prevent a plugin from filling memory or the
    // DB with a runaway log.
    log: pushLog,
  };
}

module.exports = {
  buildContext,
  UPDATE_ALLOWLISTS,
  FILTER_ALLOWLISTS,
  RANGE_FILTER_ALLOWLISTS,
  READ_COLUMN_ALLOWLISTS,
  TABLE_FEATURE_FLAGS,
  MAX_ROWS,
  MAX_QUERIES_PER_RUN,
  MAX_TASKS_CREATED_PER_RUN,
  MAX_AI_CALLS_PER_RUN,
  AI_MAX_TOKENS_CAP,
  AI_DEFAULT_MAX_TOKENS,
  AI_MAX_PROMPT_CHARS,
  AI_MAX_SYSTEM_CHARS,
  PLUGIN_STATEMENT_TIMEOUT,
  PluginQueryBudgetExceeded,
  PluginTaskBudgetExceeded,
  PluginTimeBudgetExceeded,
  PluginAiBudgetExceeded,
  // Shared with the confirm-first apply layer (services/pluginActions.js) so
  // the re-validation on Apply uses the exact same allowlist + normalization
  // the preview captured.
  ENTITY_BY_TABLE,
  TABLE_BY_ENTITY,
  sanitizePatch,
  normalizeTaskData,
  assertId,
};
