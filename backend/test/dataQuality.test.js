// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Data-Quality Pack tests:
//   1. POST /api/import/deals — happy path, bad-row skip, org-scoping
//   2. GET  /:resource/export.csv — org-scoped CSV with correct headers;
//      a cross-org row never appears in the output
//   3. POST /contacts + /companies — soft duplicate warning: the 201 response
//      carries warning.possibleDuplicates when a match exists AND the row is
//      still inserted (never blocks)
//
// Same harness as orgIsolation.test.js: the pg pool is mocked, so we prove the
// qs(req) discipline (every query binds the caller's org) plus the response
// contracts, not DB-level behavior. authMiddleware's first query per request
// is `SELECT org_id, org_role, status FROM users WHERE id = $1`.

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
realPool.query = vi.fn();
realPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const importRoutes = require('../routes/importRoutes');
const contactRoutes = require('../routes/contactRoutes');
const companyRoutes = require('../routes/companyRoutes');
const dealRoutes = require('../routes/dealRoutes');

const USER_ID = 4242;
const ORG_ID = 7;
const OTHER_ORG_ID = 8;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function buildApp(mount, router) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use(mount, router);
  return app;
}

const USERS_ROW = { org_id: ORG_ID, org_role: 'member', status: 'active' };

beforeEach(() => {
  realPool.query.mockReset();
  realPool.connect.mockReset();
  realPool.connect.mockImplementation(async () => ({ query: realPool.query, release: () => {} }));
});

// ---------------------------------------------------------------------------
// 1. Deals CSV import
// ---------------------------------------------------------------------------

