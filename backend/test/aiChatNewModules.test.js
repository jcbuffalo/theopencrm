// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// New-module chat tools (July 2026 wave): list_leads / list_open_cases /
// list_upcoming_meetings / list_sequences + the confirm-first
// propose_create_lead / propose_create_case.
//
// Mirrors test/aiChatAtRisk.test.js: drives the real POST /api/ai/chat flow
// end-to-end with a mocked Postgres pool and a stubbed Claude transport. We
// make Claude emit a single tool call, let the production tool runner execute
// it against the mocked pool, then assert:
//   • every read tool queries its table scoped to the CALLER's org
//     (org_id = $1, value = ORG_ID) — never a client-supplied id
//   • flag-gated tools consult featureFlags.hasFeature with the right flag and
//     go inert (FEATURE_DISABLED, no table query) when the org has it off
//   • propose_* tools NEVER write — they return a proposal chip
//     (kind: 'apply_action') and no INSERT is ever issued
//
// featureFlags.hasFeature is stubbed (default → enabled) so module gating is
// deterministic; the flag-off tests flip the stub per-test.
//
// POOL MOCKING: dispatched on SQL content, NOT on call order. The chat flow
// interleaves fire-and-forget bookkeeping queries (per-org ai_model lookup,
// ai_usage_events / usage_meter / audit_log inserts) between the structural
// steps, so a positional mockResolvedValueOnce queue silently drifts. The
// dispatcher answers auth/cap/session queries by shape, returns `toolRows`
// for the query matching the test's `toolRe`, and empty rows for everything
// else.

// describe / test / expect / beforeEach / afterEach / vi are global.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/usageMeter', () => ({
  increment:     vi.fn().mockResolvedValue(null),
  recordAiUsage: vi.fn().mockResolvedValue(null),
}));
vi.mock('../services/aiMetering', () => ({
  recordUsage: vi.fn().mockResolvedValue(null),
}));
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

// Stub hasFeature by monkey-patching the shared CJS exports object (the
// requireAiBilling.test.js pattern): aiRoutes resolves featureFlags.hasFeature
// at call time via property lookup on this same object, so the stub is what
// runs — and the real KNOWN_FLAGS stays intact for chatActions' toggleable-
// flag allowlist. Keeps module gating deterministic and off the mocked pool.
const featureFlags = require('../services/featureFlags');
featureFlags.hasFeature = vi.fn();
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
const ATTACKER_ORG_ID = 999;

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

// Two-call Claude transcript: one tool_use for `toolName`, then a text reply.
function stubClaudeWithToolCall(toolName, toolInput) {
  const responses = [
    {
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_newmod', name: toolName, input: toolInput }],
    },
    {
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Here is what I found.' }],
    },
  ];
  globalThis.fetch = vi.fn().mockImplementation(() =>
    Promise.resolve(fakeResponse(responses.shift()))
  );
}

