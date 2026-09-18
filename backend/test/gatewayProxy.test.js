// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// AI Gateway proxy — POST /api/gateway/v1/messages (routes/gatewayRoutes.js,
// spec 202).
//
// COVERAGE:
//   • 401 missing / invalid / revoked (cache-busted) gateway key
//   • 400 model not in allowlist; 400 stream; 400 tools; 400 max_tokens >8192;
//     400 tool_result content blocks; 413 body > 1MB
//   • 402 when the billing verdict denies (stubbed verdict + REAL
//     evaluateAiBilling integration for the hard-cap 'halted' state)
//   • comped org → allowed, metered with charged > 0
//   • 503 when the platform ANTHROPIC_API_KEY is unset
//   • happy path: upstream JSON passed through, X-OpenCRM-Charged-USD header,
//     org-attributed ai_usage_events INSERT (endpoint='gateway', charged>0),
//     key last_used_at/requests_count stamp
//
// MOCKING: pool.query dispatched by SQL shape; global fetch stubbed;
// usageMeter + audit patched in place; featureFlags patched for the real
// evaluateAiBilling integration tests. aiMetering.recordUsage runs FOR REAL
// so the assertion covers the actual ledger INSERT.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/logger', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), notice: vi.fn(), debug: vi.fn(),
}));

const audit = require('../services/audit');
audit.record = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

const usageMeter = require('../services/usageMeter');
usageMeter.increment = vi.fn().mockResolvedValue(null);
usageMeter.recordAiUsage = vi.fn().mockResolvedValue(null);

const featureFlags = require('../services/featureFlags');
const requireAiBilling = require('../middleware/requireAiBilling');
const realEvaluateAiBilling = requireAiBilling.evaluateAiBilling;
const gatewayKeys = require('../services/gatewayKeys');

const express = require('express');
const request = require('supertest');
const gatewayRoutes = require('../routes/gatewayRoutes');

const ORG_ID = 42;
const KEY = 'ocrm_gw_' + 'B'.repeat(43);
const KEY_ROW = { id: 9, org_id: ORG_ID, label: 'self-host', key_prefix: 'ocrm_gw_BBBBBBBB', status: 'active' };

function buildApp() {
  const app = express();
  // Mirror index.js: stash raw bytes so the 1MB cap sees true body size.
  app.use(express.json({ limit: '10mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use('/api/gateway', gatewayRoutes);
  return app;
}

// SQL-shape dispatcher so query ordering can't flake. Individual tests
// override entries via the `rows` map.
let insertedUsageEvents;
function wireDb({ keyRow = KEY_ROW, orgRow = null } = {}) {
  insertedUsageEvents = [];
  mockPool.query.mockImplementation(async (sql, params) => {
    if (/FROM ai_gateway_keys/.test(sql)) return { rows: keyRow ? [keyRow] : [] };
    if (/INSERT INTO ai_usage_events/.test(sql)) { insertedUsageEvents.push(params); return { rows: [] }; }
    if (/UPDATE ai_gateway_keys/.test(sql)) return { rows: [] };
    if (/FROM organizations/.test(sql)) return { rows: orgRow ? [orgRow] : [] };
    if (/FROM admin_users/.test(sql)) return { rows: [] };
    return { rows: [] };
  });
}

function goodBody(extra = {}) {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Say hi.' }],
    ...extra,
  };
}

const UPSTREAM_OK = {
  id: 'msg_01', type: 'message', role: 'assistant',
  content: [{ type: 'text', text: 'hi' }],
  model: 'claude-sonnet-4-6',
  usage: { input_tokens: 100, output_tokens: 50 },
};

let app;

beforeEach(() => {
  app = buildApp();
  mockPool.query.mockReset();
  usageMeter.increment.mockClear();
  usageMeter.recordAiUsage.mockClear();
  gatewayKeys._resetCachesForTests();
  requireAiBilling._resetCachesForTests();
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-platform';
  // Default: verdict allows (org on the active plan). Individual tests override.
  requireAiBilling.evaluateAiBilling = vi.fn().mockResolvedValue({ allowed: true, status: 'active' });
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => JSON.parse(JSON.stringify(UPSTREAM_OK)),
  });
});

afterEach(() => {
  requireAiBilling.evaluateAiBilling = realEvaluateAiBilling;
  delete process.env.ANTHROPIC_API_KEY;
});

