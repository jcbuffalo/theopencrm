// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Route-handler tests for POST /api/plugins/from-prompt.
//
// Strategy mirrors test/me.test.js: mount the plugin router on a bare Express
// app, mock the pg pool by overwriting query() on the live instance, and
// mock services/ai.callClaude with vi.fn() so we control the model reply.
// supertest drives the HTTP layer end-to-end so the zod schema + featureGate
// + validator path all run.
//
// Coverage:
//   • happy path — valid spec → 201 with { ok, plugin }
//   • parse failure (and retry) → 502
//   • spec rejection (unknown trigger) → 422
//   • spec rejection (disallowed SDK method) → 422
//   • AI not configured → 503
//   • AI quota exceeded → 429
//   • zod validation (too-short description) → 400
//   • UNIQUE collision → 409

// vitest globals.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

// Mock the AI module before requiring the route. Live-export patch since
// services/ai exports a plain object.
const ai = require('../services/ai');
const aiCallSpy = vi.fn();
ai.callClaude = aiCallSpy;

// Feature flag check — return true so the requireFeature middleware lets us
// through. Live-export patch on the service.
const featureFlags = require('../services/featureFlags');
featureFlags.hasFeature = vi.fn().mockResolvedValue(true);

// Audit + logger noise.
const audit = require('../services/audit');
audit.record  = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

const logger = require('../services/logger');
logger.info  = vi.fn();
logger.warn  = vi.fn();
logger.error = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const pluginRoutes = require('../routes/pluginRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/plugins', pluginRoutes);
  return app;
}

const USER_ID = 4242;
const ORG_ID = 99;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

// Convenience: queue the authMiddleware's SELECT (which returns the user's
// org_id/org_role). Use this as the first call in every test that hits the
// route. Subsequent mockResolvedValueOnce calls handle the route's own
// queries.
function queueAuthRow() {
  mockPool.query.mockResolvedValueOnce({
    rows: [{ org_id: ORG_ID, org_role: 'admin', status: 'active' }],
  });
}

// Returns a model reply where the LLM emitted a valid plugin spec. Used by
// the happy-path and conflict tests.
function validModelReply(overrides = {}) {
  const spec = {
    name: 'follow-up-on-proposal',
    description: 'When a deal hits PROPOSAL, create a follow-up task.',
    trigger_event: 'deal.stage_changed',
    source_kind: 'conversational',
    spec_json: {
      summary: 'When a deal hits PROPOSAL, create a follow-up task.',
      triggerEvent: 'deal.stage_changed',
      triggerFilter: { stage: 'PROPOSAL' },
      actions: [
        { kind: 'create_task', title_template: 'Follow up on {deal.title}', due_in_days: 3 },
      ],
    },
    source_code: 'await crm.createTask({ title: "Follow up", deal_id: input.deal_id });',
    ...overrides,
  };
  return {
    configured: true,
    ok: true,
    text: JSON.stringify(spec),
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

beforeEach(() => {
  mockPool.query.mockReset();
  aiCallSpy.mockReset();
  featureFlags.hasFeature.mockClear();
  featureFlags.hasFeature.mockResolvedValue(true);
});

describe('POST /api/plugins/from-prompt — happy path', () => {
  test('valid spec → 201 with plugin row', async () => {
    queueAuthRow();
    aiCallSpy.mockResolvedValueOnce(validModelReply());
    // INSERT INTO plugins → returning the saved row.
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 7,
        name: 'follow-up-on-proposal',
        public_id: '00000000-0000-0000-0000-000000000007',
        status: 'draft',
        source_kind: 'conversational',
        description: 'When a deal hits PROPOSAL, create a follow-up task.',
      }],
    });

    const res = await request(buildApp())
      .post('/api/plugins/from-prompt')
      .set('Cookie', authCookie())
      .send({ description: 'When a deal hits PROPOSAL, create a follow-up task in 3 days.' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.plugin).toMatchObject({
      id: 7,
      name: 'follow-up-on-proposal',
      status: 'draft',
      source_kind: 'conversational',
    });
    // Confirm the route called Claude with the right endpoint label so the
    // ai_usage_events row lands in the right bucket.
    expect(aiCallSpy).toHaveBeenCalledTimes(1);
    const callArgs = aiCallSpy.mock.calls[0][0];
    expect(callArgs.endpoint).toBe('plugin-spec-from-prompt');
    expect(callArgs.orgId).toBe(ORG_ID);
    expect(callArgs.userId).toBe(USER_ID);
    expect(callArgs.maxTokens).toBe(4000);
  });

  test('name override is applied before INSERT', async () => {
    queueAuthRow();
    aiCallSpy.mockResolvedValueOnce(validModelReply());
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 8,
        name: 'my-override-name',
        public_id: 'uuid',
        status: 'draft',
        source_kind: 'conversational',
        description: 'When a deal hits PROPOSAL, create a follow-up task.',
      }],
    });

    const res = await request(buildApp())
      .post('/api/plugins/from-prompt')
      .set('Cookie', authCookie())
      .send({
        description: 'When a deal hits PROPOSAL, create a follow-up task in 3 days.',
        name: 'my-override-name',
      });

    expect(res.status).toBe(201);
    // The INSERT params (second pool.query call after auth) — index 1 is
    // the name param.
    const insertCall = mockPool.query.mock.calls[1];
    expect(insertCall[1][1]).toBe('my-override-name');
  });
});

