// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// aiMetering × bring-your-own key (migration 154).
//
// Contract: a call made under an org's own Anthropic key is still written to
// ai_usage_events (tokens + raw cost, for visibility) but with
// charged_usd_micro = 0 and billing_mode = 'byo_key'. Platform-key calls are
// unchanged: charged = cost × upcharge, billing_mode = 'platform'.
//
// Also covers the seam in services/ai.js: callClaude passes the resolved
// billingMode through to recordUsage and prefers the org key over the
// platform key on the wire.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/logger', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), notice: vi.fn(), debug: vi.fn(),
}));
vi.mock('../services/usageMeter', () => ({
  increment:     vi.fn().mockResolvedValue(null),
  recordAiUsage: vi.fn().mockResolvedValue(null),
}));
vi.mock('../services/quotaEnforcer', () => {
  class QuotaExceeded extends Error {}
  return { QuotaExceeded, getSeatCount: vi.fn().mockResolvedValue(1), checkAiQuota: vi.fn().mockResolvedValue(null) };
});
process.env.ANTHROPIC_API_KEY = 'platform-key-for-vitest';

const audit = require('../services/audit');
audit.record = vi.fn().mockResolvedValue(null);

const aiModel = require('../services/aiModel');
aiModel.getOrgAiSettings = vi.fn().mockResolvedValue({ model: 'claude-sonnet-4-6', effort: 'low' });

const orgAiKeys = require('../services/orgAiKeys');
const aiMetering = require('../services/aiMetering');
const ai = require('../services/ai');

const ORG = 9;
const USAGE = { input_tokens: 1000, output_tokens: 200 };

function insertedRow() {
  const call = mockPool.query.mock.calls.find(([sql]) => /INSERT INTO ai_usage_events/i.test(sql));
  expect(call).toBeTruthy();
  const p = call[1];
  return { cost: p[8], charged: p[9], billing_mode: p[10], sql: call[0] };
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.query.mockResolvedValue({ rows: [] });
  audit.record.mockClear();
  orgAiKeys._resetForTests();
});

describe('aiMetering.recordUsage billing_mode', () => {
  test('platform (default): charged = cost × upcharge, billing_mode platform', async () => {
    await aiMetering.recordUsage({ orgId: ORG, userId: 1, endpoint: 'chat', model: 'claude-sonnet-4-6', usage: USAGE });
    const row = insertedRow();
    const expected = aiMetering.computeCost('claude-sonnet-4-6', USAGE);
    expect(row.cost).toBe(expected.cost_usd_micro);
    expect(row.charged).toBe(expected.charged_usd_micro);
    expect(row.charged).toBeGreaterThan(0);
    expect(row.billing_mode).toBe('platform');
    expect(row.sql).toMatch(/billing_mode/);
  });

  test('byo_key: raw cost still recorded, charged forced to 0, row tagged', async () => {
    await aiMetering.recordUsage({ orgId: ORG, userId: 1, endpoint: 'chat', model: 'claude-sonnet-4-6', usage: USAGE, billingMode: 'byo_key' });
    const row = insertedRow();
    expect(row.cost).toBe(aiMetering.computeCost('claude-sonnet-4-6', USAGE).cost_usd_micro);
    expect(row.charged).toBe(0);
    expect(row.billing_mode).toBe('byo_key');
    // The audit meta mirrors the ledger so a forensic reader sees the mode.
    const auditMeta = audit.record.mock.calls[0][0].meta;
    expect(auditMeta).toMatchObject({ charged_usd_micro: 0, billing_mode: 'byo_key' });
  });

  test('unknown billingMode falls back to platform (never a silent free ride)', async () => {
    await aiMetering.recordUsage({ orgId: ORG, endpoint: 'chat', model: 'claude-sonnet-4-6', usage: USAGE, billingMode: 'free_lunch' });
    const row = insertedRow();
    expect(row.billing_mode).toBe('platform');
    expect(row.charged).toBeGreaterThan(0);
  });

  test('summarizeUsage surfaces byo_key_calls on totals and per-endpoint rows', async () => {
    mockPool.query.mockImplementation(async (sql) => {
      if (/AS byo_key_calls[\s\S]*FROM ai_usage_events[\s\S]*GROUP BY endpoint/i.test(sql)) {
        return { rows: [{ endpoint: 'chat', calls: 3, byo_key_calls: 3, input_tokens: 10, output_tokens: 5, cost_micro: 100, charged_micro: 0 }] };
      }
      if (/AS byo_key_calls/i.test(sql)) {
        return { rows: [{ calls: 3, total_input_tokens: 10, total_output_tokens: 5, total_cache_creation_tokens: 0, total_cache_read_tokens: 0, cost_micro: 100, charged_micro: 0, byo_key_calls: 3 }] };
      }
      return { rows: [] };
    });
    const s = await aiMetering.summarizeUsage({ orgId: ORG, from: '2026-08-01', to: '2026-09-01' });
    expect(s.byo_key_calls).toBe(3);
    expect(s.total_charged_usd).toBe(0);
    expect(s.by_endpoint[0]).toMatchObject({ endpoint: 'chat', calls: 3, byo_key_calls: 3 });
  });
});

describe('services/ai.js key resolution', () => {
  afterEach(() => {
    delete process.env.ORG_AI_KEYS_IN_TESTS;
  });

  test('resolveApiKey prefers the org key and reports byo_key; falls back to platform', async () => {
    orgAiKeys.getOrgKey = vi.fn().mockResolvedValue('sk-ant-org-key');
    expect(await ai.resolveApiKey(ORG)).toEqual({ key: 'sk-ant-org-key', billingMode: 'byo_key' });
    orgAiKeys.getOrgKey = vi.fn().mockResolvedValue(null);
    expect(await ai.resolveApiKey(ORG)).toEqual({ key: 'platform-key-for-vitest', billingMode: 'platform' });
    expect(await ai.resolveApiKey(null)).toEqual({ key: 'platform-key-for-vitest', billingMode: 'platform' });
    expect(await ai.isConfiguredForOrg(ORG)).toBe(true);
  });

  test('callClaude sends the org key on the wire and meters the call as byo_key', async () => {
    orgAiKeys.getOrgKey = vi.fn().mockResolvedValue('sk-ant-org-key');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: 'hi' }], usage: USAGE }),
    });
    const r = await ai.callClaude({ system: 's', messages: [{ role: 'user', content: 'x' }], orgId: ORG, userId: 1, endpoint: 'test' });
    expect(r.ok).toBe(true);
    expect(r.billing_mode).toBe('byo_key');
    expect(globalThis.fetch.mock.calls[0][1].headers['x-api-key']).toBe('sk-ant-org-key');
    // recordUsage is fire-and-forget; let it flush.
    await new Promise(r => setTimeout(r, 0));
    const row = insertedRow();
    expect(row.charged).toBe(0);
    expect(row.billing_mode).toBe('byo_key');
  });
});
