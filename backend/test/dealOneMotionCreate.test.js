// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// One-motion deal creation (Wave 3, 2026-09-19): POST /api/deals accepts
// company_name / contact_name / contact_email and finds-or-creates the
// company and contact INSIDE the deal's own transaction via the shared
// services/recordUpsert.js helpers (the same ones the chat copilot's
// deal.create apply uses).
//
//   1. New company + new contact typed inline → both INSERTed, deal links to
//      them, and the company doubles as customer_id.
//   2. Existing company (case-insensitive) + existing contact (by email) are
//      matched, not duplicated.
//   3. Explicit ids win over typed names.
//   4. recordUpsert unit behaviour: null on empty input; name splitting.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/v2DualWrite', () => ({
  onDealCreated: vi.fn().mockResolvedValue(null),
  onDealStageChanged: vi.fn().mockResolvedValue(null),
}));
vi.mock('../services/webhookDispatcher', () => ({ dispatch: vi.fn().mockResolvedValue(null) }));
vi.mock('../services/notificationDispatcher', () => ({ notifyDealActivity: vi.fn().mockResolvedValue(null) }));

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const pipelines = require('../services/pipelines');
const dealRoutes = require('../routes/dealRoutes');
const recordUpsert = require('../services/recordUpsert');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 8101;
const ORG_ID = 81;
function authCookie() { return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`]; }

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/deals', dealRoutes);
  return app;
}

// Transaction client with a SQL-shape router. `companies` / `contacts` are
// the pre-existing rows the find step can match.
function makeClient({ companies = [], contacts = [] } = {}) {
  const client = {
    calls: [],
    query: vi.fn(async (sql, params) => {
      const s = String(sql).trim();
      client.calls.push({ sql: s, params });
      if (/^SELECT id FROM companies WHERE org_id = \$1 AND LOWER\(name\) = LOWER\(\$2\)/i.test(s)) {
        const hit = companies.find((c) => c.name.toLowerCase() === String(params[1]).toLowerCase());
        return { rows: hit ? [{ id: hit.id }] : [] };
      }
      if (/^INSERT INTO companies/i.test(s)) return { rows: [{ id: 501 }] };
      if (/^SELECT id FROM contacts WHERE org_id = \$1 AND LOWER\(email\) = LOWER\(\$2\)/i.test(s)) {
        const hit = contacts.find((c) => c.email.toLowerCase() === String(params[1]).toLowerCase());
        return { rows: hit ? [{ id: hit.id }] : [] };
      }
      if (/^INSERT INTO contacts/i.test(s)) return { rows: [{ id: 701 }] };
      if (/^INSERT INTO deals/i.test(s)) {
        return { rows: [{ id: 9001, title: params[8], contact_id: params[2], company_id: params[3], customer_id: params[4], stage: params[11], deal_type: params[13] }] };
      }
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  return client;
}

function primePool() {
  mockPool.query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (/FROM admin_users/i.test(s)) return { rows: [] };
    if (/FROM users WHERE id/i.test(s)) return { rows: [{ org_id: ORG_ID, org_role: 'owner', status: 'active' }] };
    if (/SELECT profile FROM organizations/i.test(s)) return { rows: [{ profile: 'generic' }] };
    return { rows: [] };
  });
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  pipelines._clearCacheForTests?.();
});

describe('POST /deals — one-motion company + contact', () => {
  test('typed company + contact are created in the deal transaction and linked (company doubles as customer)', async () => {
    primePool();
    const client = makeClient();
    mockPool.connect.mockResolvedValue(client);
    const res = await request(buildApp())
      .post('/deals')
      .set('Cookie', authCookie())
      .send({ title: 'Bravo rollout', stage: 'lead', company_name: 'Bravo LLC', contact_name: 'Dana Reyes', contact_email: 'dana@bravo.example', amount: 9000 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 9001, company_id: 501, customer_id: 501, contact_id: 701 });

    const sqls = client.calls.map((c) => c.sql);
    const idx = (re) => sqls.findIndex((q) => re.test(q));
    // Order: BEGIN → company find → company insert → contact find → contact insert → deal insert → COMMIT.
    expect(idx(/^BEGIN/)).toBeLessThan(idx(/^SELECT id FROM companies/));
    expect(idx(/^SELECT id FROM companies/)).toBeLessThan(idx(/^INSERT INTO companies/));
    expect(idx(/^INSERT INTO companies/)).toBeLessThan(idx(/^SELECT id FROM contacts/));
    expect(idx(/^INSERT INTO contacts/)).toBeLessThan(idx(/^INSERT INTO deals/));
    expect(idx(/^INSERT INTO deals/)).toBeLessThan(idx(/^COMMIT/));
    // Contact INSERT carries the split name, the email and the new company id; org-scoped.
    const ct = client.calls.find((c) => /^INSERT INTO contacts/.test(c.sql));
    expect(ct.params).toEqual([USER_ID, ORG_ID, 'Dana', 'Reyes', 'dana@bravo.example', 501]);
    const co = client.calls.find((c) => /^INSERT INTO companies/.test(c.sql));
    expect(co.params).toEqual([USER_ID, ORG_ID, 'Bravo LLC']);
  });

  test('existing company (case-insensitive) and contact (by email) are matched, never duplicated', async () => {
    primePool();
    const client = makeClient({ companies: [{ id: 33, name: 'Bravo LLC' }], contacts: [{ id: 44, email: 'dana@bravo.example' }] });
    mockPool.connect.mockResolvedValue(client);
    const res = await request(buildApp())
      .post('/deals')
      .set('Cookie', authCookie())
      .send({ title: 'Bravo renewal', stage: 'lead', company_name: 'bravo llc', contact_name: 'Dana R', contact_email: 'DANA@bravo.example' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ company_id: 33, customer_id: 33, contact_id: 44 });
    expect(client.calls.some((c) => /^INSERT INTO companies/.test(c.sql))).toBe(false);
    expect(client.calls.some((c) => /^INSERT INTO contacts/.test(c.sql))).toBe(false);
  });

  test('explicit ids win over typed names (no lookups run)', async () => {
    primePool();
    const client = makeClient();
    mockPool.connect.mockResolvedValue(client);
    const res = await request(buildApp())
      .post('/deals')
      .set('Cookie', authCookie())
      .send({ title: 'Ids win', stage: 'lead', customer_id: 5, company_id: 5, contact_id: 6, company_name: 'Ignored Co', contact_name: 'Ignored Person' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ company_id: 5, customer_id: 5, contact_id: 6 });
    expect(client.calls.some((c) => /FROM companies/.test(c.sql) || /FROM contacts/.test(c.sql))).toBe(false);
  });
});

describe('services/recordUpsert', () => {
  const actor = { sf: 'org_id', sv: ORG_ID, userId: USER_ID, orgId: ORG_ID };

  test('returns null for empty input without touching the client', async () => {
    const client = makeClient();
    expect(await recordUpsert.findOrCreateCompany(client, actor, '   ')).toBeNull();
    expect(await recordUpsert.findOrCreateContact(client, actor, { name: '', email: null })).toBeNull();
    expect(client.query).not.toHaveBeenCalled();
  });

  test('a contact with only an email gets a usable name; a single-token name gets a placeholder last name', async () => {
    const client = makeClient();
    await recordUpsert.findOrCreateContact(client, actor, { email: 'solo@x.example' });
    let ins = client.calls.find((c) => /^INSERT INTO contacts/.test(c.sql));
    expect(ins.params.slice(2, 5)).toEqual(['solo@x.example', '—', 'solo@x.example']);
    client.calls.length = 0;
    await recordUpsert.findOrCreateContact(client, actor, { name: 'Cher' });
    ins = client.calls.find((c) => /^INSERT INTO contacts/.test(c.sql));
    expect(ins.params.slice(2, 5)).toEqual(['Cher', '—', null]);
  });
});
