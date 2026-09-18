// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// AI Pay-as-you-go billing endpoints — backend/routes/billingRoutes.js /ai/*.
//
// COVERAGE (per spec):
//   GET   /api/billing/ai/status     — full shape; threshold_pct math;
//                                       configured reflects env var
//   POST  /api/billing/ai/start      — 503 when STRIPE_PRICE_AI_USAGE unset,
//                                       503 when stripe unconfigured, happy
//                                       path returns Checkout URL + audit
//   POST  /api/billing/ai/halt       — 403 non-admin; happy path flips status
//                                       to halted, sets ai_halted_at /
//                                       ai_halted_by_user_id / ai_halted_reason,
//                                       busts cache, audits
//   POST  /api/billing/ai/resume     — 403 non-admin; happy path restores to
//                                       active (sub id present) or unconfigured
//                                       (no sub id); clears halt fields; audits
//   POST  /api/billing/ai/comp       — 403 non-super-admin; 400 missing
//                                       org_id; happy path → comped
//   POST  /api/billing/ai/start-trial — 403 non-super-admin; 400 missing
//                                       org_id; clamps days 1..90 (default 14);
//                                       happy path → trial w/ trial_ends_at
//                                       in future
//   PATCH /api/billing/ai/threshold  — 403 non-admin; 400 out-of-range
//                                       threshold_usd; happy path resets
//                                       ai_threshold_last_warned_period
//   GET   /api/billing/ai/admin/list — 403 non-super-admin; rows shape with
//                                       mtd_usage_usd / threshold_pct computed
//
// MOCKING
//   • pool.query mocked at the live instance
//   • stripeService, adminNotify replaced in-place
//   • aiMetering.summarizeUsage mocked so getMtdUsageUsd returns controlled
//     dollar amounts
//   • isSuperAdmin is DESTRUCTURED into billingRoutes.js at require-time
//     (`const { isSuperAdmin } = require('../middleware/adminAuth')`), so
//     patching adminAuth.isSuperAdmin afterwards does NOT change the route's
//     bound reference. We satisfy the gate by queueing admin_users rows
//     for every isSuperAdmin call (it's a single pool.query under the hood).
//
// Like other suites we patch the live instance because module.exports = pool
// is hostile to vitest's CJS-mock interop.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/logger', () => ({
  info:   vi.fn(),
  warn:   vi.fn(),
  error:  vi.fn(),
  notice: vi.fn(),
  debug:  vi.fn(),
}));

// stripeService — only the methods the /ai/* routes touch.
const stripeService = require('../services/stripe');
stripeService.isConfigured              = vi.fn(() => true);
stripeService.createUsageCheckoutSession = vi.fn();
stripeService.verifyWebhook             = vi.fn();
stripeService.createCheckoutSession     = vi.fn();
stripeService.createPortalSession       = vi.fn();

const audit = require('../services/audit');
audit.record  = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

const adminNotify = require('../services/adminNotify');
adminNotify.send = vi.fn().mockResolvedValue({ ok: true });

// MTD usage helper — patch the underlying aggregator so getMtdUsageUsd(...)
// inside the route returns deterministic dollars without queueing per-test
// SQL responses.
const aiMetering = require('../services/aiMetering');
aiMetering.summarizeUsage = vi.fn();

// requireAiBilling.bustCache is called from updateAiBillingStatus on every
// status transition. Spy without replacing so the real implementation runs.
const requireAiBilling = require('../middleware/requireAiBilling');
const bustCacheSpy = vi.spyOn(requireAiBilling, 'bustCache');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const billingRoutes = require('../routes/billingRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 5555;
const ORG_ID  = 200;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/billing', billingRoutes);
  return app;
}

// authMiddleware preflight — populates req.orgId / req.orgRole.
function queueAuthRow(role = 'admin') {
  mockPool.query.mockResolvedValueOnce({
    rows: [{ org_id: ORG_ID, org_role: role, status: 'active' }],
  });
}

// admin_users SELECT response — drives the `isSuperAdmin` gate. Many of the
// /ai/* routes go through canManageOrgBilling() which calls isSuperAdmin when
// the orgRole gate fails, plus the explicit super-admin routes call it
// unconditionally. queue one row per expected call.
function queueIsSuperAdmin(isSuper) {
  mockPool.query.mockResolvedValueOnce({
    rows: isSuper ? [{ id: 1, user_id: USER_ID, role: 'super_admin', permissions: [] }] : [],
  });
}

