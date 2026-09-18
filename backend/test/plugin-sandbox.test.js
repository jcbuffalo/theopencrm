// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Smoke tests for the plugin sandbox v3 hardening pass.
//
// We exercise:
//   1. pluginSdk's per-run query budget (chargeQuery → PluginQueryBudgetExceeded)
//   2. pluginSdk's per-run createTask budget (chargeTask → PluginTaskBudgetExceeded)
//   3. pluginRunner's per-org concurrent-run cap (rejects the 6th)
//   4. pluginRoutes' secret-pattern scanner (warns on hex / sk_live / Bearer)
//
// The SDK tests use a mocked pool.connect that returns a stub client so we
// don't need a real PostgreSQL — and so we can verify the SET LOCAL
// statement_timeout transaction wrapping behaviour.

// describe / test / expect / beforeEach / vi are global.

// ---------------------------------------------------------------------------
// Pool mock. The new SDK wraps every query in pool.connect() + BEGIN +
// SET LOCAL statement_timeout + the real query + COMMIT, so we mock
// connect() to return a stub client whose query() records what was asked.
// ---------------------------------------------------------------------------

const clientQueryCalls = [];
function makeStubClient(rowsForQuery) {
  return {
    query: vi.fn().mockImplementation((sql, params) => {
      clientQueryCalls.push({ sql, params });
      // BEGIN / COMMIT / ROLLBACK / SET LOCAL all return an empty result.
      if (/^BEGIN|^COMMIT|^ROLLBACK|^SET LOCAL/i.test(String(sql).trim())) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return Promise.resolve(rowsForQuery || { rows: [{ id: 1 }], rowCount: 1 });
    }),
    release: vi.fn(),
  };
}

// See auth.test.js — patch the live pool instance instead of vi.mock'ing.
const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

// Patch downstream live exports so audit + usage + quota + logger calls
// inside pluginRunner.run() don't issue DB writes during the test.
const audit = require('../services/audit');
audit.record  = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

const usageMeter = require('../services/usageMeter');
usageMeter.increment     = vi.fn().mockResolvedValue(null);
usageMeter.recordAiUsage = vi.fn().mockResolvedValue(null);

const logger = require('../services/logger');
logger.info  = vi.fn();
logger.warn  = vi.fn();
logger.error = vi.fn();
logger.notice = vi.fn();
logger.debug = vi.fn();

const pluginSdk = require('../services/pluginSdk');

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  clientQueryCalls.length = 0;
});