describe('POST /import/deals', () => {
  test('happy path: creates deals, resolves company by name, org-scopes every write', async () => {
    realPool.query.mockImplementation(async (sql) => {
      if (/from users/i.test(sql)) return { rows: [USERS_ROW] };
      if (/select id from companies/i.test(sql)) return { rows: [{ id: 55 }] };
      if (/insert into deals/i.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [] };
    });

    const res = await request(buildApp('/import', importRoutes))
      .post('/import/deals')
      .set('Cookie', authCookie())
      .send({
        rows: [
          { Title: 'Big deal', Company: 'Acme Co', Stage: 'lead', Amount: '$1,200.50', Close: '2026-08-01', Notes: 'from CSV' },
          { Title: 'Zang order', Company: 'Acme Co', Stage: 'PROCESSED', Amount: '900', Close: '', Notes: '' },
        ],
        mapping: { title: 'Title', company_name: 'Company', stage: 'Stage', amount: 'Amount', expected_close_date: 'Close', notes: 'Notes' },
      });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(2);
    expect(res.body.skipped).toBe(0);

    // Company lookup must be org-scoped.
    const lookup = realPool.query.mock.calls.find(([sql]) => /select id from companies/i.test(sql));
    expect(lookup).toBeDefined();
    expect(lookup[0].toLowerCase()).toContain('org_id');
    expect(lookup[1]).toContain(ORG_ID);
    // Same-name rows within one import hit the cache — exactly one lookup.
    expect(realPool.query.mock.calls.filter(([sql]) => /select id from companies/i.test(sql)).length).toBe(1);

    // Every deal INSERT stamps org_id + derived values.
    const inserts = realPool.query.mock.calls.filter(([sql]) => /insert into deals/i.test(sql));
    expect(inserts.length).toBe(2);
    for (const [sql, params] of inserts) {
      expect(sql.toLowerCase()).toContain('org_id');
      expect(params).toContain(ORG_ID);
      expect(params).toContain(55); // resolved company id
    }
    const [, firstParams] = inserts[0];
    expect(firstParams).toContain('Big deal');
    expect(firstParams).toContain(1200.5);          // "$1,200.50" parsed
    expect(firstParams).toContain('lead');
    expect(firstParams).toContain('pre_sale');      // phase derived from stage
    expect(firstParams).toContain('2026-08-01');
    const [, secondParams] = inserts[1];
    expect(secondParams).toContain('PROCESSED');
    expect(secondParams).toContain('post_sale');    // Zang post-sale stage
  });

  test('creates a missing company by name (org-stamped) instead of dropping the row', async () => {
    realPool.query.mockImplementation(async (sql) => {
      if (/from users/i.test(sql)) return { rows: [USERS_ROW] };
      if (/insert into companies/i.test(sql)) return { rows: [{ id: 601 }] };
      if (/select id from companies/i.test(sql)) return { rows: [] }; // no match
      if (/insert into deals/i.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [] };
    });

    const res = await request(buildApp('/import', importRoutes))
      .post('/import/deals')
      .set('Cookie', authCookie())
      .send({
        rows: [{ Title: 'New logo deal', Company: 'Brand New Inc' }],
        mapping: { title: 'Title', company_name: 'Company' },
      });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    const companyInsert = realPool.query.mock.calls.find(([sql]) => /insert into companies/i.test(sql));
    expect(companyInsert).toBeDefined();
    expect(companyInsert[1]).toContain(ORG_ID);
    expect(companyInsert[1]).toContain('Brand New Inc');
    const dealInsert = realPool.query.mock.calls.find(([sql]) => /insert into deals/i.test(sql));
    expect(dealInsert[1]).toContain(601);
  });

  test('skips bad rows (missing title, invalid stage, bad amount/date) with per-row errors', async () => {
    realPool.query.mockImplementation(async (sql) => {
      if (/from users/i.test(sql)) return { rows: [USERS_ROW] };
      if (/insert into deals/i.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [] };
    });

    const res = await request(buildApp('/import', importRoutes))
      .post('/import/deals')
      .set('Cookie', authCookie())
      .send({
        rows: [
          { Title: '',           Stage: 'lead' },                 // row 2: no title
          { Title: 'Bad stage',  Stage: 'NOT_A_STAGE' },          // row 3: invalid stage
          { Title: 'Bad amount', Stage: 'lead', Amount: 'lots' }, // row 4: unparseable amount
          { Title: 'Bad date',   Stage: 'lead', Close: 'someday' }, // row 5: unparseable date
          { Title: 'Good one',   Stage: 'lead', Amount: '50' },   // row 6: fine
        ],
        mapping: { title: 'Title', stage: 'Stage', amount: 'Amount', expected_close_date: 'Close' },
      });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.skipped).toBe(4);
    expect(res.body.errors.map((e) => e.row)).toEqual([2, 3, 4, 5]);
    expect(res.body.errors[1].reason).toMatch(/invalid stage/i);
    // Only ONE insert happened — bad rows never touch the DB.
    expect(realPool.query.mock.calls.filter(([sql]) => /insert into deals/i.test(sql)).length).toBe(1);
  });

  test('400s when the title mapping is missing', async () => {
    realPool.query.mockImplementation(async (sql) => {
      if (/from users/i.test(sql)) return { rows: [USERS_ROW] };
      return { rows: [] };
    });

    const res = await request(buildApp('/import', importRoutes))
      .post('/import/deals')
      .set('Cookie', authCookie())
      .send({ rows: [{ Name: 'x' }], mapping: { notes: 'Name' } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/i);
  });
});

// ---------------------------------------------------------------------------
// 2. List CSV export — org-scoped, correct headers, cross-org rows excluded
// ---------------------------------------------------------------------------

// Fixture: two tenants' rows. The mock emulates the DB by filtering on the
// bound scope param — so if a route ever dropped its org binding, the other
// tenant's row would leak into the CSV and the assertions below would fail.
const CONTACT_FIXTURE = [
  { org_id: ORG_ID,       id: 1, first_name: 'Ada',  last_name: 'Lovelace', email: 'ada@acme.com', phone: null, job_title: 'CTO', company_name: 'Acme Co', status: 'customer', notes: 'has, comma', created_at: '2026-07-01T00:00:00.000Z' },
  { org_id: OTHER_ORG_ID, id: 2, first_name: 'Evil', last_name: 'Intruder', email: 'evil@other.org', phone: null, job_title: null, company_name: null, status: 'lead', notes: null, created_at: '2026-07-01T00:00:00.000Z' },
];

