// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Record ownership (migration 135) — route tests for companies + deals.
//
// Covers:
//   * owner_user_id persists on create + update for BOTH entities
//   * ?owner=me narrows the list to the caller's records (ANDed with org scope)
//   * ?owner=<id> filters to that user; garbage values are ignored
//   * an owner outside the caller's org is rejected with 400 (no write issued)
//   * personal (user_id-scoped) workspaces may only self-assign
//   * org isolation is preserved: the scope value is threaded into every query
//
// Test style mirrors contactCadence.test.js: the pg pool is fully mocked and
// each pool.query call resolves the next queued response in the order the
// route issues them. Deal create runs in a transaction — pool.connect is
// mocked to a client that reuses the same mocked pool.query (the
// dataQuality.test.js pattern), and the v2 dual-write hook is stubbed.
//
// Query order per request: 1. authMiddleware (SELECT org_id, org_role, status
// FROM users), 2. the owner in-org membership check (only when an owner is in
// the body), then the route's own queries.

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const companyRoutes = require('../routes/companyRoutes');
const dealRoutes = require('../routes/dealRoutes');
const v2DualWrite = require('../services/v2DualWrite');
const pipelines = require('../services/pipelines');
const webhookDispatcher = require('../services/webhookDispatcher');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 4242;
const OTHER_MEMBER_ID = 5;
const ORG_ID = 7;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/companies', companyRoutes);
  app.use('/api/deals', dealRoutes);
  return app;
}

// authMiddleware issues SELECT org_id, org_role, status FROM users WHERE id=$1.
function queueAuthRow(orgId = ORG_ID) {
  mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: orgId, org_role: 'member', status: 'active' }] });
}

// The recordOwnership in-org membership check: SELECT id FROM users WHERE id AND org_id.
function queueOwnerIsMember() {
  mockPool.query.mockResolvedValueOnce({ rows: [{ id: OTHER_MEMBER_ID }] });
}
function queueOwnerNotMember() {
  mockPool.query.mockResolvedValueOnce({ rows: [] });
}

function findCall(re) {
  return mockPool.query.mock.calls.find(([sql]) => typeof sql === 'string' && re.test(sql));
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.query.mockResolvedValue({ rows: [] });
  mockPool.connect.mockReset();
  // Transactional handlers get a "client" that routes through the same mocked
  // pool.query, so queued responses cover BEGIN / INSERT / COMMIT too.
  mockPool.connect.mockImplementation(async () => ({ query: mockPool.query, release: () => {} }));
  // Deal create's v2 dual-write + webhook side effects are not under test.
  vi.spyOn(v2DualWrite, 'onDealCreated').mockResolvedValue(null);
  // Deal create resolves the org's effective pipeline (migration 155) before
  // the txn; this suite's pool mock is ORDER-based, so answer it off-DB.
  vi.spyOn(pipelines, 'getEffectivePipeline').mockResolvedValue({
    profile: 'generic', is_custom: false, stages: pipelines.defaultStagesFor('generic'), phases: [], default_stage: 'lead',
  });
  vi.spyOn(webhookDispatcher, 'dispatch').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Companies — owner persists on create / update
// ---------------------------------------------------------------------------
describe('POST /api/companies owner_user_id', () => {
  test('persists an in-org owner on create', async () => {
    queueAuthRow();
    queueOwnerIsMember();
    // duplicate soft-check → no matches (default {rows: []} would also do)
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // INSERT
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'Acme', owner_user_id: OTHER_MEMBER_ID }] });

    const res = await request(buildApp())
      .post('/api/companies')
      .set('Cookie', authCookie())
      .send({ name: 'Acme', owner_user_id: OTHER_MEMBER_ID });

    expect(res.status).toBe(201);
    expect(res.body.owner_user_id).toBe(OTHER_MEMBER_ID);

    // Membership check ran against the caller's org.
    const member = findCall(/SELECT id FROM users WHERE id = \$1 AND org_id = \$2/);
    expect(member).toBeTruthy();
    expect(member[1]).toEqual([OTHER_MEMBER_ID, ORG_ID]);

    // INSERT carries the owner column + value.
    const insert = findCall(/INSERT INTO companies/);
    expect(insert[0]).toMatch(/owner_user_id/);
    expect(insert[1]).toContain(OTHER_MEMBER_ID);
  });

  test('rejects an owner outside the caller org with 400 and never writes', async () => {
    queueAuthRow();
    queueOwnerNotMember();

    const res = await request(buildApp())
      .post('/api/companies')
      .set('Cookie', authCookie())
      .send({ name: 'Acme', owner_user_id: 999 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/member of your organization/);
    expect(findCall(/INSERT INTO companies/)).toBeUndefined();
  });

  test('personal workspace (no org) may only self-assign', async () => {
    queueAuthRow(null); // user has no org → user_id scope

    const res = await request(buildApp())
      .post('/api/companies')
      .set('Cookie', authCookie())
      .send({ name: 'Solo Co', owner_user_id: OTHER_MEMBER_ID });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/your own user id/);
    expect(findCall(/INSERT INTO companies/)).toBeUndefined();
  });
});

