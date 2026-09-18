// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// crm.ai.complete — the sandbox's metered AI bridge (pluginSdk.buildContext).
//
// Covered here (SDK level; the isolate-bridged end-to-end path lives in
// test/pluginAiRun.test.js):
//   1. A successful call routes through the REAL services/ai.callClaude
//      (mocked Anthropic wire) and lands an org-attributed ai_usage_events
//      row with endpoint='plugin-run' and charged > 0 (platform 2× upcharge).
//   2. The 2-call budget: the 3rd upstream-bound call throws
//      PluginAiBudgetExceeded (code PLUGIN_AI_BUDGET_EXCEEDED).
//   3. A blocked billing verdict returns { ok:false, blocked:true } WITHOUT
//      any upstream call, meter row, or budget charge — autonomous runs can
//      never bypass billing.
//   4. AI-unconfigured returns the platform-standard { configured:false }
//      shape without charging the budget.
//   5. Argument validation: prompt required, ~8KB prompt cap, max_tokens
//      capped at 1024 (default 512).
//   6. Timeout interplay: a passed deadline trips PluginTimeBudgetExceeded
//      on the way into an upstream call, and the extendDeadline callback's
//      returned deadline replaces the one used by subsequent budget checks
//      (so time spent awaiting a slow AI call doesn't kill the run).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/logger', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), notice: vi.fn(), debug: vi.fn(),
}));

// Live-module stubs (same instances the modules under test close over).
const audit = require('../services/audit');
audit.record = vi.fn().mockResolvedValue(null);

const usageMeter = require('../services/usageMeter');
usageMeter.increment = vi.fn().mockResolvedValue(null);
usageMeter.recordAiUsage = vi.fn().mockResolvedValue(null);

const quotaEnforcer = require('../services/quotaEnforcer');
quotaEnforcer.getSeatCount = vi.fn().mockResolvedValue(1);
quotaEnforcer.checkAiQuota = vi.fn().mockResolvedValue(null);

const aiModel = require('../services/aiModel');
aiModel.getOrgAiSettings = vi.fn().mockResolvedValue({ model: 'claude-sonnet-4-6', effort: 'low' });

const orgAiKeys = require('../services/orgAiKeys');
orgAiKeys.getOrgKey = vi.fn().mockResolvedValue(null); // platform-key path

const aiService = require('../services/ai');
const aiBilling = require('../middleware/requireAiBilling');
const pluginSdk = require('../services/pluginSdk');

const ORG = 42;
const USER = 7;
const USAGE = { input_tokens: 900, output_tokens: 150 };

const ALLOW = { allowed: true, status: 'active', code: null, action: null, message: null };
const BLOCKED = {
  allowed: false, status: 'halted', code: 'AI_BILLING_HALTED',
  action: 'contact_admin', message: 'AI usage is halted by your organization admin.',
};

function mockAnthropicFetch(text = 'MOCK AI TEXT') {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: 'text', text }],
      usage: USAGE,
      model: 'claude-sonnet-4-6',
    }),
  });
}

function buildCtx(overrides = {}) {
  const logBuffer = [];
  const counters = { db_queries: 0, tasks_created: 0 };
  const ctx = pluginSdk.buildContext({
    orgId: ORG, logBuffer, counters, userId: USER, ...overrides,
  });
  return { ctx, logBuffer, counters };
}

function aiUsageInsert() {
  return mockPool.query.mock.calls.find(([sql]) => /INSERT INTO ai_usage_events/i.test(String(sql)));
}

let evaluateSpy = null;
let origEvaluate = null;

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.query.mockResolvedValue({ rows: [] });
  mockPool.connect.mockReset();
  usageMeter.increment.mockClear();
  usageMeter.recordAiUsage.mockClear();
  audit.record.mockClear();
  // Deterministic AI env regardless of the shell this runs in.
  process.env.ANTHROPIC_API_KEY = 'platform-key-for-vitest';
  delete process.env.OPENCRM_AI_GATEWAY_KEY;
  // Billing verdict: stubbed per test; default allow.
  if (!origEvaluate) origEvaluate = aiBilling.evaluateAiBilling;
  evaluateSpy = vi.fn().mockResolvedValue({ ...ALLOW });
  aiBilling.evaluateAiBilling = evaluateSpy;
  mockAnthropicFetch();
});

afterAll(() => {
  if (origEvaluate) aiBilling.evaluateAiBilling = origEvaluate;
});

