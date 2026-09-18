// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Multi-tenant org-isolation route tests for the core CRUD resources
// (contacts, companies, tasks, activities, deals).
//
// The pg pool is mocked, so we can't prove isolation at the *database* level —
// instead we prove the thing that MAKES isolation hold: the qs(req) discipline.
// For every request we assert that EVERY query touching the resource's own
// tenant table binds the caller's org_id as a parameter and names the org_id
// scope column. A route that dropped its `WHERE org_id = $n` (the classic
// cross-tenant read leak) would fail these tests. We also assert that an id the
// org-scoped query can't find returns 404 (an out-of-scope row is not-found),
// and that create stamps org_id onto the new row.
//
// authMiddleware issues the first query per request:
//   SELECT org_id, org_role, status FROM users WHERE id = $1
// so the generic mock row below carries those fields too.

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
realPool.query = vi.fn();
realPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 4242;
const ORG_ID = 7;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

// A row that satisfies BOTH the authMiddleware users lookup
// (org_id/org_role/status) and any route data query (id + common columns).
const GENERIC_ROW = {
  id: 1, org_id: ORG_ID, org_role: 'member', status: 'active',
  user_id: USER_ID, title: 'x', name: 'x',
};

function buildApp(mount, router) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use(mount, router);
  return app;
}

// Every query that reads/writes `table` must name the org_id scope column and
// bind ORG_ID — otherwise it's a cross-tenant leak.
function assertEveryTableQueryScoped(table, orgId) {
  const tableRe = new RegExp(`\\b(from|into|update)\\s+${table}\\b`, 'i');
  const hits = realPool.query.mock.calls.filter(([sql]) => typeof sql === 'string' && tableRe.test(sql));
  expect(hits.length, `expected at least one query touching "${table}"`).toBeGreaterThan(0);
  for (const [sql, params] of hits) {
    expect(sql.toLowerCase(), `query on "${table}" must reference the org_id scope column:\n${sql}`).toContain('org_id');
    expect(Array.isArray(params) ? params : [], `query on "${table}" must bind ORG_ID (${orgId}):\n${sql}`).toContain(orgId);
  }
}

const RESOURCES = [
  { name: 'contacts',   mount: '/contacts',   router: require('../routes/contactRoutes'),  table: 'contacts',   create: { first_name: 'Ada', last_name: 'Lovelace' } },
  { name: 'companies',  mount: '/companies',  router: require('../routes/companyRoutes'),  table: 'companies',  create: { name: 'Acme Co' } },
  { name: 'tasks',      mount: '/tasks',      router: require('../routes/taskRoutes'),      table: 'tasks',      create: { title: 'Follow up' } },
  { name: 'activities', mount: '/activities', router: require('../routes/activityRoutes'),  table: 'activities', create: { type: 'call', title: 'Kickoff', activity_date: '2026-06-20T15:00:00.000Z' } },
  { name: 'deals',      mount: '/deals',      router: require('../routes/dealRoutes'),      table: 'deals',      create: { title: 'New deal' } },
];

beforeEach(() => {
  realPool.query.mockReset();
  // Some routes (deals create/stage) run their write inside a pool.connect()
  // transaction. Hand back a client whose query IS the same mock, so BEGIN /
  // INSERT / COMMIT land in realPool.query.mock.calls and stay inspectable.
  realPool.connect.mockReset();
  realPool.connect.mockImplementation(async () => ({ query: realPool.query, release: () => {} }));
});

for (const r of RESOURCES) {
  describe(`org isolation — ${r.name}`, () => {
    test('GET / (list) scopes every query to the caller org', async () => {
      realPool.query.mockResolvedValue({ rows: [{ ...GENERIC_ROW }] });

      const res = await request(buildApp(r.mount, r.router)).get(r.mount).set('Cookie', authCookie());

      expect(res.status).toBe(200);
      assertEveryTableQueryScoped(r.table, ORG_ID);
    });

    test('GET /:id in scope returns the row and is org-scoped', async () => {
      realPool.query.mockResolvedValue({ rows: [{ ...GENERIC_ROW }] });

      const res = await request(buildApp(r.mount, r.router)).get(`${r.mount}/1`).set('Cookie', authCookie());

      expect(res.status).toBe(200);
      assertEveryTableQueryScoped(r.table, ORG_ID);
    });

    test('GET /:id for an out-of-scope id returns 404 (not another org\'s row)', async () => {
      // 1. authMiddleware users lookup — caller belongs to ORG_ID.
      realPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
      // 2. the org-scoped fetch finds nothing (the row belongs to another org).
      realPool.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(buildApp(r.mount, r.router)).get(`${r.mount}/999999`).set('Cookie', authCookie());

      expect(res.status).toBe(404);
      // The fetch that returned nothing must itself have been org-scoped.
      const fetch = realPool.query.mock.calls.find(([sql]) => new RegExp(`from\\s+${r.table}\\b`, 'i').test(sql));
      expect(fetch, `expected a scoped fetch on ${r.table}`).toBeDefined();
      expect(fetch[1]).toContain(ORG_ID);
    });

    test('POST / stamps org_id onto the new row', async () => {
      realPool.query.mockResolvedValue({ rows: [{ ...GENERIC_ROW }] });

      const res = await request(buildApp(r.mount, r.router))
        .post(r.mount)
        .set('Cookie', authCookie())
        .send(r.create);

      expect([200, 201], `create returned ${res.status}: ${JSON.stringify(res.body)}`).toContain(res.status);
      const insert = realPool.query.mock.calls.find(([sql]) => new RegExp(`insert\\s+into\\s+${r.table}\\b`, 'i').test(sql));
      expect(insert, `expected an INSERT INTO ${r.table}`).toBeDefined();
      expect(insert[0].toLowerCase()).toContain('org_id');
      expect(insert[1]).toContain(ORG_ID);
    });
  });
}
