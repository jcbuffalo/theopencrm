// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Tier & seat enforcement (migration 136) — THE SAFETY CONTRACT TESTS.
//
// This gate runs live against real production orgs, so the fail-open cases
// are the point of this file, not an afterthought:
//   * comped org (ai_billing_status='comped')   → NEVER blocked
//   * paid org   (ai_billing_status='active')   → NEVER blocked
//   * super-admin caller                        → NEVER blocked
//   * org with NO limits_tier assigned (NULL)   → NEVER blocked, and no
//     count query is even issued (inert)
//   * unknown/garbage limits_tier value         → NEVER blocked
//   * DB error during the org lookup            → NEVER blocked (fail open)
// Enforcement fires ONLY for an org explicitly on a capped tier, at/over its
// cap, and the 402 body carries the upgrade shape
// ({ success:false, error, code:'TIER_LIMIT_EXCEEDED', action:'upgrade',
//    details:{ orgId, tier, metric, limit, current } }).
//
// Test style mirrors recordOwnership.test.js: the pg pool is fully mocked
// and each pool.query call resolves the next queued response in the order
// the route issues them. Deal create's txn client reuses the mocked
// pool.query; the v2 dual-write + webhook hooks are stubbed.
//
// BYPASS GATE: tierLimits.js is inert under NODE_ENV=test unless
// TIER_ENFORCEMENT_IN_TESTS='true' (same pattern as requireAiBilling.js).
// We flip it on in beforeEach and off in afterEach so the other route
// suites' queued mocks are untouched.
//
// Query order per gated create request:
//   1. authMiddleware  — SELECT org_id, org_role, status FROM users
//   2. super-admin     — SELECT role FROM admin_users
//   3. org limits row  — SELECT id, limits_tier, ai_billing_status
//   4. count           — ONLY when the resolved cap is finite
//   5. the route's own queries (duplicate soft-check, INSERT, …)

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const contactRoutes = require('../routes/contactRoutes');
const companyRoutes = require('../routes/companyRoutes');
const dealRoutes = require('../routes/dealRoutes');
const orgRoutes = require('../routes/orgRoutes');
const v2DualWrite = require('../services/v2DualWrite');
const pipelines = require('../services/pipelines');
const webhookDispatcher = require('../services/webhookDispatcher');
const tierLimits = require('../services/tierLimits');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 4242;
const ORG_ID = 7;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/contacts', contactRoutes);
  app.use('/api/companies', companyRoutes);
  app.use('/api/deals', dealRoutes);
  app.use('/api/org', orgRoutes);
  return app;
}

// 1. authMiddleware — the invite flow additionally needs org_role='owner'.
function queueAuthRow({ orgId = ORG_ID, orgRole = 'member' } = {}) {
  mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: orgId, org_role: orgRole, status: 'active' }] });
}
// 2. super-admin lookup (SELECT role FROM admin_users).
function queueNotSuperAdmin() {
  mockPool.query.mockResolvedValueOnce({ rows: [] });
}
function queueSuperAdmin() {
  mockPool.query.mockResolvedValueOnce({ rows: [{ role: 'super_admin' }] });
}
// 3. org limits row.
function queueOrgLimits({ limits_tier = null, ai_billing_status = 'unconfigured' } = {}) {
  mockPool.query.mockResolvedValueOnce({ rows: [{ id: ORG_ID, limits_tier, ai_billing_status }] });
}
// 4. record count.
function queueCount(n) {
  mockPool.query.mockResolvedValueOnce({ rows: [{ c: n }] });
}
function queueSeatCount(n) {
  mockPool.query.mockResolvedValueOnce({ rows: [{ seats: n }] });
}

function findCall(re) {
  return mockPool.query.mock.calls.find(([sql]) => typeof sql === 'string' && re.test(sql));
}

