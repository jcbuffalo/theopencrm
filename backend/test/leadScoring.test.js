// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Lead scoring + routing (migration 147) — services/leadScoring.js and the
// /api/leads/scoring-rules CRUD in routes/leadRoutes.js.
//
// Same harness as leads.test.js: pool fully mocked (responses queued in call
// order, authMiddleware's users SELECT is always call #1 on route tests),
// featureFlags/audit/notifications spied so no stray queries.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const leadScoring = require('../services/leadScoring');
const leadsService = require('../services/leads');
const leadRoutes = require('../routes/leadRoutes');
const featureFlags = require('../services/featureFlags');
const audit = require('../services/audit');
const notificationDispatcher = require('../services/notificationDispatcher');
const { requireFeature } = require('../middleware/featureGate');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 4242;
const ORG_ID = 7;
const OTHER_USER = 9;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function authRow(role = 'member') {
  return { rows: [{ org_id: ORG_ID, org_role: role, status: 'active' }] };
}

function rule(overrides = {}) {
  return {
    id: 1, org_id: ORG_ID, user_id: USER_ID,
    field: 'source', op: 'eq', value: 'web form', points: 10,
    route_to_user_id: null, min_score: null, is_active: true,
    ...overrides,
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/leads', requireFeature('leads_enabled'), leadRoutes);
  return app;
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  vi.spyOn(featureFlags, 'hasFeature').mockResolvedValue(true);
  vi.spyOn(audit, 'fromReq').mockImplementation(() => Promise.resolve());
  vi.spyOn(notificationDispatcher, 'notifyLeadAssigned').mockResolvedValue();
});

// ---------------------------------------------------------------------------
// scoreLead — score math + allowlist
// ---------------------------------------------------------------------------

describe('scoreLead', () => {
  test('sums the points of every matching active rule', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        rule({ id: 1, field: 'source', op: 'eq', value: 'web form', points: 10 }),
        rule({ id: 2, field: 'title', op: 'contains', value: 'chief', points: 25 }),
        rule({ id: 3, field: 'has_email', op: 'exists', value: null, points: 5 }),
        rule({ id: 4, field: 'company_name', op: 'eq', value: 'acme', points: 100 }), // no match
      ],
    });

    const score = await leadScoring.scoreLead(['org_id', ORG_ID], {
      source: 'web form',
      title: 'Chief Engineer',
      email: 'ada@example.com',
      company_name: 'Analytical Engines Ltd',
    });

    expect(score).toBe(40); // 10 + 25 + 5, the acme rule doesn't match
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('org_id = $1');
    expect(sql).toContain('is_active = TRUE');
    expect(params).toEqual([ORG_ID]);
  });

  test('a non-allowlisted field/op in a stored row never matches (defense in depth)', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        rule({ id: 1, field: 'notes; DROP TABLE leads', op: 'eq', value: 'x', points: 999 }),
        rule({ id: 2, field: 'source', op: 'regex', value: '.*', points: 999 }),
        rule({ id: 3, field: 'source', op: 'eq', value: 'manual', points: 7 }),
      ],
    });

    const score = await leadScoring.scoreLead(['org_id', ORG_ID], { source: 'manual' });
    expect(score).toBe(7);
  });

  test('rejects an invalid scope field before any query', async () => {
    await expect(leadScoring.scoreLead(['name', 'evil'], {})).rejects.toThrow(/Invalid scope field/);
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});

describe('validateRule allowlist', () => {
  test('rejects a field outside the allowlist', () => {
    expect(() => leadScoring.validateRule({ field: 'notes', op: 'eq', value: 'x', points: 1 }))
      .toThrow(/field must be one of/);
  });

  test('rejects an op outside the allowlist', () => {
    expect(() => leadScoring.validateRule({ field: 'source', op: 'ilike', value: 'x', points: 1 }))
      .toThrow(/op must be one of/);
  });

  test('rejects non-integer points and missing values', () => {
    expect(() => leadScoring.validateRule({ field: 'source', op: 'eq', value: 'x', points: 'lots' }))
      .toThrow(/points/);
    expect(() => leadScoring.validateRule({ field: 'source', op: 'eq', points: 5 }))
      .toThrow(/requires a non-empty string value/);
  });
});

