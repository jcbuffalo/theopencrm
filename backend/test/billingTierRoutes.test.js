// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Seat-tier billing endpoints + webhook (sell-readiness fixes 2/3/5):
//   • POST /api/billing/checkout / /portal — org-admin gated (member → 403)
//   • checkout.session.completed webhook   — sets limits_tier with tier
//   • customer.subscription.updated        — tier change scoped to the org in
//     sub.metadata (never a customer-wide UPDATE when metadata is present)
//   • customer.subscription.deleted        — downgrade scoped: metadata org_id
//     when present, else stripe_customer_id AND the cancelled tier — NEVER a
//     bare customer-wide downgrade.
//
// Mocking mirrors billingAiRoutes.test.js: live pool instance patched,
// stripeService methods replaced in place, isSuperAdmin satisfied by queueing
// admin_users rows (it's a single pool.query under the hood).

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

const stripeService = require('../services/stripe');
stripeService.isConfigured          = vi.fn(() => true);
stripeService.verifyWebhook         = vi.fn();
stripeService.createCheckoutSession = vi.fn();
stripeService.createPortalSession   = vi.fn();

const audit = require('../services/audit');
audit.record  = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

const adminNotify = require('../services/adminNotify');
adminNotify.send = vi.fn().mockResolvedValue({ ok: true });

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const billingRoutes = require('../routes/billingRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 6001;
const ORG_ID  = 77;

process.env.STRIPE_PRICE_STARTER = process.env.STRIPE_PRICE_STARTER || 'price_starter_test';
process.env.STRIPE_PRICE_PRO     = process.env.STRIPE_PRICE_PRO     || 'price_pro_test';

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function buildApp() {
  const app = express();
  // Webhook route mounts its own express.raw; JSON parser for the rest.
  app.use((req, res, next) => {
    if (req.path === '/api/billing/webhook') return next();
    return express.json()(req, res, next);
  });
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/billing', billingRoutes);
  return app;
}

function queueAuthRow(role = 'owner') {
  mockPool.query.mockResolvedValueOnce({
    rows: [{ org_id: ORG_ID, org_role: role, status: 'active' }],
  });
}
function queueNotSuperAdmin() {
  mockPool.query.mockResolvedValueOnce({ rows: [] });
}
// Webhook idempotency claim (stripe_webhook_events INSERT ... RETURNING).
function queueWebhookClaim() {
  mockPool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ event_id: 'evt_1' }] });
}
function findCall(re) {
  return mockPool.query.mock.calls.find(([sql]) => typeof sql === 'string' && re.test(sql));
}

async function postWebhook(app, event) {
  stripeService.verifyWebhook.mockReturnValueOnce(event);
  return request(app)
    .post('/api/billing/webhook')
    .set('stripe-signature', 'sig_test')
    .set('content-type', 'application/json')
    .send(JSON.stringify(event));
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  stripeService.isConfigured.mockReturnValue(true);
  stripeService.verifyWebhook.mockReset();
  stripeService.createCheckoutSession.mockReset();
  stripeService.createPortalSession.mockReset();
  audit.record.mockClear();
  audit.fromReq.mockClear();
});

