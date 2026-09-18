// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// END-TO-END: crm.ai.complete through the REAL sandbox.
//
// The monetization chain this proves: event → pluginEvents.runTriggeredPlugin
// → pluginRunner (real isolated-vm) → prelude-bridged crm.ai.complete →
// REAL requireAiBilling.evaluateAiBilling (org row from the stub DB) → REAL
// services/ai.callClaude (mocked Anthropic wire) → REAL aiMetering.recordUsage
// → an org-attributed ai_usage_events INSERT with endpoint='plugin-run' and
// charged > 0 — while the AI text lands in the auto-applied task.
//
// Also covered:
//   • blocked billing (org halted): the SAME plugin degrades to its fallback
//     task, with NO upstream call and NO meter row — an autonomous triggered
//     run cannot bypass billing.
//   • AI unconfigured: { configured:false } fallback inside the isolate.
//   • runner-side classification of the AI-call budget (3rd call → status
//     'error' with the normalized budget message).
//   • the crm.ai.complete log line (model/tokens/charged) lands in run logs.

process.env.PLUGIN_EVENTS_IN_TESTS = 'true';

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

const audit = require('../services/audit');
audit.record = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

const usageMeter = require('../services/usageMeter');
usageMeter.increment = vi.fn().mockResolvedValue(null);
usageMeter.recordAiUsage = vi.fn().mockResolvedValue(null);

const logger = require('../services/logger');
logger.info = vi.fn();
logger.warn = vi.fn();
logger.error = vi.fn();
logger.notice = vi.fn();
logger.debug = vi.fn();

const quotaEnforcer = require('../services/quotaEnforcer');
const origGetOrgTier = quotaEnforcer.getOrgTier;
quotaEnforcer.getOrgTier = vi.fn().mockResolvedValue('enterprise');
quotaEnforcer.getSeatCount = vi.fn().mockResolvedValue(1);
quotaEnforcer.checkAiQuota = vi.fn().mockResolvedValue(null);

const featureFlags = require('../services/featureFlags');
featureFlags.hasFeature = vi.fn().mockResolvedValue(true);
featureFlags.getFeatures = vi.fn().mockResolvedValue({});

const notifications = require('../services/notifications');
notifications.create = vi.fn().mockResolvedValue({ id: 1 });

const aiModel = require('../services/aiModel');
aiModel.getOrgAiSettings = vi.fn().mockResolvedValue({ model: 'claude-sonnet-4-6', effort: 'low' });

const orgAiKeys = require('../services/orgAiKeys');
orgAiKeys.getOrgKey = vi.fn().mockResolvedValue(null); // platform-key path

const aiBilling = require('../middleware/requireAiBilling');
const pluginRunner = require('../services/pluginRunner');
const pluginEvents = require('../services/pluginEvents');

const ORG_ID = 7;
const USAGE = { input_tokens: 800, output_tokens: 120 };
const AI_TEXT = 'MOCK-AI-BRIEF: the deal looks healthy; call the buyer today.';

// ---------------------------------------------------------------------------
// pool.query router (pluginRunMode.test.js pattern) + a billing row so the
// REAL evaluateAiBilling produces a genuine verdict from "DB" state.
// ---------------------------------------------------------------------------
let pluginRow = null;
let runIdCounter = 0;
let runRows = {};
let taskInserts = [];
let billingStatus = 'active'; // organizations.ai_billing_status served to the gate

