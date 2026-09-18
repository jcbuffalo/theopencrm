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
};

// Filter allowlists for list*() functions. Keys not in this set are
// silently dropped; this prevents a plugin from filtering on internal
// columns like `created_by` and inferring cross-tenant data shape.
const FILTER_ALLOWLISTS = {
  deals:     ['stage', 'phase', 'contact_id', 'company_id', 'owner_id', 'status'],
  contacts:  ['status', 'company_id', 'owner_id'],
  companies: ['type', 'status', 'owner_id'],
  tasks:     ['status', 'contact_id', 'deal_id', 'priority', 'assigned_to'],
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
const ENTITY_BY_TABLE = { deals: 'deal', contacts: 'contact', companies: 'company', tasks: 'task' };
const TABLE_BY_ENTITY = { deal: 'deals', contact: 'contacts', company: 'companies', task: 'tasks' };

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

// Build a list of WHERE clauses from a sanitized filter object. Always
// includes `org_id = $1`; additional fragments increment from $2.
function buildWhere(table, filter) {
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
 */
function buildContext({ orgId, logBuffer, counters, deadline = null, dryRun = false, proposedActions = null }) {
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
    if (deadline && Date.now() > deadline) {
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

  async function getOne(table, id) {
    chargeQuery();
    const cols = readColumnsFor(table);
    const r = await runScopedQuery(
      `SELECT ${cols} FROM ${table} WHERE id = $1 AND org_id = $2 LIMIT 1`,
      [assertId(id), orgId]
    );
    return r.rows[0] || null;
  }

  async function listSome(table, filter) {
    const clean = sanitizeFilter(filter, table);
    const { whereSql, extraParams } = buildWhere(table, clean);
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

    // Writes (column-allowlisted, org-scoped)
    updateDeal:    (id, patch) => updateSome('deals', id, patch),
    updateContact: (id, patch) => updateSome('contacts', id, patch),
    updateCompany: (id, patch) => updateSome('companies', id, patch),
    updateTask:    (id, patch) => updateSome('tasks', id, patch),

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

    // Logging — pushed into the run's log buffer, capped at 200 lines, each
    // line capped at 2KB. Caps prevent a plugin from filling memory or the
    // DB with a runaway log.
    log: (message) => {
      if (logBuffer.length >= 200) return; // silently drop further lines
      const s = (typeof message === 'string' ? message : JSON.stringify(message ?? null)).slice(0, 2048);
      logBuffer.push(s);
    },
  };
}

module.exports = {
  buildContext,
  UPDATE_ALLOWLISTS,
  FILTER_ALLOWLISTS,
  READ_COLUMN_ALLOWLISTS,
  MAX_ROWS,
  MAX_QUERIES_PER_RUN,
  MAX_TASKS_CREATED_PER_RUN,
  PLUGIN_STATEMENT_TIMEOUT,
  PluginQueryBudgetExceeded,
  PluginTaskBudgetExceeded,
  PluginTimeBudgetExceeded,
  // Shared with the confirm-first apply layer (services/pluginActions.js) so
  // the re-validation on Apply uses the exact same allowlist + normalization
  // the preview captured.
  ENTITY_BY_TABLE,
  TABLE_BY_ENTITY,
  sanitizePatch,
  normalizeTaskData,
  assertId,
};