describe('org-admin gate on seat-tier billing routes', () => {
  test('POST /checkout as plain member → 403 ADMIN_REQUIRED', async () => {
    queueAuthRow('member');
    queueNotSuperAdmin();
    const res = await request(buildApp())
      .post('/api/billing/checkout')
      .set('Cookie', authCookie())
      .send({ tier: 'starter' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');
    expect(stripeService.createCheckoutSession).not.toHaveBeenCalled();
  });

  test('POST /checkout as owner → creates checkout session', async () => {
    queueAuthRow('owner');
    // route: SELECT email FROM users
    mockPool.query.mockResolvedValueOnce({ rows: [{ email: 'o@x.com' }] });
    stripeService.createCheckoutSession.mockResolvedValueOnce({ id: 'cs_1', url: 'https://stripe.test/cs_1' });
    const res = await request(buildApp())
      .post('/api/billing/checkout')
      .set('Cookie', authCookie())
      .send({ tier: 'starter' });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://stripe.test/cs_1');
    const args = stripeService.createCheckoutSession.mock.calls[0][0];
    expect(args.metadata).toMatchObject({ org_id: String(ORG_ID), tier: 'starter' });
  });

  test('POST /portal as plain member → 403 ADMIN_REQUIRED', async () => {
    queueAuthRow('member');
    queueNotSuperAdmin();
    const res = await request(buildApp())
      .post('/api/billing/portal')
      .set('Cookie', authCookie())
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');
    expect(stripeService.createPortalSession).not.toHaveBeenCalled();
  });

  test('POST /portal as admin → returns portal URL', async () => {
    queueAuthRow('admin');
    mockPool.query.mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_1' }] });
    stripeService.createPortalSession.mockResolvedValueOnce({ url: 'https://stripe.test/portal' });
    const res = await request(buildApp())
      .post('/api/billing/portal')
      .set('Cookie', authCookie())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://stripe.test/portal');
  });
});

describe('webhook — limits_tier + scoped tier changes', () => {
  test('checkout.session.completed sets tier AND limits_tier for the org', async () => {
    queueWebhookClaim();
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // the UPDATE
    const res = await postWebhook(buildApp(), {
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_2', customer: 'cus_9', metadata: { org_id: String(ORG_ID), tier: 'pro' } } },
    });
    expect(res.status).toBe(200);
    const call = findCall(/UPDATE organizations/);
    expect(call).toBeDefined();
    expect(call[0]).toMatch(/limits_tier = \$1/);
    expect(call[1]).toEqual(['pro', 'cus_9', ORG_ID]);
  });

  test('subscription.updated with metadata.org_id scopes the tier change to that org', async () => {
    queueWebhookClaim();
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: ORG_ID }], rowCount: 1 }); // the UPDATE
    const res = await postWebhook(buildApp(), {
      id: 'evt_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          status: 'active',
          customer: 'cus_shared',
          metadata: { org_id: String(ORG_ID) },
          items: { data: [{ price: { id: process.env.STRIPE_PRICE_PRO } }] },
        },
      },
    });
    expect(res.status).toBe(200);
    const call = findCall(/UPDATE organizations SET tier = \$1, limits_tier = \$1/);
    expect(call).toBeDefined();
    expect(call[0]).toMatch(/WHERE id = \$2/);
    expect(call[1]).toEqual(['pro', ORG_ID]);
  });

  test('subscription.deleted with metadata.org_id downgrades ONLY that org', async () => {
    queueWebhookClaim();
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: ORG_ID }], rowCount: 1 });
    const res = await postWebhook(buildApp(), {
      id: 'evt_1',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_1',
          customer: 'cus_shared',
          metadata: { org_id: String(ORG_ID) },
          items: { data: [{ price: { id: process.env.STRIPE_PRICE_STARTER } }] },
        },
      },
    });
    expect(res.status).toBe(200);
    const call = findCall(/SET tier = 'free', limits_tier = 'free'/);
    expect(call).toBeDefined();
    expect(call[0]).toMatch(/WHERE id = \$1/);
    expect(call[1]).toEqual([ORG_ID]);
  });

  test('legacy subscription.deleted (no metadata) matches customer AND cancelled tier — never customer-wide', async () => {
    queueWebhookClaim();
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: ORG_ID }], rowCount: 1 });
    const res = await postWebhook(buildApp(), {
      id: 'evt_1',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_legacy',
          customer: 'cus_shared',
          metadata: {},
          items: { data: [{ price: { id: process.env.STRIPE_PRICE_STARTER } }] },
        },
      },
    });
    expect(res.status).toBe(200);
    const call = findCall(/SET tier = 'free', limits_tier = 'free'/);
    expect(call).toBeDefined();
    expect(call[0]).toMatch(/WHERE stripe_customer_id = \$1 AND tier = \$2/);
    expect(call[1]).toEqual(['cus_shared', 'starter']);
  });

  test('subscription.deleted for an unrelated (non-tier) price touches nothing', async () => {
    queueWebhookClaim();
    const res = await postWebhook(buildApp(), {
      id: 'evt_1',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_other',
          customer: 'cus_shared',
          metadata: {},
          items: { data: [{ price: { id: 'price_something_else' } }] },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(findCall(/SET tier = 'free'/)).toBeUndefined();
  });
});
