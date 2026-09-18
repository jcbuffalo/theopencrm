// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Multiple pipelines per org via deal_type (spec 201, migration 156).
//
//   1. Effective-pipeline fallback chain: type row → default row → profile
//      default.
//   2. savePipeline with dealType only moves that type's deals; a default-row
//      save doesn't touch typed deals.
//   3. Stage validation is per-type: a supply-stage id is rejected on a
//      default-type deal and vice versa.
//   4. Deal create with an unknown deal_type → 400; an import row with a bad
//      type → row error.
//   5. Back-compat: an org with only the pre-156 default row behaves exactly
//      as today (same stages, same 'default' sweep, same create defaults).
//
// Pool is fully mocked with a SQL-shape router (same pattern as
// pipelines.test.js). The 30s effective-pipeline cache is cleared per test.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/v2DualWrite', () => ({
  onDealCreated: vi.fn().mockResolvedValue(null),
  onDealStageChanged: vi.fn().mockResolvedValue(null),
}));
vi.mock('../services/webhookDispatcher', () => ({
  dispatch: vi.fn().mockResolvedValue(null),
}));
vi.mock('../services/notificationDispatcher', () => ({
  notifyDealActivity: vi.fn().mockResolvedValue(null),
}));

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const pipelines = require('../services/pipelines');
const dealStages = require('../utils/dealStages');
const pipelineRoutes = require('../routes/pipelineRoutes');
const dealRoutes = require('../routes/dealRoutes');
const importRoutes = require('../routes/importRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 9201;
const ORG_ID = 92;

function authCookie() { return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`]; }

const DEFAULT_CUSTOM = [
  { id: 'new', label: 'New', tone: 'slate' },
  { id: 'demo', label: 'Demo', tone: 'blue' },
  { id: 'won', label: 'Won', tone: 'green', is_won: true },
  { id: 'lost', label: 'Lost', tone: 'red', is_lost: true },
];

const SUPPLY_STAGES = [
  { id: 'prospect_site', label: 'Prospect Site', tone: 'slate' },
  { id: 'site_visit', label: 'Site Visit', tone: 'cyan' },
  { id: 'won_supply', label: 'Signed', tone: 'green', is_won: true },
  { id: 'lost_supply', label: 'Passed', tone: 'red', is_lost: true },
];

function makeClient() {
  const client = {
    calls: [],
    query: vi.fn(function (sql, params) {
      const s = String(sql).trim();
      client.calls.push({ sql: s, params });
      if (/^INSERT INTO pipelines/i.test(s)) {
        return Promise.resolve({ rows: [{ id: 556, name: params[1], stage_defs: JSON.parse(params[3]), deal_type: params[5], profile: params[6], updated_at: 'now', updated_by: params[7] }] });
      }
      if (/^UPDATE pipelines/i.test(s)) {
        return Promise.resolve({ rows: [{ id: 556, name: params[2], stage_defs: JSON.parse(params[0]), deal_type: null, profile: params[3], updated_at: 'now', updated_by: params[4] }] });
      }
      if (/^INSERT INTO deals/i.test(s)) {
        return Promise.resolve({ rows: [{ id: 4242, title: params[8], stage: params[11], phase: params[12], deal_type: params[13] }] });
      }
      if (/^UPDATE deals SET stage = \$1, phase = \$2,/i.test(s)) {
        // PATCH /:id/stage in-txn update — echo the row back.
        return Promise.resolve({ rows: [{ id: 10, stage: params[0], phase: params[1] }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    }),
    release: vi.fn(),
  };
  return client;
}

// SQL-shape router. `typeRows` maps deal_type → pipelines row; `counts` are
// the deal_type='default' stage counts and `countsByType` the typed ones.
// `dealRow` backs the deal-context lookups (PATCH stage / PUT deal).
function primePool({
  profile = 'generic', pipelineRow = null, typeRows = {}, counts = {},
  countsByType = {}, orgRole = 'owner', dealRow = null,
} = {}) {
  mockPool.query.mockImplementation(async (sql, params) => {
    const s = String(sql);
    if (/FROM admin_users/i.test(s)) return { rows: [] };
    if (/FROM users WHERE id/i.test(s)) return { rows: [{ org_id: ORG_ID, org_role: orgRole, status: 'active' }] };
    if (/SELECT profile FROM organizations/i.test(s)) return { rows: [{ profile }] };
    if (/FROM pipelines WHERE org_id = \$1 AND is_default = TRUE/i.test(s)) return { rows: pipelineRow ? [pipelineRow] : [] };
    if (/FROM pipelines WHERE org_id = \$1 AND deal_type = \$2/i.test(s)) {
      const row = typeRows[params[1]];
      return { rows: row ? [{ deal_type: params[1], ...row }] : [] };
    }
    if (/FROM pipelines\s+WHERE org_id = \$1 AND \(is_default = TRUE OR deal_type IS NOT NULL\)/i.test(s)) {
      const rows = [];
      if (pipelineRow) rows.push({ ...pipelineRow, deal_type: null, is_default: true });
      for (const [dt, row] of Object.entries(typeRows)) rows.push({ deal_type: dt, is_default: false, ...row });
      return { rows };
    }
    if (/FROM deals WHERE org_id = \$1 AND deal_type = \$2 GROUP BY stage/i.test(s)) {
      const c = params[1] === 'default' ? counts : (countsByType[params[1]] || {});
      return { rows: Object.entries(c).map(([stage, n]) => ({ stage, n })) };
    }
    if (/SELECT d\.stage AS current_stage, d\.deal_type/i.test(s)) {
      return { rows: dealRow ? [{ current_stage: dealRow.stage, deal_type: dealRow.deal_type, profile }] : [] };
    }
    if (/SELECT (stage, )?deal_type FROM deals WHERE id/i.test(s)) {
      return { rows: dealRow ? [{ stage: dealRow.stage, deal_type: dealRow.deal_type }] : [] };
    }
    if (/^\s*UPDATE deals SET/i.test(s)) {
      return { rows: dealRow ? [{ id: params[params.length - 2], ...dealRow }] : [] };
    }
    if (/INSERT INTO deals/i.test(s)) {
      return { rows: [{ id: 4242 }] };
    }
    if (/INSERT INTO audit_log/i.test(s)) return { rows: [] };
    return { rows: [] };
  });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/pipelines', pipelineRoutes);
  app.use('/api/deals', dealRoutes);
  app.use('/api/import', importRoutes);
  return app;
}

const supplyRow = () => ({ id: 7, name: 'Supply', stage_defs: SUPPLY_STAGES, profile: 'generic', updated_at: 't', updated_by: 1 });
const defaultRow = () => ({ id: 5, name: 'Sales', stage_defs: DEFAULT_CUSTOM, profile: 'generic', updated_at: 't', updated_by: 1 });

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  pipelines._clearCache();
});

// ===========================================================================
// 1. Fallback chain: type row → default row → profile default
// ===========================================================================
describe('getEffectivePipeline — deal_type fallback chain', () => {
  test('a type row wins for its type', async () => {
    primePool({ typeRows: { supply: supplyRow() }, pipelineRow: defaultRow() });
    const p = await pipelines.getEffectivePipeline(ORG_ID, undefined, { dealType: 'supply' });
    expect(p.is_custom).toBe(true);
    expect(p.deal_type).toBe('supply');
    expect(p.stages.map((s) => s.id)).toEqual(['prospect_site', 'site_visit', 'won_supply', 'lost_supply']);
    expect(p.name).toBe('Supply');
  });

  test('a type WITHOUT a row falls back to the org default row', async () => {
    primePool({ pipelineRow: defaultRow() });
    const p = await pipelines.getEffectivePipeline(ORG_ID, undefined, { dealType: 'supply' });
    expect(p.deal_type).toBe('default');
    expect(p.stages.map((s) => s.id)).toEqual(['new', 'demo', 'won', 'lost']);
  });

  test('a type without any rows falls through to the profile default', async () => {
    primePool({});
    const p = await pipelines.getEffectivePipeline(ORG_ID, undefined, { dealType: 'supply' });
    expect(p.is_custom).toBe(false);
    expect(p.deal_type).toBe('default');
    expect(p.stages.map((s) => s.id)).toEqual(['lead', 'qualified', 'proposal', 'negotiation', 'closed_won', 'closed_lost']);
  });

  test('caching is per (org, type) and bustCache clears every type of the org', async () => {
    primePool({ typeRows: { supply: supplyRow() } });
    await pipelines.getEffectivePipeline(ORG_ID, undefined, { dealType: 'supply' });
    await pipelines.getEffectivePipeline(ORG_ID);
    const before = mockPool.query.mock.calls.length;
    await pipelines.getEffectivePipeline(ORG_ID, undefined, { dealType: 'supply' });
    await pipelines.getEffectivePipeline(ORG_ID);
    expect(mockPool.query.mock.calls.length).toBe(before); // both cached
    pipelines.bustCache(ORG_ID);
    await pipelines.getEffectivePipeline(ORG_ID, undefined, { dealType: 'supply' });
    await pipelines.getEffectivePipeline(ORG_ID);
    expect(mockPool.query.mock.calls.length).toBeGreaterThan(before);
  });

  test('deal_type slugs are validated: uppercase is normalized, junk is a 400', async () => {
    expect(pipelines.normalizeDealType('Supply')).toBe('supply');
    expect(pipelines.normalizeDealType(undefined)).toBe('default');
    expect(() => pipelines.normalizeDealType('9bad')).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => pipelines.normalizeDealType('has space')).toThrow(expect.objectContaining({ status: 400 }));
  });
});

// ===========================================================================
// 2. savePipeline / resetPipeline scoping per deal_type
// ===========================================================================
describe('savePipeline — deal moves are scoped to the deal_type', () => {
  test('saving a type pipeline only sweeps that type\'s deals', async () => {
    primePool({
      typeRows: { supply: supplyRow() },
      countsByType: { supply: { site_visit: 2 } },
      counts: { site_visit: 99 }, // default-type deals in a same-named stage must be untouched
    });
    const client = makeClient();
    mockPool.connect.mockResolvedValue(client);
    const stages = SUPPLY_STAGES.filter((s) => s.id !== 'site_visit');
    const out = await pipelines.savePipeline(ORG_ID, stages, USER_ID, { dealType: 'supply', moveDealsTo: { site_visit: 'prospect_site' } });
    expect(out.moved).toEqual([{ from: 'site_visit', to: 'prospect_site', count: 2 }]);
    expect(out.pipeline.deal_type).toBe('supply');
    const upd = client.calls.find((c) => /^UPDATE deals SET stage/i.test(c.sql));
    expect(upd.params).toEqual(['prospect_site', 'pre_sale', ORG_ID, 'site_visit', 'supply']);
    // Upsert targeted the (org, deal_type) row, not the default row.
    const sel = client.calls.find((c) => /^SELECT id FROM pipelines/i.test(c.sql));
    expect(sel.sql).toMatch(/deal_type = \$2/);
    expect(sel.params).toEqual([ORG_ID, 'supply']);
  });

  test('a default-row save never touches typed deals sitting in a removed stage name', async () => {
    primePool({
      pipelineRow: defaultRow(),
      counts: {}, // no default-type deals in 'demo'
      countsByType: { supply: { demo: 6 } }, // typed deals named the same — must not 409 or move
    });
    const client = makeClient();
    mockPool.connect.mockResolvedValue(client);
    const stages = DEFAULT_CUSTOM.filter((s) => s.id !== 'demo');
    const out = await pipelines.savePipeline(ORG_ID, stages, USER_ID);
    expect(out.moved).toEqual([]);
    expect(client.calls.some((c) => /^UPDATE deals/i.test(c.sql))).toBe(false);
  });

  test('PUT /api/pipelines with a NEW deal_type creates that pipeline (owner only)', async () => {
    primePool({ orgRole: 'owner' });
    const client = makeClient();
    mockPool.connect.mockResolvedValue(client);
    const r = await request(buildApp())
      .put('/api/pipelines')
      .set('Cookie', authCookie())
      .send({ stages: SUPPLY_STAGES, deal_type: 'supply', name: 'Supply funnel' });
    expect(r.status).toBe(200);
    expect(r.body.pipeline.deal_type).toBe('supply');
    const ins = client.calls.find((c) => /^INSERT INTO pipelines/i.test(c.sql));
    expect(ins.params[4]).toBe(false);      // is_default
    expect(ins.params[5]).toBe('supply');   // deal_type
    expect(ins.params[1]).toBe('Supply funnel');

    primePool({ orgRole: 'member' });
    const denied = await request(buildApp())
      .put('/api/pipelines')
      .set('Cookie', authCookie())
      .send({ stages: SUPPLY_STAGES, deal_type: 'supply' });
    expect(denied.status).toBe(403);
  });

  test('deleting a type pipeline refuses while its deals are unresolved, then retypes them', async () => {
    primePool({ typeRows: { supply: supplyRow() }, countsByType: { supply: { site_visit: 3 } } });
    const conflict = await request(buildApp())
      .delete('/api/pipelines?deal_type=supply')
      .set('Cookie', authCookie())
      .send({});
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('stages_have_deals');

    pipelines._clearCache();
    const client = makeClient();
    mockPool.connect.mockResolvedValue(client);
    const ok = await request(buildApp())
      .delete('/api/pipelines?deal_type=supply')
      .set('Cookie', authCookie())
      .send({ moveDealsTo: { site_visit: 'lead' } });
    expect(ok.status).toBe(200);
    expect(ok.body.deleted).toBe('supply');
    expect(ok.body.retyped_to).toBe('default');
    const sqls = client.calls.map((c) => c.sql);
    expect(sqls.some((s) => /^UPDATE deals SET deal_type/i.test(s))).toBe(true);
    expect(sqls.some((s) => /^DELETE FROM pipelines WHERE org_id = \$1 AND deal_type = \$2/i.test(s))).toBe(true);
    // The default pipeline itself can never be deleted.
    const noDefault = await request(buildApp())
      .delete('/api/pipelines?deal_type=default')
      .set('Cookie', authCookie())
      .send({});
    expect(noDefault.status).toBe(400);
  });
});

// ===========================================================================
// 3. Stage validation is per-type
// ===========================================================================
describe('stage validation — per deal_type pipeline', () => {
  test('a supply stage is invalid on the default pipeline and vice versa', async () => {
    primePool({ pipelineRow: defaultRow(), typeRows: { supply: supplyRow() } });
    const supply = await pipelines.getEffectivePipeline(ORG_ID, undefined, { dealType: 'supply' });
    const dflt = await pipelines.getEffectivePipeline(ORG_ID);
    expect(dealStages.isValidStage('site_visit', supply)).toBe(true);
    expect(dealStages.isValidStage('site_visit', dflt)).toBe(false);
    expect(dealStages.isValidStage('demo', dflt)).toBe(true);
    expect(dealStages.isValidStage('demo', supply)).toBe(false);
  });

  test('PATCH /:id/stage resolves the pipeline for the DEAL\'s type', async () => {
    primePool({
      pipelineRow: defaultRow(),
      typeRows: { supply: supplyRow() },
      dealRow: { stage: 'prospect_site', deal_type: 'supply' },
    });
    const client = makeClient();
    mockPool.connect.mockResolvedValue(client);
    const bad = await request(buildApp())
      .patch('/api/deals/10/stage')
      .set('Cookie', authCookie())
      .send({ stage: 'demo' }); // a default-pipeline stage — not on supply
    expect(bad.status).toBe(400);
    expect(bad.body.valid_stages).toEqual(['prospect_site', 'site_visit', 'won_supply', 'lost_supply']);

    const ok = await request(buildApp())
      .patch('/api/deals/10/stage')
      .set('Cookie', authCookie())
      .send({ stage: 'site_visit' });
    expect(ok.status).toBe(200);
  });

  test('PUT /:id refuses a deal_type change without a stage valid on the target pipeline', async () => {
    primePool({
      pipelineRow: defaultRow(),
      typeRows: { supply: supplyRow() },
      dealRow: { stage: 'demo', deal_type: 'default' },
    });
    const noStage = await request(buildApp())
      .put('/api/deals/10')
      .set('Cookie', authCookie())
      .send({ deal_type: 'supply' });
    expect(noStage.status).toBe(400);
    expect(noStage.body.code).toBe('DEAL_TYPE_NEEDS_STAGE');

    const badStage = await request(buildApp())
      .put('/api/deals/10')
      .set('Cookie', authCookie())
      .send({ deal_type: 'supply', stage: 'demo' });
    expect(badStage.status).toBe(400);
    expect(badStage.body.code).toBe('INVALID_STAGE');

    const ok = await request(buildApp())
      .put('/api/deals/10')
      .set('Cookie', authCookie())
      .send({ deal_type: 'supply', stage: 'site_visit' });
    expect(ok.status).toBe(200);
  });
});

// ===========================================================================
// 4. Unknown deal_type on create / import
// ===========================================================================
describe('unknown deal_type — 400 on create, row error on import', () => {
  test('POST /api/deals with an unknown deal_type → 400 listing the valid types', async () => {
    primePool({ typeRows: { supply: supplyRow() } });
    const client = makeClient();
    mockPool.connect.mockResolvedValue(client);
    const r = await request(buildApp())
      .post('/api/deals')
      .set('Cookie', authCookie())
      .send({ title: 'Test', deal_type: 'bogus' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_DEAL_TYPE');
    expect(r.body.valid_deal_types).toEqual(['default', 'supply']);
    // Nothing was written.
    expect(client.calls.some((c) => /^INSERT INTO deals/i.test(c.sql))).toBe(false);
  });

  test('POST /api/deals with a known deal_type creates on that pipeline\'s default stage', async () => {
    primePool({ typeRows: { supply: supplyRow() } });
    const client = makeClient();
    mockPool.connect.mockResolvedValue(client);
    const r = await request(buildApp())
      .post('/api/deals')
      .set('Cookie', authCookie())
      .send({ title: 'New site', deal_type: 'supply' });
    expect(r.status).toBe(201);
    const ins = client.calls.find((c) => /^INSERT INTO deals/i.test(c.sql));
    expect(ins.params[11]).toBe('prospect_site'); // stage = supply pipeline's first
    expect(ins.params[13]).toBe('supply');        // deal_type
  });

  test('import: a row with a bad deal_type is a row error naming the valid types', async () => {
    primePool({ typeRows: { supply: supplyRow() } });
    const r = await request(buildApp())
      .post('/api/import/deals')
      .set('Cookie', authCookie())
      .send({
        rows: [
          { Title: 'Good', Type: 'supply' },
          { Title: 'Bad', Type: 'nonsense' },
        ],
        mapping: { title: 'Title', deal_type: 'Type' },
      });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(1);
    expect(r.body.skipped).toBe(1);
    expect(r.body.errors[0].reason).toMatch(/Invalid deal_type "nonsense"/);
    expect(r.body.errors[0].reason).toMatch(/default, supply/);
  });
});

// ===========================================================================
// 5. Back-compat: single-pipeline org behaves exactly as today
// ===========================================================================
describe('back-compat — an org that never created a second pipeline', () => {
  test('effective pipeline with no dealType equals dealType "default"', async () => {
    primePool({ pipelineRow: defaultRow() });
    const a = await pipelines.getEffectivePipeline(ORG_ID);
    pipelines._clearCache();
    const b = await pipelines.getEffectivePipeline(ORG_ID, undefined, { dealType: 'default' });
    expect(b).toEqual(a);
  });

  test('GET /api/pipelines keeps its shape; the pipelines list has just the default', async () => {
    primePool({ pipelineRow: defaultRow(), counts: { new: 2 } });
    const r = await request(buildApp()).get('/api/pipelines').set('Cookie', authCookie());
    expect(r.status).toBe(200);
    expect(r.body.is_custom).toBe(true);
    expect(r.body.deal_type).toBe('default');
    expect(r.body.stages.map((s) => s.id)).toEqual(['new', 'demo', 'won', 'lost']);
    expect(r.body.deal_counts).toEqual({ new: 2 });
    expect(r.body.pipelines).toEqual([{ deal_type: 'default', name: 'Sales', is_custom: true, stage_count: 4 }]);
  });

  test('an untouched org gets the profile default and a one-entry pipelines list', async () => {
    primePool({});
    const r = await request(buildApp()).get('/api/pipelines').set('Cookie', authCookie());
    expect(r.status).toBe(200);
    expect(r.body.is_custom).toBe(false);
    expect(r.body.pipelines).toEqual([{ deal_type: 'default', name: 'Pipeline', is_custom: false, stage_count: 6 }]);
  });

  test('deal create without deal_type lands on "default" with the legacy stage default', async () => {
    primePool({});
    const client = makeClient();
    mockPool.connect.mockResolvedValue(client);
    const r = await request(buildApp())
      .post('/api/deals')
      .set('Cookie', authCookie())
      .send({ title: 'Plain deal' });
    expect(r.status).toBe(201);
    const ins = client.calls.find((c) => /^INSERT INTO deals/i.test(c.sql));
    expect(ins.params[11]).toBe('TRIAGE');   // unchanged legacy default on a profile default
    expect(ins.params[13]).toBe('default');
  });
});
