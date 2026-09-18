// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// AI-token billing attribution for the PLUGIN path (trigger-engine work,
// migration 164 verification item).
//
// Business premise: any Claude tokens burned by the plugin framework must
// land as metered ai_usage_events rows attributed to the org, so the token
// upcharge flows through billing. The plugin path's AI seam is
// services/pluginGenerator.generatePluginSpec (used by
// POST /api/plugins/from-prompt and the chat propose_build_plugin tool) —
// the sandbox runtime itself exposes NO AI method (the 'claude_complete'
// action kind is declarative-only and never executed by the runner).
//
// This test drives a real generatePluginSpec call end-to-end through
// services/ai.callClaude with a mocked Anthropic wire response and asserts a
// per-call ai_usage_events INSERT attributed to the org, tagged with the
// plugin endpoint label, and charged (platform billing mode).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/logger', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), notice: vi.fn(), debug: vi.fn(),
}));
// Live-module stub (not vi.mock) so the same instance ai.js closes over is
// the spy we assert on.
const usageMeterLive = require('../services/usageMeter');
usageMeterLive.increment = vi.fn().mockResolvedValue(null);
usageMeterLive.recordAiUsage = vi.fn().mockResolvedValue(null);
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
orgAiKeys.getOrgKey = vi.fn().mockResolvedValue(null); // platform key path

const usageMeter = require('../services/usageMeter');
const pluginGenerator = require('../services/pluginGenerator');

const ORG = 42;
const USER = 7;
const USAGE = { input_tokens: 900, output_tokens: 150 };

// A model reply that parses cleanly (no retry) — content doesn't need to
// pass the spec validator here; generatePluginSpec only parses.
const SPEC_REPLY = JSON.stringify({
  name: 'stale-deal-nudge',
  description: 'Creates a follow-up task when a deal goes stale.',
  trigger_event: 'deal.stage_changed',
  source_kind: 'conversational',
  spec_json: { summary: 's', triggerEvent: 'deal.stage_changed', triggerFilter: null, actions: [{ kind: 'create_task' }] },
  source_code: "crm.log('hi');",
});

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.query.mockResolvedValue({ rows: [] });
  audit.record.mockClear();
  usageMeter.increment.mockClear();
  usageMeter.recordAiUsage.mockClear();
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: 'text', text: SPEC_REPLY }],
      usage: USAGE,
      model: 'claude-sonnet-4-6',
    }),
  });
});

function aiUsageInsert() {
  return mockPool.query.mock.calls.find(([sql]) => /INSERT INTO ai_usage_events/i.test(String(sql)));
}

describe('plugin-path AI billing attribution', () => {
  test('a plugin-initiated Claude call lands a metered ai_usage_events row attributed to the org', async () => {
    const r = await pluginGenerator.generatePluginSpec({
      description: 'When a deal changes stage, create a follow-up task for the owner.',
      orgId: ORG,
      userId: USER,
    });
    expect(r.ok).toBe(true);
    // exactly one wire call (parse succeeded, no retry)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // recordUsage is fire-and-forget inside callClaude — let it flush.
    await new Promise((res) => setTimeout(res, 0));

    const call = aiUsageInsert();
    expect(call).toBeTruthy();
    const p = call[1];
    // (org_id, user_id, endpoint, model, in, out, cache_c, cache_r, cost, charged, mode)
    expect(p[0]).toBe(ORG);                          // attributed to the org
    expect(p[1]).toBe(USER);                         // and the acting user
    expect(p[2]).toBe('plugin-spec-from-prompt');    // plugin endpoint tag
    expect(p[4]).toBe(USAGE.input_tokens);
    expect(p[5]).toBe(USAGE.output_tokens);
    expect(p[9]).toBeGreaterThan(0);                 // charged (upcharge applied)
    expect(p[10]).toBe('platform');                  // platform billing mode

    // The aggregate quota ledger got the same tokens against the same org.
    expect(usageMeter.recordAiUsage).toHaveBeenCalledWith(ORG, expect.objectContaining({
      inputTokens: USAGE.input_tokens,
      outputTokens: USAGE.output_tokens,
    }));
  });

  test('the chat propose_build_plugin seam (custom endpoint tag) is attributed the same way', async () => {
    const r = await pluginGenerator.generatePluginSpec({
      description: 'Flag hot deals that go quiet for a week.',
      orgId: ORG,
      userId: USER,
      endpoint: 'chat-propose-build-plugin',
    });
    expect(r.ok).toBe(true);
    await new Promise((res) => setTimeout(res, 0));
    const call = aiUsageInsert();
    expect(call).toBeTruthy();
    expect(call[1][0]).toBe(ORG);
    expect(call[1][2]).toBe('chat-propose-build-plugin');
  });
});
