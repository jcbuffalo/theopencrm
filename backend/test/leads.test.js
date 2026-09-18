// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Leads module — service + route tests (migrations 130/131).
//
// Follows the segments.test.js pattern: routes are mounted on a tiny Express
// app with the pg pool fully mocked (each pool.query call resolves the next
// queued response in route-issue order; authMiddleware's user lookup is
// always query #1 on authenticated surfaces). featureFlags.hasFeature is
// stubbed; audit.fromReq is stubbed so the fire-and-forget audit write never
// consumes a mocked pool response.
//
// Coverage map (per the slice spec):
//   • CRUD org-isolation — every query carries the caller's org scope;
//     cross-org ids 404.
//   • convert — one transaction creates the contact + optional deal and
//     stamps status='converted' + converted_* ids; already-converted → 409.
//   • round-robin — org members ordered by least-recently-assigned; org-less
//     scope short-circuits to the user.
//   • public submit — happy path creates exactly one org-scoped lead and
//     bumps submit_count; unknown/inactive token → generic 404 with NO row
//     created; module flag off → same 404; oversized body → 413.
//   • rate limiting — the per-IP leadCaptureLimiter 429s a hammering client.
//   • feature gate — leads_enabled=false → 403 on the authenticated surface.

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const leadsService = require('../services/leads');
const leadRoutes = require('../routes/leadRoutes');
const leadFormRoutes = require('../routes/leadFormRoutes');
const featureFlags = require('../services/featureFlags');
const audit = require('../services/audit');
const { requireFeature } = require('../middleware/featureGate');
const { leadCaptureLimiter } = require('../middleware/rateLimits');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 4242;
const ORG_ID = 7;
const LEAD_ID = 55;
const FORM_TOKEN = 'a'.repeat(48); // matches the 48-hex-char minted shape

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function authRow(role = 'member') {
  return { rows: [{ org_id: ORG_ID, org_role: role, status: 'active' }] };
}

function leadRow(overrides = {}) {
  return {
    id: LEAD_ID, org_id: ORG_ID, user_id: USER_ID,
    name: 'Ada Lovelace', email: 'ada@example.com', phone: null,
    company_name: 'Analytical Engines Ltd', title: 'Founder',
    source: 'web form', status: 'new', owner_user_id: null, notes: null,
    converted_contact_id: null, converted_deal_id: null,
    ...overrides,
  };
}

function formRow(overrides = {}) {
  return {
    id: 9, org_id: ORG_ID, user_id: USER_ID, name: 'Homepage capture',
    public_token: FORM_TOKEN,
    fields: { email: true, phone: true, company_name: true, title: false, notes: false },
    redirect_url: null, is_active: true, submit_count: 3,
    ...overrides,
  };
}

// Authenticated app — mirrors the index.js mount (gate at the mount point).
function buildAuthedApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/leads', requireFeature('leads_enabled'), leadRoutes);
  app.use('/api/lead-forms', requireFeature('leads_enabled'), leadFormRoutes);
  return app;
}

// Public app — capture surface only, WITHOUT the limiter so functional tests
// don't burn its budget (the limiter is a module-level singleton; the rate-
// limit test below mounts it deliberately).
function buildPublicApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/public/lead-forms', leadFormRoutes.publicRouter);
  return app;
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  vi.spyOn(featureFlags, 'hasFeature').mockResolvedValue(true);
  vi.spyOn(audit, 'fromReq').mockImplementation(() => Promise.resolve());
});

// ---------------------------------------------------------------------------
// CRUD org-isolation
// ---------------------------------------------------------------------------

