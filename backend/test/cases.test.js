// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Support Cases (CS-5, migration 134) — route tests.
//
// The router mounts behind the REAL requireFeature('customer_success_enabled')
// gate, exactly as index.js mounts it, with featureFlags.hasFeature mocked
// (default ON; the gate test flips it OFF). The pg pool is fully mocked: each
// pool.query call resolves the next queued response, in the order the route
// issues them.
//
// Query order (valid requests, flag ON — the mount-point gate resolves the
// session itself, and the router's own authMiddleware is an idempotent no-op):
//   every route:   1. authMiddleware — SELECT org_id, org_role, status FROM users
//   GET /cases:    2. list SELECT
//   POST /cases:   2. company/contact scope SELECT (only when a link is given)
//                  3. INSERT ... RETURNING *
//   PUT /cases/:id 2. UPDATE ... RETURNING *   (no link in body)
//   DELETE:        2. DELETE ... RETURNING *
//
// Also covered: the Account 360 (accountRoutes) cases feed — the trailing,
// try/catch-wrapped query 11 — is org-scoped and lands in both the `cases`
// payload and the merged timeline.

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const caseRoutes = require('../routes/caseRoutes');
const accountRoutes = require('../routes/accountRoutes');
const featureFlags = require('../services/featureFlags');
const { requireFeature } = require('../middleware/featureGate');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  // Same shape as the index.js mounts.
  app.use('/cases', requireFeature('customer_success_enabled'), caseRoutes);
  app.use('/accounts', requireFeature('customer_success_enabled'), accountRoutes);
  return app;
}

const USER_ID = 4242;
const ORG_ID = 7;
const COMPANY_ID = 99;
const CASE_ID = 31;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

const AUTH_MEMBER = { rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] };
const AUTH_ORGLESS = { rows: [{ org_id: null, org_role: null, status: 'active' }] };

beforeEach(() => {
  mockPool.query.mockReset();
  vi.spyOn(featureFlags, 'hasFeature').mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// Feature gate
// ---------------------------------------------------------------------------
describe('feature gate', () => {
  test('403s with FEATURE_DISABLED when customer_success_enabled is off for the org', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER); // gate resolves the session itself

    const res = await request(buildApp())
      .get('/cases')
      .set('Cookie', authCookie());

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
    expect(mockPool.query).toHaveBeenCalledTimes(1); // auth only — no case SQL ran
  });
});

// ---------------------------------------------------------------------------
// List — org isolation
// ---------------------------------------------------------------------------
describe('GET /cases', () => {
  test('lists org-scoped, open-first, with status/company filters bound as params', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: CASE_ID, subject: 'Portal down', status: 'open', priority: 'urgent', company_name: 'Acme Co' }],
    });

    const res = await request(buildApp())
      .get(`/cases?status=open&company_id=${COMPANY_ID}`)
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].subject).toBe('Portal down');

    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/WHERE cs\.org_id = \$1/);
    expect(sql).toMatch(/cs\.status = \$2/);
    expect(sql).toMatch(/cs\.company_id = \$3/);
    expect(sql).toMatch(/ORDER BY \(cs\.status IN \('resolved', 'closed'\)\)/); // open-first
    expect(params).toEqual([ORG_ID, 'open', String(COMPANY_ID)]);
  });

  test('falls back to user_id scope for users without an org', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_ORGLESS); // gate fail-open, org-less
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .get('/cases')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/WHERE cs\.user_id = \$1/);
    expect(params).toEqual([USER_ID]);
  });
});