function expectUpgradeShape(body, metric, limit, current) {
  expect(body).toMatchObject({
    success: false,
    code: 'TIER_LIMIT_EXCEEDED',
    action: 'upgrade',
    details: { orgId: ORG_ID, metric, limit, current },
  });
  expect(body.error).toMatch(/[Uu]pgrade/);
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.query.mockResolvedValue({ rows: [] });
  mockPool.connect.mockReset();
  mockPool.connect.mockImplementation(async () => ({ query: mockPool.query, release: () => {} }));
  vi.spyOn(v2DualWrite, 'onDealCreated').mockResolvedValue(null);
  // Deal create resolves the org's effective pipeline (migration 155) before
  // the txn; this suite's pool mock is ORDER-based, so answer it off-DB.
  vi.spyOn(pipelines, 'getEffectivePipeline').mockResolvedValue({
    profile: 'generic', is_custom: false, stages: pipelines.defaultStagesFor('generic'), phases: [], default_stage: 'lead',
  });
  vi.spyOn(webhookDispatcher, 'dispatch').mockImplementation(() => {});
  // Force the gate to run under vitest (default test env is bypassed).
  process.env.TIER_ENFORCEMENT_IN_TESTS = 'true';
});

afterEach(() => {
  delete process.env.TIER_ENFORCEMENT_IN_TESTS;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// FAIL-OPEN / EXEMPTION CASES — no production org may ever be blocked.
// ---------------------------------------------------------------------------
describe('SAFETY: exempt orgs are NEVER blocked on create', () => {
  test('comped org (comped-customer) creates a contact even on a capped tier', async () => {
    queueAuthRow();
    queueNotSuperAdmin();
    queueOrgLimits({ limits_tier: 'free', ai_billing_status: 'comped' });
    // no count query expected → next queued rows serve the route itself
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // dup check (email)
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // dup check (name)
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1, first_name: 'A', last_name: 'B' }] }); // INSERT

    const res = await request(buildApp())
      .post('/api/contacts')
      .set('Cookie', authCookie())
      .send({ first_name: 'A', last_name: 'B' });

    expect(res.status).toBe(201);
    // Comped short-circuits BEFORE any counting — no COUNT query issued.
    expect(findCall(/COUNT\(\*\).*FROM contacts/s)).toBeUndefined();
  });

  test('paid org (ai_billing_status=active) creates a company on a capped tier', async () => {
    queueAuthRow();
    queueNotSuperAdmin();
    queueOrgLimits({ limits_tier: 'free', ai_billing_status: 'active' });
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // dup check
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 2, name: 'Acme' }] }); // INSERT

    const res = await request(buildApp())
      .post('/api/companies')
      .set('Cookie', authCookie())
      .send({ name: 'Acme' });

    expect(res.status).toBe(201);
    expect(findCall(/COUNT\(\*\).*FROM companies/s)).toBeUndefined();
  });

  test('super-admin caller bypasses before the org row is even read', async () => {
    queueAuthRow();
    queueSuperAdmin();
    // gate exits here → org-limits SELECT never runs
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // dup check (email)
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // dup check (name)
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 3, first_name: 'S', last_name: 'A' }] }); // INSERT

    const res = await request(buildApp())
      .post('/api/contacts')
      .set('Cookie', authCookie())
      .send({ first_name: 'S', last_name: 'A' });

    expect(res.status).toBe(201);
    expect(findCall(/SELECT id, limits_tier, ai_billing_status/)).toBeUndefined();
  });

  test('org with NO limits_tier (NULL — every org today) is inert: no count, create succeeds', async () => {
    queueAuthRow();
    queueNotSuperAdmin();
    queueOrgLimits({ limits_tier: null, ai_billing_status: 'unconfigured' });
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // dup check (email)
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // dup check (name)
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 4, first_name: 'N', last_name: 'T' }] }); // INSERT

    const res = await request(buildApp())
      .post('/api/contacts')
      .set('Cookie', authCookie())
      .send({ first_name: 'N', last_name: 'T' });

    expect(res.status).toBe(201);
    expect(findCall(/COUNT\(\*\).*FROM contacts/s)).toBeUndefined();
  });

  test('unknown/garbage limits_tier value fails open', async () => {
    queueAuthRow();
    queueNotSuperAdmin();
    queueOrgLimits({ limits_tier: 'platinum', ai_billing_status: 'unconfigured' });
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // dup check
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 5, name: 'Zeta' }] }); // INSERT

    const res = await request(buildApp())
      .post('/api/companies')
      .set('Cookie', authCookie())
      .send({ name: 'Zeta' });

    expect(res.status).toBe(201);
    expect(findCall(/COUNT\(\*\).*FROM companies/s)).toBeUndefined();
  });

  test('DB error during the org-limits lookup fails OPEN (create still succeeds)', async () => {
    queueAuthRow();
    queueNotSuperAdmin();
    mockPool.query.mockRejectedValueOnce(new Error('connection reset')); // org limits SELECT blows up
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // dup check
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 6, name: 'Resilient Inc' }] }); // INSERT

    const res = await request(buildApp())
      .post('/api/companies')
      .set('Cookie', authCookie())
      .send({ name: 'Resilient Inc' });

    expect(res.status).toBe(201);
  });

  test('DB error during the COUNT fails OPEN even on a capped tier at limit', async () => {
    queueAuthRow();
    queueNotSuperAdmin();
    queueOrgLimits({ limits_tier: 'free' });
    mockPool.query.mockRejectedValueOnce(new Error('count timeout')); // COUNT blows up
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // dup check
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 7, name: 'Still Works' }] }); // INSERT

    const res = await request(buildApp())
      .post('/api/companies')
      .set('Cookie', authCookie())
      .send({ name: 'Still Works' });

    expect(res.status).toBe(201);
  });

  test('personal (no-org) workspace is never gated — no admin/org/count queries', async () => {
    queueAuthRow({ orgId: null });
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // dup check (email)
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // dup check (name)
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 8, first_name: 'P', last_name: 'W' }] }); // INSERT

    const res = await request(buildApp())
      .post('/api/contacts')
      .set('Cookie', authCookie())
      .send({ first_name: 'P', last_name: 'W' });

    expect(res.status).toBe(201);
    expect(findCall(/FROM admin_users/)).toBeUndefined();
    expect(findCall(/SELECT id, limits_tier, ai_billing_status/)).toBeUndefined();
  });
});