beforeEach(() => {
  mockPool.query.mockReset();
  audit.fromReq.mockReset();
  audit.record.mockReset();
  audit.record.mockResolvedValue(null);
  adminNotify.send.mockReset();
  adminNotify.send.mockResolvedValue({ ok: true });
  stripeService.isConfigured.mockReturnValue(true);
  stripeService.createUsageCheckoutSession.mockReset();
  aiMetering.summarizeUsage.mockReset();
  bustCacheSpy.mockClear();
  // Ensure the AI usage price id is set for /ai/start tests by default;
  // individual tests delete it to exercise the 503 path.
  process.env.STRIPE_PRICE_AI_USAGE = 'price_ai_test';
});

afterEach(() => {
  delete process.env.STRIPE_PRICE_AI_USAGE;
});

// ===========================================================================
// GET /api/billing/ai/status
// ===========================================================================

describe('GET /api/billing/ai/status', () => {
  test('returns full shape + threshold_pct math', async () => {
    queueAuthRow('admin');
    // SELECT organizations
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        ai_billing_status: 'active',
        ai_billing_subscription_id: 'sub_123',
        ai_billing_trial_ends_at: null,
        ai_monthly_threshold_usd: 100,
        ai_threshold_last_warned_period: null,
        ai_halted_at: null,
        ai_halted_reason: null,
        stripe_customer_id: 'cus_abc',
        updated_at: new Date().toISOString(),
      }],
    });
    // aiMetering.summarizeUsage returns the MTD shape
    aiMetering.summarizeUsage.mockResolvedValueOnce({
      total_charged_usd: 25,
      total_calls: 5,
      total_input_tokens: 1000,
      total_output_tokens: 500,
    });

    const res = await request(buildApp())
      .get('/api/billing/ai/status')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('active');
    expect(res.body.subscription_id).toBe('sub_123');
    expect(res.body.threshold_usd).toBe(100);
    expect(res.body.mtd_usage_usd).toBe(25);
    // 25/100 = 25%
    expect(res.body.threshold_pct).toBe(25);
    expect(res.body.has_stripe_customer).toBe(true);
    // STRIPE_PRICE_AI_USAGE is set in beforeEach → configured: true.
    expect(res.body.configured).toBe(true);
  });

  test('configured reflects STRIPE_PRICE_AI_USAGE env var presence', async () => {
    delete process.env.STRIPE_PRICE_AI_USAGE;
    queueAuthRow('admin');
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        ai_billing_status: 'unconfigured',
        ai_monthly_threshold_usd: 50,
        updated_at: new Date().toISOString(),
      }],
    });
    aiMetering.summarizeUsage.mockResolvedValueOnce({
      total_charged_usd: 0, total_calls: 0, total_input_tokens: 0, total_output_tokens: 0,
    });
    const res = await request(buildApp())
      .get('/api/billing/ai/status')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
  });
});

// ===========================================================================
// POST /api/billing/ai/start
// ===========================================================================

describe('POST /api/billing/ai/start', () => {
  test('503 when STRIPE_PRICE_AI_USAGE env var is unset', async () => {
    delete process.env.STRIPE_PRICE_AI_USAGE;
    queueAuthRow('admin');
    const res = await request(buildApp())
      .post('/api/billing/ai/start')
      .set('Cookie', authCookie())
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('STRIPE_PRICE_AI_USAGE_MISSING');
  });

  test('503 when stripe not configured', async () => {
    stripeService.isConfigured.mockReturnValue(false);
    queueAuthRow('admin');
    const res = await request(buildApp())
      .post('/api/billing/ai/start')
      .set('Cookie', authCookie())
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('STRIPE_NOT_CONFIGURED');
  });

  test('happy path returns Checkout URL + audits BILLING_AI_CHECKOUT_STARTED', async () => {
    queueAuthRow('admin');
    // SELECT email FROM users
    mockPool.query.mockResolvedValueOnce({ rows: [{ email: 'caller@example.com' }] });
    stripeService.createUsageCheckoutSession.mockResolvedValueOnce({
      id: 'cs_abc',
      url: 'https://checkout.stripe.com/c/abc',
    });

    const res = await request(buildApp())
      .post('/api/billing/ai/start')
      .set('Cookie', authCookie())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.url).toBe('https://checkout.stripe.com/c/abc');

    expect(stripeService.createUsageCheckoutSession).toHaveBeenCalledTimes(1);
    const checkoutArgs = stripeService.createUsageCheckoutSession.mock.calls[0][0];
    expect(checkoutArgs.customerEmail).toBe('caller@example.com');
    expect(checkoutArgs.metadata).toMatchObject({
      org_id: String(ORG_ID),
      user_id: String(USER_ID),
    });

    expect(audit.fromReq).toHaveBeenCalledTimes(1);
    expect(audit.fromReq.mock.calls[0][1].event).toBe(audit.EVENTS.BILLING_AI_CHECKOUT_STARTED);
    expect(audit.fromReq.mock.calls[0][1].meta.sessionId).toBe('cs_abc');
  });
});

