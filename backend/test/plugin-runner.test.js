// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// End-to-end tests for backend/services/pluginRunner.js.
//
// Strategy (per the test-agent brief):
//   • Use the REAL isolated-vm — don't mock it. Each test ships a tiny inline
//     plugin script that exercises exactly one branch of the runner.
//   • Stub the pg pool at the live-module level (see auth.test.js / the
//     existing plugin-sandbox.test.js for the same pattern). pool.query is
//     routed by SQL pattern so different stages (quota lookup, plugin load,
//     run row insert, finalize) get different canned responses.
//   • Stub audit / usageMeter / logger so they don't issue DB writes during
//     the test.
//
// Coverage target: lift pluginRunner.run() from ~41% to ≥70% by exercising
// the isolate-spin-up → compile → bridge SDK in → run → finalize → release
// concurrency-slot loop that the previous test agent skipped.

// describe / test / expect / beforeEach / vi are global — see vitest.config.js.

// ---------------------------------------------------------------------------
// Live-module pool stub. Same approach as test/auth.test.js: db.js exports
// the pool instance itself, so we overwrite query/connect on the live object
// rather than vi.mock()'ing the module.
// ---------------------------------------------------------------------------
const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

// Audit + usage meter + logger — these would otherwise hit the DB or spam
// stderr on every run.
const audit = require('../services/audit');
audit.record = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();
// Defensive: pluginRunner imports audit.EVENTS, make sure it's there.
if (!audit.EVENTS) audit.EVENTS = { PLUGIN_RUN: 'plugin.run' };

const usageMeter = require('../services/usageMeter');
usageMeter.increment = vi.fn().mockResolvedValue(null);
usageMeter.recordAiUsage = vi.fn().mockResolvedValue(null);

const logger = require('../services/logger');
logger.info = vi.fn();
logger.warn = vi.fn();
logger.error = vi.fn();
logger.notice = vi.fn();
logger.debug = vi.fn();

// quotaEnforcer — we want most tests to bypass the quota check. The runner
// calls getOrgTier() then checks TIER_QUOTAS. We stub getOrgTier to return
// 'enterprise' (Infinity cap → unmetered) so the check short-circuits before
// any DB lookup.
const quotaEnforcer = require('../services/quotaEnforcer');
const origGetOrgTier = quotaEnforcer.getOrgTier;
quotaEnforcer.getOrgTier = vi.fn().mockResolvedValue('enterprise');

const pluginRunner = require('../services/pluginRunner');

// ---------------------------------------------------------------------------
// pool.query router. Most tests just need:
//   1. A plugin row (the SELECT against `plugins`)
//   2. createRunRow returns an id (INSERT INTO plugin_runs)
//   3. finalizeRun captures the UPDATE so we can assert on its fields
//
// The router below handles each SQL shape. Override pluginRow in beforeEach
// to vary the source_code per test. lastFinalizeUpdate captures the params
// passed to finalizeRun so tests can assert on status / output_payload /
// log_lines without instrumenting the runner.
// ---------------------------------------------------------------------------
let pluginRow = null;
let createdRunIdCounter = 0;
let lastFinalizeUpdate = null;
let allFinalizeUpdates = [];