describe('POST /api/plugins/from-prompt — failure modes', () => {
  test('zod rejects too-short description with 400', async () => {
    queueAuthRow();
    const res = await request(buildApp())
      .post('/api/plugins/from-prompt')
      .set('Cookie', authCookie())
      .send({ description: 'too short' });
    expect(res.status).toBe(400);
    // Claude must not have been called.
    expect(aiCallSpy).not.toHaveBeenCalled();
  });

  test('AI not configured → 503 with AI_NOT_CONFIGURED', async () => {
    queueAuthRow();
    aiCallSpy.mockResolvedValueOnce({ configured: false, message: 'AI not configured.' });

    const res = await request(buildApp())
      .post('/api/plugins/from-prompt')
      .set('Cookie', authCookie())
      .send({ description: 'When a deal hits PROPOSAL, do something.' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AI_NOT_CONFIGURED');
  });

  test('AI quota exceeded → 429 with QUOTA_EXCEEDED', async () => {
    queueAuthRow();
    aiCallSpy.mockResolvedValueOnce({
      configured: true,
      ok: false,
      code: 'QUOTA_EXCEEDED',
      error: 'Org has exceeded its AI quota for this period.',
    });

    const res = await request(buildApp())
      .post('/api/plugins/from-prompt')
      .set('Cookie', authCookie())
      .send({ description: 'When a deal hits PROPOSAL, do something.' });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('QUOTA_EXCEEDED');
  });

  test('unparseable JSON triggers a retry, then 502 if retry also fails', async () => {
    queueAuthRow();
    // Both attempts return junk.
    aiCallSpy.mockResolvedValueOnce({
      configured: true,
      ok: true,
      text: 'sorry I cannot help with that today',
    });
    aiCallSpy.mockResolvedValueOnce({
      configured: true,
      ok: true,
      text: 'still no JSON',
    });

    const res = await request(buildApp())
      .post('/api/plugins/from-prompt')
      .set('Cookie', authCookie())
      .send({ description: 'When a deal hits PROPOSAL, do something.' });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('AI_PARSE_FAILED');
    expect(aiCallSpy).toHaveBeenCalledTimes(2);
  });

  test('retry succeeds when the first call returns junk but the second is valid', async () => {
    queueAuthRow();
    aiCallSpy.mockResolvedValueOnce({
      configured: true,
      ok: true,
      text: 'I cannot help with that.',
    });
    aiCallSpy.mockResolvedValueOnce(validModelReply());
    // INSERT row
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 9,
        name: 'follow-up-on-proposal',
        public_id: 'uuid',
        status: 'draft',
        source_kind: 'conversational',
        description: '...',
      }],
    });

    const res = await request(buildApp())
      .post('/api/plugins/from-prompt')
      .set('Cookie', authCookie())
      .send({ description: 'When a deal hits PROPOSAL, do something.' });

    expect(res.status).toBe(201);
    expect(aiCallSpy).toHaveBeenCalledTimes(2);
  });

  test('spec with unknown trigger_event → 422 SPEC_REJECTED', async () => {
    queueAuthRow();
    aiCallSpy.mockResolvedValueOnce({
      configured: true,
      ok: true,
      text: JSON.stringify({
        name: 'bad-trigger',
        description: 'Has a bad trigger event.',
        trigger_event: 'slack.message_received',
        source_kind: 'conversational',
        spec_json: {
          actions: [{ kind: 'create_task', title_template: 'x' }],
        },
        source_code: 'await crm.createTask({ title: "x" });',
      }),
    });

    const res = await request(buildApp())
      .post('/api/plugins/from-prompt')
      .set('Cookie', authCookie())
      .send({ description: 'When something happens, do something.' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SPEC_REJECTED');
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.some(e => e.field === 'trigger_event')).toBe(true);
  });

  test('spec with disallowed SDK method → 422 SPEC_REJECTED', async () => {
    queueAuthRow();
    aiCallSpy.mockResolvedValueOnce({
      configured: true,
      ok: true,
      text: JSON.stringify({
        name: 'sneaky',
        description: 'Tries to call a method that does not exist.',
        trigger_event: 'manual',
        source_kind: 'conversational',
        spec_json: {
          actions: [{ kind: 'noop' }],
        },
        source_code: 'await crm.sendSlackMessage("hi");',
      }),
    });

    const res = await request(buildApp())
      .post('/api/plugins/from-prompt')
      .set('Cookie', authCookie())
      .send({ description: 'When something happens, do something.' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SPEC_REJECTED');
    expect(res.body.errors.some(e => /sendSlackMessage/.test(e.message))).toBe(true);
  });

  test('UNIQUE collision on (org_id, name) → 409 NAME_CONFLICT', async () => {
    queueAuthRow();
    aiCallSpy.mockResolvedValueOnce(validModelReply());
    // INSERT rejects with PG unique_violation.
    const dupErr = new Error('duplicate key value violates unique constraint');
    dupErr.code = '23505';
    mockPool.query.mockRejectedValueOnce(dupErr);

    const res = await request(buildApp())
      .post('/api/plugins/from-prompt')
      .set('Cookie', authCookie())
      .send({ description: 'When a deal hits PROPOSAL, do something useful.' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NAME_CONFLICT');
    expect(res.body.generatedName).toBe('follow-up-on-proposal');
  });
});