describe('PUT /api/companies/:id owner_user_id', () => {
  test('persists an in-org owner on update (COALESCE keeps other fields)', async () => {
    queueAuthRow();
    queueOwnerIsMember();
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 3, name: 'Acme', owner_user_id: OTHER_MEMBER_ID }] });

    const res = await request(buildApp())
      .put('/api/companies/3')
      .set('Cookie', authCookie())
      .send({ owner_user_id: OTHER_MEMBER_ID });

    expect(res.status).toBe(200);
    const update = findCall(/UPDATE companies SET/);
    expect(update[0]).toMatch(/owner_user_id = COALESCE\(\$15, owner_user_id\)/);
    // Org isolation on the write: scope value is in the params.
    expect(update[1]).toContain(ORG_ID);
    expect(update[1][14]).toBe(OTHER_MEMBER_ID);
  });

  test('rejects a foreign-org owner on update', async () => {
    queueAuthRow();
    queueOwnerNotMember();

    const res = await request(buildApp())
      .put('/api/companies/3')
      .set('Cookie', authCookie())
      .send({ owner_user_id: 999 });

    expect(res.status).toBe(400);
    expect(findCall(/UPDATE companies SET/)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Companies — ?owner= list filter
// ---------------------------------------------------------------------------
describe('GET /api/companies?owner=', () => {
  test('owner=me filters to the caller AND keeps the org scope', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .get('/api/companies?owner=me')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/org_id = \$1/);
    expect(sql).toMatch(/owner_user_id = \$2/);
    expect(params).toEqual([ORG_ID, USER_ID]);
  });

  test('owner=<id> filters to that user within the org scope', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await request(buildApp())
      .get(`/api/companies?owner=${OTHER_MEMBER_ID}`)
      .set('Cookie', authCookie());

    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/owner_user_id = \$2/);
    expect(params).toEqual([ORG_ID, OTHER_MEMBER_ID]);
  });

  test('a non-numeric owner value is ignored (no owner clause)', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await request(buildApp())
      .get('/api/companies?owner=abc')
      .set('Cookie', authCookie());

    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).not.toMatch(/owner_user_id/);
    expect(params).toEqual([ORG_ID]);
  });

  test('owner=me in a personal workspace scopes by user_id + owner', async () => {
    queueAuthRow(null);
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await request(buildApp())
      .get('/api/companies?owner=me')
      .set('Cookie', authCookie());

    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/user_id = \$1/);
    expect(sql).toMatch(/owner_user_id = \$2/);
    expect(params).toEqual([USER_ID, USER_ID]);
  });
});