// ===========================================================================
// 1. Metering — the billing-proof at SDK level
// ===========================================================================
describe('crm.ai.complete — metered through callClaude', () => {
  test('a successful call lands an org-attributed ai_usage_events row, endpoint=plugin-run, charged > 0', async () => {
    const { ctx, logBuffer, counters } = buildCtx();
    const res = await ctx.ai.complete({ prompt: 'Summarize this deal.' });

    expect(res.ok).toBe(true);
    expect(res.text).toBe('MOCK AI TEXT');
    expect(res.tokens).toEqual({ input_tokens: 900, output_tokens: 150 });
    expect(counters.ai_calls).toBe(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // recordUsage is fire-and-forget inside callClaude — let it flush.
    await new Promise((r) => setTimeout(r, 0));
    const call = aiUsageInsert();
    expect(call).toBeTruthy();
    const p = call[1];
    // (org_id, user_id, endpoint, model, in, out, cache_c, cache_r, cost, charged, mode)
    expect(p[0]).toBe(ORG);
    expect(p[1]).toBe(USER);
    expect(p[2]).toBe('plugin-run');
    expect(p[4]).toBe(USAGE.input_tokens);
    expect(p[5]).toBe(USAGE.output_tokens);
    expect(p[9]).toBeGreaterThan(0);        // charged (2× upcharge applied)
    expect(p[10]).toBe('platform');

    // The aggregate quota ledger got the same tokens.
    expect(usageMeter.recordAiUsage).toHaveBeenCalledWith(ORG, expect.objectContaining({
      inputTokens: USAGE.input_tokens,
      outputTokens: USAGE.output_tokens,
    }));

    // One log line per call: model + tokens + charged — never the prompt.
    const line = logBuffer.find(l => l.startsWith('crm.ai.complete:'));
    expect(line).toMatch(/model=claude-sonnet-4-6/);
    expect(line).toMatch(/input_tokens=900/);
    expect(line).toMatch(/output_tokens=150/);
    expect(line).toMatch(/charged=true/);
    expect(line).not.toMatch(/Summarize this deal/);
  });

  test('an AI call does NOT consume the DB query budget', async () => {
    const { ctx, counters } = buildCtx();
    await ctx.ai.complete({ prompt: 'hello' });
    expect(counters.db_queries).toBe(0);
    expect(counters.ai_calls).toBe(1);
  });
});

// ===========================================================================
// 2. The 2-call budget
// ===========================================================================
describe('crm.ai.complete — per-run AI budget', () => {
  test('the 3rd upstream call throws PluginAiBudgetExceeded', async () => {
    const { ctx, counters } = buildCtx();
    await ctx.ai.complete({ prompt: 'one' });
    await ctx.ai.complete({ prompt: 'two' });
    expect(counters.ai_calls).toBe(pluginSdk.MAX_AI_CALLS_PER_RUN);

    let thrown = null;
    try { await ctx.ai.complete({ prompt: 'three' }); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(pluginSdk.PluginAiBudgetExceeded);
    expect(thrown.code).toBe('PLUGIN_AI_BUDGET_EXCEEDED');
    // The over-budget attempt is visible in the counter (forensics), but no
    // 3rd wire call went out.
    expect(counters.ai_calls).toBe(pluginSdk.MAX_AI_CALLS_PER_RUN + 1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// 3. Billing gate inside the call path
// ===========================================================================
describe('crm.ai.complete — billing verdict', () => {
  test('a blocked verdict returns { blocked:true } with NO upstream call, NO meter row, NO budget charge', async () => {
    evaluateSpy.mockResolvedValue({ ...BLOCKED });
    const { ctx, logBuffer, counters } = buildCtx();
    const res = await ctx.ai.complete({ prompt: 'draft something' });

    expect(res).toEqual(expect.objectContaining({
      ok: false,
      configured: true,
      blocked: true,
      code: 'AI_BILLING_HALTED',
    }));
    expect(typeof res.message).toBe('string');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(aiUsageInsert()).toBeUndefined();
    expect(usageMeter.recordAiUsage).not.toHaveBeenCalled();
    // Blocked attempts don't burn the budget — a fallback loop can't kill the run.
    expect(counters.ai_calls).toBe(0);
    expect(logBuffer.some(l => /crm\.ai\.complete blocked/.test(l))).toBe(true);
  });

  test('the verdict is evaluated with the run initiator attribution (orgId + userId)', async () => {
    const { ctx } = buildCtx();
    await ctx.ai.complete({ prompt: 'x' });
    expect(evaluateSpy).toHaveBeenCalledWith({ orgId: ORG, userId: USER });
  });
});

// ===========================================================================
// 4. Unconfigured AI
// ===========================================================================
describe('crm.ai.complete — AI not configured', () => {
  test('returns the { configured: false } shape without charging the budget', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENCRM_AI_GATEWAY_KEY;
    const { ctx, counters } = buildCtx();
    const res = await ctx.ai.complete({ prompt: 'anything' });
    expect(res.ok).toBe(false);
    expect(res.configured).toBe(false);
    expect(typeof res.message).toBe('string');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(counters.ai_calls).toBe(0);
    // The billing gate was never consulted — configured is checked first.
    expect(evaluateSpy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 5. Argument validation + caps
// ===========================================================================
describe('crm.ai.complete — argument validation', () => {
  test('prompt is required', async () => {
    const { ctx } = buildCtx();
    await expect(ctx.ai.complete({})).rejects.toThrow(/prompt is required/);
    await expect(ctx.ai.complete(null)).rejects.toThrow(/options must be an object/);
  });

  test('prompt over the ~8KB cap is rejected before any call', async () => {
    const { ctx, counters } = buildCtx();
    const huge = 'x'.repeat(pluginSdk.AI_MAX_PROMPT_CHARS + 1);
    await expect(ctx.ai.complete({ prompt: huge })).rejects.toThrow(/8192-character cap/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(counters.ai_calls).toBe(0);
  });

  test('max_tokens caps at 1024 and defaults to 512', async () => {
    const callSpy = vi.spyOn(aiService, 'callClaude').mockResolvedValue({
      configured: true, ok: true, text: 'ok', usage: USAGE,
      model: 'claude-sonnet-4-6', billing_mode: 'platform',
    });
    try {
      const { ctx } = buildCtx();
      await ctx.ai.complete({ prompt: 'a', max_tokens: 4000 });
      expect(callSpy).toHaveBeenLastCalledWith(expect.objectContaining({
        maxTokens: pluginSdk.AI_MAX_TOKENS_CAP,
        orgId: ORG, userId: USER, endpoint: 'plugin-run',
      }));
      await ctx.ai.complete({ prompt: 'b' });
      expect(callSpy).toHaveBeenLastCalledWith(expect.objectContaining({
        maxTokens: pluginSdk.AI_DEFAULT_MAX_TOKENS,
      }));
      await expect(ctx.ai.complete({ prompt: 'c', max_tokens: -5 }))
        .rejects.toThrow(/max_tokens must be a positive integer/);
    } finally {
      callSpy.mockRestore();
    }
  });

  test('system prompt is passed through (truncated to the cap)', async () => {
    const callSpy = vi.spyOn(aiService, 'callClaude').mockResolvedValue({
      configured: true, ok: true, text: 'ok', usage: USAGE,
      model: 'claude-sonnet-4-6', billing_mode: 'platform',
    });
    try {
      const { ctx } = buildCtx();
      await ctx.ai.complete({ prompt: 'a', system: 's'.repeat(pluginSdk.AI_MAX_SYSTEM_CHARS + 100) });
      const arg = callSpy.mock.calls[0][0];
      expect(arg.system.length).toBe(pluginSdk.AI_MAX_SYSTEM_CHARS);
    } finally {
      callSpy.mockRestore();
    }
  });
});

// ===========================================================================
// 6. Timeout interplay — deadline + extendDeadline
// ===========================================================================
describe('crm.ai.complete — wall-clock interplay', () => {
  test('a passed deadline trips PluginTimeBudgetExceeded before the upstream call', async () => {
    const { ctx, counters } = buildCtx({ deadline: Date.now() - 1000 });
    let thrown = null;
    try { await ctx.ai.complete({ prompt: 'late' }); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(pluginSdk.PluginTimeBudgetExceeded);
    expect(thrown.code).toBe('PLUGIN_TIME_BUDGET_EXCEEDED');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(counters.ai_calls).toBe(0);
  });

  test('extendDeadline is called per upstream AI call and its return becomes the new deadline', async () => {
    // Original deadline expires DURING the (slow) AI call; the extension
    // granted just before the call keeps subsequent budget checks alive.
    const originalDeadline = Date.now() + 150;
    const extendedDeadline = Date.now() + 60_000;
    const extendDeadline = vi.fn().mockReturnValue(extendedDeadline);
    // Slow upstream: 250ms — past the original deadline.
    globalThis.fetch = vi.fn().mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve({
        ok: true, status: 200,
        json: async () => ({ content: [{ type: 'text', text: 'slow reply' }], usage: USAGE, model: 'claude-sonnet-4-6' }),
      }), 250);
    }));
    // A DB read after the AI call must NOT trip the (stale) original deadline.
    mockPool.connect.mockImplementation(() => Promise.resolve({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: vi.fn(),
    }));

    const { ctx } = buildCtx({ deadline: originalDeadline, extendDeadline });
    const res = await ctx.ai.complete({ prompt: 'slow one' });
    expect(res.ok).toBe(true);
    expect(extendDeadline).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBeGreaterThan(originalDeadline); // sanity: original really expired
    await expect(ctx.listDeals({})).resolves.toEqual([]); // would throw without the extension
  });
});