// ---------------------------------------------------------------------------
// Score on create + recompute on update (service wiring)
// ---------------------------------------------------------------------------

describe('createLead scoring', () => {
  test('computes and stores the score on insert', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [rule({ points: 15 })] }) // scoreLead's rules SELECT
      .mockResolvedValueOnce({ rows: [{ id: 55, score: 15 }] }); // INSERT

    const lead = await leadsService.createLead(
      { userId: USER_ID, orgId: ORG_ID },
      { name: 'Ada', source: 'web form' }
    );

    expect(lead.score).toBe(15);
    const [insertSql, insertParams] = mockPool.query.mock.calls[1];
    expect(insertSql).toContain('INSERT INTO leads');
    expect(insertSql).toContain('score');
    expect(insertParams[insertParams.length - 1]).toBe(15); // score is the last param
  });

  test('a scoring failure never blocks the create (score falls back to 0)', async () => {
    mockPool.query
      .mockRejectedValueOnce(new Error('rules table on fire'))
      .mockResolvedValueOnce({ rows: [{ id: 55, score: 0 }] });

    const lead = await leadsService.createLead(
      { userId: USER_ID, orgId: ORG_ID },
      { name: 'Ada', source: 'web form' }
    );
    expect(lead.score).toBe(0);
    const [, insertParams] = mockPool.query.mock.calls[1];
    expect(insertParams[insertParams.length - 1]).toBe(0);
  });
});

describe('updateLead rescoring', () => {
  test('recomputes against the FINAL row values and persists a changed score', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 55, org_id: ORG_ID, title: 'Chief Engineer', score: 0 }] }) // UPDATE … RETURNING
      .mockResolvedValueOnce({ rows: [rule({ field: 'title', op: 'contains', value: 'chief', points: 25 })] }) // rules SELECT
      .mockResolvedValueOnce({ rows: [{ id: 55, org_id: ORG_ID, title: 'Chief Engineer', score: 25 }] }); // rescore UPDATE

    const updated = await leadsService.updateLead(['org_id', ORG_ID], 55, { title: 'Chief Engineer' });

    expect(updated.score).toBe(25);
    const [rescoreSql, rescoreParams] = mockPool.query.mock.calls[2];
    expect(rescoreSql).toContain('SET score = $1');
    expect(rescoreSql).toContain('org_id = $3'); // rescore is still org-scoped
    expect(rescoreParams).toEqual([25, 55, ORG_ID]);
  });

  test('skips the extra write when the score is unchanged', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 55, org_id: ORG_ID, title: 'Analyst', score: 0 }] })
      .mockResolvedValueOnce({ rows: [] }); // no rules → score stays 0

    const updated = await leadsService.updateLead(['org_id', ORG_ID], 55, { title: 'Analyst' });
    expect(updated.score).toBe(0);
    expect(mockPool.query).toHaveBeenCalledTimes(2); // UPDATE + rules SELECT only
  });
});

// ---------------------------------------------------------------------------
// pickOwner — routing threshold vs round-robin + org isolation
// ---------------------------------------------------------------------------

describe('pickOwner routing', () => {
  const routingRule = rule({
    id: 8, field: 'source', op: 'eq', value: 'web form',
    points: 10, route_to_user_id: OTHER_USER, min_score: 50,
  });

  test('routes to the rule target when the threshold is met and the target is in-org', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [routingRule] })            // rules SELECT
      .mockResolvedValueOnce({ rows: [{ id: OTHER_USER }] });    // in-org membership check

    const owner = await leadScoring.pickOwner(['org_id', ORG_ID], { source: 'web form' }, 60);
    expect(owner).toBe(OTHER_USER);
    const [memberSql, memberParams] = mockPool.query.mock.calls[1];
    expect(memberSql).toContain('org_id = $2');
    expect(memberParams).toEqual([OTHER_USER, ORG_ID]);
  });

  test('falls back to round-robin when the score is below the threshold', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [routingRule] })            // rules SELECT (threshold not met)
      .mockResolvedValueOnce({ rows: [{ id: 3 }] });             // assignRoundRobin SELECT

    const owner = await leadScoring.pickOwner(['org_id', ORG_ID], { source: 'web form' }, 10);
    expect(owner).toBe(3);
    const [rrSql] = mockPool.query.mock.calls[1];
    expect(rrSql).toContain('FROM users u'); // it really is the round-robin query
  });

  test('refuses a routing target outside the org and falls back to round-robin', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [routingRule] })            // rules SELECT
      .mockResolvedValueOnce({ rows: [] })                       // membership check: NOT in org
      .mockResolvedValueOnce({ rows: [{ id: 3 }] });             // round-robin fallback

    const owner = await leadScoring.pickOwner(['org_id', ORG_ID], { source: 'web form' }, 99);
    expect(owner).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// /api/leads/scoring-rules routes — org isolation + admin gate
