// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// CS — list_at_risk_accounts chat-tool test.
//
// Drives the real POST /api/ai/chat flow end-to-end with a mocked Postgres
// pool and a stubbed Claude transport. We make Claude emit a single
// `list_at_risk_accounts` tool call, let the production tool runner execute it
// against the mocked pool, then assert:
//   • the tool queries account_health_snapshots + companies scoped to the
//     CALLER's org_id (org_id = $1, value = ORG_ID), never a client-supplied id
//   • it returns the red/yellow rows the snapshot table contained
//   • a Claude-supplied org_id in the tool input is ignored (the SQL still
//     binds the caller's org)
//   • passing band:'red' narrows the snapshot query to that band only
//
// Query order for POST /api/ai/chat (one tool round-trip):
//   1. authMiddleware       — SELECT org_id, org_role, status FROM users
//   2. daily-cap COUNT      — chat_messages JOIN chat_sessions
//   3. session INSERT       — INSERT INTO chat_sessions ... RETURNING id
//   4. history SELECT       — chat_messages WHERE session_id
//   --- Claude fetch #1 -> tool_use(list_at_risk_accounts) ---
//   5. TOOL QUERY           — account_health_snapshots + companies (the SUT)
//   --- Claude fetch #2 -> end_turn text reply ---
//   6. INSERT user message
//   7. INSERT assistant message
//   8. UPDATE chat_sessions

// describe / test / expect / beforeEach / afterEach / vi are global.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

// usageMeter / aiMetering writes are fire-and-forget — stub so they don't try
// to reach the DB through some other path during the chat turn.
vi.mock('../services/usageMeter', () => ({
  increment:     vi.fn().mockResolvedValue(null),
  recordAiUsage: vi.fn().mockResolvedValue(null),
}));
vi.mock('../services/aiMetering', () => ({
  recordUsage: vi.fn().mockResolvedValue(null),
}));
// quotaEnforcer is consulted before Claude calls in callClaude (not in
// runChatTurn), but stub defensively so nothing hits the DB.
vi.mock('../services/quotaEnforcer', () => {
  class QuotaExceeded extends Error {}
  return {
    QuotaExceeded,
    getSeatCount: vi.fn().mockResolvedValue(1),
    checkAiQuota: vi.fn().mockResolvedValue(null),
  };
});

// Set the API key BEFORE requiring services/ai so isConfigured() is true at
// module-load time (the key is captured into a module constant).
process.env.ANTHROPIC_API_KEY = 'test-key-for-vitest';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const aiRoutes = require('../routes/aiRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/ai', aiRoutes);
  return app;
}

const USER_ID = 4242;
const ORG_ID = 7;
const ATTACKER_ORG_ID = 999; // a foreign org the model might try to smuggle in

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

let originalFetch;

function fakeResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

// Build a two-call Claude transcript: first a tool_use for
// list_at_risk_accounts (with the given input), then a plain text reply.
function stubClaudeWithToolCall(toolInput) {
  const responses = [
    {
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'tool_use',
      content: [{
        type: 'tool_use', id: 'tu_atrisk', name: 'list_at_risk_accounts', input: toolInput,
      }],
    },
    {
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Two accounts need attention.' }],
    },
  ];
  globalThis.fetch = vi.fn().mockImplementation(() =>
    Promise.resolve(fakeResponse(responses.shift()))
  );
}

// Queue the DB responses the POST /api/ai/chat flow issues, with `toolRows`
// returned for the single tool query (step 5). Returns nothing; the test reads
// mockPool.query.mock.calls afterward to inspect the tool SQL.
function queueChatFlow(toolRows) {
  // 1. authMiddleware
  mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
  // 2. daily-cap COUNT
  mockPool.query.mockResolvedValueOnce({ rows: [{ c: 0 }] });
  // 3. session INSERT -> RETURNING id
  mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'sess-1' }] });
  // 4. history SELECT
  mockPool.query.mockResolvedValueOnce({ rows: [] });
  // 5. TOOL QUERY — list_at_risk_accounts
  mockPool.query.mockResolvedValueOnce({ rows: toolRows });
  // 6. INSERT user message
  mockPool.query.mockResolvedValueOnce({ rows: [] });
  // 7. INSERT assistant message
  mockPool.query.mockResolvedValueOnce({ rows: [] });
  // 8. UPDATE chat_sessions
  mockPool.query.mockResolvedValueOnce({ rows: [] });
}