describe('GET /export.csv', () => {
  test('contacts export is org-scoped CSV with headers; cross-org row never appears', async () => {
    realPool.query.mockImplementation(async (sql, params) => {
      if (/from users/i.test(sql)) return { rows: [USERS_ROW] };
      if (/from contacts c/i.test(sql)) {
        return { rows: CONTACT_FIXTURE.filter((r) => r.org_id === params[0]) };
      }
      return { rows: [] };
    });

    const res = await request(buildApp('/contacts', contactRoutes))
      .get('/contacts/export.csv')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.headers['content-disposition']).toMatch(/contacts-export\.csv/);

    const body = res.text;
    expect(body.split('\r\n')[0]).toBe('ID,First Name,Last Name,Email,Phone,Job Title,Company,Status,Notes,Created At');
    expect(body).toContain('Ada');
    expect(body).toContain('"has, comma"'); // RFC-4180 quoting
    expect(body).not.toContain('Evil');
    expect(body).not.toContain('evil@other.org');

    // The export SELECT itself must be org-scoped.
    const exportQuery = realPool.query.mock.calls.find(([sql]) => /from contacts c/i.test(sql));
    expect(exportQuery[0].toLowerCase()).toContain('org_id');
    expect(exportQuery[1]).toContain(ORG_ID);
  });

  test('contacts export forwards the list filters (status, search)', async () => {
    realPool.query.mockImplementation(async (sql, params) => {
      if (/from users/i.test(sql)) return { rows: [USERS_ROW] };
      if (/from contacts c/i.test(sql)) return { rows: [] };
      return { rows: [] };
    });

    const res = await request(buildApp('/contacts', contactRoutes))
      .get('/contacts/export.csv?status=customer&search=ada')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    const [sql, params] = realPool.query.mock.calls.find(([q]) => /from contacts c/i.test(q));
    expect(sql).toMatch(/c\.status = \$2/);
    expect(sql).toMatch(/ILIKE/);
    expect(params).toEqual([ORG_ID, 'customer', '%ada%']);
  });

  test('companies export is org-scoped with the expected header row', async () => {
    realPool.query.mockImplementation(async (sql, params) => {
      if (/from users/i.test(sql)) return { rows: [USERS_ROW] };
      if (/from companies/i.test(sql)) {
        const rows = [
          { org_id: ORG_ID, id: 10, name: 'Acme Co', type: 'customer', industry: 'mfg', website: 'acme.com', phone: null, location: null, employee_count: 12, annual_revenue: null, status: 'active', lifecycle_stage: 'active', notes: null, created_at: '2026-07-01T00:00:00.000Z' },
          { org_id: OTHER_ORG_ID, id: 11, name: 'Other Org Co', type: 'vendor', industry: null, website: null, phone: null, location: null, employee_count: null, annual_revenue: null, status: 'active', lifecycle_stage: null, notes: null, created_at: '2026-07-01T00:00:00.000Z' },
        ];
        return { rows: rows.filter((r) => r.org_id === params[0]) };
      }
      return { rows: [] };
    });

    const res = await request(buildApp('/companies', companyRoutes))
      .get('/companies/export.csv')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/companies-export\.csv/);
    expect(res.text.split('\r\n')[0]).toBe('ID,Name,Type,Industry,Website,Phone,Location,Employees,Annual Revenue,Status,Lifecycle Stage,Notes,Created At');
    expect(res.text).toContain('Acme Co');
    expect(res.text).not.toContain('Other Org Co');

    const exportQuery = realPool.query.mock.calls.find(([sql]) => /from companies/i.test(sql));
    expect(exportQuery[0].toLowerCase()).toContain('org_id');
    expect(exportQuery[1]).toContain(ORG_ID);
  });

  test('deals export is org-scoped, honours ?stage=, and excludes cross-org rows', async () => {
    realPool.query.mockImplementation(async (sql, params) => {
      if (/from users/i.test(sql)) return { rows: [USERS_ROW] };
      if (/from deals d/i.test(sql)) {
        const rows = [
          { org_id: ORG_ID, id: 20, title: 'Our deal', stage: 'lead', phase: 'pre_sale', amount: 100, expected_close_date: null, contact_name: null, company_name: 'Acme Co', customer_name: null, vendor_name: null, po_number: null, hot_flag: false, notes: null, created_at: '2026-07-01T00:00:00.000Z' },
          { org_id: OTHER_ORG_ID, id: 21, title: 'Their secret deal', stage: 'lead', phase: 'pre_sale', amount: 999, expected_close_date: null, contact_name: null, company_name: null, customer_name: null, vendor_name: null, po_number: null, hot_flag: false, notes: null, created_at: '2026-07-01T00:00:00.000Z' },
        ];
        return { rows: rows.filter((r) => r.org_id === params[0]) };
      }
      return { rows: [] };
    });

    const res = await request(buildApp('/deals', dealRoutes))
      .get('/deals/export.csv?stage=lead')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/deals-export\.csv/);
    expect(res.text.split('\r\n')[0]).toBe('ID,Title,Stage,Phase,Deal Type,Amount,Expected Close Date,Contact,Company,Customer,Vendor,PO Number,Hot,Next Step,Next Step Date,Notes,Created At,Line Revenue,Line Cost,Contribution,Margin %');
    expect(res.text).toContain('Our deal');
    expect(res.text).not.toContain('Their secret deal');

    const [sql, params] = realPool.query.mock.calls.find(([q]) => /from deals d/i.test(q));
    expect(sql.toLowerCase()).toContain('org_id');
    expect(sql).toMatch(/d\.stage = \$2/);
    expect(params).toEqual([ORG_ID, 'lead']);
  });
});