// Answer the chat flow's DB traffic by SQL shape. `toolRows` is returned for
// the first query matching `toolRe` (the tool under test); every bookkeeping
// query (history, ai_model lookup, metering/audit inserts) gets empty rows.
function stubChatFlow(toolRows, toolRe) {
  mockPool.query.mockImplementation((sql) => {
    const s = String(sql);
    if (/FROM users WHERE id/i.test(s)) {
      return Promise.resolve({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
    }
    if (/COUNT\(\*\)::int AS c/i.test(s)) return Promise.resolve({ rows: [{ c: 0 }] }); // daily cap
    if (/INSERT INTO chat_sessions/i.test(s)) return Promise.resolve({ rows: [{ id: 'sess-1' }] });
    if (toolRe && toolRe.test(s)) return Promise.resolve({ rows: toolRows });
    return Promise.resolve({ rows: [] });
  });
}

// Find the pool.query call whose SQL matches `re`.
function findQuery(re) {
  return mockPool.query.mock.calls.find(([sql]) => typeof sql === 'string' && re.test(sql));
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mockPool.query.mockReset();
  featureFlags.hasFeature.mockReset();
  featureFlags.hasFeature.mockResolvedValue(true); // modules ON by default
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function postChat(message) {
  return request(buildApp())
    .post('/api/ai/chat')
    .set('Cookie', authCookie())
    .send({ message });
}

// ---------------------------------------------------------------------------
// list_leads
// ---------------------------------------------------------------------------
describe('list_leads chat tool', () => {
  const leadRow = {
    id: 31, name: 'Jane Doe', email: 'jane@acme.test', company_name: 'Acme Co',
    source: 'referral', status: 'qualified', owner_user_id: USER_ID,
    created_at: '2026-07-01T00:00:00.000Z',
  };

  test('runs an org-scoped leads query, filtered by status, flag-checked', async () => {
    stubClaudeWithToolCall('list_leads', { status: 'qualified' });
    stubChatFlow([leadRow], /FROM leads/i);

    const res = await postChat('show me qualified leads');
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Here is what I found.');

    // Module gate consulted with the caller's org + the right flag.
    expect(featureFlags.hasFeature).toHaveBeenCalledWith(ORG_ID, 'leads_enabled');

    const call = findQuery(/FROM leads/i);
    expect(call).toBeDefined();
    const [sql, params] = call;
    expect(sql).toMatch(/org_id\s*=\s*\$1/);
    expect(params[0]).toBe(ORG_ID);
    expect(sql).toMatch(/status\s*=\s*\$2/);
    expect(params[1]).toBe('qualified');
    expect(sql).toMatch(/ORDER BY created_at DESC/i);
    expect(sql).toMatch(/LIMIT 20/i);
  });

  test('ignores a smuggled org_id / user_id in the tool input', async () => {
    stubClaudeWithToolCall('list_leads', { status: 'new', org_id: ATTACKER_ORG_ID, user_id: 1 });
    stubChatFlow([leadRow], /FROM leads/i);

    const res = await postChat('leads for org 999');
    expect(res.status).toBe(200);

    const call = findQuery(/FROM leads/i);
    expect(call).toBeDefined();
    const [, params] = call;
    expect(params[0]).toBe(ORG_ID);
    expect(params).not.toContain(ATTACKER_ORG_ID);
    expect(params).not.toContain(1);
  });

  test('is inert when leads_enabled is off — FEATURE_DISABLED, no table query', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    stubClaudeWithToolCall('list_leads', {});
    stubChatFlow([leadRow], /FROM leads/i);

    const res = await postChat('any new leads?');
    expect(res.status).toBe(200); // the copilot relays the error as prose

    expect(featureFlags.hasFeature).toHaveBeenCalledWith(ORG_ID, 'leads_enabled');
    // The gate fired BEFORE the query: the leads table was never read.
    expect(findQuery(/FROM leads/i)).toBeUndefined();
    // And the disabled tool must not mint a navigate chip to a dead page.
    const navLeads = (res.body.actions || []).find((a) => a.path === '/leads');
    expect(navLeads).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// list_open_cases
// ---------------------------------------------------------------------------
describe('list_open_cases chat tool', () => {
  const caseRow = {
    id: 51, subject: 'Portal is down', status: 'open', priority: 'urgent',
    sla_due_at: '2026-07-10T00:00:00.000Z', created_at: '2026-07-08T00:00:00.000Z',
    company_id: 11, company_name: 'Acme Co', sla_breached: true,
  };

  test('org-scoped, excludes resolved/closed, priority narrows, worst SLA first', async () => {
    stubClaudeWithToolCall('list_open_cases', { priority: 'urgent' });
    stubChatFlow([caseRow], /FROM cases/i);

    const res = await postChat('any urgent open cases?');
    expect(res.status).toBe(200);

    expect(featureFlags.hasFeature).toHaveBeenCalledWith(ORG_ID, 'customer_success_enabled');

    const call = findQuery(/FROM cases/i);
    expect(call).toBeDefined();
    const [sql, params] = call;
    expect(sql).toMatch(/cs\.org_id\s*=\s*\$1/);
    expect(params[0]).toBe(ORG_ID);
    // The companies join is scoped to the same org — no cross-tenant name leak.
    expect(sql).toMatch(/c\.org_id\s*=\s*\$1/);
    expect(sql).toMatch(/status NOT IN \('resolved', 'closed'\)/i);
    expect(sql).toMatch(/priority\s*=\s*\$2/);
    expect(params[1]).toBe('urgent');
    // SLA breach computed in SQL; worst SLA first, bounded.
    expect(sql).toMatch(/sla_breached/i);
    expect(sql).toMatch(/ORDER BY[\s\S]*sla_due_at ASC NULLS LAST/i);
    expect(sql).toMatch(/LIMIT 20/i);
  });

  test('is inert when customer_success_enabled is off', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    stubClaudeWithToolCall('list_open_cases', {});
    stubChatFlow([caseRow], /FROM cases/i);

    const res = await postChat('open cases?');
    expect(res.status).toBe(200);
    expect(findQuery(/FROM cases/i)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// list_upcoming_meetings
// ---------------------------------------------------------------------------
describe('list_upcoming_meetings chat tool', () => {
  const meetingRow = {
    id: 61, title: 'QBR with Acme', starts_at: '2026-07-16T15:00:00.000Z',
    ends_at: '2026-07-16T16:00:00.000Z', location: 'Zoom',
    company_id: 11, company_name: 'Acme Co', deal_id: null, contact_id: 21,
  };

  test('org-scoped forward window, defaulting to 7 days', async () => {
    stubClaudeWithToolCall('list_upcoming_meetings', {});
    stubChatFlow([meetingRow], /FROM meetings/i);

    const res = await postChat('what meetings do I have coming up?');
    expect(res.status).toBe(200);

    const call = findQuery(/FROM meetings/i);
    expect(call).toBeDefined();
    const [sql, params] = call;
    expect(sql).toMatch(/m\.org_id\s*=\s*\$1/);
    expect(params[0]).toBe(ORG_ID);
    expect(sql).toMatch(/c\.org_id\s*=\s*\$1/); // scoped companies join
    expect(sql).toMatch(/starts_at\s*>=\s*NOW\(\)/i);
    expect(sql).toMatch(/ORDER BY m\.starts_at ASC/i);
    expect(params[1]).toBe('7'); // default window
    // Meetings are core CRM (ungated mount) — no module-flag lookup.
    expect(featureFlags.hasFeature).not.toHaveBeenCalled();
  });

  test('clamps an out-of-range days input to the 90-day cap', async () => {
    stubClaudeWithToolCall('list_upcoming_meetings', { days: 400 });
    stubChatFlow([meetingRow], /FROM meetings/i);

    const res = await postChat('meetings in the next 400 days');
    expect(res.status).toBe(200);

    const call = findQuery(/FROM meetings/i);
    expect(call).toBeDefined();
    expect(call[1][1]).toBe('90');
  });
});

// ---------------------------------------------------------------------------
// list_sequences
// ---------------------------------------------------------------------------
describe('list_sequences chat tool', () => {
  const seqRow = {
    id: 3, name: 'Post-demo nurture', is_active: true, created_at: '2026-06-01T00:00:00.000Z',
    step_count: 4, active_enrollments: 12, completed_enrollments: 30,
  };

  test('org-scoped aggregate over sequences + enrollments, flag-checked', async () => {
    stubClaudeWithToolCall('list_sequences', {});
    stubChatFlow([seqRow], /FROM sequences/i);

    const res = await postChat('how are my sequences doing?');
    expect(res.status).toBe(200);

    expect(featureFlags.hasFeature).toHaveBeenCalledWith(ORG_ID, 'campaigns_enabled');

    const call = findQuery(/FROM sequences/i);
    expect(call).toBeDefined();
    const [sql, params] = call;
    expect(sql).toMatch(/s\.org_id\s*=\s*\$1/);
    expect(params[0]).toBe(ORG_ID);
    expect(sql).toMatch(/sequence_enrollments/i);
    expect(sql).toMatch(/active_enrollments/i);
    expect(sql).toMatch(/GROUP BY s\.id/i);
    expect(sql).toMatch(/LIMIT 20/i);
  });

  test('is inert when campaigns_enabled is off', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    stubClaudeWithToolCall('list_sequences', {});
    stubChatFlow([seqRow], /FROM sequences/i);

    const res = await postChat('sequences?');
    expect(res.status).toBe(200);
    expect(findQuery(/FROM sequences/i)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// propose_create_lead / propose_create_case — confirm-first: NEVER write.
// ---------------------------------------------------------------------------
describe('propose_create_lead / propose_create_case (confirm-first)', () => {
  test('propose_create_lead returns an apply_action proposal and writes NOTHING', async () => {
    stubClaudeWithToolCall('propose_create_lead', {
      name: 'Jane Doe', company_name: 'Acme Co', source: 'referral',
    });
    stubChatFlow([], null);

    const res = await postChat('add Jane from Acme as a lead');
    expect(res.status).toBe(200);

    // Confirm-first: no INSERT into leads anywhere in the turn. The only
    // INSERTs the flow issues are chat_sessions/chat_messages/audit_log.
    const leadInsert = mockPool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && /INSERT INTO leads/i.test(sql)
    );
    expect(leadInsert).toBeUndefined();

    // The proposal surfaces as an Apply/Cancel chip with the validated action.
    const chip = (res.body.actions || []).find((a) => a.kind === 'apply_action');
    expect(chip).toBeDefined();
    expect(chip.proposal.entity).toBe('lead');
    expect(chip.proposal.op).toBe('create');
    expect(chip.proposal.fields.name).toBe('Jane Doe');
    expect(chip.proposal.summary).toMatch(/Jane Doe/);

    // Flag consulted for the leads module.
    expect(featureFlags.hasFeature).toHaveBeenCalledWith(ORG_ID, 'leads_enabled');
  });

  test('propose_create_lead rejects a direct "converted" status (validator, no DB)', async () => {
    stubClaudeWithToolCall('propose_create_lead', { name: 'Sly Fox', status: 'converted' });
    stubChatFlow([], null);

    const res = await postChat('add a converted lead');
    expect(res.status).toBe(200);

    // Validation failed → no proposal chip, and still no write.
    const chip = (res.body.actions || []).find((a) => a.kind === 'apply_action');
    expect(chip).toBeUndefined();
    expect(findQuery(/INSERT INTO leads/i)).toBeUndefined();
  });

  test('propose_create_case ownership-checks a referenced company inside the org', async () => {
    stubClaudeWithToolCall('propose_create_case', {
      subject: 'Portal is down', priority: 'urgent', company_id: 11,
    });
    stubChatFlow([{ ok: 1 }], /SELECT 1 FROM companies/i); // ownership pre-flight finds the company

    const res = await postChat('open an urgent case for Acme');
    expect(res.status).toBe(200);

    // Ownership pre-flight ran against companies, scoped to the caller's org.
    const preflight = findQuery(/SELECT 1 FROM companies/i);
    expect(preflight).toBeDefined();
    expect(preflight[1]).toEqual([11, ORG_ID]);

    // Still no write.
    expect(findQuery(/INSERT INTO cases/i)).toBeUndefined();

    const chip = (res.body.actions || []).find((a) => a.kind === 'apply_action');
    expect(chip).toBeDefined();
    expect(chip.proposal.entity).toBe('case');
    expect(chip.proposal.fields.subject).toBe('Portal is down');
  });

  test('propose_create_case is inert when customer_success_enabled is off', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    stubClaudeWithToolCall('propose_create_case', { subject: 'Broken thing' });
    stubChatFlow([], null);

    const res = await postChat('open a case');
    expect(res.status).toBe(200);

    expect(featureFlags.hasFeature).toHaveBeenCalledWith(ORG_ID, 'customer_success_enabled');
    const chip = (res.body.actions || []).find((a) => a.kind === 'apply_action');
    expect(chip).toBeUndefined();
    expect(findQuery(/INSERT INTO cases/i)).toBeUndefined();
  });
});