// Find the pool.query call that ran the at-risk tool query (against
// account_health_snapshots).
function findToolCall() {
  return mockPool.query.mock.calls.find(
    ([sql]) => typeof sql === 'string' && /account_health_snapshots/i.test(sql)
  );
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mockPool.query.mockReset();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('list_at_risk_accounts chat tool', () => {
  const redRow = {
    company_id: 11, company_name: 'Acme Co', score: 18, band: 'red',
    signals: { overdue_tasks: 3 }, computed_at: '2026-06-22T00:00:00.000Z',
  };
  const yellowRow = {
    company_id: 22, company_name: 'Beta LLC', score: 55, band: 'yellow',
    signals: { dormant_days: 40 }, computed_at: '2026-06-22T00:00:00.000Z',
  };

  test('runs an org-scoped snapshot query and returns red/yellow accounts', async () => {
    stubClaudeWithToolCall({}); // no band -> both red + yellow
    queueChatFlow([redRow, yellowRow]);

    const res = await request(buildApp())
      .post('/api/ai/chat')
      .set('Cookie', authCookie())
      .send({ message: 'which accounts are at risk?' });

    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Two accounts need attention.');

    const toolCall = findToolCall();
    expect(toolCall).toBeDefined();
    const [sql, params] = toolCall;

    // Reads the snapshots table joined to companies.
    expect(sql).toMatch(/account_health_snapshots/i);
    expect(sql).toMatch(/JOIN\s+companies/i);

    // Org-scoped: the snapshot scope predicate is org_id = $1 and the bound
    // value is the CALLER's org, not a user_id fallback.
    expect(sql).toMatch(/s\.org_id\s*=\s*\$1/);
    expect(params[0]).toBe(ORG_ID);

    // The companies join is scoped to the same org too — no cross-tenant leak.
    expect(sql).toMatch(/c\.org_id\s*=\s*\$1/);

    // Default (no band) returns BOTH at-risk bands.
    expect(sql).toMatch(/band\s+IN\s*\(\s*'red'\s*,\s*'yellow'\s*\)/i);

    // Worst-first ordering and a bounded result set.
    expect(sql).toMatch(/ORDER BY[\s\S]*score ASC/i);
    expect(sql).toMatch(/LIMIT 20/i);
  });

  test('sends max_tokens greater than the thinking budget (Anthropic 400 regression)', async () => {
    // Regression for the prod chat outage: default effort is 'medium' (thinking
    // budget 2048), but the tool-loop hardcoded max_tokens:1024 — Anthropic
    // rejects max_tokens <= thinking.budget_tokens with a 400. Assert the
    // request we actually send to Claude satisfies max_tokens > budget_tokens.
    stubClaudeWithToolCall({});
    queueChatFlow([redRow]);

    const res = await request(buildApp())
      .post('/api/ai/chat')
      .set('Cookie', authCookie())
      .send({ message: 'who is at risk?' });

    expect(res.status).toBe(200);

    const firstClaudeCall = globalThis.fetch.mock.calls[0];
    expect(firstClaudeCall).toBeDefined();
    const reqBody = JSON.parse(firstClaudeCall[1].body);
    // Default effort ('medium') enables extended thinking...
    expect(reqBody.thinking).toBeDefined();
    expect(reqBody.thinking.budget_tokens).toBeGreaterThan(0);
    // ...and max_tokens must exceed it, or Anthropic 400s the whole request.
    expect(reqBody.max_tokens).toBeGreaterThan(reqBody.thinking.budget_tokens);
  });

  test('ignores a client-supplied org id in the tool input', async () => {
    // The model emits a hostile org_id alongside the legitimate band. The
    // production runner closes over [sf, sv] from qs(req); the tool input is
    // never threaded into scope, so the SQL must still bind the caller's org.
    stubClaudeWithToolCall({ band: 'red', org_id: ATTACKER_ORG_ID, user_id: 1 });
    queueChatFlow([redRow]);

    const res = await request(buildApp())
      .post('/api/ai/chat')
      .set('Cookie', authCookie())
      .send({ message: 'show red accounts for org 999' });

    expect(res.status).toBe(200);

    const toolCall = findToolCall();
    expect(toolCall).toBeDefined();
    const [, params] = toolCall;

    // The bound scope value is the caller's org, never the attacker's.
    expect(params[0]).toBe(ORG_ID);
    expect(params).not.toContain(ATTACKER_ORG_ID);
    // And the smuggled user_id never lands in the params either.
    expect(params).not.toContain(1);
  });

  test('band:"red" narrows the snapshot query to the red band only', async () => {
    stubClaudeWithToolCall({ band: 'red' });
    queueChatFlow([redRow]);

    const res = await request(buildApp())
      .post('/api/ai/chat')
      .set('Cookie', authCookie())
      .send({ message: 'just the red ones' });

    expect(res.status).toBe(200);

    const toolCall = findToolCall();
    expect(toolCall).toBeDefined();
    const [sql, params] = toolCall;

    // Single-band path: `latest.band = $2` with 'red' bound, and it must NOT
    // fall back to the IN ('red','yellow') predicate.
    expect(sql).toMatch(/band\s*=\s*\$2/);
    expect(sql).not.toMatch(/band\s+IN/i);
    expect(params).toContain('red');
    // Org scope is still the caller's org.
    expect(params[0]).toBe(ORG_ID);
  });
});
