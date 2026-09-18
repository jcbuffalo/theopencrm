// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Relationship Segments — compiler + route tests.
//
// Part 1 exercises services/segments.compileCriteria directly: the allowlist
// is the security boundary (user JSON → SQL), so we verify it rejects every
// non-allowlisted field/op/value shape and that compiled SQL carries user
// values ONLY as parameters (never in the text).
//
// Part 2 mounts segmentRoutes against a tiny Express app with the pg pool
// fully mocked (companyLifecycleStage.test.js pattern): each pool.query call
// resolves the next queued response in route-issue order. authMiddleware's
// user lookup is always query #1. featureFlags.hasFeature is stubbed ON;
// audit.fromReq is stubbed so the fire-and-forget audit write doesn't consume
// mocked pool responses.

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const segments = require('../services/segments');
const segmentRoutes = require('../routes/segmentRoutes');
const featureFlags = require('../services/featureFlags');
const audit = require('../services/audit');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const { compileCriteria, CriteriaError } = segments;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/segments', segmentRoutes);
  return app;
}

const USER_ID = 4242;
const ORG_ID = 7;
const SEGMENT_ID = 12;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

// authMiddleware response — role is per-test (member vs admin).
function authRow(role = 'member') {
  return { rows: [{ org_id: ORG_ID, org_role: role, status: 'active' }] };
}

function segmentRow(overrides = {}) {
  return {
    rows: [{
      id: SEGMENT_ID, org_id: ORG_ID, user_id: USER_ID,
      name: 'At-risk manufacturers', entity_type: 'company',
      criteria: [{ field: 'lifecycle_stage', op: 'eq', value: 'at_risk' }],
      ...overrides,
    }],
  };
}

beforeEach(() => {
  mockPool.query.mockReset();
  vi.spyOn(featureFlags, 'hasFeature').mockResolvedValue(true);
  vi.spyOn(audit, 'fromReq').mockImplementation(() => Promise.resolve());
});

// ---------------------------------------------------------------------------
// Part 1 — the criteria compiler (pure, no DB).
// ---------------------------------------------------------------------------