function runnerPoolQuery(sql, params) {
  const text = String(sql).trim();
  // requireAiBilling.readOrgBilling — matched BEFORE the generic organizations
  // branch so the real billing gate sees a genuine org billing row.
  if (/ai_billing_status/i.test(text) && /FROM organizations/i.test(text)) {
    return Promise.resolve({
      rows: [{
        id: params[0], ai_billing_status: billingStatus,
        ai_billing_subscription_id: null, ai_billing_trial_ends_at: null,
        ai_halted_reason: billingStatus === 'halted' ? 'admin' : null,
        updated_at: new Date(),
      }],
      rowCount: 1,
    });
  }
  if (/FROM organizations/i.test(text)) {
    return Promise.resolve({ rows: [{ tier: 'enterprise' }], rowCount: 1 });
  }
  if (/FROM admin_users/i.test(text)) {
    return Promise.resolve({ rows: [], rowCount: 0 }); // not a super-admin
  }
  if (/COUNT\(\*\)/i.test(text) && /plugin_runs/i.test(text)) {
    return Promise.resolve({ rows: [{ c: 0 }], rowCount: 1 });
  }
  if (/INSERT INTO plugin_trigger_dedupe/i.test(text)) {
    return Promise.resolve({ rows: [{ plugin_id: params[0] }], rowCount: 1 });
  }
  if (/FROM plugin_runs r/i.test(text) && /JOIN plugins p/i.test(text)) {
    const runId = params[0];
    const row = runRows[runId];
    if (!row) return Promise.resolve({ rows: [], rowCount: 0 });
    return Promise.resolve({
      rows: [{
        id: runId, plugin_id: params[1], org_id: params[2],
        status: row.status || 'success',
        proposed_actions: row.proposed_actions,
        applied_at: row.applied_at || null,
      }],
      rowCount: 1,
    });
  }
  if (/^SELECT 1 FROM (deals|contacts)/i.test(text)) {
    return Promise.resolve({ rows: [{ ok: 1 }], rowCount: 1 });
  }
  if (/FROM plugins WHERE id = \$1 AND org_id = \$2/i.test(text)) {
    return Promise.resolve({ rows: pluginRow ? [pluginRow] : [], rowCount: pluginRow ? 1 : 0 });
  }
  if (/INSERT INTO plugin_runs/i.test(text)) {
    runIdCounter += 1;
    runRows[runIdCounter] = { applied_at: null, proposed_actions: null };
    return Promise.resolve({ rows: [{ id: runIdCounter }], rowCount: 1 });
  }
  if (/UPDATE plugin_runs/i.test(text) && /SET ended_at/i.test(text)) {
    const runId = params[10];
    const row = runRows[runId] || (runRows[runId] = {});
    row.status = params[0];
    row.proposed_actions = params[8] ? JSON.parse(params[8]) : null;
    row.run_mode = params[9];
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (/UPDATE plugins/i.test(text)) {
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  // ai_usage_events INSERT + everything else: recorded via mock.calls.
  return Promise.resolve({ rows: [], rowCount: 0 });
}

function makeClient() {
  return {
    query: vi.fn().mockImplementation((sql, params) => {
      const text = String(sql).trim();
      if (/^BEGIN|^COMMIT|^ROLLBACK|^SET LOCAL/i.test(text)) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (/SELECT applied_at FROM plugin_runs/i.test(text) && /FOR UPDATE/i.test(text)) {
        const row = runRows[params[0]];
        if (!row) return Promise.resolve({ rows: [], rowCount: 0 });
        return Promise.resolve({ rows: [{ applied_at: row.applied_at || null }], rowCount: 1 });
      }
      if (/INSERT INTO tasks/i.test(text)) {
        taskInserts.push(params);
        return Promise.resolve({ rows: [{ id: 555, title: params[4] }], rowCount: 1 });
      }
      if (/UPDATE plugin_runs SET applied_at/i.test(text)) {
        const row = runRows[params[2]];
        if (row) row.applied_at = new Date();
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release: vi.fn(),
  };
}

function setPlugin(sourceCode, opts = {}) {
  pluginRow = {
    id: opts.id || 100,
    name: opts.name || 'ai-test-plugin',
    status: 'active',
    source_code: sourceCode,
    spec_json: null,
    run_mode: opts.run_mode || 'preview',
  };
}

function mockAnthropicFetch() {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: 'text', text: AI_TEXT }],
      usage: USAGE,
      model: 'claude-sonnet-4-6',
    }),
  });
}