describe('SAFETY: exempt orgs are NEVER blocked on invite', () => {
  test('comped org invites past any seat number', async () => {
    queueAuthRow({ orgRole: 'owner' });
    queueNotSuperAdmin();
    queueOrgLimits({ limits_tier: 'starter', ai_billing_status: 'comped' });
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // existing-user check
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // cancel stale invites
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1, email: 'new@x.com' }] }); // INSERT invite

    const res = await request(buildApp())
      .post('/api/org/invite')
      .set('Cookie', authCookie())
      .send({ email: 'new@x.com' });

    expect(res.status).toBe(201);
    expect(findCall(/AS seats/)).toBeUndefined(); // seat counting never ran
  });

  test('no-tier org invites freely (inert default)', async () => {
    queueAuthRow({ orgRole: 'owner' });
    queueNotSuperAdmin();
    queueOrgLimits({ limits_tier: null });
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // existing-user check
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // cancel stale invites
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 2, email: 'more@x.com' }] }); // INSERT invite

    const res = await request(buildApp())
      .post('/api/org/invite')
      .set('Cookie', authCookie())
      .send({ email: 'more@x.com' });

    expect(res.status).toBe(201);
    expect(findCall(/AS seats/)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ENFORCED CASES — explicit capped tier, not exempt.
// ---------------------------------------------------------------------------
describe('explicitly capped tier at its limit → 402 upgrade shape', () => {
  test('free tier at 100 contacts blocks the 101st with the upgrade shape', async () => {
    queueAuthRow();
    queueNotSuperAdmin();
    queueOrgLimits({ limits_tier: 'free' });
    queueCount(100);

    const res = await request(buildApp())
      .post('/api/contacts')
      .set('Cookie', authCookie())
      .send({ first_name: 'Over', last_name: 'Cap' });

    expect(res.status).toBe(402);
    expectUpgradeShape(res.body, 'contacts', 100, 100);
    expect(res.body.details.tier).toBe('free');
    expect(findCall(/INSERT INTO contacts/)).toBeUndefined(); // never writes
  });

  test('free tier under the cap (99/100) creates normally', async () => {
    queueAuthRow();
    queueNotSuperAdmin();
    queueOrgLimits({ limits_tier: 'free' });
    queueCount(99);
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // dup check (email)
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // dup check (name)
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 9, first_name: 'Under', last_name: 'Cap' }] }); // INSERT

    const res = await request(buildApp())
      .post('/api/contacts')
      .set('Cookie', authCookie())
      .send({ first_name: 'Under', last_name: 'Cap' });

    expect(res.status).toBe(201);
  });

  test('the record count is org-scoped (org isolation preserved)', async () => {
    queueAuthRow();
    queueNotSuperAdmin();
    queueOrgLimits({ limits_tier: 'free' });
    queueCount(100);

    await request(buildApp())
      .post('/api/contacts')
      .set('Cookie', authCookie())
      .send({ first_name: 'Scope', last_name: 'Check' });

    const count = findCall(/COUNT\(\*\).*FROM contacts/s);
    expect(count).toBeTruthy();
    expect(count[0]).toMatch(/WHERE org_id = \$1/);
    expect(count[1]).toEqual([ORG_ID]);
  });

  test('free tier at 10 deals blocks the 11th BEFORE the transaction opens', async () => {
    queueAuthRow();
    queueNotSuperAdmin();
    queueOrgLimits({ limits_tier: 'free' });
    queueCount(10);

    const res = await request(buildApp())
      .post('/api/deals')
      .set('Cookie', authCookie())
      .send({ title: 'Deal 11' });

    expect(res.status).toBe(402);
    expectUpgradeShape(res.body, 'deals', 10, 10);
    expect(findCall(/INSERT INTO deals/)).toBeUndefined();
    expect(findCall(/^BEGIN$/)).toBeUndefined();
  });

  test('free tier under the deal cap creates normally', async () => {
    queueAuthRow();
    queueNotSuperAdmin();
    queueOrgLimits({ limits_tier: 'free' });
    queueCount(3);
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // BEGIN
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 11, title: 'Deal 4', stage: 'TRIAGE' }] }); // INSERT
    // COMMIT falls through to the default {rows: []}

    const res = await request(buildApp())
      .post('/api/deals')
      .set('Cookie', authCookie())
      .send({ title: 'Deal 4' });

    expect(res.status).toBe(201);
  });

  test('starter tier at 10 seats blocks the 11th invite with the upgrade shape', async () => {
    queueAuthRow({ orgRole: 'owner' });
    queueNotSuperAdmin();
    queueOrgLimits({ limits_tier: 'starter' });
    queueSeatCount(10);

    const res = await request(buildApp())
      .post('/api/org/invite')
      .set('Cookie', authCookie())
      .send({ email: 'eleventh@x.com' });

    expect(res.status).toBe(402);
    expectUpgradeShape(res.body, 'seats', 10, 10);
    expect(res.body.details.tier).toBe('starter');
    expect(findCall(/INSERT INTO org_invites/)).toBeUndefined(); // never writes

    // Seat counting is org-scoped and includes pending invites.
    const seats = findCall(/AS seats/);
    expect(seats[0]).toMatch(/FROM users\s+WHERE org_id = \$1/);
    expect(seats[0]).toMatch(/FROM org_invites\s+WHERE org_id = \$1/);
    expect(seats[1]).toEqual([ORG_ID]);
  });

  test('starter tier under the seat cap (9/10) invites normally', async () => {
    queueAuthRow({ orgRole: 'owner' });
    queueNotSuperAdmin();
    queueOrgLimits({ limits_tier: 'starter' });
    queueSeatCount(9);
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // existing-user check
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // cancel stale invites
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 3, email: 'tenth@x.com' }] }); // INSERT invite

    const res = await request(buildApp())
      .post('/api/org/invite')
      .set('Cookie', authCookie())
      .send({ email: 'tenth@x.com' });

    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Unit checks on the exemption ladder (limitFor is the single decision point).