// ===========================================================================
// POST /api/billing/ai/halt
//
// Flow: authMiddleware → canManageOrgBilling(req) → (if orgRole isn't
// admin/owner) → isSuperAdmin(userId). For a member with no super-admin row,
// the second pool.query (admin_users SELECT) returns empty → 403.
// ===========================================================================

describe('POST /api/billing/ai/halt', () => {
  test('403 for non-admin (member role, not super-admin)', async () => {
    queueAuthRow('member');
    queueIsSuperAdmin(false);
    const res = await request(buildApp())
      .post('/api/billing/ai/halt')
      .set('Cookie', authCookie())
      .send({});
    expect(res.status).toBe(403);
  });

  test('happy path flips status to halted, sets halt fields, busts cache, audits', async () => {
    queueAuthRow('owner');
    // owner role → canManageOrgBilling short-circuits true (no isSuperAdmin call)
    // prior SELECT ai_billing_status
    mockPool.query.mockResolvedValueOnce({ rows: [{ ai_billing_status: 'active' }] });
    // updateAiBillingStatus UPDATE
    mockPool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const res = await request(buildApp())
      .post('/api/billing/ai/halt')
      .set('Cookie', authCookie())
      .send({ reason: 'too_expensive' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('halted');
    expect(res.body.reason).toBe('too_expensive');

    // The UPDATE call set every halt field.
    const updateCall = mockPool.query.mock.calls.find(
      ([sql]) => /UPDATE organizations/i.test(sql) && /ai_billing_status/i.test(sql)
    );
    expect(updateCall).toBeDefined();
    const sql = updateCall[0];
    expect(sql).toMatch(/ai_billing_status/);
    expect(sql).toMatch(/ai_halted_at/);
    expect(sql).toMatch(/ai_halted_by_user_id/);
    expect(sql).toMatch(/ai_halted_reason/);

    expect(bustCacheSpy).toHaveBeenCalledWith(ORG_ID);

    expect(audit.fromReq).toHaveBeenCalledTimes(1);
    expect(audit.fromReq.mock.calls[0][1].event).toBe(audit.EVENTS.BILLING_AI_HALTED);
    expect(audit.fromReq.mock.calls[0][1].meta).toMatchObject({
      reason: 'too_expensive',
      prior_status: 'active',
    });
  });
});

// ===========================================================================
// POST /api/billing/ai/resume
// ===========================================================================

describe('POST /api/billing/ai/resume', () => {
  test('403 for non-admin', async () => {
    queueAuthRow('member');
    queueIsSuperAdmin(false);
    const res = await request(buildApp())
      .post('/api/billing/ai/resume')
      .set('Cookie', authCookie())
      .send({});
    expect(res.status).toBe(403);
  });

  test('restores to active when ai_billing_subscription_id is present', async () => {
    queueAuthRow('admin');
    mockPool.query.mockResolvedValueOnce({
      rows: [{ ai_billing_subscription_id: 'sub_keep' }],
    });
    mockPool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const res = await request(buildApp())
      .post('/api/billing/ai/resume')
      .set('Cookie', authCookie())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(bustCacheSpy).toHaveBeenCalledWith(ORG_ID);
    expect(audit.fromReq.mock.calls[0][1].event).toBe(audit.EVENTS.BILLING_AI_RESUMED);
    expect(audit.fromReq.mock.calls[0][1].meta.restored_status).toBe('active');
  });

  test('restores to unconfigured when no subscription id stored', async () => {
    queueAuthRow('admin');
    mockPool.query.mockResolvedValueOnce({
      rows: [{ ai_billing_subscription_id: null }],
    });
    mockPool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const res = await request(buildApp())
      .post('/api/billing/ai/resume')
      .set('Cookie', authCookie())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('unconfigured');
  });
});

// ===========================================================================
// POST /api/billing/ai/comp — super-admin only.
// ===========================================================================

describe('POST /api/billing/ai/comp', () => {
  test('403 for non-super-admin', async () => {
    queueAuthRow('admin');
    queueIsSuperAdmin(false);
    const res = await request(buildApp())
      .post('/api/billing/ai/comp')
      .set('Cookie', authCookie())
      .send({ org_id: 999 });
    expect(res.status).toBe(403);
  });

  test('400 when org_id is missing', async () => {
    queueAuthRow('admin');
    queueIsSuperAdmin(true);
    const res = await request(buildApp())
      .post('/api/billing/ai/comp')
      .set('Cookie', authCookie())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/org_id/);
  });

  test('happy path flips target org to comped', async () => {
    queueAuthRow('admin');
    queueIsSuperAdmin(true);
    // SELECT id FROM organizations
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 777 }] });
    // updateAiBillingStatus UPDATE
    mockPool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const res = await request(buildApp())
      .post('/api/billing/ai/comp')
      .set('Cookie', authCookie())
      .send({ org_id: 777 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('comped');
    expect(res.body.org_id).toBe(777);
    expect(bustCacheSpy).toHaveBeenCalledWith(777);
    expect(audit.fromReq.mock.calls[0][1].event).toBe(audit.EVENTS.BILLING_AI_COMPED);
  });
});