describe('compileCriteria — allowlist enforcement', () => {
  test('rejects a field outside the allowlist', () => {
    expect(() => compileCriteria('company', 'org_id', [
      { field: 'name', op: 'eq', value: 'Acme' },
    ])).toThrow(CriteriaError);
  });

  test('rejects an op outside the allowlist for an allowed field', () => {
    // lifecycle_stage allows eq/in — ilike must be rejected.
    expect(() => compileCriteria('company', 'org_id', [
      { field: 'lifecycle_stage', op: 'ilike', value: 'act' },
    ])).toThrow(CriteriaError);
  });

  test('rejects SQL-shaped field names outright', () => {
    expect(() => compileCriteria('company', 'org_id', [
      { field: 'industry = industry; DROP TABLE companies; --', op: 'eq', value: 'x' },
    ])).toThrow(CriteriaError);
  });

  test('rejects prototype-chain field names (hasOwnProperty guard)', () => {
    expect(() => compileCriteria('company', 'org_id', [
      { field: 'constructor', op: 'eq', value: 'x' },
    ])).toThrow(CriteriaError);
    expect(() => compileCriteria('company', 'org_id', [
      { field: 'lifecycle_stage', op: 'toString', value: 'x' },
    ])).toThrow(CriteriaError);
  });

  test('rejects an unknown entity type and non-array criteria', () => {
    expect(() => compileCriteria('deal', 'org_id', [])).toThrow(CriteriaError);
    expect(() => compileCriteria('company', 'org_id', { field: 'industry' })).toThrow(CriteriaError);
  });

  test('rejects bad values: bogus stage, non-int days, non-bool cadence', () => {
    expect(() => compileCriteria('company', 'org_id', [
      { field: 'lifecycle_stage', op: 'eq', value: 'super_active' },
    ])).toThrow(CriteriaError);
    expect(() => compileCriteria('company', 'org_id', [
      { field: 'last_touch_older_than_days', op: 'gt', value: 'thirty; DROP TABLE x' },
    ])).toThrow(CriteriaError);
    expect(() => compileCriteria('contact', 'org_id', [
      { field: 'cadence_overdue', op: 'eq', value: 'yes' },
    ])).toThrow(CriteriaError);
  });

  test('rejects an invalid scope field (internal misuse guard)', () => {
    expect(() => compileCriteria('company', 'org_id; --', [])).toThrow(/Invalid scope field/);
  });

  test('compiles allowlisted criteria with values ONLY in params, never in SQL text', () => {
    const { whereSql, params } = compileCriteria('company', 'org_id', [
      { field: 'lifecycle_stage', op: 'in', value: ['at_risk', 'churned'] },
      { field: 'industry', op: 'ilike', value: 'manufact' },
      { field: 'last_touch_older_than_days', op: 'gt', value: 45 },
    ]);
    // All three user values are parameterized ($2..$4; $1 is the scope value).
    expect(params).toEqual([['at_risk', 'churned'], '%manufact%', 45]);
    expect(whereSql).toContain('$2');
    expect(whereSql).toContain('$3');
    expect(whereSql).toContain('$4');
    // No user-supplied byte appears in the SQL text.
    expect(whereSql).not.toContain('at_risk');
    expect(whereSql).not.toContain('manufact');
    expect(whereSql).not.toContain('45');
  });

  test('compiles contact criteria (owner eq + title ilike + cadence_overdue)', () => {
    const { whereSql, params } = compileCriteria('contact', 'user_id', [
      { field: 'owner_user_id', op: 'eq', value: 9 },
      { field: 'title', op: 'ilike', value: 'engineer' },
      { field: 'cadence_overdue', op: 'eq', value: true },
    ]);
    expect(params).toEqual([9, '%engineer%']);
    expect(whereSql).toContain('ct.owner_id = $2');
    expect(whereSql).toContain('ct.job_title ILIKE $3');
    // cadence_overdue=true compiles to NOT EXISTS over recent activities.
    expect(whereSql).toMatch(/NOT EXISTS/);
    // The scope inside the correlated subquery is the caller's tenancy field.
    expect(whereSql).toContain('a.user_id = $1');
  });

  test('empty criteria compiles to no extra WHERE (matches the whole tenant)', () => {
    const { whereSql, params } = compileCriteria('company', 'org_id', []);
    expect(whereSql).toBe('');
    expect(params).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — routes (mocked pool).
// ---------------------------------------------------------------------------

describe('GET /segments — org-scoped list', () => {
  test('lists only the caller org’s segments', async () => {
    mockPool.query.mockResolvedValueOnce(authRow());       // 1. auth
    mockPool.query.mockResolvedValueOnce(segmentRow());    // 2. SELECT segments

    const res = await request(buildApp()).get('/segments').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const listCall = mockPool.query.mock.calls[1];
    expect(listCall[0]).toMatch(/FROM segments WHERE org_id = \$1/);
    expect(listCall[1]).toEqual([ORG_ID]);
  });
});

describe('POST /segments — create validates through the compiler', () => {
  test('400s on non-allowlisted criteria (no INSERT issued)', async () => {
    mockPool.query.mockResolvedValueOnce(authRow());

    const res = await request(buildApp())
      .post('/segments')
      .set('Cookie', authCookie())
      .send({ name: 'Bad', entity_type: 'company', criteria: [{ field: 'annual_revenue', op: 'gt', value: 5 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not filterable/);
    expect(mockPool.query).toHaveBeenCalledTimes(1); // auth only
  });

  test('creates with org tenancy threaded into the INSERT', async () => {
    mockPool.query.mockResolvedValueOnce(authRow());
    mockPool.query.mockResolvedValueOnce(segmentRow());

    const res = await request(buildApp())
      .post('/segments')
      .set('Cookie', authCookie())
      .send({
        name: 'At-risk manufacturers',
        entity_type: 'company',
        criteria: [{ field: 'lifecycle_stage', op: 'eq', value: 'at_risk' }],
      });

    expect(res.status).toBe(201);
    const insertCall = mockPool.query.mock.calls[1];
    expect(insertCall[0]).toMatch(/INSERT INTO segments/);
    expect(insertCall[1][0]).toBe(USER_ID); // user_id
    expect(insertCall[1][1]).toBe(ORG_ID);  // org_id
  });
});

describe('GET /segments/:id/members — evaluate, org-isolated', () => {
  test('404s when the segment belongs to another org (scoped fetch misses)', async () => {
    mockPool.query.mockResolvedValueOnce(authRow());
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // scoped SELECT finds nothing

    const res = await request(buildApp())
      .get(`/segments/${SEGMENT_ID}/members`)
      .set('Cookie', authCookie());

    expect(res.status).toBe(404);
    const fetchCall = mockPool.query.mock.calls[1];
    expect(fetchCall[0]).toMatch(/FROM segments WHERE id = \$1 AND org_id = \$2/);
    expect(fetchCall[1]).toEqual([SEGMENT_ID, ORG_ID]);
  });

  test('count + evaluate queries are both org-scoped with $1 = org id', async () => {
    mockPool.query.mockResolvedValueOnce(authRow());
    mockPool.query.mockResolvedValueOnce(segmentRow());                        // fetch segment
    mockPool.query.mockResolvedValueOnce({ rows: [{ n: 2 }] });                // count
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'Acme' }, { id: 2, name: 'Beta' }] }); // evaluate

    const res = await request(buildApp())
      .get(`/segments/${SEGMENT_ID}/members`)
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.members).toHaveLength(2);

    const countCall = mockPool.query.mock.calls[2];
    expect(countCall[0]).toMatch(/SELECT COUNT\(\*\)::int AS n FROM companies c WHERE c\.org_id = \$1/);
    expect(countCall[1][0]).toBe(ORG_ID);
    expect(countCall[1][1]).toBe('at_risk'); // criterion value is a PARAM

    const evalCall = mockPool.query.mock.calls[3];
    expect(evalCall[0]).toMatch(/FROM companies c WHERE c\.org_id = \$1/);
    expect(evalCall[0]).not.toContain('at_risk'); // never in the SQL text
    expect(evalCall[1][0]).toBe(ORG_ID);
  });
});

describe('POST /segments/:id/bulk — admin-gated, allowlisted verbs', () => {
  test('403s for a non-admin org member before touching the segment', async () => {
    mockPool.query.mockResolvedValueOnce(authRow('member'));

    const res = await request(buildApp())
      .post(`/segments/${SEGMENT_ID}/bulk`)
      .set('Cookie', authCookie())
      .send({ action: 'set_lifecycle_stage', params: { lifecycle_stage: 'active' } });

    expect(res.status).toBe(403);
    expect(mockPool.query).toHaveBeenCalledTimes(1); // auth only
  });

  test('400s on a non-allowlisted action (no write issued)', async () => {
    mockPool.query.mockResolvedValueOnce(authRow('admin'));
    mockPool.query.mockResolvedValueOnce(segmentRow());

    const res = await request(buildApp())
      .post(`/segments/${SEGMENT_ID}/bulk`)
      .set('Cookie', authCookie())
      .send({ action: 'delete_all', params: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown bulk action/);
    expect(mockPool.query).toHaveBeenCalledTimes(2); // auth + segment fetch only
  });

  test('400s when set_lifecycle_stage targets a contact segment', async () => {
    mockPool.query.mockResolvedValueOnce(authRow('owner'));
    mockPool.query.mockResolvedValueOnce(segmentRow({
      entity_type: 'contact',
      criteria: [{ field: 'title', op: 'ilike', value: 'ceo' }],
    }));
    mockPool.query.mockResolvedValueOnce({ rows: [{ n: 2 }] }); // blast-radius count guard

    const res = await request(buildApp())
      .post(`/segments/${SEGMENT_ID}/bulk`)
      .set('Cookie', authCookie())
      .send({ action: 'set_lifecycle_stage', params: { lifecycle_stage: 'active' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/only applies to company segments/);
    expect(mockPool.query).toHaveBeenCalledTimes(3); // auth + fetch + count, no write
  });

  test('refuses a bulk write whose member count exceeds MAX_BULK_AFFECTED', async () => {
    mockPool.query.mockResolvedValueOnce(authRow('admin'));
    mockPool.query.mockResolvedValueOnce(segmentRow());
    mockPool.query.mockResolvedValueOnce({ rows: [{ n: 9001 }] }); // count over the cap

    const res = await request(buildApp())
      .post(`/segments/${SEGMENT_ID}/bulk`)
      .set('Cookie', authCookie())
      .send({ action: 'set_lifecycle_stage', params: { lifecycle_stage: 'active' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/over the 5000 limit/);
    // count ran, but the guard tripped before any UPDATE.
    expect(mockPool.query).toHaveBeenCalledTimes(3);
  });

  test('set_lifecycle_stage updates ONLY in-org members via the compiled subquery', async () => {
    mockPool.query.mockResolvedValueOnce(authRow('admin'));
    mockPool.query.mockResolvedValueOnce(segmentRow());
    mockPool.query.mockResolvedValueOnce({ rows: [{ n: 3 }] }); // blast-radius count guard
    mockPool.query.mockResolvedValueOnce({ rowCount: 3, rows: [] }); // UPDATE

    const res = await request(buildApp())
      .post(`/segments/${SEGMENT_ID}/bulk`)
      .set('Cookie', authCookie())
      .send({ action: 'set_lifecycle_stage', params: { lifecycle_stage: 'active' } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ action: 'set_lifecycle_stage', affected: 3 });

    const updateCall = mockPool.query.mock.calls[3];
    // Outer write AND inner member subquery are both org-scoped on $1.
    expect(updateCall[0]).toMatch(/UPDATE companies SET lifecycle_stage/);
    expect(updateCall[0]).toMatch(/WHERE org_id = \$1 AND id IN \(SELECT c\.id FROM companies c WHERE c\.org_id = \$1/);
    expect(updateCall[1][0]).toBe(ORG_ID);
    // Both the criterion value and the new stage travel as params.
    expect(updateCall[1]).toContain('at_risk');
    expect(updateCall[1]).toContain('active');
  });

  test('400s a bogus lifecycle_stage value on the action itself', async () => {
    mockPool.query.mockResolvedValueOnce(authRow('admin'));
    mockPool.query.mockResolvedValueOnce(segmentRow());
    mockPool.query.mockResolvedValueOnce({ rows: [{ n: 3 }] }); // blast-radius count guard

    const res = await request(buildApp())
      .post(`/segments/${SEGMENT_ID}/bulk`)
      .set('Cookie', authCookie())
      .send({ action: 'set_lifecycle_stage', params: { lifecycle_stage: 'super_active' } });

    expect(res.status).toBe(400);
    expect(mockPool.query).toHaveBeenCalledTimes(3); // auth + fetch + count, no UPDATE
  });

  test('assign_owner rejects a user outside the caller org', async () => {
    mockPool.query.mockResolvedValueOnce(authRow('admin'));
    mockPool.query.mockResolvedValueOnce(segmentRow());
    mockPool.query.mockResolvedValueOnce({ rows: [{ n: 3 }] }); // blast-radius count guard
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // org-membership check misses

    const res = await request(buildApp())
      .post(`/segments/${SEGMENT_ID}/bulk`)
      .set('Cookie', authCookie())
      .send({ action: 'assign_owner', params: { owner_id: 999 } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/member of your organization/);
    const memberCheck = mockPool.query.mock.calls[3];
    expect(memberCheck[0]).toMatch(/SELECT id FROM users WHERE id = \$1 AND org_id = \$2/);
    expect(memberCheck[1]).toEqual([999, ORG_ID]);
    expect(mockPool.query).toHaveBeenCalledTimes(4); // no UPDATE issued
  });

  test('create_task inserts one org-scoped task per current member', async () => {
    mockPool.query.mockResolvedValueOnce(authRow('owner'));
    mockPool.query.mockResolvedValueOnce(segmentRow({
      entity_type: 'contact',
      criteria: [{ field: 'cadence_overdue', op: 'eq', value: true }],
    }));
    mockPool.query.mockResolvedValueOnce({ rows: [{ n: 5 }] }); // blast-radius count guard
    mockPool.query.mockResolvedValueOnce({ rowCount: 5, rows: [] }); // INSERT..SELECT

    const res = await request(buildApp())
      .post(`/segments/${SEGMENT_ID}/bulk`)
      .set('Cookie', authCookie())
      .send({ action: 'create_task', params: { title: 'Re-engage', due_date: '2026-08-01' } });

    expect(res.status).toBe(200);
    expect(res.body.affected).toBe(5);

    const insertCall = mockPool.query.mock.calls[3];
    expect(insertCall[0]).toMatch(/INSERT INTO tasks/);
    expect(insertCall[0]).toMatch(/FROM contacts ct WHERE ct\.org_id = \$1/);
    expect(insertCall[1][0]).toBe(ORG_ID);
    expect(insertCall[1]).toContain('Re-engage');
    expect(insertCall[1]).toContain(USER_ID);
  });
});

describe('POST /segments/preview — live count for unsaved criteria', () => {
  test('400s non-allowlisted fields with the allowlist message', async () => {
    mockPool.query.mockResolvedValueOnce(authRow());

    const res = await request(buildApp())
      .post('/segments/preview')
      .set('Cookie', authCookie())
      .send({ entity_type: 'contact', criteria: [{ field: 'email', op: 'ilike', value: '@' }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not filterable/);
  });

  test('returns count + sample for valid criteria', async () => {
    mockPool.query.mockResolvedValueOnce(authRow());
    mockPool.query.mockResolvedValueOnce({ rows: [{ n: 7 }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'Acme' }] });

    const res = await request(buildApp())
      .post('/segments/preview')
      .set('Cookie', authCookie())
      .send({ entity_type: 'company', criteria: [{ field: 'industry', op: 'eq', value: 'Manufacturing' }] });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(7);
    expect(res.body.sample).toHaveLength(1);
  });
});

describe('feature gating', () => {
  test('403s with FEATURE_DISABLED when customer_success_enabled is off', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    mockPool.query.mockResolvedValueOnce(authRow());

    const res = await request(buildApp()).get('/segments').set('Cookie', authCookie());

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
  });
});