describe('auth', () => {
  it('401s with no key', async () => {
    wireDb();
    const r = await request(app).post('/api/gateway/v1/messages').send(goodBody());
    expect(r.status).toBe(401);
    expect(r.body.error.type).toBe('authentication_error');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('401s on an unknown key', async () => {
    wireDb({ keyRow: null });
    const r = await request(app)
      .post('/api/gateway/v1/messages')
      .set('Authorization', `Bearer ${KEY}`)
      .send(goodBody());
    expect(r.status).toBe(401);
  });

  it('401s on a revoked key once the cache is busted', async () => {
    wireDb();
    const ok = await request(app)
      .post('/api/gateway/v1/messages')
      .set('Authorization', `Bearer ${KEY}`)
      .send(goodBody());
    expect(ok.status).toBe(200); // key active, cached
    // Revoke in the DB + bust (what DELETE /ai/gateway-keys/:id does).
    wireDb({ keyRow: { ...KEY_ROW, status: 'revoked' } });
    gatewayKeys.bustCache(gatewayKeys.sha256Hex(KEY));
    const r = await request(app)
      .post('/api/gateway/v1/messages')
      .set('Authorization', `Bearer ${KEY}`)
      .send(goodBody());
    expect(r.status).toBe(401);
    expect(r.body.error.message).toMatch(/revoked/i);
  });

  it('accepts the key via x-api-key (Anthropic SDK header shape)', async () => {
    wireDb();
    const r = await request(app)
      .post('/api/gateway/v1/messages')
      .set('x-api-key', KEY)
      .send(goodBody());
    expect(r.status).toBe(200);
  });
});

describe('shape rails', () => {
  beforeEach(() => wireDb());

  const send = (body) => request(app)
    .post('/api/gateway/v1/messages')
    .set('Authorization', `Bearer ${KEY}`)
    .send(body);

  it('400s on a model outside the allowlist', async () => {
    const r = await send(goodBody({ model: 'gpt-4o' }));
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/claude-sonnet-4-6/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('400s on stream: true (v1 is non-streaming)', async () => {
    const r = await send(goodBody({ stream: true }));
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/stream/i);
  });

  it('400s on tools / tool_choice (v1 is plain messages)', async () => {
    const r = await send(goodBody({ tools: [{ name: 't' }] }));
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/tool/i);
  });

  it('400s on tool_result content blocks', async () => {
    const r = await send(goodBody({
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x' }] }],
    }));
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/plain text/i);
  });

  it('400s on max_tokens above the 8192 ceiling', async () => {
    const r = await send(goodBody({ max_tokens: 8193 }));
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/8192/);
  });

  it('413s on a body over 1MB', async () => {
    const r = await send(goodBody({
      messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024 + 100) }],
    }));
    expect(r.status).toBe(413);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('billing enforcement (before the upstream call)', () => {
  it('402s with the verdict code/message when the stubbed verdict denies', async () => {
    wireDb();
    requireAiBilling.evaluateAiBilling = vi.fn().mockResolvedValue({
      allowed: false,
      status: 'unconfigured',
      code: 'AI_BILLING_REQUIRED',
      action: 'start_billing',
      message: 'AI usage requires an active billing subscription. Start your pay-as-you-go plan.',
    });
    const r = await request(app)
      .post('/api/gateway/v1/messages')
      .set('Authorization', `Bearer ${KEY}`)
      .send(goodBody());
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('AI_BILLING_REQUIRED');
    expect(r.body.error.message).toMatch(/pay-as-you-go/);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(insertedUsageEvents).toHaveLength(0);
  });

  it('HARD CAP integration: an org halted by the hard-cap worker gets the halted 402 through the REAL evaluateAiBilling', async () => {
    requireAiBilling.evaluateAiBilling = realEvaluateAiBilling;
    const origHasFeature = featureFlags.hasFeature;
    const origGetFeatures = featureFlags.getFeatures;
    featureFlags.hasFeature = vi.fn().mockResolvedValue(true);
    featureFlags.getFeatures = vi.fn().mockResolvedValue({ ai_billing_required: true });
    try {
      wireDb({
        orgRow: {
          id: ORG_ID,
          ai_billing_status: 'halted',
          ai_halted_reason: 'auto_threshold', // what aiThresholdWorker sets at the hard cap
          ai_billing_subscription_id: 'sub_1',
          ai_billing_trial_ends_at: null,
          updated_at: new Date().toISOString(),
        },
      });
      const r = await request(app)
        .post('/api/gateway/v1/messages')
        .set('Authorization', `Bearer ${KEY}`)
        .send(goodBody());
      expect(r.status).toBe(402);
      expect(r.body.code).toBe('AI_BILLING_HALTED');
      expect(r.body.error.message).toMatch(/monthly spending threshold/i);
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      featureFlags.hasFeature = origHasFeature;
      featureFlags.getFeatures = origGetFeatures;
    }
  });

  it('comped org is allowed through the REAL evaluateAiBilling and metered with charged > 0', async () => {
    requireAiBilling.evaluateAiBilling = realEvaluateAiBilling;
    const origHasFeature = featureFlags.hasFeature;
    const origGetFeatures = featureFlags.getFeatures;
    featureFlags.hasFeature = vi.fn().mockResolvedValue(true);
    featureFlags.getFeatures = vi.fn().mockResolvedValue({ ai_billing_required: true });
    try {
      wireDb({
        orgRow: {
          id: ORG_ID,
          ai_billing_status: 'comped',
          ai_halted_reason: null,
          ai_billing_subscription_id: null,
          ai_billing_trial_ends_at: null,
          updated_at: new Date().toISOString(),
        },
      });
      const r = await request(app)
        .post('/api/gateway/v1/messages')
        .set('Authorization', `Bearer ${KEY}`)
        .send(goodBody());
      expect(r.status).toBe(200);
      // Metering still records (the monthly aiBilling push skips comped orgs
      // downstream — existing behavior).
      expect(insertedUsageEvents).toHaveLength(1);
      const [orgId, , endpoint, , , , , , , chargedMicro, mode] = insertedUsageEvents[0];
      expect(orgId).toBe(ORG_ID);
      expect(endpoint).toBe('gateway');
      expect(mode).toBe('platform');
      expect(Number(chargedMicro)).toBeGreaterThan(0);
    } finally {
      featureFlags.hasFeature = origHasFeature;
      featureFlags.getFeatures = origGetFeatures;
    }
  });
});

describe('platform key + happy path', () => {
  it('503s gracefully when the platform ANTHROPIC_API_KEY is unset', async () => {
    wireDb();
    delete process.env.ANTHROPIC_API_KEY;
    const r = await request(app)
      .post('/api/gateway/v1/messages')
      .set('Authorization', `Bearer ${KEY}`)
      .send(goodBody());
    expect(r.status).toBe(503);
    expect(r.body.error.message).toMatch(/not configured/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('proxies to Anthropic with the PLATFORM key, returns upstream JSON + charged header, meters org-attributed gateway usage, stamps the key', async () => {
    wireDb();
    const r = await request(app)
      .post('/api/gateway/v1/messages')
      .set('Authorization', `Bearer ${KEY}`)
      .send(goodBody({ system: 'be brief', temperature: 0.2, junk_field: 'dropped' }));

    expect(r.status).toBe(200);
    expect(r.body.content[0].text).toBe('hi');

    // Upstream call: platform key, Anthropic endpoint, allowlisted fields only.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(opts.headers['x-api-key']).toBe('sk-ant-test-platform');
    const sent = JSON.parse(opts.body);
    expect(sent.model).toBe('claude-sonnet-4-6');
    expect(sent.system).toBe('be brief');
    expect(sent.junk_field).toBeUndefined();

    // Charged header: sonnet 100 in + 50 out = (100×3 + 50×15) µ$ = 1050 µ$
    // raw → ×2 upcharge = 2100 µ$ = $0.002100.
    expect(r.headers['x-opencrm-charged-usd']).toBe('0.002100');

    // Org-attributed ledger row: endpoint 'gateway', charged > 0, user NULL.
    expect(insertedUsageEvents).toHaveLength(1);
    const [orgId, userId, endpoint, model, inTok, outTok, , , costMicro, chargedMicro, mode] = insertedUsageEvents[0];
    expect(orgId).toBe(ORG_ID);
    expect(userId).toBeNull();
    expect(endpoint).toBe('gateway');
    expect(model).toBe('claude-sonnet-4-6');
    expect(inTok).toBe(100);
    expect(outTok).toBe(50);
    expect(Number(costMicro)).toBe(1050);
    expect(Number(chargedMicro)).toBe(2100);
    expect(mode).toBe('platform');

    // usage_meter parallel write (same as hosted callClaude).
    expect(usageMeter.recordAiUsage).toHaveBeenCalledWith(ORG_ID, { inputTokens: 100, outputTokens: 50 });

    // Key stamp: last_used_at + requests_count.
    const touch = mockPool.query.mock.calls.find(([sql]) => /UPDATE ai_gateway_keys/.test(sql));
    expect(touch).toBeTruthy();
    expect(touch[1]).toEqual([KEY_ROW.id]);
  });

  it('passes upstream errors through without metering token cost', async () => {
    wireDb();
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ type: 'error', error: { type: 'rate_limit_error', message: 'Overloaded' } }),
    });
    const r = await request(app)
      .post('/api/gateway/v1/messages')
      .set('Authorization', `Bearer ${KEY}`)
      .send(goodBody());
    expect(r.status).toBe(429);
    expect(r.body.error.type).toBe('rate_limit_error');
    expect(insertedUsageEvents).toHaveLength(0);
    expect(usageMeter.increment).toHaveBeenCalledWith(ORG_ID, 'ai_requests', 1, 0);
  });
});