// ===========================================================================
// POST /api/billing/ai/start-trial — super-admin only.
// ===========================================================================

describe('POST /api/billing/ai/start-trial', () => {
  test('403 for non-super-admin', async () => {
    queueAuthRow('admin');
    queueIsSuperAdmin(false);
    const res = await request(buildApp())
      .post('/api/billing/ai/start-trial')
      .set('Cookie', authCookie())
      .send({ org_id: 1 });
    expect(res.status).toBe(403);
  });

  test('400 when org_id is missing', async () => {
    queueAuthRow('admin');
    queueIsSuperAdmin(true);
    const res = await request(buildApp())
      .post('/api/billing/ai/start-trial')
      .set('Cookie', authCookie())
      .send({ days: 7 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/org_id/);
  });

  test('days defaults to 14 when omitted; trial_ends_at is in the future', async () => {
    queueAuthRow('admin');
    queueIsSuperAdmin(true);
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 777 }] });
    mockPool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const res = await request(buildApp())
      .post('/api/billing/ai/start-trial')
      .set('Cookie', authCookie())
      .send({ org_id: 777 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('trial');
    expect(res.body.days).toBe(14);
    expect(new Date(res.body.trial_ends_at).getTime()).toBeGreaterThan(Date.now());
    expect(audit.fromReq.mock.calls[0][1].event).toBe(audit.EVENTS.BILLING_AI_TRIAL_STARTED);
  });

  test('days are clamped to 90 (high end)', async () => {
    queueAuthRow('admin');
    queueIsSuperAdmin(true);
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 777 }] });
    mockPool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const res = await request(buildApp())
      .post('/api/billing/ai/start-trial')
      .set('Cookie', authCookie())
      .send({ org_id: 777, days: 9999 });
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(90);
  });

  test('days are clamped to 1 (low end — negative input)', async () => {
    queueAuthRow('admin');
    queueIsSuperAdmin(true);
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 777 }] });
    mockPool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const res = await request(buildApp())
      .post('/api/billing/ai/start-trial')
      .set('Cookie', authCookie())
      .send({ org_id: 777, days: -5 });
    expect(res.status).toBe(200);
    // Math.max(1, Math.min(90, Number(-5) || 14)) — Number(-5) is truthy, so
    // the || 14 fallback skips; min(90,-5)=-5; max(1,-5)=1.
    expect(res.body.days).toBe(1);
  });

  test('days: 0 (falsy) → 14 default', async () => {
    queueAuthRow('admin');
    queueIsSuperAdmin(true);
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 777 }] });
    mockPool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const res = await request(buildApp())
      .post('/api/billing/ai/start-trial')
      .set('Cookie', authCookie())
      .send({ org_id: 777, days: 0 });
    expect(res.status).toBe(200);
    // Number(0) || 14 → 14 (the || fallback when input is falsy).
    expect(res.body.days).toBe(14);
  });
});