// ===========================================================================
// 1. Per-run query budget
// ===========================================================================
describe('pluginSdk — per-run DB query budget', () => {
  test('throws PluginQueryBudgetExceeded on the 51st call', async () => {
    // Every connect() returns a fresh stub client; the SDK calls
    // BEGIN+SET LOCAL+SELECT+COMMIT per query.
    mockPool.connect.mockImplementation(() => Promise.resolve(makeStubClient()));

    const counters = { db_queries: 0, tasks_created: 0 };
    const ctx = pluginSdk.buildContext({ orgId: 1, logBuffer: [], counters });

    // First 50 listContacts calls succeed.
    for (let i = 0; i < pluginSdk.MAX_QUERIES_PER_RUN; i++) {
      await ctx.listContacts({});
    }
    expect(counters.db_queries).toBe(pluginSdk.MAX_QUERIES_PER_RUN);

    // The 51st must throw a PluginQueryBudgetExceeded.
    let thrown = null;
    try { await ctx.listContacts({}); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(pluginSdk.PluginQueryBudgetExceeded);
    expect(thrown.code).toBe('PLUGIN_QUERY_BUDGET_EXCEEDED');
    // Counter reflects the over-budget attempt — important for forensics.
    expect(counters.db_queries).toBe(pluginSdk.MAX_QUERIES_PER_RUN + 1);
  });

  test('wraps each SDK query in BEGIN + SET LOCAL statement_timeout + COMMIT', async () => {
    mockPool.connect.mockImplementation(() => Promise.resolve(makeStubClient()));
    const ctx = pluginSdk.buildContext({ orgId: 1, logBuffer: [], counters: { db_queries: 0, tasks_created: 0 } });
    await ctx.listDeals({});
    // Expect exactly: BEGIN, SET LOCAL statement_timeout = '2s', SELECT ..., COMMIT
    const stmts = clientQueryCalls.map(c => String(c.sql).trim().split('\n')[0]);
    expect(stmts[0]).toMatch(/^BEGIN/i);
    expect(stmts[1]).toMatch(/^SET LOCAL statement_timeout = '2s'/i);
    expect(stmts[2]).toMatch(/^SELECT/i);
    expect(stmts[3]).toMatch(/^COMMIT/i);
  });
});

// ===========================================================================
// 2. Per-run createTask sub-budget
// ===========================================================================
describe('pluginSdk — per-run createTask budget', () => {
  test('throws PluginTaskBudgetExceeded on the 11th createTask call', async () => {
    mockPool.connect.mockImplementation(() => Promise.resolve(makeStubClient()));
    const counters = { db_queries: 0, tasks_created: 0 };
    const ctx = pluginSdk.buildContext({ orgId: 1, logBuffer: [], counters });

    for (let i = 0; i < pluginSdk.MAX_TASKS_CREATED_PER_RUN; i++) {
      await ctx.createTask({ title: `t${i}` });
    }
    expect(counters.tasks_created).toBe(pluginSdk.MAX_TASKS_CREATED_PER_RUN);

    let thrown = null;
    try { await ctx.createTask({ title: 'overflow' }); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(pluginSdk.PluginTaskBudgetExceeded);
    expect(thrown.code).toBe('PLUGIN_TASK_BUDGET_EXCEEDED');
    expect(counters.tasks_created).toBe(pluginSdk.MAX_TASKS_CREATED_PER_RUN + 1);
  });

  test('task budget trips BEFORE the query counter is consumed on the rejected call', async () => {
    // Verifies that the 11th createTask doesn't waste a query-budget slot.
    mockPool.connect.mockImplementation(() => Promise.resolve(makeStubClient()));
    const counters = { db_queries: 0, tasks_created: 0 };
    const ctx = pluginSdk.buildContext({ orgId: 1, logBuffer: [], counters });

    // Fill the task budget exactly.
    for (let i = 0; i < pluginSdk.MAX_TASKS_CREATED_PER_RUN; i++) {
      await ctx.createTask({ title: `t${i}` });
    }
    const dbQueriesBefore = counters.db_queries;
    try { await ctx.createTask({ title: 'overflow' }); } catch { /* expected */ }
    // task counter ticked, db_queries did NOT — chargeTask runs first and
    // throws before chargeQuery has a chance to fire.
    expect(counters.db_queries).toBe(dbQueriesBefore);
  });
});

// ===========================================================================
// 3. Read column allowlist
// ===========================================================================
describe('pluginSdk — read column allowlist', () => {
  test('uses the allowed-column projection rather than SELECT *', async () => {
    mockPool.connect.mockImplementation(() => Promise.resolve(makeStubClient()));
    const ctx = pluginSdk.buildContext({ orgId: 1, logBuffer: [], counters: { db_queries: 0, tasks_created: 0 } });
    await ctx.listDeals({});
    const selectCall = clientQueryCalls.find(c => /^\s*SELECT/i.test(String(c.sql)));
    expect(selectCall).toBeTruthy();
    expect(selectCall.sql).not.toMatch(/SELECT \*/);
    // Spot-check: the dealings allowlist should include the stage column.
    expect(selectCall.sql).toMatch(/\bstage\b/);
  });
});

// ===========================================================================
// 4. Concurrent-run cap
// ===========================================================================
describe('pluginRunner — concurrent runs per org', () => {
  test('rejects the 6th in-flight run for an org', async () => {
    const pluginRunner = require('../services/pluginRunner');
    const { MAX_CONCURRENT_RUNS_PER_ORG, concurrentRunsByOrg } = pluginRunner._internal;

    // Simulate 5 in-flight runs for org 7 by manipulating the in-memory map.
    concurrentRunsByOrg.set(7, MAX_CONCURRENT_RUNS_PER_ORG);

    // createRunRow + finalizeRun both call pool.query directly (not via
    // pool.connect — pluginRunner doesn't use the per-statement timeout
    // transaction). Stub them so the rejection path doesn't blow up.
    mockPool.query.mockResolvedValue({ rows: [{ id: 9999 }], rowCount: 1 });

    const result = await pluginRunner.run({
      pluginId: 1,
      orgId: 7,
      userId: 1,
      triggerKind: 'test_run',
      triggerSource: 'manual',
      triggerData: null,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('concurrent_limit_exceeded');
    expect(result.reason).toBe('concurrent_limit_exceeded');

    // Cleanup so this test doesn't leak counter state to a future run.
    concurrentRunsByOrg.delete(7);
  });
});

// ===========================================================================
// 5. Secret-pattern scanner (routes/pluginRoutes.js → scanForSecretWarnings)
// ===========================================================================
describe('pluginRoutes — scanForSecretWarnings', () => {
  // Imported via the underscored test-only export.
  const pluginRoutes = require('../routes/pluginRoutes');
  const scan = pluginRoutes._scanForSecretWarnings;

  test('warns on a 40+ char hex literal on its own line', () => {
    // The regex anchors the line — quoted or unquoted, optionally trailing
    // with a comma/semicolon. The hex literal itself must be on its own line
    // (any leading whitespace + optional quote is fine). This is the shape
    // of an API key carelessly pasted into source.
    const src = `\n  "${'a'.repeat(48)}",\n`;
    const warnings = scan(src);
    expect(warnings).toContain('code-may-contain-secrets');
  });

  test('warns on a Stripe sk_live key', () => {
    const src = 'const STRIPE = "sk_live_abc123def456ghi789jkl";';
    expect(scan(src)).toContain('code-may-contain-secrets');
  });

  test('warns on a Bearer token literal', () => {
    const src = 'const auth = "Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop";';
    expect(scan(src)).toContain('code-may-contain-secrets');
  });

  test('does not warn on ordinary plugin code', () => {
    const src = `
async function run({ crm }) {
  const deals = await crm.listDeals({ stage: 'OPEN' });
  for (const d of deals) {
    await crm.createTask({ title: 'Follow up on ' + d.title });
  }
}
module.exports = { run };
    `;
    expect(scan(src)).toEqual([]);
  });

  test('returns empty array for falsy / non-string input', () => {
    expect(scan(null)).toEqual([]);
    expect(scan(undefined)).toEqual([]);
    expect(scan(42)).toEqual([]);
  });
});