// ---------------------------------------------------------------------------
// Deals — owner persists on create / update
// ---------------------------------------------------------------------------
describe('POST /api/deals owner_user_id', () => {
  test('persists an in-org owner on create (inside the txn)', async () => {
    queueAuthRow();
    queueOwnerIsMember();
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // BEGIN
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 10, title: 'Big Deal', stage: 'TRIAGE', owner_user_id: OTHER_MEMBER_ID }] }); // INSERT
    // COMMIT falls through to the default {rows: []}

    const res = await request(buildApp())
      .post('/api/deals')
      .set('Cookie', authCookie())
      .send({ title: 'Big Deal', owner_user_id: OTHER_MEMBER_ID });

    expect(res.status).toBe(201);
    expect(res.body.owner_user_id).toBe(OTHER_MEMBER_ID);

    const insert = findCall(/INSERT INTO deals/);
    expect(insert[0]).toMatch(/owner_user_id/);
    // owner is the last INSERT param ($27).
    expect(insert[1][insert[1].length - 1]).toBe(OTHER_MEMBER_ID);
  });

  test('rejects a foreign-org owner BEFORE the transaction opens', async () => {
    queueAuthRow();
    queueOwnerNotMember();

    const res = await request(buildApp())
      .post('/api/deals')
      .set('Cookie', authCookie())
      .send({ title: 'Big Deal', owner_user_id: 999 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/member of your organization/);
    expect(findCall(/INSERT INTO deals/)).toBeUndefined();
    expect(findCall(/^BEGIN$/)).toBeUndefined();
  });
});

describe('PUT /api/deals/:id owner_user_id', () => {
  test('persists an in-org owner on update', async () => {
    queueAuthRow();
    queueOwnerIsMember();
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 10, title: 'Big Deal', owner_user_id: OTHER_MEMBER_ID }] });

    const res = await request(buildApp())
      .put('/api/deals/10')
      .set('Cookie', authCookie())
      .send({ owner_user_id: OTHER_MEMBER_ID });

    expect(res.status).toBe(200);
    const update = findCall(/UPDATE deals SET/);
    expect(update[0]).toMatch(/owner_user_id = COALESCE\(\$32, owner_user_id\)/);
    expect(update[1]).toContain(ORG_ID);
    expect(update[1][31]).toBe(OTHER_MEMBER_ID);
  });

  test('rejects a foreign-org owner on update', async () => {
    queueAuthRow();
    queueOwnerNotMember();

    const res = await request(buildApp())
      .put('/api/deals/10')
      .set('Cookie', authCookie())
      .send({ owner_user_id: 999 });

    expect(res.status).toBe(400);
    expect(findCall(/UPDATE deals SET/)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Deals — ?owner= list filter
// ---------------------------------------------------------------------------
describe('GET /api/deals?owner=', () => {
  test('owner=me filters to the caller AND keeps the org scope', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .get('/api/deals?owner=me')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/d\.org_id = \$1/);
    expect(sql).toMatch(/d\.owner_user_id = \$2/);
    expect(params).toEqual([ORG_ID, USER_ID]);
  });

  test('owner=<id> filters to that user; owner name is joined for display', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await request(buildApp())
      .get(`/api/deals?owner=${OTHER_MEMBER_ID}`)
      .set('Cookie', authCookie());

    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/d\.owner_user_id = \$2/);
    expect(sql).toMatch(/LEFT JOIN users uo\s+ON d\.owner_user_id = uo\.id/);
    expect(sql).toMatch(/uo\.name AS owner_name/);
    expect(params).toEqual([ORG_ID, OTHER_MEMBER_ID]);
  });

  test('no owner param → unchanged org-scoped list (isolation preserved)', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await request(buildApp())
      .get('/api/deals')
      .set('Cookie', authCookie());

    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/d\.org_id = \$1/);
    expect(sql).not.toMatch(/d\.owner_user_id = \$/);
    expect(params).toEqual([ORG_ID]);
  });
});