describe('leads CRUD — org isolation', () => {
  test('GET /api/leads scopes the list query to the caller org', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow())                    // auth (gate)
      .mockResolvedValueOnce({ rows: [leadRow()] });       // list
    const res = await request(buildAuthedApp())
      .get('/api/leads').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toContain('org_id = $1');
    expect(params[0]).toBe(ORG_ID);
  });

  test('GET /api/leads/:id 404s for a cross-org (invisible) id', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] });                // scoped fetch → miss
    const res = await request(buildAuthedApp())
      .get(`/api/leads/${LEAD_ID}`).set('Cookie', authCookie());
    expect(res.status).toBe(404);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toContain('org_id = $2');
    expect(params).toEqual([String(LEAD_ID), ORG_ID]);
  });

  test('POST /api/leads stamps user_id + org_id and round-robins an owner', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow())                          // auth
      .mockResolvedValueOnce({ rows: [] })                       // route scoreLead: rules SELECT (147)
      .mockResolvedValueOnce({ rows: [] })                       // pickOwner: rules SELECT (147)
      .mockResolvedValueOnce({ rows: [{ id: 99 }] })             // round-robin pick
      .mockResolvedValueOnce({ rows: [] })                       // createLead scoreLead: rules SELECT (147)
      .mockResolvedValueOnce({ rows: [leadRow({ owner_user_id: 99, source: 'manual' })] }); // insert
    const res = await request(buildAuthedApp())
      .post('/api/leads').set('Cookie', authCookie())
      .send({ name: 'Ada Lovelace', email: 'ada@example.com' });
    expect(res.status).toBe(201);
    expect(res.body.owner_user_id).toBe(99);
    const [insertSql, insertParams] = mockPool.query.mock.calls[5];
    expect(insertSql).toContain('INSERT INTO leads');
    expect(insertParams[0]).toBe(USER_ID); // user_id
    expect(insertParams[1]).toBe(ORG_ID);  // org_id
    expect(insertParams[9]).toBe(99);      // owner_user_id
  });

  test('PUT /api/leads/:id rejects a direct status=converted write', async () => {
    mockPool.query.mockResolvedValueOnce(authRow());
    const res = await request(buildAuthedApp())
      .put(`/api/leads/${LEAD_ID}`).set('Cookie', authCookie())
      .send({ status: 'converted' });
    expect(res.status).toBe(400);
    expect(mockPool.query).toHaveBeenCalledTimes(1); // auth only — no UPDATE
  });

  test('DELETE /api/leads/:id is org-scoped', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [leadRow()] });
    const res = await request(buildAuthedApp())
      .delete(`/api/leads/${LEAD_ID}`).set('Cookie', authCookie());
    expect(res.status).toBe(200);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toContain('DELETE FROM leads');
    expect(sql).toContain('org_id = $2');
    expect(params[1]).toBe(ORG_ID);
  });
});

// ---------------------------------------------------------------------------
// Convert
// ---------------------------------------------------------------------------

