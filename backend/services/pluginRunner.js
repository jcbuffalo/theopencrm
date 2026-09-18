// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Plugin runtime — Phase C build-out.
//
// Replaces the prior STUB with a real isolated-vm sandbox. Each invocation
// spins up a fresh v8 Isolate (NO sharing across orgs, NO sharing across
// invocations), compiles the plugin's source, injects an org-scoped `crm`
// SDK as the only non-default global, and runs with hard CPU + memory caps.
//
// SECURITY MODEL (read /security/THREAT_MODEL.md if you change this file):
//
//   • One Isolate per call. Fresh heap. The isolate is disposed in a
//     finally{} block. A plugin cannot persist state across invocations
//     through the runtime — only through the DB (via the SDK).
//   • The isolate has NO default access to fetch / http / process / require
//     / Buffer / setTimeout / setInterval / setImmediate / console. The only
//     globals are: the built-in v8 globals (Math, JSON, Date, Promise,
//     Array, Object, ...) and the `crm` object we inject.
//   • The `crm` SDK functions are exposed via ivm.Reference.applySyncPromise.
//     They run in the HOST (with full DB access) but every query is bound
//     to the caller's org_id by buildContext() — the plugin cannot supply
//     org_id. See services/pluginSdk.js.
//   • Plugin source is wrapped in an async IIFE so `await crm.foo()` works
//     and the top-level result is observable. The wrapper deliberately does
//     NOT `try/catch` around the user code — uncaught errors propagate to
//     us so we can record them as run.status = 'error'.
//   • Resource caps:
//       memoryLimit:  128 MB
//       compile timeout:  1 second
//       run timeout:      5 seconds (wall clock; CPU is implicitly capped
//                                    by the timeout since the isolate runs
//                                    in a worker thread).
//   • A timeout kills the isolate hard (`isolate.dispose()`). The next call
//     gets a clean process; no in-process state survives.
//
// KILL SWITCHES:
//   • Per plugin: set plugins.status = 'suspended' — runner short-circuits.
//   • Per org:    feature flag `plugins_enabled` = false on the org.
//   • Per platform: set env PLUGIN_RUNTIME_DISABLED=1 — runner rejects all
//                   calls without spinning the isolate.

const pool = require('../db');
const logger = require('./logger');
const audit = require('./audit');
const quotaEnforcer = require('./quotaEnforcer');
const usageMeter = require('./usageMeter');
const pluginSdk = require('./pluginSdk');
const pluginActions = require('./pluginActions');

// Load isolated-vm lazily so the module still loads in dev environments
// where the native build failed. If require() throws, run() will short-
// circuit with status='rejected' and reason 'sandbox_unavailable' — better
// to fail loud than to silently run plugin code unsandboxed.
let ivm = null;
let ivmLoadError = null;
try {
  // eslint-disable-next-line global-require
  ivm = require('isolated-vm');
} catch (err) {
  ivmLoadError = err;
  logger.error('isolated_vm_unavailable', { error: err.message });
}

const MEMORY_LIMIT_MB = 128;
const COMPILE_TIMEOUT_MS = 1000;
const RUN_TIMEOUT_MS = 5000;
// Hard TOTAL wall-clock ceiling for a single run, enforced HOST-side. The
// isolate `timeout` (RUN_TIMEOUT_MS) only meters time spent executing INSIDE
// the isolate — while a `crm.*` call is parked in applySyncPromise awaiting a
// host promise, the isolate clock is effectively paused. So a hostile plugin
// that fires MAX_QUERIES_PER_RUN queries, each riding just under the per-query
// statement_timeout, could hold a run (and a pg connection per query) for
// ~100s of wall clock despite the "5 second" isolate cap. We race the user
// script against this deadline; on expiry we dispose the isolate and report a
// timeout. Sized to comfortably exceed a legitimate 50-query run yet cap the
// worst case at a small multiple of RUN_TIMEOUT_MS.
const HARD_WALL_CLOCK_MS = 15000;
const MAX_OUTPUT_BYTES = 64 * 1024; // cap copied-out result payload

// Per-org rough monthly cap. The full tier-aware cap lives in quotaEnforcer;
// this is the floor we apply when an org's tier isn't recognized.
const DEFAULT_FREE_TIER_MONTHLY_CAP = 50;
const DEFAULT_PAID_TIER_MONTHLY_CAP = 1000;

// In-memory concurrency cap. An org can have at most this many plugin runs
// in-flight on this process at one time. Counts are incremented at the top
// of run() (after arg normalization but BEFORE the isolate is spun) and
// decremented in the finally{} block that disposes the isolate. The Map
// lives in module scope so it persists across calls within this process —
// but a process restart clears it. That's deliberate: the persistent
// per-month quota in quotaEnforcer is the real cost ceiling; this cap only
// exists to bound concurrent host resource pressure (heap, CPU, pg
// connections) from a single buggy or hostile tenant.
const MAX_CONCURRENT_RUNS_PER_ORG = 5;
const concurrentRunsByOrg = new Map(); // orgId -> integer count

class PluginRuntimeUnavailable extends Error {
  constructor() {
    super('Plugin sandbox is unavailable on this server. Contact the platform operator.');
    this.code = 'PLUGIN_SANDBOX_UNAVAILABLE';
  }
}