// ---------------------------------------------------------------------------
describe('tierLimits.limitFor exemption ladder', () => {
  test('null org / comped / active / no-tier / unknown tier → UNLIMITED', () => {
    expect(tierLimits.limitFor(null, 'contacts')).toBe(tierLimits.UNLIMITED);
    expect(tierLimits.limitFor({ id: 1, limits_tier: 'free', ai_billing_status: 'comped' }, 'contacts')).toBe(tierLimits.UNLIMITED);
    expect(tierLimits.limitFor({ id: 1, limits_tier: 'free', ai_billing_status: 'active' }, 'contacts')).toBe(tierLimits.UNLIMITED);
    expect(tierLimits.limitFor({ id: 1, limits_tier: null, ai_billing_status: 'unconfigured' }, 'contacts')).toBe(tierLimits.UNLIMITED);
    expect(tierLimits.limitFor({ id: 1, limits_tier: 'diamond', ai_billing_status: 'unconfigured' }, 'contacts')).toBe(tierLimits.UNLIMITED);
  });

  test('explicit capped tiers resolve their PRICING_AND_FEATURES caps', () => {
    const freeOrg = { id: 1, limits_tier: 'free', ai_billing_status: 'unconfigured' };
    expect(tierLimits.limitFor(freeOrg, 'seats')).toBe(1);
    expect(tierLimits.limitFor(freeOrg, 'contacts')).toBe(100);
    expect(tierLimits.limitFor(freeOrg, 'deals')).toBe(10);
    const starterOrg = { id: 1, limits_tier: 'starter', ai_billing_status: 'unconfigured' };
    expect(tierLimits.limitFor(starterOrg, 'seats')).toBe(10);
    expect(tierLimits.limitFor(starterOrg, 'contacts')).toBe(tierLimits.UNLIMITED);
    const proOrg = { id: 1, limits_tier: 'pro', ai_billing_status: 'unconfigured' };
    expect(tierLimits.limitFor(proOrg, 'seats')).toBe(50);
    const entOrg = { id: 1, limits_tier: 'enterprise', ai_billing_status: 'unconfigured' };
    expect(tierLimits.limitFor(entOrg, 'seats')).toBe(tierLimits.UNLIMITED);
  });

  test('unknown resource on a capped tier → UNLIMITED (fail open)', () => {
    const freeOrg = { id: 1, limits_tier: 'free', ai_billing_status: 'unconfigured' };
    expect(tierLimits.limitFor(freeOrg, 'widgets')).toBe(tierLimits.UNLIMITED);
  });
});

// ---------------------------------------------------------------------------
// Default-bypass regression guard: with the env var unset (how every OTHER
// test file runs), the gate must issue zero queries.
// ---------------------------------------------------------------------------
describe('NODE_ENV=test default bypass', () => {
  test('without TIER_ENFORCEMENT_IN_TESTS the gate is a no-op', async () => {
    delete process.env.TIER_ENFORCEMENT_IN_TESTS;
    queueAuthRow();
    // Straight to the route's own queries — no admin_users / limits queries.
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // dup check (email)
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // dup check (name)
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 12, first_name: 'By', last_name: 'Pass' }] }); // INSERT

    const res = await request(buildApp())
      .post('/api/contacts')
      .set('Cookie', authCookie())
      .send({ first_name: 'By', last_name: 'Pass' });

    expect(res.status).toBe(201);
    expect(findCall(/FROM admin_users/)).toBeUndefined();
    expect(findCall(/limits_tier/)).toBeUndefined();
  });
});
