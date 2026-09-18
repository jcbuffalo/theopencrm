// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Smoke tests for the chat-first AI surface.
//
// We exercise services/ai.runChatTurn directly with a mocked fetch (so
// no real Claude calls). This is a lighter-weight surface than wiring up
// the full /api/ai/chat route — the route's responsibilities (rate
// limiter, daily cap, session creation, persistence) are mostly DB
// plumbing and don't change when the agent loop changes.

// describe / test / expect / beforeEach / afterEach / vi are global.

// See auth.test.js — patch the live pool instance instead of vi.mock'ing.
const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

// usageMeter writes are fire-and-forget — stub so they don't try to hit
// the DB through some other path.
vi.mock('../services/usageMeter', () => ({
  increment:     vi.fn().mockResolvedValue(null),
  recordAiUsage: vi.fn().mockResolvedValue(null),
}));

// Set the API key BEFORE requiring services/ai so isConfigured() returns
// true at module-load time.
process.env.ANTHROPIC_API_KEY = 'test-key-for-vitest';

const ai = require('../services/ai');

// We replace globalThis.fetch with a stub. runChatTurn uses the global
// fetch (Node 18+ built-in) to call the Anthropic API; intercepting at
// the global level avoids touching network code.
let originalFetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  mockPool.query.mockReset();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function fakeResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

describe('ai.runChatTurn — tool-use loop', () => {
  test('returns final text on a no-tools response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      fakeResponse({
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Hello!' }],
      })
    );
    const out = await ai.runChatTurn({
      userMessage: 'hi',
      history: [],
      runTool: async () => ({}),
      orgId: 1,
    });
    expect(out.ok).toBe(true);
    expect(out.reply).toBe('Hello!');
    expect(out.toolCalls).toEqual([]);
  });

  test('loops through tool calls and stops at final text', async () => {
    // 1st response: a tool_use. 2nd: another tool_use. 3rd: text reply.
    const responses = [
      {
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'tool_use',
        content: [{
          type: 'tool_use', id: 'tu_1', name: 'list_deals', input: { stage: 'OPEN' },
        }],
      },
      {
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'tool_use',
        content: [{
          type: 'tool_use', id: 'tu_2', name: 'list_hot_deals', input: {},
        }],
      },
      {
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Done.' }],
      },
    ];
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(fakeResponse(responses.shift()))
    );
    const runTool = vi.fn().mockResolvedValue({ rows: [] });
    const out = await ai.runChatTurn({
      userMessage: 'show me deals',
      history: [],
      runTool,
      orgId: 1,
    });
    expect(out.ok).toBe(true);
    expect(out.reply).toBe('Done.');
    expect(out.toolCalls).toHaveLength(2);
    expect(out.toolCalls[0].name).toBe('list_deals');
    expect(out.toolCalls[1].name).toBe('list_hot_deals');
    expect(runTool).toHaveBeenCalledTimes(2);
  });

  test('bails out after MAX_TOOL_ITERATIONS (5) tool-only turns', async () => {
    // Always return tool_use — verify the loop terminates rather than
    // looping forever.
    const everToolUse = {
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_x', name: 'list_deals', input: {} }],
    };
    globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse(everToolUse));
    const out = await ai.runChatTurn({
      userMessage: 'do it',
      history: [],
      runTool: async () => ({}),
      orgId: 1,
    });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('MAX_ITERATIONS');
    // The cap is 5 — we should have called fetch exactly 5 times before
    // giving up. (Each iteration is one fetch.)
    expect(globalThis.fetch).toHaveBeenCalledTimes(ai.MAX_TOOL_ITERATIONS);
  });

  test('surfaces a fetch error as an AI_NETWORK_ERROR code', async () => {
    // We don't easily test AI_NOT_CONFIGURED because ai.js captures the
    // API key at module-load time and vi.resetModules() doesn't reliably
    // re-trigger that capture for CJS modules. Network-error classification
    // covers the same "the call didn't succeed" boundary case from the
    // runner's POV.
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('connection refused'));
    const out = await ai.runChatTurn({
      userMessage: 'hi', history: [], runTool: async () => ({}), orgId: 1,
    });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('AI_NETWORK_ERROR');
  });
});
