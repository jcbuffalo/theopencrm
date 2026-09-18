// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Dedup / merge — contact & company merge endpoints.
//
// We mount contactRoutes / companyRoutes on a tiny Express app with an auth
// cookie and a fully mocked pg pool (same pattern as account-360.test.js and
// aiActionsApply.test.js). The pool is mocked for authMiddleware + the winner
// re-fetch; the transaction runs on a fake client returned by pool.connect().
//
// Assertions:
//   • happy path (contacts): every child FK is reassigned loser -> winner,
//     the loser is deleted, all inside BEGIN/COMMIT, and a contact.merged
//     audit row is written.
//   • org-scope: when the scope pre-flight returns < 2 rows (cross-org / missing
//     loser), the route 404s, ROLLBACKs, and never reassigns or deletes.
//   • non-admin org member -> 403, transaction never opened.
//   • merging a record into itself -> 400.
//   • happy path (companies): every child FK (incl. company_roles de-collision)
//     is reassigned and the loser deleted inside a txn.

// describe / test / expect / beforeEach / vi are vitest globals.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const contactRoutes = require('../routes/contactRoutes');
const companyRoutes = require('../routes/companyRoutes');
const { CONTACT_FKS, COMPANY_FKS } = require('../services/mergeRecords');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/contacts', contactRoutes);
  app.use('/companies', companyRoutes);
  return app;
}

const USER_ID = 4242;
const ORG_ID = 7;
const WINNER = 10;
const LOSER = 20;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

// Fake pg client recording every SQL string it sees. The scope pre-flight
// (SELECT ... FOR UPDATE) returns `scopeRows`; UPDATE/DELETE succeed silently.
function makeClient(scopeRows) {
  return {
    calls: [],
    query: vi.fn(function (sql) {
      this.calls.push(String(sql));
      if (/FOR UPDATE/i.test(String(sql))) {
        return Promise.resolve({ rows: scopeRows, rowCount: scopeRows.length });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release: vi.fn(),
  };
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
});

describe('POST /contacts/:id/merge', () => {
  test('happy path: reassigns every contact FK, deletes loser, audits, in a txn', async () => {
    const client = makeClient([{ id: WINNER }, { id: LOSER }]);
    // 1. authMiddleware — org owner (admin)
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'owner', status: 'active' }] });
    // pool.connect -> transaction client
    mockPool.connect.mockResolvedValueOnce(client);
    // winner re-fetch after COMMIT + fire-and-forget audit INSERT both use pool.query
    mockPool.query.mockResolvedValue({ rows: [{ id: WINNER, first_name: 'Jane' }] });

    const res = await request(buildApp())
      .post(`/contacts/${WINNER}/merge`)
      .set('Cookie', authCookie())
      .send({ loserId: LOSER });

    expect(res.status).toBe(200);
    expect(res.body.winner.id).toBe(WINNER);

    const sqls = client.calls.join('\n');
    // Ran inside a transaction.
    expect(client.calls.some(s => /^BEGIN/.test(s))).toBe(true);
    expect(client.calls.some(s => /^COMMIT/.test(s))).toBe(true);

    // Every contact FK column was reassigned loser -> winner.
    for (const fk of CONTACT_FKS) {
      const re = new RegExp(`UPDATE ${fk.table} SET ${fk.column} = \\$1 WHERE ${fk.column} = \\$2`);
      expect(re.test(sqls)).toBe(true);
    }
    // Reassign params are (winner, loser).
    const reassignCall = client.query.mock.calls.find(
      ([sql]) => /UPDATE deals SET contact_id = \$1 WHERE contact_id = \$2/.test(String(sql))
    );
    expect(reassignCall[1]).toEqual([WINNER, LOSER]);

    // Loser deleted.
    const delCall = client.query.mock.calls.find(([sql]) => /DELETE FROM contacts WHERE id = \$1/.test(String(sql)));
    expect(delCall[1]).toEqual([LOSER]);

    // contact.merged audit row written via pool.query.
    const auditCall = mockPool.query.mock.calls.find(
      ([sql, params]) => /INSERT INTO audit_log/i.test(String(sql)) && Array.isArray(params) && params.includes('contact.merged')
    );
    expect(auditCall).toBeDefined();

    expect(client.release).toHaveBeenCalled();
  });

  test('cross-org / missing loser: scope pre-flight < 2 rows -> 404, rollback, no reassign', async () => {
    const client = makeClient([{ id: WINNER }]); // only the winner is in-scope
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'owner', status: 'active' }] });
    mockPool.connect.mockResolvedValueOnce(client);

    const res = await request(buildApp())
      .post(`/contacts/${WINNER}/merge`)
      .set('Cookie', authCookie())
      .send({ loserId: LOSER });

    expect(res.status).toBe(404);
    expect(client.calls.some(s => /^ROLLBACK/.test(s))).toBe(true);
    // Never reassigned or committed or deleted.
    expect(client.calls.some(s => /^COMMIT/.test(s))).toBe(false);
    expect(client.calls.some(s => /UPDATE deals SET contact_id/.test(s))).toBe(false);
    expect(client.calls.some(s => /DELETE FROM contacts/.test(s))).toBe(false);
    expect(client.release).toHaveBeenCalled();
  });

  test('non-admin org member -> 403, transaction never opened', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });

    const res = await request(buildApp())
      .post(`/contacts/${WINNER}/merge`)
      .set('Cookie', authCookie())
      .send({ loserId: LOSER });

    expect(res.status).toBe(403);
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  test('merging a contact into itself -> 400', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'owner', status: 'active' }] });

    const res = await request(buildApp())
      .post(`/contacts/${WINNER}/merge`)
      .set('Cookie', authCookie())
      .send({ loserId: WINNER });

    expect(res.status).toBe(400);
    expect(mockPool.connect).not.toHaveBeenCalled();
  });
});