// ---------------------------------------------------------------------------
// 3. Create-time duplicate warning — soft, never blocks
// ---------------------------------------------------------------------------

describe('soft duplicate warning on create', () => {
  test('POST /contacts returns warning.possibleDuplicates on an email match and STILL inserts', async () => {
    realPool.query.mockImplementation(async (sql) => {
      if (/from users/i.test(sql)) return { rows: [USERS_ROW] };
      if (/lower\(trim\(email\)\)/i.test(sql)) {
        return { rows: [{ id: 9, first_name: 'Ada', last_name: 'Lovelace', email: 'ada@acme.com' }] };
      }
      if (/insert into contacts/i.test(sql)) {
        return { rows: [{ id: 100, first_name: 'Ada', last_name: 'Lovelace', email: 'ada@acme.com', org_id: ORG_ID }] };
      }
      return { rows: [] };
    });

    const res = await request(buildApp('/contacts', contactRoutes))
      .post('/contacts')
      .set('Cookie', authCookie())
      .send({ first_name: 'Ada', last_name: 'Lovelace', email: 'ada@acme.com' });

    expect(res.status).toBe(201); // created despite the duplicate — never blocks
    expect(res.body.id).toBe(100);
    expect(res.body.warning.possibleDuplicates).toEqual([
      { id: 9, name: 'Ada Lovelace', email: 'ada@acme.com' },
    ]);

    // The insert really happened, org-stamped.
    const insert = realPool.query.mock.calls.find(([sql]) => /insert into contacts/i.test(sql));
    expect(insert).toBeDefined();
    expect(insert[1]).toContain(ORG_ID);
    // Dup lookup was org-scoped too.
    const dupQuery = realPool.query.mock.calls.find(([sql]) => /lower\(trim\(email\)\)/i.test(sql));
    expect(dupQuery[0].toLowerCase()).toContain('org_id');
    expect(dupQuery[1]).toContain(ORG_ID);
  });

  test('POST /contacts falls back to a name match when there is no email match', async () => {
    realPool.query.mockImplementation(async (sql) => {
      if (/from users/i.test(sql)) return { rows: [USERS_ROW] };
      if (/lower\(trim\(email\)\)/i.test(sql)) return { rows: [] };
      if (/lower\(trim\(first_name/i.test(sql)) {
        return { rows: [{ id: 12, first_name: 'Grace', last_name: 'Hopper', email: null }] };
      }
      if (/insert into contacts/i.test(sql)) {
        return { rows: [{ id: 101, first_name: 'Grace', last_name: 'Hopper', org_id: ORG_ID }] };
      }
      return { rows: [] };
    });

    const res = await request(buildApp('/contacts', contactRoutes))
      .post('/contacts')
      .set('Cookie', authCookie())
      .send({ first_name: 'Grace', last_name: 'Hopper', email: 'new@navy.mil' });

    expect(res.status).toBe(201);
    expect(res.body.warning.possibleDuplicates[0]).toEqual({ id: 12, name: 'Grace Hopper', email: null });
  });

  test('POST /contacts has no warning field when nothing matches', async () => {
    realPool.query.mockImplementation(async (sql) => {
      if (/from users/i.test(sql)) return { rows: [USERS_ROW] };
      if (/insert into contacts/i.test(sql)) {
        return { rows: [{ id: 102, first_name: 'Uni', last_name: 'Que', org_id: ORG_ID }] };
      }
      return { rows: [] }; // both dup lookups: no matches
    });

    const res = await request(buildApp('/contacts', contactRoutes))
      .post('/contacts')
      .set('Cookie', authCookie())
      .send({ first_name: 'Uni', last_name: 'Que' });

    expect(res.status).toBe(201);
    expect(res.body.warning).toBeUndefined();
  });

  test('POST /companies returns warning.possibleDuplicates on a name match and STILL inserts', async () => {
    realPool.query.mockImplementation(async (sql) => {
      if (/from users/i.test(sql)) return { rows: [USERS_ROW] };
      if (/lower\(trim\(name\)\)/i.test(sql)) {
        return { rows: [{ id: 30, name: 'Acme Co', website: 'acme.com' }] };
      }
      if (/insert into companies/i.test(sql)) {
        return { rows: [{ id: 200, name: 'Acme Co', org_id: ORG_ID }] };
      }
      return { rows: [] };
    });

    const res = await request(buildApp('/companies', companyRoutes))
      .post('/companies')
      .set('Cookie', authCookie())
      .send({ name: 'Acme Co' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(200);
    expect(res.body.warning.possibleDuplicates).toEqual([
      { id: 30, name: 'Acme Co', website: 'acme.com' },
    ]);
    const insert = realPool.query.mock.calls.find(([sql]) => /insert into companies/i.test(sql));
    expect(insert).toBeDefined();
    expect(insert[1]).toContain(ORG_ID);
  });

  test('a failing duplicate check never blocks the create (still 201, no warning)', async () => {
    realPool.query.mockImplementation(async (sql) => {
      if (/from users/i.test(sql)) return { rows: [USERS_ROW] };
      if (/lower\(trim\(name\)\)/i.test(sql)) throw new Error('dup check exploded');
      if (/insert into companies/i.test(sql)) {
        return { rows: [{ id: 201, name: 'Resilient Inc', org_id: ORG_ID }] };
      }
      return { rows: [] };
    });

    const res = await request(buildApp('/companies', companyRoutes))
      .post('/companies')
      .set('Cookie', authCookie())
      .send({ name: 'Resilient Inc' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(201);
    expect(res.body.warning).toBeUndefined();
  });
});