// ===========================================================================
// PATCH /api/billing/ai/threshold
// ===========================================================================

describe('PATCH /api/billing/ai/threshold', () => {
  test('403 for non-admin', async () => {
    queueAuthRow('member');
    queueIsSuperAdmin(false);
    const res = await request(buildApp())
      .patch('/api/billing/ai/threshold')
      .set('Cookie', authCookie())
      .send({ threshold_usd: 50 });
    expect(res.status).toBe(403);
  });

  test('400 when threshold_usd is out of range (negative)', async () => {
    queueAuthRow('admin');
    const res = await request(buildApp())
      .patch('/api/billing/ai/threshold')
      .set('Cookie', authCookie())
      .send({ threshold_usd: -1 });
    expect(res.status).toBe(400);
  });

  test('400 when threshold_usd is out of range (too high)', async () => {
    queueAuthRow('admin');
    const res = await request(buildApp())
      .patch('/api/billing/ai/threshold')
      .set('Cookie', authCookie())
      .send({ threshold_usd: 500000 });
    expect(res.status).toBe(400);
  });

  test('happy path updates threshold and resets last-warned period', async () => {
    queueAuthRow('admin');
    mockPool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const res = await request(buildApp())
      .patch('/api/billing/ai/threshold')
      .set('Cookie', authCookie())
      .send({ threshold_usd: 75 });

    expect(res.status).toBe(200);
    expect(res.body.threshold_usd).toBe(75);
    const updateCall = mockPool.query.mock.calls.find(
      ([sql]) => /UPDATE organizations/i.test(sql) && /ai_monthly_threshold_usd/i.test(sql)
    );
    expect(updateCall).toBeDefined();
    // The UPDATE must also reset ai_threshold_last_warned_period to NULL.
    expect(updateCall[0]).toMatch(/ai_threshold_last_warned_period/);
    expect(bustCacheSpy).toHaveBeenCalledWith(ORG_ID);
  });
});

// ===========================================================================
// GET /api/billing/ai/admin/list — super-admin only.
// ===========================================================================

describe('GET /api/billing/ai/admin/list', () => {
  test('403 for non-super-admin', async () => {
    queueAuthRow('admin');
    queueIsSuperAdmin(false);
    const res = await request(buildApp())
      .get('/api/billing/ai/admin/list')
      .set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  test('returns rows with mtd_usage_usd + threshold_pct computed', async () => {
    queueAuthRow('admin');
    queueIsSuperAdmin(true);
    // SELECT ... FROM organizations
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 1, name: 'Acme', ai_billing_status: 'active',
          ai_billing_subscription_id: 'sub_1', ai_billing_trial_ends_at: null,
          ai_monthly_threshold_usd: 100,
          ai_threshold_last_warned_period: null,
          ai_halted_at: null, ai_halted_reason: null,
          stripe_customer_id: 'cus_1',
        },
        {
          id: 2, name: 'Beta', ai_billing_status: 'comped',
          ai_billing_subscription_id: null, ai_billing_trial_ends_at: null,
          ai_monthly_threshold_usd: null, // → defaults to 50
          ai_threshold_last_warned_period: null,
          ai_halted_at: null, ai_halted_reason: null,
          stripe_customer_id: null,
        },
      ],
    });
    // Two getMtdUsageUsd lookups — one per org.
    aiMetering.summarizeUsage
      .mockResolvedValueOnce({ total_charged_usd: 25, total_calls: 3, total_input_tokens: 100, total_output_tokens: 50 })
      .mockResolvedValueOnce({ total_charged_usd: 60, total_calls: 1, total_input_tokens: 10,  total_output_tokens:  5 });

    const res = await request(buildApp())
      .get('/api/billing/ai/admin/list')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.orgs).toHaveLength(2);
    expect(res.body.orgs[0]).toMatchObject({
      id: 1, name: 'Acme', status: 'active', threshold_usd: 100,
      mtd_usage_usd: 25, threshold_pct: 25, has_stripe_customer: true,
    });
    // Beta — null threshold defaults to 50, mtd 60 > 50 → 100 clamp via Math.min(100, ...).
    expect(res.body.orgs[1].threshold_usd).toBe(50);
    expect(res.body.orgs[1].mtd_usage_usd).toBe(60);
    expect(res.body.orgs[1].threshold_pct).toBe(100);
    expect(res.body.orgs[1].has_stripe_customer).toBe(false);
  });
});