function aiUsageInsert() {
  return mockPool.query.mock.calls.find(([sql]) => /INSERT INTO ai_usage_events/i.test(String(sql)));
}

beforeEach(() => {
  pluginRow = null;
  runIdCounter = 0;
  runRows = {};
  taskInserts = [];
  billingStatus = 'active';
  mockPool.query.mockReset();
  mockPool.query.mockImplementation(runnerPoolQuery);
  mockPool.connect.mockReset();
  mockPool.connect.mockImplementation(() => Promise.resolve(makeClient()));
  audit.record.mockClear();
  usageMeter.recordAiUsage.mockClear();
  quotaEnforcer.getOrgTier.mockReset();
  quotaEnforcer.getOrgTier.mockResolvedValue('enterprise');
  featureFlags.hasFeature.mockReset();
  featureFlags.hasFeature.mockResolvedValue(true);
  pluginRunner._internal.concurrentRunsByOrg.clear();
  // The gate caches org billing rows for 30s — reset between tests so each
  // test's billingStatus is actually consulted.
  aiBilling._resetCachesForTests();
  process.env.ANTHROPIC_API_KEY = 'platform-key-for-vitest';
  delete process.env.OPENCRM_AI_GATEWAY_KEY;
  mockAnthropicFetch();
});

afterAll(() => {
  quotaEnforcer.getOrgTier = origGetOrgTier;
  delete process.env.ANTHROPIC_API_KEY;
});

const sandboxAvailable = pluginRunner._internal.isSandboxAvailable();
const describeIfSandbox = sandboxAvailable ? describe : describe.skip;

// A library-entry-shaped plugin: AI first, real output into the task, honest
// fallback on { configured:false } / { blocked:true }.
const AI_PLUGIN_SRC = `
  module.exports = { run: async ({ crm, input }) => {
    const ai = await crm.ai.complete({ prompt: 'Summarize deal #' + (input && input.id), max_tokens: 300 });
    if (ai && ai.ok && ai.text) {
      await crm.createTask({ title: 'AI brief', description: 'AI draft:\\n' + ai.text });
      return { drafted: true, tokens: ai.tokens };
    }
    await crm.createTask({ title: 'Fallback brief', description: 'Copilot brief (paste into chat): summarize the deal.' });
    return { drafted: false, configured: ai ? ai.configured !== false : null, blocked: !!(ai && ai.blocked) };
  }};
`;