// Thrown HOST-side when a run blows past HARD_WALL_CLOCK_MS of total wall
// clock (isolate CPU + all host-parked crm.* calls combined). Carries a
// typed code so the run classifier maps it to status='timeout' without
// relying on message-regex matching.
class PluginWallClockExceeded extends Error {
  constructor(ms) {
    super(`Plugin exceeded the ${ms} ms total wall-clock limit.`);
    this.code = 'PLUGIN_WALL_CLOCK_EXCEEDED';
  }
}

/**
 * Count this org's plugin_runs so far this calendar month (UTC). Cheap
 * because of idx_plugin_runs_org_started.
 */
async function getOrgRunsThisMonth(orgId) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c
       FROM plugin_runs
      WHERE org_id = $1
        AND started_at >= date_trunc('month', NOW() AT TIME ZONE 'UTC')`,
    [orgId]
  );
  return r.rows[0]?.c || 0;
}

async function checkPluginQuota(orgId) {
  const tier = await quotaEnforcer.getOrgTier(orgId);
  const quotas = quotaEnforcer.TIER_QUOTAS[tier] || quotaEnforcer.TIER_QUOTAS.free;
  const limit = quotas.plugin_runs_per_org_per_month;
  if (limit === Infinity) return; // unmetered tier

  const used = await getOrgRunsThisMonth(orgId);
  if (used >= limit) {
    if (!quotas.overageAllowed) {
      const err = new quotaEnforcer.QuotaExceeded({
        orgId, tier, metric: 'plugin_runs', limit, current: used,
      });
      throw err;
    }
    // Overage allowed — log it; billing will pick it up.
    logger.notice('quota_overage_plugin_runs', { orgId, tier, used, limit });
  }
  // Defensive floor in case tier is missing/typo'd.
  if (typeof limit !== 'number' || Number.isNaN(limit)) {
    const fallback = tier === 'free' ? DEFAULT_FREE_TIER_MONTHLY_CAP : DEFAULT_PAID_TIER_MONTHLY_CAP;
    const used2 = await getOrgRunsThisMonth(orgId);
    if (used2 >= fallback) {
      throw new quotaEnforcer.QuotaExceeded({
        orgId, tier, metric: 'plugin_runs', limit: fallback, current: used2,
      });
    }
  }
}

// The function names we bridge. Order matters only for clarity.
const SDK_METHODS = [
  // reads (sync DB calls — bridged via applySyncPromise)
  'getDeal', 'listDeals',
  'getContact', 'listContacts',
  'getCompany', 'listCompanies',
  'getTask', 'listTasks',
  // writes
  'updateDeal', 'updateContact', 'updateCompany', 'updateTask',
  'createTask',
];
// `log` is the only fully-synchronous host call (it just pushes to a buffer).
const SDK_LOG_METHOD = 'log';

/**
 * Build the JS prelude that runs inside the isolate before the user code.
 * Each SDK function is installed on the isolate global as its own
 * `ivm.Reference` (the names are `__host_<fnName>`). The prelude wraps
 * each Reference's `applySyncPromise` (or `applySync` for `log`) in a
 * plain JS function, exposes the union as a frozen `crm` object on the
 * isolate's `globalThis`, then DELETES the raw host references so user
 * code can't call them directly.
 *
 * IMPORTANT: This string is concatenated with untrusted user code only
 * AFTER it runs. The prelude itself contains NO user-controlled values —
 * the user code goes in its own subsequent compileScript() call.
 */
function buildIsolatePrelude() {
  // For each SDK method we capture the host Reference into a local `const`
  // first, then build a wrapper. Inline property access like
  // `globalThis.__host_foo.applySync(...)` does NOT work — every dotted
  // expression on a Reference inside the isolate copies the reference
  // object into a plain JS value without the `.applySync` method. Binding
  // the Reference to a local preserves the method.
  const localBindings = [...SDK_METHODS, SDK_LOG_METHOD]
    .map(name => `const __r_${name} = globalThis.__host_${name};`)
    .join('\n    ');

  const reads = SDK_METHODS.map(name =>
    // applySyncPromise crosses the isolate/host boundary. Args must be
    // copy-transferred so the host gets plain JS values (otherwise the
    // host receives References it can't pg.query() with). The result is
    // ALWAYS copied by applySyncPromise — no opt-in needed. We coerce
    // undefined slots to null because v8's structured clone refuses
    // sparse arrays.
    `${name}: (...args) => __r_${name}.applySyncPromise(undefined, args.map(v => v === undefined ? null : v), { arguments: { copy: true } })`
  ).join(',\n      ');

  const deletes = [...SDK_METHODS, SDK_LOG_METHOD]
    .map(n => `delete globalThis.__host_${n};`)
    .join('\n    ');

  return `
    'use strict';
    // Verify every host reference is present before we build crm — fail
    // loud if a wiring bug ever ships a half-built sandbox.
    for (const n of ${JSON.stringify(SDK_METHODS.concat([SDK_LOG_METHOD]))}) {
      if (!globalThis['__host_' + n]) throw new Error('plugin sandbox: missing host ref ' + n);
    }
    ${localBindings}
    const crm = Object.freeze({
      ${reads},
      log: (msg) => __r_${SDK_LOG_METHOD}.applySync(undefined, [typeof msg === 'string' ? msg : JSON.stringify(msg === undefined ? null : msg)], { arguments: { copy: true } })
    });
    Object.defineProperty(globalThis, 'crm', { value: crm, writable: false, configurable: false, enumerable: true });
    // Hide the raw references. After deletion, user code cannot reach the
    // host-side functions except through the frozen \`crm\` shim. The
    // \`__r_*\` locals leak only into the prelude's lexical scope and are
    // dropped when this script returns.
    ${deletes}
    // v8 includes a few globals we want to make inaccessible. \`console\`
    // is the obvious one — plugin authors should use \`crm.log()\`, which
    // routes into our run log. We do NOT remove Math/JSON/Date/Promise
    // because those are part of the language surface plugins legitimately
    // need.
    for (const n of ['console', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'queueMicrotask', 'fetch', 'XMLHttpRequest', 'WebSocket', 'Buffer', 'process']) {
      try { delete globalThis[n]; } catch {}
    }
  `;
}

/**
 * Wrap user code in an async IIFE that exposes the result. We do NOT
 * try/catch — any throw propagates to the host's script.run() call.
 *
 * `userCode` can be:
 *   • a bare expression / statement list using `crm` and returning a value
 *   • a module-style `module.exports = { run: ({crm, input}) => ... }` —
 *     we detect this shape and call .run({crm, input}) for the author.
 */
function buildUserScript(userCode, inputPayloadJson) {
  // Two ways the user can deliver a result:
  //   1. Set `globalThis.__pluginResult` directly (suits short scripts).
  //   2. Provide `module.exports = { run({ crm, input }) { ... } }` —
  //      we polyfill `module` and call its `.run`.
  // We never use Node's require()/module; the polyfill is hand-rolled.
  //
  // The script ends with an EXPRESSION that evaluates to a Promise. We
  // run it with `{ promise: true }` from the host, which awaits the
  // promise (synchronously from the script's perspective, asynchronously
  // from ours) before script.run() resolves. This is how we capture the
  // user's async work without leaking microtasks past the timeout.

  return `
    (async () => {
      const input = ${inputPayloadJson};
      let module = { exports: {} };
      // -------- BEGIN USER CODE --------
      ${userCode}
      // -------- END USER CODE ----------
      // After the user code runs, prefer module.exports.run({ crm, input }):
      if (module.exports && typeof module.exports.run === 'function') {
        const v = await module.exports.run({ crm, input });
        if (typeof globalThis.__pluginResult === 'undefined') {
          globalThis.__pluginResult = v === undefined ? null : v;
        }
      }
      // If user code threw, the surrounding catch in the host will record
      // it. If user code set globalThis.__pluginResult directly, we leave
      // it untouched.
    })()
  `;
}

/**
 * Create a plugin_runs row in 'running' state. Always created so the audit
 * trail is intact even when we reject the call immediately.
 */
async function createRunRow({ pluginId, orgId, triggeredBy, triggerSource, triggerKind, triggerData, inputPayload }) {
  const r = await pool.query(
    `INSERT INTO plugin_runs
       (plugin_id, org_id, started_at, status, trigger_kind, trigger_source,
        triggered_by, trigger_data, input_payload)
     VALUES ($1, $2, NOW(), 'running', $3, $4, $5, $6::jsonb, $7::jsonb)
     RETURNING id`,
    [
      pluginId, orgId, triggerKind, triggerSource, triggeredBy,
      triggerData ? JSON.stringify(triggerData) : null,
      inputPayload ? JSON.stringify(inputPayload) : null,
    ]
  );
  return r.rows[0].id;
}

async function finalizeRun(runId, fields) {
  const {
    status,
    error_message = null,
    result_summary = null,
    output_payload = null,
    log_lines = null,
    cpu_ms = 0,
    db_queries = 0,
    egress_bytes = 0,
    proposed_actions = null,
    run_mode = null,
  } = fields;
  // memory_peak_bytes was removed in migration 081 — isolated-vm doesn't
  // expose a peak after dispose(), so the column always stored 0. Anyone
  // reviving a memory metric should add a new column with an honest source
  // (probably an interval-sampled getHeapStatisticsSync().used_heap_size).
  //
  // proposed_actions (migration 113) holds the confirm-first write proposals a
  // preview run captured; NULL for read-only runs and legacy rows.
  //
  // run_mode (migration 167) records which posture governed this run
  // ('preview' | 'autonomous' | legacy 'commit'); NULL for runs rejected
  // before the plugin row was loaded — readers treat NULL as 'preview'.
  await pool.query(
    `UPDATE plugin_runs
        SET ended_at = NOW(),
            status = $1,
            error_message = $2,
            result_summary = $3,
            output_payload = $4::jsonb,
            log_lines = $5,
            cpu_ms = $6,
            db_queries = $7,
            egress_bytes = $8,
            proposed_actions = $9::jsonb,
            run_mode = COALESCE($10, run_mode)
      WHERE id = $11`,
    [
      status, error_message, result_summary,
      output_payload ? JSON.stringify(output_payload) : null,
      log_lines,
      Math.round(cpu_ms), db_queries, egress_bytes,
      proposed_actions ? JSON.stringify(proposed_actions) : null,
      run_mode,
      runId,
    ]
  );
}

/**
 * Best-effort JSON serialization of the plugin's return value, capped at
 * MAX_OUTPUT_BYTES. Anything that doesn't serialize cleanly (Functions,
 * Symbols, cycles) becomes `null` — we don't surface the failure to the
 * user because the run itself succeeded.
 */
function safeSerializeOutput(value) {
  try {
    const s = JSON.stringify(value);
    if (s === undefined) return null;
    if (s.length > MAX_OUTPUT_BYTES) {
      return { _truncated: true, preview: s.slice(0, MAX_OUTPUT_BYTES) };
    }
    return value;
  } catch {
    return null;
  }
}

/**
 * Run a plugin. Main entry point.
 *
 * Two call shapes are supported for backward compat with the existing
 * routes/pluginRoutes.js test-run endpoint:
 *
 *   run({ pluginId, orgId, triggerKind, triggerData })          // legacy
 *   run(pluginId, input, { userId, orgId, triggerSource })       // new
 *
 * The new shape is what /api/plugins/:id/run uses. We dispatch based on
 * whether the first arg is an object or a primitive id.
 */
async function run(...args) {
  // Normalize the two call signatures into a single internal options object.
  //
  // `mode` selects the write posture:
  //   'preview' (DEFAULT) — CONFIRM-FIRST. Writes are captured as proposals and
  //                         NOT committed; the caller must Apply them through
  //                         POST /api/plugins/:id/apply. Every route uses this.
  //   'commit'            — legacy direct-write path (SDK executes writes inside
  //                         the sandbox). No production caller selects it; kept
  //                         only so the pluginSdk direct-write unit tests stay
  //                         valid. Defaulting to 'preview' means a caller that
  //                         forgets `mode` can NEVER have a plugin write directly.
  //
  // AUTONOMOUS (migration 167): independent of this arg, a plugin whose row
  // carries run_mode='autonomous' (owner/admin-set) still executes in the
  // preview capture posture, but its successful runs' proposals are
  // auto-applied after finalize via pluginActions.applyRunProposals — the
  // same commit machinery as POST /:id/apply. See the AUTO-APPLY block below.
  let pluginId, orgId, userId, triggerSource, triggerKind, triggerData, input, mode;
  if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
    const o = args[0];
    pluginId      = Number(o.pluginId);
    orgId         = Number(o.orgId);
    userId        = o.userId || null;
    triggerKind   = o.triggerKind || 'manual';
    triggerSource = o.triggerSource || (triggerKind === 'test_run' ? 'manual' : triggerKind);
    triggerData   = o.triggerData || null;
    input         = (o.input !== undefined ? o.input : triggerData) || null;
    mode          = o.mode === 'commit' ? 'commit' : 'preview';
  } else {
    pluginId        = Number(args[0]);
    input           = args[1] ?? null;
    const ctx       = args[2] || {};
    orgId           = Number(ctx.orgId);
    userId          = ctx.userId || null;
    triggerSource   = ctx.triggerSource || 'manual';
    triggerKind     = triggerSource;
    triggerData     = input;
    mode            = ctx.mode === 'commit' ? 'commit' : 'preview';
  }

  if (!Number.isInteger(pluginId) || !Number.isInteger(orgId)) {
    return { ok: false, status: 'rejected', reason: 'bad_args' };
  }

  // Platform-wide kill switch.
  if (process.env.PLUGIN_RUNTIME_DISABLED === '1') {
    return { ok: false, status: 'rejected', reason: 'runtime_disabled' };
  }

  // Sandbox unavailable (native module failed to load). Refuse — better to
  // fail loud than to silently run unsandboxed user code.
  if (!ivm) {
    const runId = await createRunRow({
      pluginId, orgId, triggeredBy: userId, triggerSource, triggerKind, triggerData, inputPayload: input,
    }).catch(() => null);
    if (runId) {
      await finalizeRun(runId, {
        status: 'rejected',
        error_message: 'isolated-vm not available on this server. Plugin sandbox is offline.',
      }).catch(() => {});
    }
    audit.record({
      event: audit.EVENTS.PLUGIN_RUN,
      actorUserId: userId, orgId,
      targetType: 'plugin', targetId: pluginId,
      success: false,
      meta: { reason: 'sandbox_unavailable', loadError: ivmLoadError?.message },
    }).catch(() => {});
    return { ok: false, status: 'rejected', reason: 'sandbox_unavailable', runId };
  }

  // Per-org concurrency cap. Reject BEFORE creating the plugin_runs row or
  // touching the isolate — a rejection here is a "we refused to even try"
  // and doesn't get billed or audit-logged as a normal run. We still record
  // a run row so the user can see the rejection in their runs list (HTTP
  // 429 with status='concurrent_limit_exceeded'), but we short-circuit
  // before the expensive isolate spin-up.
  const currentInFlight = concurrentRunsByOrg.get(orgId) || 0;
  if (currentInFlight >= MAX_CONCURRENT_RUNS_PER_ORG) {
    const rejId = await createRunRow({
      pluginId, orgId, triggeredBy: userId, triggerSource, triggerKind, triggerData, inputPayload: input,
    }).catch(() => null);
    if (rejId) {
      await finalizeRun(rejId, {
        status: 'concurrent_limit_exceeded',
        error_message: `Org has ${currentInFlight} plugin runs in flight; cap is ${MAX_CONCURRENT_RUNS_PER_ORG}.`,
      }).catch(() => {});
    }
    audit.record({
      event: audit.EVENTS.PLUGIN_RUN,
      actorUserId: userId, orgId,
      targetType: 'plugin', targetId: pluginId,
      success: false,
      meta: { reason: 'concurrent_limit_exceeded', inFlight: currentInFlight, cap: MAX_CONCURRENT_RUNS_PER_ORG },
    }).catch(() => {});
    return {
      ok: false,
      status: 'concurrent_limit_exceeded',
      reason: 'concurrent_limit_exceeded',
      runId: rejId,
      error: `Org has ${currentInFlight} plugin runs in flight; cap is ${MAX_CONCURRENT_RUNS_PER_ORG}.`,
    };
  }
  const startedAt = Date.now();
  const runId = await createRunRow({
    pluginId, orgId, triggeredBy: userId, triggerSource, triggerKind, triggerData, inputPayload: input,
  });

  let isolate = null;
  // Race-safe isolate disposal. Both the wall-clock timeout path and the
  // normal-completion finally{} block call disposeIsolateOnce(); the flag +
  // the isolate.isDisposed guard together guarantee dispose() runs at most
  // once even if the two paths fire nearly simultaneously.
  let isolateDisposed = false;
  let wallClockExpired = false;
  function disposeIsolateOnce() {
    if (isolateDisposed) return;
    isolateDisposed = true;
    try {
      if (isolate && !isolate.isDisposed) isolate.dispose();
    } catch (e) {
      logger.warn('plugin_isolate_dispose_failed', { runId, error: e.message });
    }
  }
  const logBuffer = [];
  // tasks_created is a sibling counter to db_queries — incremented inside
  // pluginSdk.chargeTask each time the plugin calls createTask(). The runner
  // doesn't currently persist this to the plugin_runs row schema (no column
  // for it; that's a follow-up migration if we ever need per-run task-creation
  // analytics) but it surfaces in the error message when the task budget is
  // exceeded.
  const counters = { db_queries: 0, tasks_created: 0 };
  // Confirm-first write proposals captured during a preview (dryRun) run. The
  // SDK pushes onto this in-place; we persist it to plugin_runs.proposed_actions
  // and return it so the caller can render the Apply diff. Empty in 'commit'
  // mode and for read-only plugins.
  const proposedActions = [];
  let status = 'error';
  let errorMessage = null;
  let output = null;
  // Effective run posture (migration 167). Resolved from the plugin row once
  // it loads: an org owner/admin can flip plugins.run_mode to 'autonomous',
  // in which case a SUCCESSFUL run's proposals are auto-applied below through
  // the same commit machinery as POST /:id/apply. The legacy 'commit' arg
  // (test-only) is recorded honestly. Until the plugin row loads this stays
  // null — early rejections record no mode.
  let runModeUsed = mode === 'commit' ? 'commit' : null;

  // Claim the concurrency slot IMMEDIATELY before the try whose finally{}
  // releases it. Keeping the increment adjacent to the try (rather than up
  // near createRunRow) guarantees every increment has a matching decrement:
  // if anything between the concurrency check and here had thrown — e.g.
  // createRunRow — we'd never have incremented, so the counter can't leak and
  // permanently lock the org out with concurrent_limit_exceeded.
  concurrentRunsByOrg.set(orgId, currentInFlight + 1);

  try {
    // Quota check first. If we're over, don't even spin the isolate.
    try {
      await checkPluginQuota(orgId);
    } catch (err) {
      if (err && err.code === 'QUOTA_EXCEEDED') {
        status = 'quota_exceeded';
        errorMessage = err.message;
        await finalizeRun(runId, { status, error_message: errorMessage });
        audit.record({
          event: audit.EVENTS.PLUGIN_RUN,
          actorUserId: userId, orgId,
          targetType: 'plugin', targetId: pluginId,
          success: false,
          meta: { runId, status, reason: 'quota_exceeded' },
        }).catch(() => {});
        return { ok: false, status, reason: 'quota_exceeded', runId, error: errorMessage };
      }
      throw err;
    }

    // Load plugin spec. Cross-org access is structurally blocked.
    const pluginRes = await pool.query(
      `SELECT id, name, status, source_code, spec_json, run_mode FROM plugins WHERE id = $1 AND org_id = $2`,
      [pluginId, orgId]
    );
    if (pluginRes.rows.length === 0) {
      status = 'rejected';
      errorMessage = 'plugin_not_found_or_wrong_org';
      await finalizeRun(runId, { status, error_message: errorMessage });
      return { ok: false, status, reason: 'plugin_not_found', runId };
    }
    const plugin = pluginRes.rows[0];
    // Resolve the effective posture. The plugin's stored run_mode governs ALL
    // of its runs uniformly — manual, chat, event-triggered, and scheduled —
    // one coherent rule. Anything but an explicit 'autonomous' is 'preview'
    // (the legacy test-only 'commit' arg wins if the caller passed it).
    if (mode !== 'commit') {
      runModeUsed = plugin.run_mode === 'autonomous' ? 'autonomous' : 'preview';
    }
    if (plugin.status !== 'active') {
      status = 'rejected';
      errorMessage = `plugin_status_is_${plugin.status}`;
      await finalizeRun(runId, { status, error_message: errorMessage });
      return { ok: false, status, reason: errorMessage, runId };
    }

    const source = plugin.source_code;
    if (!source || typeof source !== 'string' || source.trim().length === 0) {
      status = 'rejected';
      errorMessage = 'plugin_has_no_source_code';
      await finalizeRun(runId, { status, error_message: errorMessage });
      return { ok: false, status, reason: errorMessage, runId };
    }

    // ----------------------------- ISOLATE ---------------------------------
    isolate = new ivm.Isolate({
      memoryLimit: MEMORY_LIMIT_MB,
      inspector: false,
    });
    const context = await isolate.createContext({ inspector: false });
    const jail = context.global;

    // Build the org-scoped SDK + install each function as its own
    // ivm.Reference under a `__host_<name>` global. The prelude wraps these
    // in a frozen `crm` object and then deletes the raw references — after
    // the prelude runs, user code has no way to reach the host bridge
    // except through `crm`.
    //
    // We use one Reference per function rather than one Reference around
    // an object because Reference property access from inside the isolate
    // requires explicit getSync() with extra await steps; per-function is
    // both faster and structurally simpler.
    // Absolute wall-clock deadline for this run, shared by (a) the host-side
    // Promise.race guard below and (b) the SDK's scoped-query path. Passing it
    // into buildContext lets the query loop self-limit: once the deadline is
    // passed, the next crm.* DB call throws synchronously instead of opening
    // yet another pg connection, so we usually stop cleanly BEFORE the hard
    // race has to dispose the isolate out from under running code.
    const wallClockDeadline = Date.now() + HARD_WALL_CLOCK_MS;
    // CONFIRM-FIRST: in 'preview' mode the SDK captures writes as proposals in
    // `proposedActions` and does NOT touch the DB. 'commit' (no production
    // caller) is the legacy direct-write path.
    const sdk = pluginSdk.buildContext({
      orgId, logBuffer, counters,
      deadline: wallClockDeadline,
      dryRun: mode === 'preview',
      proposedActions,
    });

    // Each async SDK function must return an ivm.ExternalCopy of its
    // resolved value — isolated-vm doesn't auto-clone arbitrary objects
    // back across the isolate boundary, even when the result option is
    // (implicitly) "copy". Wrapping the result in ExternalCopy makes the
    // return transferable; ExternalCopy uses structured clone, which
    // handles plain objects, arrays, numbers, strings, booleans, null,
    // Dates, and (importantly) does NOT include pg connection objects.
    // We also normalize non-serializable shapes through JSON to defend
    // against pg returning Buffer/BigInt fields that structured clone
    // refuses.
    function copyResult(p) {
      return p.then(v => {
        // JSON-roundtrip strips BigInt, Function, Symbol, etc. Anything
        // pg returns that JSON can't handle becomes null, which is fine
        // for v1.
        const safe = v === undefined ? null : JSON.parse(JSON.stringify(v));
        return new ivm.ExternalCopy(safe).copyInto({ release: true });
      });
    }
    for (const name of SDK_METHODS) {
      const fn = sdk[name];
      await jail.set(`__host_${name}`, new ivm.Reference((...args) => copyResult(fn(...args))));
    }
    // log() is synchronous on the host; its return value (undefined) doesn't
    // need wrapping. applySync handles it.
    await jail.set(`__host_${SDK_LOG_METHOD}`, new ivm.Reference(sdk[SDK_LOG_METHOD]));

    // 1) Compile + run the prelude (locks down `crm`, hides host ref).
    const prelude = await isolate.compileScript(buildIsolatePrelude(), {
      filename: 'plugin-runtime-prelude.js',
      timeout: COMPILE_TIMEOUT_MS,
    });
    await prelude.run(context, { timeout: COMPILE_TIMEOUT_MS });

    // 2) Compile + run the user code. The script body evaluates to a
    //    Promise that resolves AFTER the user's async work finishes; we
    //    pass `promise: true` so script.run() awaits it under the same
    //    wall-clock timeout as the synchronous execution would have.
    const inputJson = JSON.stringify(input === undefined ? null : input);
    const userScript = await isolate.compileScript(
      buildUserScript(source, inputJson),
      { filename: `plugin-${pluginId}.js`, timeout: COMPILE_TIMEOUT_MS }
    );
    // Bound the TOTAL wall clock. `timeout: RUN_TIMEOUT_MS` only meters CPU
    // spent inside the isolate; time parked in applySyncPromise awaiting a
    // host promise (a slow crm.* query) does NOT count against it. Race the
    // script against a hard host-side deadline. On expiry we dispose the
    // isolate — which makes the in-flight userScript.run() reject with an
    // "Isolate is disposed" error — and settle the race with a typed
    // wall-clock error. We flip `wallClockExpired` first so the catch{} below
    // classifies the outcome as a timeout regardless of which rejection wins.
    let wallClockTimer = null;
    const remainingMs = Math.max(0, wallClockDeadline - Date.now());
    const wallClockGuard = new Promise((_, reject) => {
      wallClockTimer = setTimeout(() => {
        wallClockExpired = true;
        disposeIsolateOnce();
        reject(new PluginWallClockExceeded(HARD_WALL_CLOCK_MS));
      }, remainingMs);
    });
    try {
      const runPromise = userScript.run(context, { timeout: RUN_TIMEOUT_MS, promise: true });
      // If the guard wins the race, runPromise settles (rejects) later with a
      // disposed-isolate error. Promise.race already attaches a handler, but
      // we add our own no-op catch to be explicit that a late rejection here
      // is expected and must not surface as an unhandledRejection.
      runPromise.catch(() => {});
      await Promise.race([runPromise, wallClockGuard]);
    } finally {
      if (wallClockTimer) clearTimeout(wallClockTimer);
    }

    // 3) Read the result the user code wrote to globalThis.__pluginResult.
    //    Any thrown error bubbles up to the catch{} below.
    const resultMarker = await jail.get('__pluginResult', { copy: true }).catch(() => null);
    output = safeSerializeOutput(resultMarker);
    status = 'success';
  } catch (err) {
    // isolated-vm error taxonomy. The native module exposes these as
    // generic Errors but with characteristic message strings. We classify
    // by message because the constructor names aren't stable across
    // versions. SDK-side errors (like the per-run query budget) bubble up
    // with a typed `.code` we can match on first — preferring code-based
    // dispatch over regex matching whenever the source error is ours.
    const msg = String(err && err.message ? err.message : err);
    const code = err && err.code;
    if (wallClockExpired || code === 'PLUGIN_WALL_CLOCK_EXCEEDED' || code === 'PLUGIN_TIME_BUDGET_EXCEEDED') {
      // Host-side wall-clock deadline hit. Checked FIRST (and gated on the
      // wallClockExpired flag) so that even the "Isolate is disposed"
      // rejection produced by disposing the isolate out from under the run is
      // reported as a timeout rather than being misclassified as 'killed' or
      // an internal 'error'. PLUGIN_TIME_BUDGET_EXCEEDED is the SDK-side
      // self-limit that trips a hair earlier at the same deadline.
      status = 'timeout';
      errorMessage = `Plugin exceeded the ${HARD_WALL_CLOCK_MS} ms total wall-clock limit.`;
    } else if (code === 'PLUGIN_QUERY_BUDGET_EXCEEDED' || /per-run DB query budget/i.test(msg)) {
      // Thrown synchronously inside the isolate by pluginSdk.chargeQuery().
      // The error message survives the bridge intact because applySyncPromise
      // copies the rejection reason; we match on either the typed code (if
      // it propagates) or the message text (which always does).
      status = 'query_budget_exceeded';
      errorMessage = `Plugin exceeded the per-run DB query budget. Counter: ${counters.db_queries}.`;
    } else if (code === 'PLUGIN_TASK_BUDGET_EXCEEDED' || /per-run createTask budget/i.test(msg)) {
      // Thrown synchronously inside the isolate by pluginSdk.chargeTask().
      // Independent of the query budget — even if a plugin still has query
      // budget left, the 11th createTask call rejects so a single run can't
      // spawn an unbounded pile of tasks.
      status = 'task_budget_exceeded';
      errorMessage = `Plugin exceeded the per-run createTask budget. Counter: ${counters.tasks_created || 0}.`;
    } else if (/memory limit/i.test(msg) || /IsolateMemoryLimitExceeded/i.test(msg)) {
      status = 'memory_exceeded';
      errorMessage = 'Plugin exceeded the 128 MB memory cap.';
    } else if (/Script execution timed out/i.test(msg) || /timed out/i.test(msg)) {
      status = 'timeout';
      errorMessage = `Plugin exceeded the ${RUN_TIMEOUT_MS} ms execution timeout.`;
    } else if (/Isolate is disposed/i.test(msg) || /Isolate was disposed/i.test(msg)) {
      status = 'killed';
      errorMessage = 'Plugin isolate was disposed mid-execution.';
    } else {
      status = 'error';
      errorMessage = msg.slice(0, 4096);
    }
    logger.warn('plugin_run_failed', { runId, pluginId, orgId, status, error: errorMessage });
  } finally {
    // ALWAYS dispose the isolate. Leaks here are tenant-degrading. Routed
    // through disposeIsolateOnce() so that if the wall-clock timeout path
    // already disposed the isolate, this is a no-op — we never call
    // isolate.dispose() twice (double-dispose throws on some iso-vm builds).
    disposeIsolateOnce();
    // ALWAYS decrement the per-org concurrency counter. This finally pairs
    // with the increment above the try block; doing it here guarantees the
    // counter drains even if the isolate path threw, the DB write failed,
    // or we returned early. If the count would go to 0 we delete the map
    // entry to keep the Map from accumulating zombies for long-departed
    // orgs.
    const after = (concurrentRunsByOrg.get(orgId) || 1) - 1;
    if (after <= 0) concurrentRunsByOrg.delete(orgId);
    else concurrentRunsByOrg.set(orgId, after);
  }

  const elapsedMs = Date.now() - startedAt;

  // Only a successful run can carry actionable proposals. A run that threw,
  // timed out, or hit a budget mid-way may have captured a partial set — we
  // deliberately DO NOT persist those (an Apply of a half-computed proposal set
  // is a footgun). proposedActions is thus non-null only on success.
  const proposalsToPersist = (status === 'success' && proposedActions.length > 0) ? proposedActions : null;

  // Persist + meter outside the try/catch above so a finalizeRun failure
  // doesn't get swallowed by the error-classifier branch.
  try {
    await finalizeRun(runId, {
      status,
      error_message: errorMessage,
      result_summary: status === 'success' ? null : (errorMessage ? errorMessage.slice(0, 500) : null),
      output_payload: output,
      log_lines: logBuffer.length > 0 ? logBuffer : null,
      cpu_ms: elapsedMs,
      // memory_peak_bytes intentionally omitted — column dropped in 081.
      db_queries: counters.db_queries,
      egress_bytes: 0,
      proposed_actions: proposalsToPersist,
      run_mode: runModeUsed,
    });
  } catch (err) {
    logger.error('plugin_run_finalize_failed', { runId, error: err.message });
  }

  // ---------------------------------------------------------------------------
  // AUTONOMOUS AUTO-APPLY (migration 167). When an org owner/admin has set the
  // plugin's run_mode to 'autonomous', a SUCCESSFUL run's proposals are applied
  // immediately — through pluginActions.applyRunProposals, the EXACT commit
  // machinery POST /api/plugins/:id/apply uses (same server-side proposal load,
  // same allowlist re-validation, same org-scoped transaction + applied_at
  // guard). There is deliberately no second write path: the sandbox still ran
  // in the confirm-first capture posture with every cap enforced (query/task
  // budgets, wall clock); only the Apply step is automated. Failed / partial
  // runs never reach here because proposalsToPersist is null unless
  // status === 'success' — so a half-computed proposal set is never committed.
  // An auto-apply failure leaves the proposals pending on the run row for a
  // human to Apply from the runs UI; the run itself still reports success.
  // ---------------------------------------------------------------------------
  let autoApply = null;
  if (runModeUsed === 'autonomous' && status === 'success' && proposalsToPersist) {
    try {
      const outcome = await pluginActions.applyRunProposals({
        runId, pluginId, orgId, appliedBy: userId || null,
      });
      if (outcome.ok) {
        autoApply = { applied: true, result: outcome.result };
        // Same per-write audit granularity as the human Apply endpoint, with
        // autonomous:true so forensics can tell the two apart.
        for (const a of outcome.result.applied) {
          if (!a.ok) continue;
          audit.record({
            event: audit.EVENTS.PLUGIN_ACTION_APPLIED,
            actorUserId: userId, orgId,
            targetType: a.entity, targetId: a.target_id,
            success: true,
            meta: { runId, plugin_id: pluginId, op: a.op, autonomous: true },
          }).catch(() => {});
        }
      } else {
        autoApply = { applied: false, error: outcome.error, code: outcome.code || null };
        logger.warn('plugin_autonomous_apply_rejected', {
          runId, pluginId, orgId, error: outcome.error, code: outcome.code,
        });
      }
    } catch (err) {
      autoApply = { applied: false, error: err.message };
      logger.error('plugin_autonomous_apply_failed', { runId, pluginId, orgId, error: err.message });
    }
  }

  // Meter the run for billing. Fire-and-forget; meter failures are logged
  // but don't break the response.
  usageMeter.increment(orgId, 'plugin_runs', 1, 0).catch(() => {});
  usageMeter.increment(orgId, 'plugin_run_ms', elapsedMs, 0).catch(() => {});

  // Audit-log every run (success and failure).
  audit.record({
    event: audit.EVENTS.PLUGIN_RUN,
    actorUserId: userId,
    orgId,
    targetType: 'plugin',
    targetId: pluginId,
    success: status === 'success',
    meta: {
      runId,
      status,
      triggerSource,
      cpu_ms: elapsedMs,
      db_queries: counters.db_queries,
      log_lines: logBuffer.length,
      error: errorMessage,
      run_mode: runModeUsed,
      ...(autoApply ? { auto_applied: autoApply.applied, auto_applied_count: autoApply.result ? autoApply.result.applied_count : 0 } : {}),
    },
  }).catch(() => {});

  return {
    ok: status === 'success',
    status,
    runId,
    output,
    logs: logBuffer,
    error: errorMessage,
    cpu_ms: elapsedMs,
    db_queries: counters.db_queries,
    mode,
    // The posture that governed this run: 'preview' | 'autonomous' | 'commit'
    // (null when the run was rejected before the plugin row loaded).
    run_mode: runModeUsed,
    // Autonomous auto-apply outcome. Null unless run_mode='autonomous' AND
    // the run succeeded with proposals: { applied: true, result } on commit,
    // { applied: false, error, code? } when the apply was rejected/failed
    // (proposals stay pending for a human Apply).
    auto_apply: autoApply,
    // Confirm-first proposals the caller can Apply. Always an array so the
    // client can `.length` it unconditionally. Empty for read-only runs, for
    // 'commit' mode, and for runs that didn't finish successfully.
    proposed_actions: proposalsToPersist || [],
  };
}

module.exports = {
  run,
  PluginRuntimeUnavailable,
  PluginWallClockExceeded,
  // Exposed for tests + admin inspection. Do not use in routes.
  _internal: {
    MEMORY_LIMIT_MB,
    COMPILE_TIMEOUT_MS,
    RUN_TIMEOUT_MS,
    HARD_WALL_CLOCK_MS,
    MAX_CONCURRENT_RUNS_PER_ORG,
    concurrentRunsByOrg,
    isSandboxAvailable: () => Boolean(ivm),
  },
};