function mockClient(responses) {
  const query = vi.fn((sql) => {
    if (typeof sql === 'string' && ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) {
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve(responses.shift() || { rows: [] });
  });
  return { query, release: vi.fn() };
}

describe('POST /api/leads/:id/convert', () => {
  test('creates contact + deal and stamps converted_* in one transaction', async () => {
    const contact = { id: 301, first_name: 'Ada', last_name: 'Lovelace', org_id: ORG_ID };
    const deal = { id: 401, title: 'Analytical Engines Ltd — Ada Lovelace', stage: 'LEAD', contact_id: 301 };
    const client = mockClient([
      { rows: [leadRow()] },                                            // SELECT ... FOR UPDATE
      { rows: [contact] },                                              // INSERT contact
      { rows: [deal] },                                                 // INSERT deal
      { rows: [leadRow({ status: 'converted', converted_contact_id: 301, converted_deal_id: 401 })] }, // UPDATE lead
    ]);
    mockPool.query.mockResolvedValueOnce(authRow());                    // auth
    mockPool.connect.mockResolvedValueOnce(client);

    const res = await request(buildAuthedApp())
      .post(`/api/leads/${LEAD_ID}/convert`).set('Cookie', authCookie())
      .send({ createDeal: true });

    expect(res.status).toBe(200);
    expect(res.body.contact.id).toBe(301);
    expect(res.body.deal.id).toBe(401);
    expect(res.body.lead.status).toBe('converted');
    expect(res.body.lead.converted_contact_id).toBe(301);
    expect(res.body.lead.converted_deal_id).toBe(401);

    const sqls = client.query.mock.calls.map((c) => c[0]);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls.find((s) => s.includes('FOR UPDATE'))).toContain('org_id = $2');
    expect(sqls.some((s) => s.includes('INSERT INTO contacts'))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO deals'))).toBe(true);
    expect(sqls.some((s) => s.includes("status = 'converted'"))).toBe(true);
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  test('convert without createDeal creates no deal row', async () => {
    const client = mockClient([
      { rows: [leadRow()] },
      { rows: [{ id: 302, first_name: 'Ada', last_name: 'Lovelace' }] },
      { rows: [leadRow({ status: 'converted', converted_contact_id: 302 })] },
    ]);
    mockPool.query.mockResolvedValueOnce(authRow());
    mockPool.connect.mockResolvedValueOnce(client);

    const res = await request(buildAuthedApp())
      .post(`/api/leads/${LEAD_ID}/convert`).set('Cookie', authCookie())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.deal).toBeNull();
    const sqls = client.query.mock.calls.map((c) => c[0]);
    expect(sqls.some((s) => s.includes('INSERT INTO deals'))).toBe(false);
  });

  test('already-converted lead → 409 and rollback', async () => {
    const client = mockClient([{ rows: [leadRow({ status: 'converted' })] }]);
    mockPool.query.mockResolvedValueOnce(authRow());
    mockPool.connect.mockResolvedValueOnce(client);

    const res = await request(buildAuthedApp())
      .post(`/api/leads/${LEAD_ID}/convert`).set('Cookie', authCookie())
      .send({ createDeal: true });
    expect(res.status).toBe(409);
    const sqls = client.query.mock.calls.map((c) => c[0]);
    expect(sqls).toContain('ROLLBACK');
    expect(sqls.some((s) => s.includes('INSERT INTO'))).toBe(false);
  });

  test('cross-org lead → 404, nothing written', async () => {
    const client = mockClient([{ rows: [] }]);
    mockPool.query.mockResolvedValueOnce(authRow());
    mockPool.connect.mockResolvedValueOnce(client);

    const res = await request(buildAuthedApp())
      .post(`/api/leads/${LEAD_ID}/convert`).set('Cookie', authCookie())
      .send({ createDeal: true });
    expect(res.status).toBe(404);
    const sqls = client.query.mock.calls.map((c) => c[0]);
    expect(sqls.some((s) => s.includes('INSERT INTO'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round-robin (service level)
// ---------------------------------------------------------------------------

describe('assignRoundRobin', () => {
  test('picks the least-recently-assigned org member', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 12 }] });
    const picked = await leadsService.assignRoundRobin(['org_id', ORG_ID]);
    expect(picked).toBe(12);
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('u.org_id = $1');
    expect(sql).toContain('NULLS FIRST');
    expect(params).toEqual([ORG_ID]);
  });

  test('rotates: successive picks follow the DB ordering (distribution)', async () => {
    // Simulate the self-balancing property: after 1 is assigned, the DB
    // ordering surfaces 2, then 3, then wraps back to 1.
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 2 }] })
      .mockResolvedValueOnce({ rows: [{ id: 3 }] })
      .mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const picks = [];
    for (let i = 0; i < 4; i++) picks.push(await leadsService.assignRoundRobin(['org_id', ORG_ID]));
    expect(picks).toEqual([1, 2, 3, 1]);
  });

  test('org-less (user_id) scope short-circuits to the user, no query', async () => {
    const picked = await leadsService.assignRoundRobin(['user_id', USER_ID]);
    expect(picked).toBe(USER_ID);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('empty org degrades to null (unassigned), never throws', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const picked = await leadsService.assignRoundRobin(['org_id', ORG_ID]);
    expect(picked).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Public capture surface
// ---------------------------------------------------------------------------

describe('POST /api/public/lead-forms/:token/submit', () => {
  test('happy path: creates exactly one org-scoped lead + bumps submit_count', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [formRow()] })                        // form by token
      .mockResolvedValueOnce({ rows: [{ id: 12 }] })                       // round-robin
      .mockResolvedValueOnce({ rows: [] })                                 // createLead scoreLead: rules SELECT (147)
      .mockResolvedValueOnce({ rows: [leadRow({ owner_user_id: 12 })] })   // insert lead
      .mockResolvedValueOnce({ rows: [] });                                // submit_count++
    const res = await request(buildPublicApp())
      .post(`/api/public/lead-forms/${FORM_TOKEN}/submit`)
      .send({ name: 'Ada Lovelace', email: 'ada@example.com', company_name: 'Analytical Engines Ltd' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, redirect_url: null });

    const insertCalls = mockPool.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO leads'));
    expect(insertCalls).toHaveLength(1);
    const [, params] = insertCalls[0];
    expect(params[0]).toBe(USER_ID);       // form owner's user_id
    expect(params[1]).toBe(ORG_ID);        // form's org — the ONLY scoping
    expect(params[7]).toBe('web form');    // source
    expect(params[9]).toBe(12);            // round-robin owner

    const bump = mockPool.query.mock.calls.find(([sql]) => sql.includes('submit_count'));
    expect(bump).toBeTruthy();
  });

  test('fields the form did not opt into are dropped', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [formRow({ fields: { email: true } })] })
      .mockResolvedValueOnce({ rows: [{ id: 12 }] })
      .mockResolvedValueOnce({ rows: [leadRow()] })
      .mockResolvedValueOnce({ rows: [] });
    await request(buildPublicApp())
      .post(`/api/public/lead-forms/${FORM_TOKEN}/submit`)
      .send({ name: 'Ada', email: 'ada@example.com', notes: 'sneaky payload', company_name: 'X' });
    const [, params] = mockPool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO leads'));
    expect(params[3]).toBe('ada@example.com'); // email honored
    expect(params[5]).toBeNull();              // company_name dropped
    expect(params[10]).toBeNull();             // notes dropped
  });

  test('unknown token → generic 404 and NO lead row created', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // token lookup miss
    const res = await request(buildPublicApp())
      .post(`/api/public/lead-forms/${'f'.repeat(48)}/submit`)
      .send({ name: 'Mallory' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(mockPool.query).toHaveBeenCalledTimes(1); // lookup only — no INSERT
  });

  test('malformed token is rejected before any DB work', async () => {
    const res = await request(buildPublicApp())
      .post('/api/public/lead-forms/short!/submit')
      .send({ name: 'Mallory' });
    expect(res.status).toBe(404);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('org flag off → same generic 404 (no existence oracle), no row', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    mockPool.query.mockResolvedValueOnce({ rows: [formRow()] });
    const res = await request(buildPublicApp())
      .post(`/api/public/lead-forms/${FORM_TOKEN}/submit`)
      .send({ name: 'Ada' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  test('oversized body → 413 before any DB work', async () => {
    const res = await request(buildPublicApp())
      .post(`/api/public/lead-forms/${FORM_TOKEN}/submit`)
      .send({ name: 'Ada', notes: 'x'.repeat(20000) });
    expect(res.status).toBe(413);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('missing name → 400, no row', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [formRow()] });
    const res = await request(buildPublicApp())
      .post(`/api/public/lead-forms/${FORM_TOKEN}/submit`)
      .send({ email: 'no-name@example.com' });
    expect(res.status).toBe(400);
    expect(mockPool.query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false);
  });

  test('GET /:token returns only render-safe fields (no org internals)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [formRow()] });
    const res = await request(buildPublicApp())
      .get(`/api/public/lead-forms/${FORM_TOKEN}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['fields', 'name']);
    expect(JSON.stringify(res.body)).not.toContain(String(ORG_ID));
  });
});

// ---------------------------------------------------------------------------
// Feature gate (authenticated surface)
// ---------------------------------------------------------------------------

describe('feature gate', () => {
  test('leads_enabled=false → 403 FEATURE_DISABLED on /api/leads', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    mockPool.query.mockResolvedValueOnce(authRow()); // gate resolves auth itself
    const res = await request(buildAuthedApp())
      .get('/api/leads').set('Cookie', authCookie());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
    expect(res.body.feature).toBe('leads_enabled');
  });

  test('leads_enabled=false → 403 on /api/lead-forms too', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    mockPool.query.mockResolvedValueOnce(authRow());
    const res = await request(buildAuthedApp())
      .get('/api/lead-forms').set('Cookie', authCookie());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
  });
});

// ---------------------------------------------------------------------------
// Rate limiting — LAST so the limiter singleton's spent budget can't bleed
// into the functional tests above (they mount the router WITHOUT the limiter).
// ---------------------------------------------------------------------------

describe('leadCaptureLimiter', () => {
  test('hammering the public submit endpoint eventually 429s', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/public/lead-forms', leadCaptureLimiter, leadFormRoutes.publicRouter);

    // Every request misses the token lookup (cheap 404) — we only care that
    // the limiter throttles the surface regardless of outcome.
    mockPool.query.mockResolvedValue({ rows: [] });

    let got429 = false;
    for (let i = 0; i < 25; i++) {
      const res = await request(app)
        .post(`/api/public/lead-forms/${'e'.repeat(48)}/submit`)
        .send({ name: 'Flood' });
      if (res.status === 429) { got429 = true; break; }
      expect(res.status).toBe(404); // pre-limit requests hit the generic 404
    }
    expect(got429).toBe(true);
  });
});