function defaultPoolQueryImpl(sql, params) {
  const text = String(sql).trim();
  // organizations tier lookup — should not be hit because we stub getOrgTier,
  // but be defensive.
  if (/FROM organizations/i.test(text)) {
    return Promise.resolve({ rows: [{ tier: 'enterprise' }], rowCount: 1 });
  }
  // monthly plugin_runs count — also unreachable when tier=enterprise.
  if (/COUNT\(\*\)/i.test(text) && /plugin_runs/i.test(text)) {
    return Promise.resolve({ rows: [{ c: 0 }], rowCount: 1 });
  }
  // plugin load
  if (/FROM plugins/i.test(text)) {
    return Promise.resolve({
      rows: pluginRow ? [pluginRow] : [],
      rowCount: pluginRow ? 1 : 0,
    });
  }
  // createRunRow
  if (/INSERT INTO plugin_runs/i.test(text)) {
    createdRunIdCounter += 1;
    return Promise.resolve({ rows: [{ id: createdRunIdCounter }], rowCount: 1 });
  }
  // finalizeRun — migration 081 dropped memory_peak_bytes; migration 113 added
  // proposed_actions (bound at $9); migration 167 added run_mode (bound at
  // $10, pushing runId to $11). If a future migration adds a new column be
  // sure to bump the indices below to match.
  if (/UPDATE plugin_runs/i.test(text) && /SET ended_at/i.test(text)) {
    const update = {
      status: params[0],
      error_message: params[1],
      result_summary: params[2],
      output_payload: params[3] ? JSON.parse(params[3]) : null,
      log_lines: params[4],
      cpu_ms: params[5],
      db_queries: params[6],
      egress_bytes: params[7],
      proposed_actions: params[8] ? JSON.parse(params[8]) : null,
      run_mode: params[9],
      runId: params[10],
    };
    lastFinalizeUpdate = update;
    allFinalizeUpdates.push(update);
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  // Fallback — return empty so untracked SQL doesn't crash.
  return Promise.resolve({ rows: [], rowCount: 0 });
}

// SDK-bound queries go through pool.connect() + BEGIN + SET LOCAL + SELECT +
// COMMIT. Make connect() yield a stub client whose query handler honors
// the same routing (so a plugin's crm.getDeal(42) eventually returns rows
// from `sdkRowsByMatcher`).
let sdkRowsByMatcher = []; // array of { match: RegExp, rows: any[] }
let sdkClientCalls = [];

function makeSdkClient() {
  return {
    query: vi.fn().mockImplementation((sql, params) => {
      sdkClientCalls.push({ sql: String(sql), params });
      const text = String(sql).trim();
      if (/^BEGIN|^COMMIT|^ROLLBACK|^SET LOCAL/i.test(text)) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      for (const m of sdkRowsByMatcher) {
        if (m.match.test(text)) {
          return Promise.resolve({ rows: m.rows, rowCount: m.rows.length });
        }
      }
      // default — empty result
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release: vi.fn(),
  };
}

beforeEach(() => {
  pluginRow = null;
  createdRunIdCounter = 0;
  lastFinalizeUpdate = null;
  allFinalizeUpdates = [];
  sdkRowsByMatcher = [];
  sdkClientCalls = [];
  mockPool.query.mockReset();
  mockPool.query.mockImplementation(defaultPoolQueryImpl);
  mockPool.connect.mockReset();
  mockPool.connect.mockImplementation(() => Promise.resolve(makeSdkClient()));
  quotaEnforcer.getOrgTier.mockReset();
  quotaEnforcer.getOrgTier.mockResolvedValue('enterprise');
  // Drain any leftover concurrent-run counters from previous tests so the
  // 5-cap doesn't bleed across describes.
  pluginRunner._internal.concurrentRunsByOrg.clear();
});

afterAll(() => {
  // Restore quotaEnforcer to avoid breaking other test files that share the
  // module instance.
  quotaEnforcer.getOrgTier = origGetOrgTier;
});

function setPlugin(sourceCode, opts = {}) {
  pluginRow = {
    id: opts.id || 100,
    name: opts.name || 'test-plugin',
    status: opts.status || 'active',
    source_code: sourceCode,
    spec_json: opts.spec_json || null,
    run_mode: opts.run_mode || 'preview',
  };
}

// Skip the entire suite if isolated-vm isn't available on this machine —
// the brief says "iso-vm works in the test environment", but if a contributor
// runs this on a box where the native build failed we should skip cleanly
// rather than emit a wall of red.
const sandboxAvailable = pluginRunner._internal.isSandboxAvailable();
const describeIfSandbox = sandboxAvailable ? describe : describe.skip;

// =============================================================================
// 1. Happy path
// =============================================================================
describeIfSandbox('pluginRunner.run — happy path', () => {
  test('returns the plugin output and records status=success', async () => {
    setPlugin(`globalThis.__pluginResult = 42;`);

    const result = await pluginRunner.run({
      pluginId: 100,
      orgId: 1,
      userId: 7,
      triggerKind: 'test_run',
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('success');
    expect(result.output).toBe(42);
    expect(result.runId).toBe(createdRunIdCounter);
    // finalizeRun row should reflect success and the output payload.
    expect(lastFinalizeUpdate).toBeTruthy();
    expect(lastFinalizeUpdate.status).toBe('success');
    expect(lastFinalizeUpdate.output_payload).toBe(42);
  });

  test('supports module.exports.run({ crm, input }) style', async () => {
    setPlugin(`module.exports = { run: async ({ input }) => input.x * 2 };`);
    const result = await pluginRunner.run(100, { x: 21 }, { orgId: 1, userId: 7 });
    expect(result.ok).toBe(true);
    expect(result.output).toBe(42);
  });
});

// =============================================================================
// 2. Plugin throws inside the isolate
// =============================================================================
describeIfSandbox('pluginRunner.run — error classification', () => {
  test('captures a thrown error as status=error', async () => {
    setPlugin(`throw new Error('boom');`);

    const result = await pluginRunner.run({ pluginId: 100, orgId: 1 });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/boom/);
    expect(lastFinalizeUpdate.status).toBe('error');
    expect(lastFinalizeUpdate.error_message).toMatch(/boom/);
  });
});

// =============================================================================
// 3. Wall-clock timeout
// =============================================================================
describeIfSandbox('pluginRunner.run — timeout', () => {
  test('classifies an infinite loop as status=timeout', async () => {
    setPlugin(`while (true) {}`);

    const result = await pluginRunner.run({ pluginId: 100, orgId: 1 });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('timeout');
    expect(lastFinalizeUpdate.status).toBe('timeout');
    // The 5s wall clock is enforced by the runner — assert it doesn't take
    // appreciably longer than that. We give 2s of headroom for slow CI.
    expect(result.cpu_ms).toBeLessThan(7000);
  }, 15000);
});

// =============================================================================
// 4. Memory limit (best-effort — flaky on some platforms)
// =============================================================================
describeIfSandbox('pluginRunner.run — memory limit', () => {
  // The isolated-vm 128MB cap can manifest as either a memory_exceeded error
  // (the "we hit the cap" path) OR as the isolate being killed mid-allocation,
  // which the runner classifies as 'killed' instead. Both are acceptable —
  // what matters is that the runner doesn't return success for a plugin that
  // tries to allocate more than the configured limit. The test asserts on
  // that weaker invariant to stay non-flaky.
  test('rejects a plugin that exceeds the 128 MB cap', async () => {
    // Allocate ~256 MB of strings. The exact threshold at which iso-vm
    // throws depends on v8's heap accounting; 256 MB is well above the
    // 128 MB cap so we should reliably trip something.
    setPlugin(`
      const big = [];
      try {
        while (true) {
          // 8 MB of UTF-16 chars per push.
          big.push('x'.repeat(4 * 1024 * 1024));
        }
      } catch (e) {
        // Re-throw so the runner sees the failure rather than a clean exit.
        throw e;
      }
    `);

    const result = await pluginRunner.run({ pluginId: 100, orgId: 1 });

    expect(result.ok).toBe(false);
    // Accept any of these non-success statuses — see comment above for why
    // we don't pin to 'memory_exceeded' specifically.
    expect(['memory_exceeded', 'killed', 'error', 'timeout']).toContain(result.status);
  }, 15000);
});

// =============================================================================
// 5. crm.log() populates log_lines
// =============================================================================
describeIfSandbox('pluginRunner.run — crm.log buffer', () => {
  test('captures three log lines in the finalize row', async () => {
    setPlugin(`
      crm.log('hello');
      crm.log('world');
      crm.log('again');
      globalThis.__pluginResult = 'done';
    `);

    const result = await pluginRunner.run({ pluginId: 100, orgId: 1 });

    expect(result.ok).toBe(true);
    expect(result.logs).toEqual(['hello', 'world', 'again']);
    expect(lastFinalizeUpdate.log_lines).toEqual(['hello', 'world', 'again']);
  });
});

// =============================================================================
// 6. crm.getDeal flows through the SDK, scoped to org
// =============================================================================
describeIfSandbox('pluginRunner.run — crm.getDeal SDK bridge', () => {
  test('queries are scoped to the test orgId', async () => {
    setPlugin(`
      module.exports = { run: async () => {
        const d = await crm.getDeal(42);
        return d;
      }};
    `);
    // The SDK's getOne(table, id) issues: SELECT <cols> FROM deals WHERE id = $1 AND org_id = $2
    sdkRowsByMatcher.push({
      match: /SELECT .+ FROM deals/i,
      rows: [{ id: 42, title: 'big deal', stage: 'OPEN' }],
    });

    const result = await pluginRunner.run(100, null, { orgId: 9 });

    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ id: 42, title: 'big deal', stage: 'OPEN' });
    // Find the SELECT call and verify the org_id param was 9.
    const selectCall = sdkClientCalls.find(c => /^\s*SELECT/i.test(c.sql) && /FROM deals/i.test(c.sql));
    expect(selectCall).toBeTruthy();
    // Params: [id, orgId]
    expect(selectCall.params).toEqual([42, 9]);
  });
});

// =============================================================================
// 7. crm.updateDeal rejects fields outside the allowlist
// =============================================================================
describeIfSandbox('pluginRunner.run — updateDeal allowlist', () => {
  test('throws inside the isolate when no allowed fields are present', async () => {
    setPlugin(`
      module.exports = { run: async () => {
        await crm.updateDeal(1, { secret_field: 'x', not_allowed: 9 });
        return 'unreachable';
      }};
    `);
    // SDK won't actually issue UPDATE because sanitizePatch throws before
    // chargeQuery — but we still leave a sensible default. No matcher needed.

    const result = await pluginRunner.run(100, null, { orgId: 1 });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('error');
    // The SDK throws "No allowed fields in patch. Allowed for deals: ..."
    expect(result.error).toMatch(/allowed fields|allowlist|Allowed for deals/i);
  });
});

// =============================================================================
// 8. Query budget exceeded
// =============================================================================
describeIfSandbox('pluginRunner.run — query budget', () => {
  test('classifies 51 list calls as query_budget_exceeded', async () => {
    setPlugin(`
      module.exports = { run: async () => {
        for (let i = 0; i < 51; i++) {
          await crm.listDeals({});
        }
        return 'done';
      }};
    `);
    sdkRowsByMatcher.push({ match: /SELECT .+ FROM deals/i, rows: [] });

    const result = await pluginRunner.run(100, null, { orgId: 1 });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('query_budget_exceeded');
    expect(lastFinalizeUpdate.status).toBe('query_budget_exceeded');
  }, 15000);
});

// =============================================================================
// 9. Task budget exceeded
// =============================================================================
describeIfSandbox('pluginRunner.run — task budget', () => {
  test('classifies 11 createTask calls as task_budget_exceeded', async () => {
    setPlugin(`
      module.exports = { run: async () => {
        for (let i = 0; i < 11; i++) {
          await crm.createTask({ title: 'task-' + i });
        }
        return 'done';
      }};
    `);
    // createTask issues INSERT INTO tasks ... RETURNING *. The runner only
    // cares that we don't blow up; rows can be empty.
    sdkRowsByMatcher.push({ match: /INSERT INTO tasks/i, rows: [{ id: 1, title: 'task' }] });

    const result = await pluginRunner.run(100, null, { orgId: 1 });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('task_budget_exceeded');
    expect(lastFinalizeUpdate.status).toBe('task_budget_exceeded');
  });
});

// =============================================================================
// 10. Concurrent-run cap
// =============================================================================
describeIfSandbox('pluginRunner.run — concurrent-run cap', () => {
  test('rejects the 6th in-flight run with status=concurrent_limit_exceeded', async () => {
    const { MAX_CONCURRENT_RUNS_PER_ORG, concurrentRunsByOrg } = pluginRunner._internal;
    // Simulate the cap being saturated. (We don't actually start 5 long-
    // running isolates because they'd add seconds to the test; the runner's
    // rejection logic only reads the counter, so manipulating it directly
    // tests the same code path.)
    concurrentRunsByOrg.set(13, MAX_CONCURRENT_RUNS_PER_ORG);

    setPlugin(`globalThis.__pluginResult = 'should not run';`);
    const result = await pluginRunner.run({ pluginId: 100, orgId: 13 });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('concurrent_limit_exceeded');
    expect(result.reason).toBe('concurrent_limit_exceeded');
    // The plugin row was NOT loaded — rejection happens before the isolate
    // spin-up, so no SELECT FROM plugins call should have been issued.
    const pluginSelect = mockPool.query.mock.calls.find(
      ([sql]) => /FROM plugins/i.test(String(sql))
    );
    expect(pluginSelect).toBeUndefined();
  });
});

// =============================================================================
// 11. Concurrency slot decrement after success / failure
// =============================================================================
describeIfSandbox('pluginRunner.run — concurrency slot lifecycle', () => {
  test('decrements the slot after a successful run', async () => {
    const { concurrentRunsByOrg } = pluginRunner._internal;
    setPlugin(`globalThis.__pluginResult = 1;`);

    expect(concurrentRunsByOrg.get(21) || 0).toBe(0);
    await pluginRunner.run({ pluginId: 100, orgId: 21 });
    expect(concurrentRunsByOrg.get(21) || 0).toBe(0);
  });

  test('decrements the slot after a failed run', async () => {
    const { concurrentRunsByOrg } = pluginRunner._internal;
    setPlugin(`throw new Error('boom');`);

    expect(concurrentRunsByOrg.get(22) || 0).toBe(0);
    await pluginRunner.run({ pluginId: 100, orgId: 22 });
    expect(concurrentRunsByOrg.get(22) || 0).toBe(0);
  });

  test('after 5 sequential runs the 6th still succeeds (slot was released each time)', async () => {
    setPlugin(`globalThis.__pluginResult = 'ok';`);
    for (let i = 0; i < 5; i++) {
      const r = await pluginRunner.run({ pluginId: 100, orgId: 23 });
      expect(r.ok).toBe(true);
    }
    // 6th run — would be rejected if the slot leaked.
    const sixth = await pluginRunner.run({ pluginId: 100, orgId: 23 });
    expect(sixth.ok).toBe(true);
    expect(sixth.status).toBe('success');
  });
});

// =============================================================================
// 12. Globals are missing
// =============================================================================
describeIfSandbox('pluginRunner.run — isolate has no dangerous globals', () => {
  test('fetch / process / require / setTimeout / console are all undefined', async () => {
    setPlugin(`
      globalThis.__pluginResult = {
        fetch:        typeof fetch,
        process:      typeof process,
        require:      typeof require,
        setTimeout:   typeof setTimeout,
        setInterval:  typeof setInterval,
        setImmediate: typeof setImmediate,
        console:      typeof console,
        Buffer:       typeof Buffer,
        XMLHttpRequest: typeof XMLHttpRequest,
        WebSocket:    typeof WebSocket,
        // Sanity check that legit language globals are still around.
        Math:         typeof Math,
        JSON:         typeof JSON,
        Promise:      typeof Promise,
      };
    `);

    const result = await pluginRunner.run({ pluginId: 100, orgId: 1 });

    expect(result.ok).toBe(true);
    expect(result.output.fetch).toBe('undefined');
    expect(result.output.process).toBe('undefined');
    expect(result.output.require).toBe('undefined');
    expect(result.output.setTimeout).toBe('undefined');
    expect(result.output.setInterval).toBe('undefined');
    expect(result.output.setImmediate).toBe('undefined');
    expect(result.output.console).toBe('undefined');
    expect(result.output.Buffer).toBe('undefined');
    expect(result.output.XMLHttpRequest).toBe('undefined');
    expect(result.output.WebSocket).toBe('undefined');
    // Sanity — the language surface plugins legitimately use is still here.
    expect(result.output.Math).toBe('object');
    expect(result.output.JSON).toBe('object');
    expect(result.output.Promise).toBe('function');
  });
});

// =============================================================================
// 13. Quota exceeded
// =============================================================================
describeIfSandbox('pluginRunner.run — quota enforcement', () => {
  test('rejects with status=quota_exceeded BEFORE the isolate is created', async () => {
    // Switch the org to a tier with a hard cap and pretend the cap is used up.
    quotaEnforcer.getOrgTier.mockResolvedValue('free'); // free → 100 plugin_runs / month
    // The runner calls getOrgRunsThisMonth, which fires a SELECT COUNT(*) ...
    // Hijack that branch in our pool.query router to return >= the cap.
    mockPool.query.mockImplementation((sql, params) => {
      const text = String(sql).trim();
      if (/COUNT\(\*\)/i.test(text) && /plugin_runs/i.test(text)) {
        return Promise.resolve({ rows: [{ c: 999 }], rowCount: 1 });
      }
      return defaultPoolQueryImpl(sql, params);
    });

    setPlugin(`globalThis.__pluginResult = 'should not get here';`);
    const result = await pluginRunner.run({ pluginId: 100, orgId: 1 });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('quota_exceeded');
    expect(result.reason).toBe('quota_exceeded');
    // The plugin SELECT should NOT have run — quota check is before plugin load.
    const pluginSelect = mockPool.query.mock.calls.find(
      ([sql]) => /FROM plugins/i.test(String(sql))
    );
    expect(pluginSelect).toBeUndefined();
  });
});

// =============================================================================
// 14. Rejection branches: bad args, runtime disabled, plugin not found,
//     plugin suspended, plugin has no source code
// =============================================================================
describeIfSandbox('pluginRunner.run — rejection branches', () => {
  test('returns bad_args when pluginId or orgId is not an integer', async () => {
    const result = await pluginRunner.run({ pluginId: 'oops', orgId: 'nope' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('bad_args');
  });

  test('returns runtime_disabled when PLUGIN_RUNTIME_DISABLED=1', async () => {
    process.env.PLUGIN_RUNTIME_DISABLED = '1';
    try {
      const result = await pluginRunner.run({ pluginId: 100, orgId: 1 });
      expect(result.ok).toBe(false);
      expect(result.status).toBe('rejected');
      expect(result.reason).toBe('runtime_disabled');
    } finally {
      delete process.env.PLUGIN_RUNTIME_DISABLED;
    }
  });

  test('returns plugin_not_found when the plugins row is missing for this org', async () => {
    pluginRow = null; // explicit
    const result = await pluginRunner.run({ pluginId: 100, orgId: 1 });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('plugin_not_found');
  });

  test('returns rejected when the plugin is suspended', async () => {
    setPlugin(`globalThis.__pluginResult = 1;`, { status: 'suspended' });
    const result = await pluginRunner.run({ pluginId: 100, orgId: 1 });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('plugin_status_is_suspended');
  });

  test('returns rejected when the plugin has empty source_code', async () => {
    setPlugin('   ', {}); // whitespace-only source
    const result = await pluginRunner.run({ pluginId: 100, orgId: 1 });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('plugin_has_no_source_code');
  });
});

// =============================================================================
// 15. Output serialization edge case — non-serializable result becomes null
// =============================================================================
describeIfSandbox('pluginRunner.run — output serialization', () => {
  test('returns null output when the plugin sets undefined as the result', async () => {
    setPlugin(`module.exports = { run: () => undefined };`);
    const result = await pluginRunner.run({ pluginId: 100, orgId: 1 });
    expect(result.ok).toBe(true);
    // safeSerializeOutput returns null on undefined; module.exports.run path
    // converts the v=undefined into null before storing in __pluginResult.
    expect(result.output).toBeNull();
  });

  test('truncates oversized output to a preview wrapper', async () => {
    // Generate something well over MAX_OUTPUT_BYTES (64KB).
    setPlugin(`
      module.exports = { run: () => 'a'.repeat(80 * 1024) };
    `);
    const result = await pluginRunner.run({ pluginId: 100, orgId: 1 });
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({ _truncated: true });
    expect(typeof result.output.preview).toBe('string');
  });
});

// =============================================================================
// 16. CONFIRM-FIRST: preview mode captures writes as proposals, never commits.
// This is the core security guarantee — a plugin CANNOT write directly from a
// user-triggered run; its update/create calls become proposals awaiting Apply.
// =============================================================================
describeIfSandbox('pluginRunner.run — confirm-first preview (default)', () => {
  test('captures update + create as proposals and issues NO UPDATE/INSERT', async () => {
    // The before-read of the deal returns a row so the diff has a "before".
    sdkRowsByMatcher.push({ match: /SELECT .+ FROM deals/i, rows: [{ id: 5, stage: 'LEAD', amount: 100 }] });

    setPlugin(`
      module.exports = { run: async () => {
        await crm.updateDeal(5, { stage: 'QUALIFIED', amount: 250 });
        await crm.createTask({ title: 'Follow up on deal 5', deal_id: 5 });
        return 'done';
      }};
    `);

    // Default mode is 'preview' — do NOT pass mode.
    const result = await pluginRunner.run(100, null, { orgId: 1, userId: 7 });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('success');
    expect(result.mode).toBe('preview');
    // Two proposals captured: the deal update + the task create.
    expect(Array.isArray(result.proposed_actions)).toBe(true);
    expect(result.proposed_actions).toHaveLength(2);

    const update = result.proposed_actions.find(a => a.op === 'update');
    expect(update).toMatchObject({ entity: 'deal', op: 'update', table: 'deals', target_id: 5 });
    expect(update.fields).toEqual({ stage: 'QUALIFIED', amount: 250 });
    // The before-row is captured for the diff.
    expect(update.before).toMatchObject({ id: 5, stage: 'LEAD' });

    const create = result.proposed_actions.find(a => a.op === 'create');
    expect(create).toMatchObject({ entity: 'task', op: 'create', table: 'tasks' });
    expect(create.fields.title).toBe('Follow up on deal 5');

    // CRITICAL: no write SQL ever reached the DB. Only the before-read SELECT.
    const wroteUpdate = sdkClientCalls.some(c => /UPDATE\s+deals/i.test(String(c.sql)));
    const wroteInsert = sdkClientCalls.some(c => /INSERT\s+INTO\s+tasks/i.test(String(c.sql)));
    expect(wroteUpdate).toBe(false);
    expect(wroteInsert).toBe(false);

    // The proposals were persisted onto the run row (finalize captured them).
    expect(lastFinalizeUpdate.proposed_actions).toHaveLength(2);
  });

  test("commit mode DOES issue the write (legacy path, no route uses it)", async () => {
    sdkRowsByMatcher.push({ match: /UPDATE\s+deals/i, rows: [{ id: 5, stage: 'QUALIFIED' }] });
    setPlugin(`
      module.exports = { run: async () => {
        await crm.updateDeal(5, { stage: 'QUALIFIED' });
        return 'ok';
      }};
    `);
    const result = await pluginRunner.run(100, null, { orgId: 1, userId: 7, mode: 'commit' });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('commit');
    // No proposals in commit mode; the write went straight through.
    expect(result.proposed_actions).toEqual([]);
    const wroteUpdate = sdkClientCalls.some(c => /UPDATE\s+deals/i.test(String(c.sql)));
    expect(wroteUpdate).toBe(true);
  });
});