describe('POST /companies/:id/merge', () => {
  test('happy path: reassigns every company FK (incl. company_roles), deletes loser, in a txn', async () => {
    const client = makeClient([{ id: WINNER }, { id: LOSER }]);
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'admin', status: 'active' }] });
    mockPool.connect.mockResolvedValueOnce(client);
    mockPool.query.mockResolvedValue({ rows: [{ id: WINNER, name: 'Acme' }] });

    const res = await request(buildApp())
      .post(`/companies/${WINNER}/merge`)
      .set('Cookie', authCookie())
      .send({ loserId: LOSER });

    expect(res.status).toBe(200);
    expect(res.body.winner.id).toBe(WINNER);

    const sqls = client.calls.join('\n');
    expect(client.calls.some(s => /^BEGIN/.test(s))).toBe(true);
    expect(client.calls.some(s => /^COMMIT/.test(s))).toBe(true);

    // Every mapped company FK column was reassigned.
    for (const fk of COMPANY_FKS) {
      const re = new RegExp(`UPDATE ${fk.table} SET ${fk.column} = \\$1 WHERE ${fk.column} = \\$2`);
      expect(re.test(sqls)).toBe(true);
    }
    // company_roles handled with de-collision + reassign.
    expect(/DELETE FROM company_roles/.test(sqls)).toBe(true);
    expect(/UPDATE company_roles SET company_id = \$1 WHERE company_id = \$2/.test(sqls)).toBe(true);

    // Loser deleted.
    const delCall = client.query.mock.calls.find(([sql]) => /DELETE FROM companies WHERE id = \$1/.test(String(sql)));
    expect(delCall[1]).toEqual([LOSER]);

    // company.merged audit row.
    const auditCall = mockPool.query.mock.calls.find(
      ([sql, params]) => /INSERT INTO audit_log/i.test(String(sql)) && Array.isArray(params) && params.includes('company.merged')
    );
    expect(auditCall).toBeDefined();
    expect(client.release).toHaveBeenCalled();
  });
});