// ---------------------------------------------------------------------------
// Create — link scope verification + allowlists
// ---------------------------------------------------------------------------
describe('POST /cases', () => {
  test('creates a case; the company link is scope-verified before the INSERT', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);
    mockPool.query.mockResolvedValueOnce({ rows: [{ 1: 1 }] }); // company in scope
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: CASE_ID, subject: 'Portal down', status: 'open', priority: 'high', company_id: COMPANY_ID, resolved_at: null }],
    });

    const res = await request(buildApp())
      .post('/cases')
      .set('Cookie', authCookie())
      .send({ subject: 'Portal down', priority: 'high', company_id: COMPANY_ID, sla_due_at: '2026-07-20T00:00:00Z' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(CASE_ID);

    const [scopeSql, scopeParams] = mockPool.query.mock.calls[1];
    expect(scopeSql).toMatch(/SELECT 1 FROM companies WHERE id = \$1 AND org_id = \$2/);
    expect(scopeParams).toEqual([COMPANY_ID, ORG_ID]);

    const [insertSql, insertParams] = mockPool.query.mock.calls[2];
    expect(insertSql).toMatch(/INSERT INTO cases/);
    expect(insertParams[0]).toBe(USER_ID);          // user_id
    expect(insertParams[1]).toBe(ORG_ID);           // org_id
    expect(insertParams[2]).toBe(COMPANY_ID);       // company_id
    expect(insertParams[4]).toBe('Portal down');    // subject
    expect(insertParams[6]).toBe('open');           // default status
    expect(insertParams[7]).toBe('high');           // priority
    expect(insertParams[9]).toBe('2026-07-20T00:00:00.000Z'); // sla_due_at normalized
  });

  test('400s when company_id is not in the caller org (no INSERT issued)', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // scope SELECT misses

    const res = await request(buildApp())
      .post('/cases')
      .set('Cookie', authCookie())
      .send({ subject: 'Sneaky cross-org case', company_id: COMPANY_ID });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/company_id not found/);
    expect(mockPool.query).toHaveBeenCalledTimes(2); // auth + scope check only
  });

  test('rejects a status outside the allowlist with 400 before any case SQL', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);

    const res = await request(buildApp())
      .post('/cases')
      .set('Cookie', authCookie())
      .send({ subject: 'Bad status', status: 'escalated_to_mars' });

    expect(res.status).toBe(400);
    expect(mockPool.query).toHaveBeenCalledTimes(1); // auth only
  });

  test('rejects a priority outside the allowlist with 400', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);

    const res = await request(buildApp())
      .post('/cases')
      .set('Cookie', authCookie())
      .send({ subject: 'Bad priority', priority: 'ludicrous' });

    expect(res.status).toBe(400);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  test('rejects a missing subject with 400', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);

    const res = await request(buildApp())
      .post('/cases')
      .set('Cookie', authCookie())
      .send({ description: 'no subject given' });

    expect(res.status).toBe(400);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Status transitions — resolved_at stamping / clearing