// =============================================================================
// THE END-TO-END BILLING PROOF
// =============================================================================
describeIfSandbox('triggered autonomous run — crm.ai.complete end to end', () => {
  test('event → runner → crm.ai → org-attributed meter row (endpoint=plugin-run, charged>0) + task carrying the AI text', async () => {
    setPlugin(AI_PLUGIN_SRC, { run_mode: 'autonomous' });

    const result = await pluginEvents.runTriggeredPlugin(
      { id: 100, name: 'ai-test-plugin' }, ORG_ID, 'deal.created', { id: 5 },
      { dedupeKey: 'deal.created:5', triggerKind: 'event' }
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe('success');
    expect(result.run_mode).toBe('autonomous');
    expect(result.ai_calls).toBe(1);
    expect(result.output).toMatchObject({ drafted: true, tokens: { input_tokens: 800, output_tokens: 120 } });

    // Exactly one Anthropic wire call went out.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // The task was auto-applied and carries the REAL AI output — not an
    // embedded prompt for the user to paste somewhere.
    expect(result.auto_apply).toEqual(expect.objectContaining({ applied: true }));
    expect(taskInserts.length).toBe(1);
    expect(taskInserts[0][0]).toBe(ORG_ID);                 // org-scoped insert
    expect(String(taskInserts[0][5])).toContain(AI_TEXT);   // description carries AI text

    // The metered ai_usage_events row: org-attributed, plugin endpoint,
    // charged at the platform upcharge (> 0).
    await new Promise((r) => setTimeout(r, 0)); // recordUsage is fire-and-forget
    const call = aiUsageInsert();
    expect(call).toBeTruthy();
    const p = call[1];
    expect(p[0]).toBe(ORG_ID);            // attributed to the org
    expect(p[1]).toBeNull();              // no human initiator on a triggered run
    expect(p[2]).toBe('plugin-run');      // the plugin endpoint tag
    expect(p[4]).toBe(USAGE.input_tokens);
    expect(p[5]).toBe(USAGE.output_tokens);
    expect(p[9]).toBeGreaterThan(0);      // charged (2× upcharge applied)
    expect(p[10]).toBe('platform');

    // Aggregate quota ledger counted the same org.
    expect(usageMeter.recordAiUsage).toHaveBeenCalledWith(ORG_ID, expect.objectContaining({
      inputTokens: USAGE.input_tokens,
      outputTokens: USAGE.output_tokens,
    }));

    // Per-call run-log line: model + tokens + charged, no prompt content.
    const line = (result.logs || []).find(l => l.startsWith('crm.ai.complete:'));
    expect(line).toMatch(/model=claude-sonnet-4-6/);
    expect(line).toMatch(/charged=true/);
    expect(line).not.toMatch(/Summarize deal/);
  });

  test('blocked billing (org halted): NO upstream call, NO meter row, plugin falls back — the run still succeeds', async () => {
    billingStatus = 'halted';
    setPlugin(AI_PLUGIN_SRC, { run_mode: 'autonomous' });

    const result = await pluginEvents.runTriggeredPlugin(
      { id: 100, name: 'ai-test-plugin' }, ORG_ID, 'deal.created', { id: 6 },
      { dedupeKey: 'deal.created:6', triggerKind: 'event' }
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe('success');
    expect(result.ai_calls).toBe(0);                        // budget not charged
    expect(result.output).toMatchObject({ drafted: false, blocked: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();        // nothing reached Anthropic
    await new Promise((r) => setTimeout(r, 0));
    expect(aiUsageInsert()).toBeUndefined();                // nothing metered
    // The fallback task (prompt-embedding degradation) still auto-applied.
    expect(taskInserts.length).toBe(1);
    expect(String(taskInserts[0][4])).toBe('Fallback brief');
    expect((result.logs || []).some(l => /crm\.ai\.complete blocked: AI_BILLING_HALTED/.test(l))).toBe(true);
  });

  test('AI unconfigured: { configured:false } inside the isolate, fallback task, no wire call', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    setPlugin(AI_PLUGIN_SRC, { run_mode: 'autonomous' });

    const result = await pluginEvents.runTriggeredPlugin(
      { id: 100, name: 'ai-test-plugin' }, ORG_ID, 'deal.created', { id: 7 },
      { dedupeKey: 'deal.created:7', triggerKind: 'event' }
    );

    expect(result.ok).toBe(true);
    expect(result.ai_calls).toBe(0);
    expect(result.output).toMatchObject({ drafted: false, configured: false, blocked: false });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(taskInserts.length).toBe(1);
    expect(String(taskInserts[0][4])).toBe('Fallback brief');
  });
});

// =============================================================================
// Runner-side classification of the AI budget
// =============================================================================
describeIfSandbox('pluginRunner — AI call budget classification', () => {
  test('the 3rd upstream crm.ai.complete call ends the run with the normalized budget message', async () => {
    setPlugin(`
      module.exports = { run: async ({ crm }) => {
        for (let i = 0; i < 3; i++) {
          await crm.ai.complete({ prompt: 'call ' + i });
        }
        return 'unreachable';
      }};
    `);
    const result = await pluginRunner.run(100, null, { orgId: ORG_ID, userId: 1 });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/per-run AI call budget of 2/);
    expect(result.ai_calls).toBe(3);                  // over-budget attempt visible
    expect(globalThis.fetch).toHaveBeenCalledTimes(2); // only 2 real calls went out
  });
});