// ---------------------------------------------------------------------------

describe('GET /api/leads/scoring-rules', () => {
  test('is org-scoped and open to plain members', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow('member'))
      .mockResolvedValueOnce({ rows: [rule()] });

    const res = await request(buildApp())
      .get('/api/leads/scoring-rules').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toContain('FROM lead_scoring_rules');
    expect(sql).toContain('org_id = $1');
    expect(params).toEqual([ORG_ID]);
  });
});

describe('scoring-rules write admin gate', () => {
  test('POST 403s for a non-admin member before touching the DB', async () => {
    mockPool.query.mockResolvedValueOnce(authRow('member'));

    const res = await request(buildApp())
      .post('/api/leads/scoring-rules')
      .set('Cookie', authCookie())
      .send({ field: 'source', op: 'eq', value: 'web form', points: 10 });

    expect(res.status).toBe(403);
    expect(mockPool.query).toHaveBeenCalledTimes(1); // auth only
  });

  test('POST succeeds for an org admin and stamps the org', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow('admin'))
      .mockResolvedValueOnce({ rows: [rule()] }); // INSERT … RETURNING

    const res = await request(buildApp())
      .post('/api/leads/scoring-rules')
      .set('Cookie', authCookie())
      .send({ field: 'source', op: 'eq', value: 'web form', points: 10 });

    expect(res.status).toBe(201);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toContain('INSERT INTO lead_scoring_rules');
    expect(params).toContain(ORG_ID);
  });

  test('POST 400s on an allowlist violation (admin, bad field)', async () => {
    mockPool.query.mockResolvedValueOnce(authRow('owner'));

    const res = await request(buildApp())
      .post('/api/leads/scoring-rules')
      .set('Cookie', authCookie())
      .send({ field: 'notes', op: 'eq', value: 'x', points: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/field must be one of/);
    expect(mockPool.query).toHaveBeenCalledTimes(1); // rejected before any rules query
  });

  test('DELETE 403s for a member, works for an owner (org-scoped)', async () => {
    mockPool.query.mockResolvedValueOnce(authRow('member'));
    const denied = await request(buildApp())
      .delete('/api/leads/scoring-rules/8').set('Cookie', authCookie());
    expect(denied.status).toBe(403);

    mockPool.query.mockReset();
    mockPool.query
      .mockResolvedValueOnce(authRow('owner'))
      .mockResolvedValueOnce({ rows: [rule({ id: 8 })] });
    const ok = await request(buildApp())
      .delete('/api/leads/scoring-rules/8').set('Cookie', authCookie());
    expect(ok.status).toBe(200);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toContain('DELETE FROM lead_scoring_rules');
    expect(sql).toContain('org_id = $2');
    expect(params).toEqual(['8', ORG_ID]);
  });
});

// ---------------------------------------------------------------------------
// Leads list sort=score
// ---------------------------------------------------------------------------

describe('GET /api/leads?sort=score', () => {
  test('orders by score (allowlisted — the sort value never reaches SQL)', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .get('/api/leads?sort=score').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    const [sql] = mockPool.query.mock.calls[1];
    expect(sql).toContain('ORDER BY score DESC');
  });

  test('any other sort value falls back to the default order', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .get('/api/leads?sort=;DROP%20TABLE%20leads').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    const [sql] = mockPool.query.mock.calls[1];
    expect(sql).not.toContain('DROP');
    expect(sql).toContain('ORDER BY created_at DESC');
  });
});