// ---------------------------------------------------------------------------
describe('PUT /cases/:id — status transitions', () => {
  test('→ resolved stamps resolved_at (COALESCE keeps an earlier stamp)', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: CASE_ID, status: 'resolved', resolved_at: '2026-07-13T12:00:00Z' }],
    });

    const res = await request(buildApp())
      .put(`/cases/${CASE_ID}`)
      .set('Cookie', authCookie())
      .send({ status: 'resolved' });

    expect(res.status).toBe(200);
    expect(res.body.resolved_at).toBeTruthy();

    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/resolved_at = COALESCE\(resolved_at, CURRENT_TIMESTAMP\)/);
    // Org-scoped update; the self-join FROM subquery snapshots the pre-update
    // status/owner for the notification fan-out's change-detection.
    expect(sql).toMatch(/WHERE cases\.id = old\.prev_id AND cases\.org_id = \$10/);
    expect(sql).toMatch(/SELECT id AS prev_id, status AS prev_status/);
    expect(params[8]).toBe(String(CASE_ID));
    expect(params[9]).toBe(ORG_ID);
  });

  test('→ closed also stamps resolved_at', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: CASE_ID, status: 'closed' }] });

    const res = await request(buildApp())
      .put(`/cases/${CASE_ID}`)
      .set('Cookie', authCookie())
      .send({ status: 'closed' });

    expect(res.status).toBe(200);
    expect(mockPool.query.mock.calls[1][0]).toMatch(/resolved_at = COALESCE\(resolved_at, CURRENT_TIMESTAMP\)/);
  });

  test('reopening (→ open) clears resolved_at', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: CASE_ID, status: 'open', resolved_at: null }] });

    const res = await request(buildApp())
      .put(`/cases/${CASE_ID}`)
      .set('Cookie', authCookie())
      .send({ status: 'open' });

    expect(res.status).toBe(200);
    expect(res.body.resolved_at).toBeNull();
    expect(mockPool.query.mock.calls[1][0]).toMatch(/resolved_at = NULL/);
  });

  test('a no-status update leaves resolved_at untouched', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: CASE_ID, subject: 'Renamed' }] });

    const res = await request(buildApp())
      .put(`/cases/${CASE_ID}`)
      .set('Cookie', authCookie())
      .send({ subject: 'Renamed' });

    expect(res.status).toBe(200);
    const sql = mockPool.query.mock.calls[1][0];
    expect(sql).toMatch(/resolved_at = resolved_at/);
    expect(sql).not.toMatch(/resolved_at = NULL/);
    expect(sql).not.toMatch(/resolved_at = COALESCE/);
  });

  test('rejects a garbage status on update with 400 (no UPDATE issued)', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);

    const res = await request(buildApp())
      .put(`/cases/${CASE_ID}`)
      .set('Cookie', authCookie())
      .send({ status: "resolved'; DROP TABLE cases;--" });

    expect(res.status).toBe(400);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  test('404s when the case is not in the caller org', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // org-scoped UPDATE hits nothing

    const res = await request(buildApp())
      .put(`/cases/${CASE_ID}`)
      .set('Cookie', authCookie())
      .send({ status: 'resolved' });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Delete — org isolation
// ---------------------------------------------------------------------------
describe('DELETE /cases/:id', () => {
  test('deletes org-scoped; out-of-org id 404s', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: CASE_ID }] });

    const ok = await request(buildApp())
      .delete(`/cases/${CASE_ID}`)
      .set('Cookie', authCookie());
    expect(ok.status).toBe(200);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/DELETE FROM cases WHERE id = \$1 AND org_id = \$2/);
    expect(params).toEqual([String(CASE_ID), ORG_ID]);

    mockPool.query.mockReset();
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const miss = await request(buildApp())
      .delete(`/cases/${CASE_ID}`)
      .set('Cookie', authCookie());
    expect(miss.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Account 360 feed — the trailing cases query
// ---------------------------------------------------------------------------
describe('GET /accounts/:companyId/360 — cases feed', () => {
  test('includes only in-scope cases (org-bound query) in payload + timeline', async () => {
    const caseCreated = '2026-07-10T09:00:00.000Z';

    // Route query order: 1 auth, 2 company, 3 deals, 4 activities, 5 tasks,
    // 6 issues, 7 gmail summaries, 8 email messages, 9 meetings, 10 pulse,
    // 11 cases (trailing, try/catch-wrapped).
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: COMPANY_ID, name: 'Acme Co', type: 'customer', status: 'active' }],
    });
    for (let i = 0; i < 8; i++) mockPool.query.mockResolvedValueOnce({ rows: [] });
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: CASE_ID, subject: 'Portal down', description: 'Customer cannot log in', status: 'open', priority: 'urgent', sla_due_at: '2026-07-15T00:00:00.000Z', resolved_at: null, contact_id: null, created_at: caseCreated, updated_at: caseCreated },
        { id: 32, subject: 'Old ticket', description: null, status: 'closed', priority: 'low', sla_due_at: null, resolved_at: '2026-06-01T00:00:00.000Z', contact_id: null, created_at: '2026-05-20T00:00:00.000Z', updated_at: '2026-06-01T00:00:00.000Z' },
      ],
    });

    const res = await request(buildApp())
      .get(`/accounts/${COMPANY_ID}/360`)
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);

    // The cases query itself is company- AND org-bound — a caller can never
    // aggregate another org's cases by passing a foreign companyId.
    const [casesSql, casesParams] = mockPool.query.mock.calls[10];
    expect(casesSql).toMatch(/FROM cases/);
    expect(casesSql).toMatch(/WHERE company_id = \$1 AND org_id = \$2/);
    expect(casesParams).toEqual([COMPANY_ID, ORG_ID]);

    // Payload: full case rows, open-first as delivered by the query.
    expect(res.body.cases).toHaveLength(2);
    expect(res.body.cases[0].subject).toBe('Portal down');
    expect(res.body.header.open_case_count).toBe(1); // closed one doesn't count

    // Timeline: both cases merged in as type 'case'.
    const caseEntries = res.body.timeline.filter((e) => e.type === 'case');
    expect(caseEntries).toHaveLength(2);
    expect(caseEntries[0].meta.priority).toBeDefined();
  });

  test('a failed cases fetch degrades to cases: [] without 500ing the 360', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: COMPANY_ID, name: 'Acme Co', type: 'customer', status: 'active' }],
    });
    for (let i = 0; i < 8; i++) mockPool.query.mockResolvedValueOnce({ rows: [] });
    mockPool.query.mockRejectedValueOnce(new Error('relation "cases" does not exist'));

    const res = await request(buildApp())
      .get(`/accounts/${COMPANY_ID}/360`)
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.cases).toEqual([]);
    expect(res.body.header.open_case_count).toBe(0);
  });
});
