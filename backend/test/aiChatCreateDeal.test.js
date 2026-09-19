// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// propose_create_deal — the chat copilot's deal.create tool (2026-09-18
// usability review, P0 #3: "the copilot can't create a deal, but first-run
// tells you to ask it to"). Two layers:
//
//   1. propose_create_deal (services/ai.js tool + routes/aiRoutes.js handler)
//      — confirm-first, driven through the real POST /api/ai/chat flow with a
//      stubbed Claude transport (mirrors test/aiChatNewModules.test.js).
//      NEVER writes.
//   2. POST /api/ai/actions/apply with a deal.create proposal — the lone
//      writer. Mirrors test/aiActionsApply.test.js: a tiny Express app with
//      aiRoutes mounted bare, a mocked pg pool/client.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/usageMeter', () => ({
  increment: vi.fn().mockResolvedValue(null),
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
process.env.ANTHROPIC_API_KEY = 'test-key-for-vitest';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const featureFlags = require('../services/featureFlags');
featureFlags.hasFeature = vi.fn().mockResolvedValue(true);

const pipelines = require('../services/pipelines');
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

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

let originalFetch;

function fakeResponse(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
}

function stubClaudeWithToolCall(toolName, toolInput) {
  const responses = [
    { usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_deal', name: toolName, input: toolInput }] },
    { usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Here is what I found.' }] },
  ];
  globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(fakeResponse(responses.shift())));
}

// Answers the chat flow's DB traffic by SQL shape — auth + session bookkeeping
// are exact matches; everything else (pipelines fetchProfile/fetchDefaultRow,
// tier-limit lookups, etc.) falls through to empty rows, which every one of
// those callers treats as "use the default" (never throws).
function stubChatFlow() {
  mockPool.query.mockImplementation((sql) => {
    const s = String(sql);
    if (/FROM users WHERE id/i.test(s)) {
      return Promise.resolve({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
    }
    if (/COUNT\(\*\)::int AS c/i.test(s)) return Promise.resolve({ rows: [{ c: 0 }] });
    if (/INSERT INTO chat_sessions/i.test(s)) return Promise.resolve({ rows: [{ id: 'sess-1' }] });
    return Promise.resolve({ rows: [] });
  });
}

function findQuery(re) {
  return mockPool.query.mock.calls.find(([sql]) => typeof sql === 'string' && re.test(sql));
}

async function postChat(message) {
  return request(buildApp()).post('/api/ai/chat').set('Cookie', authCookie()).send({ message });
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  featureFlags.hasFeature.mockReset();
  featureFlags.hasFeature.mockResolvedValue(true);
  pipelines._clearCache();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// propose_create_deal — confirm-first, never writes
// ---------------------------------------------------------------------------
describe('propose_create_deal chat tool', () => {
  test('happy path: proposes a deal.create with the pipeline default stage, no write', async () => {
    stubClaudeWithToolCall('propose_create_deal', { title: 'Acme renewal', company: 'Acme Co', amount: 20000 });
    stubChatFlow();

    const res = await postChat('create a $20k deal for Acme called Acme renewal');
    expect(res.status).toBe(200);

    expect(findQuery(/INSERT INTO deals/i)).toBeUndefined();
    expect(findQuery(/INSERT INTO companies/i)).toBeUndefined();

    const chip = (res.body.actions || []).find((a) => a.kind === 'apply_action');
    expect(chip).toBeDefined();
    expect(chip.proposal.entity).toBe('deal');
    expect(chip.proposal.op).toBe('create');
    expect(chip.proposal.fields.title).toBe('Acme renewal');
    expect(chip.proposal.fields.company).toBe('Acme Co');
    expect(chip.proposal.fields.amount).toBe(20000);
    // generic profile default pipeline's first stage is lowercase 'lead'.
    expect(chip.proposal.fields.stage).toBe('lead');
    expect(chip.proposal.fields.deal_type).toBe('default');
    expect(chip.proposal.summary).toMatch(/Acme renewal/);
  });

  test('a human-label stage ("Negotiation") resolves to the real stage id', async () => {
    stubClaudeWithToolCall('propose_create_deal', { title: 'Beta deal', stage: 'Negotiation' });
    stubChatFlow();

    const res = await postChat('create a deal for Beta in negotiation');
    expect(res.status).toBe(200);
    const chip = (res.body.actions || []).find((a) => a.kind === 'apply_action');
    expect(chip.proposal.fields.stage).toBe('negotiation');
  });

  test('an invalid stage is rejected by the validator — no proposal chip, no write', async () => {
    stubClaudeWithToolCall('propose_create_deal', { title: 'Bad stage deal', stage: 'NOT_A_REAL_STAGE' });
    stubChatFlow();

    const res = await postChat('create a deal in a made-up stage');
    expect(res.status).toBe(200);
    const chip = (res.body.actions || []).find((a) => a.kind === 'apply_action');
    expect(chip).toBeUndefined();
    expect(findQuery(/INSERT INTO deals/i)).toBeUndefined();
  });

  test('missing title is rejected before any DB work beyond auth/session bookkeeping', async () => {
    stubClaudeWithToolCall('propose_create_deal', {});
    stubChatFlow();

    const res = await postChat('create a deal');
    expect(res.status).toBe(200);
    const chip = (res.body.actions || []).find((a) => a.kind === 'apply_action');
    expect(chip).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// POST /api/ai/actions/apply — the lone writer
// ---------------------------------------------------------------------------
function makeClient(rowsByPhase) {
  const calls = [];
  return {
    calls,
    query: vi.fn((sql, params) => {
      calls.push([sql, params]);
      const s = String(sql);
      if (/^BEGIN|^COMMIT|^ROLLBACK/.test(s.trim())) return Promise.resolve({ rows: [] });
      if (/SELECT id FROM companies/i.test(s)) return Promise.resolve(rowsByPhase.companyLookup || { rows: [] });
      if (/INSERT INTO companies/i.test(s)) return Promise.resolve(rowsByPhase.companyInsert || { rows: [{ id: 501 }] });
      if (/SELECT id FROM contacts/i.test(s)) return Promise.resolve(rowsByPhase.contactLookup || { rows: [] });
      if (/INSERT INTO contacts/i.test(s)) return Promise.resolve(rowsByPhase.contactInsert || { rows: [{ id: 601 }] });
      if (/INSERT INTO deals/i.test(s)) return Promise.resolve(rowsByPhase.dealInsert || { rows: [{ id: 701, title: 'Deal', stage: 'lead', deal_type: 'default', amount: null }] });
      return Promise.resolve({ rows: [] });
    }),
    release: vi.fn(),
  };
}

describe('POST /api/ai/actions/apply — deal.create', () => {
  test('happy path: upserts the company + contact and creates the deal inside one txn', async () => {
    const client = makeClient({});
    // 1. authMiddleware
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
    // 2. pipelines.getEffectivePipeline: fetchProfile
    mockPool.query.mockResolvedValueOnce({ rows: [{ profile: 'generic' }] });
    // 3. pipelines.getEffectivePipeline: fetchDefaultRow (no custom pipeline)
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    mockPool.connect.mockResolvedValueOnce(client);
    mockPool.query.mockResolvedValue({ rows: [] }); // audit fire-and-forget etc.

    const res = await request(buildApp())
      .post('/api/ai/actions/apply')
      .set('Cookie', authCookie())
      .send({
        proposal: {
          entity: 'deal', op: 'create',
          fields: { title: 'Acme renewal', company: 'Acme Co', contact_name: 'Jane Doe', contact_email: 'jane@acme.test', amount: 20000, stage: 'lead', deal_type: 'default' },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.result.id).toBe(701);
    expect(res.body.open_path).toBe('/deals?dealId=701');

    const sqls = client.calls.map(([sql]) => sql);
    expect(sqls.some((s) => /INSERT INTO companies/i.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO contacts/i.test(s))).toBe(true);
    const dealInsert = client.calls.find(([sql]) => /INSERT INTO deals/i.test(sql));
    expect(dealInsert).toBeDefined();
    const [, dealParams] = dealInsert;
    // contact_id (601) and company_id (501) from the upserts flow onto the deal.
    expect(dealParams).toContain(601);
    expect(dealParams).toContain(501);
    expect(dealParams).toContain('lead');
    expect(client.release).toHaveBeenCalled();
  });

  test('reuses an existing company/contact instead of creating duplicates', async () => {
    const client = makeClient({
      companyLookup: { rows: [{ id: 111 }] },
      contactLookup: { rows: [{ id: 222 }] },
    });
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ profile: 'generic' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    mockPool.connect.mockResolvedValueOnce(client);
    mockPool.query.mockResolvedValue({ rows: [] });

    const res = await request(buildApp())
      .post('/api/ai/actions/apply')
      .set('Cookie', authCookie())
      .send({
        proposal: {
          entity: 'deal', op: 'create',
          fields: { title: 'Existing co deal', company: 'Acme Co', contact_email: 'jane@acme.test', stage: 'lead', deal_type: 'default' },
        },
      });

    expect(res.status).toBe(200);
    const sqls = client.calls.map(([sql]) => sql);
    expect(sqls.some((s) => /INSERT INTO companies/i.test(s))).toBe(false);
    expect(sqls.some((s) => /INSERT INTO contacts/i.test(s))).toBe(false);
    const [, dealParams] = client.calls.find(([sql]) => /INSERT INTO deals/i.test(sql));
    expect(dealParams).toContain(111);
    expect(dealParams).toContain(222);
  });

  test('a tampered/invalid stage on the echoed proposal is re-validated and 400s, no write', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ profile: 'generic' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .post('/api/ai/actions/apply')
      .set('Cookie', authCookie())
      .send({
        proposal: {
          entity: 'deal', op: 'create',
          fields: { title: 'Bad stage deal', stage: 'TOTALLY_MADE_UP', deal_type: 'default' },
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_STAGE');
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  test('an unknown deal_type on the echoed proposal 400s, no write', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
    // pipelines.listPipelines(orgId) — no typed pipelines for this org.
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .post('/api/ai/actions/apply')
      .set('Cookie', authCookie())
      .send({
        proposal: {
          entity: 'deal', op: 'create',
          fields: { title: 'Typed deal', deal_type: 'inspector' },
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DEAL_TYPE');
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  test('title is required — 400 before any pipeline lookup', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });

    const res = await request(buildApp())
      .post('/api/ai/actions/apply')
      .set('Cookie', authCookie())
      .send({ proposal: { entity: 'deal', op: 'create', fields: { company: 'Acme Co' } } });

    expect(res.status).toBe(400);
    expect(mockPool.connect).not.toHaveBeenCalled();
  });
});
