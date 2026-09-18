// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// GET /api/ai/status × the AI billing gate.
//
// The regression this guards: the billing gate used to sit in front of the
// WHOLE /api/ai router, so the status probe itself 402'd for any unbilled
// org, the frontend failed open, and the user's first chat message came back
// as a raw "billing required" error with no button. Now:
//   • GET /api/ai/status is exempt from the gate and returns the verdict
//     ({ allowed, code, action, can_manage, ... }) so the UI can render the
//     "Start AI pay-as-you-go" card up front.
//   • Every OTHER /api/ai route is still gated (402 + code + action).
//
// The mount mirrors index.js exactly (auth → gate-except-status → router).

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
vi.mock('../services/aiMetering', () => ({
  recordUsage: vi.fn().mockResolvedValue(null),
  summarizeUsage: vi.fn().mockResolvedValue({}),
}));
vi.mock('../services/quotaEnforcer', () => {
  class QuotaExceeded extends Error {}
  return { QuotaExceeded, getSeatCount: vi.fn().mockResolvedValue(1), checkAiQuota: vi.fn().mockResolvedValue(null) };
});
process.env.ANTHROPIC_API_KEY = 'test-key-for-vitest';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const featureFlags = require('../services/featureFlags');
featureFlags.hasFeature  = vi.fn().mockResolvedValue(true);
featureFlags.getFeatures = vi.fn().mockResolvedValue({ ai_billing_required: true });

// Bring-your-own key (migration 154): default "no key" so the existing
// verdict cases are unchanged; the BYO describe below flips it.
const orgAiKeys = require('../services/orgAiKeys');
orgAiKeys.getOrgKey = vi.fn().mockResolvedValue(null);

const { requireAiBilling, _resetCachesForTests } = require('../middleware/requireAiBilling');
const aiRoutes = require('../routes/aiRoutes');
const { generateToken, AUTH_COOKIE_NAME, authMiddleware } = require('../auth');

const USER_ID = 8080;
const ORG_ID  = 321;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

// Same shape as index.js: auth first so the gate sees req.orgId, then the
// gate that lets GET /status through, then the router.
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  const gate = requireAiBilling();
  const gateExceptStatus = (req, res, next) =>
    (req.method === 'GET' && req.path === '/status') ? next() : gate(req, res, next);
  app.use('/api/ai', authMiddleware, gateExceptStatus, aiRoutes);
  return app;
}

// SQL-shape router for pool.query so we don't have to count calls: auth row,
// admin_users (never super here), organizations billing row, else empty.
function wirePool({ orgRole = 'owner', org = {} } = {}) {
  mockPool.query.mockImplementation(async (sql) => {
    const q = String(sql);
    if (/FROM users WHERE id/i.test(q)) {
      return { rows: [{ org_id: ORG_ID, org_role: orgRole, status: 'active' }] };
    }
    if (/FROM admin_users/i.test(q)) return { rows: [] };
    if (/FROM organizations WHERE id/i.test(q)) {
      return { rows: [{ id: ORG_ID, ai_billing_status: 'unconfigured', ...org }] };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  process.env.AI_BILLING_REQUIRED_IN_TESTS = 'true';
  delete process.env.STRIPE_PRICE_AI_USAGE;
  _resetCachesForTests();
  mockPool.query.mockReset();
  orgAiKeys.getOrgKey.mockReset();
  orgAiKeys.getOrgKey.mockResolvedValue(null);
});

describe('bring-your-own key orgs never see the pay-as-you-go card', () => {
  test('unbilled org WITH a stored key → status allowed / byo_key, and other routes pass the gate', async () => {
    orgAiKeys.getOrgKey.mockResolvedValue('sk-ant-org-key');
    wirePool({ orgRole: 'member' });
    const res = await request(buildApp()).get('/api/ai/status').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.billing).toMatchObject({ allowed: true, status: 'byo_key', code: null, action: null });

    // The gate itself (not just the probe) lets the BYO org through: the
    // chat route is reached and fails on its own validation, not on 402.
    const chat = await request(buildApp()).post('/api/ai/chat').set('Cookie', authCookie()).send({});
    expect(chat.status).not.toBe(402);
  });
});

afterEach(() => {
  delete process.env.AI_BILLING_REQUIRED_IN_TESTS;
});

describe('GET /api/ai/status is exempt from the billing gate', () => {
  test('unbilled org (owner) → 200 with a start_billing verdict the UI can act on', async () => {
    wirePool({ orgRole: 'owner' });
    const res = await request(buildApp()).get('/api/ai/status').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.billing).toMatchObject({
      allowed: false,
      status: 'unconfigured',
      code: 'AI_BILLING_REQUIRED',
      action: 'start_billing',
      can_manage: true,
    });
    expect(typeof res.body.billing.message).toBe('string');
    expect(res.body.billing.stripe_ready).toBe(false);
  });

  test('plain member of an unbilled org → can_manage false (point them at their admin)', async () => {
    wirePool({ orgRole: 'member' });
    const res = await request(buildApp()).get('/api/ai/status').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.billing.allowed).toBe(false);
    expect(res.body.billing.can_manage).toBe(false);
  });

  test('active trial → allowed with trial_ends_at so the UI can show the countdown', async () => {
    const ends = new Date(Date.now() + 5 * 86400000).toISOString();
    wirePool({ org: { ai_billing_status: 'trial', ai_billing_trial_ends_at: ends } });
    const res = await request(buildApp()).get('/api/ai/status').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.billing).toMatchObject({ allowed: true, status: 'trial', code: null });
    expect(new Date(res.body.billing.trial_ends_at).toISOString()).toBe(ends);
  });

  test('expired trial → blocked with AI_BILLING_TRIAL_EXPIRED / start_billing', async () => {
    const ends = new Date(Date.now() - 86400000).toISOString();
    wirePool({ org: { ai_billing_status: 'trial', ai_billing_trial_ends_at: ends } });
    const res = await request(buildApp()).get('/api/ai/status').set('Cookie', authCookie());
    expect(res.body.billing).toMatchObject({ allowed: false, code: 'AI_BILLING_TRIAL_EXPIRED', action: 'start_billing' });
  });

  test('comped org → allowed, no action', async () => {
    wirePool({ org: { ai_billing_status: 'comped' } });
    const res = await request(buildApp()).get('/api/ai/status').set('Cookie', authCookie());
    expect(res.body.billing).toMatchObject({ allowed: true, status: 'comped', action: null });
  });
});

describe('every other /api/ai route is still gated', () => {
  test('POST /api/ai/chat on an unbilled org → 402 with code + action + status', async () => {
    wirePool({ orgRole: 'owner' });
    const res = await request(buildApp())
      .post('/api/ai/chat')
      .set('Cookie', authCookie())
      .send({ message: 'hi' });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({
      success: false,
      code: 'AI_BILLING_REQUIRED',
      action: 'start_billing',
      status: 'unconfigured',
    });
  });

  test('a non-GET to /status is NOT exempt', async () => {
    wirePool({ orgRole: 'owner' });
    const res = await request(buildApp()).post('/api/ai/status').set('Cookie', authCookie()).send({});
    expect(res.status).toBe(402);
  });
});
