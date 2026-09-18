// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Per-org editable pipeline stages (wave 2, workstream G — migration 155).
//
//   A. services/pipelines — effective pipeline falls back to the profile
//      default; validation rules; removal with deals requires moveDealsTo and
//      moves them in the same transaction.
//   B. utils/dealStages — custom slugs accepted, unknown rejected, legacy
//      union still accepted for orgs on a profile default.
//   C. /api/pipelines — GET for a member, PUT owner/admin gate + 400/409.
//   D. chat — propose_update_pipeline proposes without writing; apply is
//      owner/admin gated and runs savePipeline.
//
// Pool is fully mocked with a SQL-shape router. The 30s effective-pipeline
// cache is cleared before every test.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/usageMeter', () => ({
  increment:     vi.fn().mockResolvedValue(null),
  recordAiUsage: vi.fn().mockResolvedValue(null),
}));
vi.mock('../services/aiMetering', () => ({
  recordUsage: vi.fn().mockResolvedValue(null),
}));
vi.mock('../services/quotaEnforcer', () => {
  class QuotaExceeded extends Error {}
  return { QuotaExceeded, getSeatCount: vi.fn().mockResolvedValue(1), checkAiQuota: vi.fn().mockResolvedValue(null) };
});

process.env.ANTHROPIC_API_KEY = 'test-key-for-vitest';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const featureFlags = require('../services/featureFlags');
featureFlags.hasFeature = vi.fn().mockResolvedValue(true);
const pipelines = require('../services/pipelines');
const dealStages = require('../utils/dealStages');
const chatActions = require('../services/chatActions');
const pipelineRoutes = require('../routes/pipelineRoutes');
const aiRoutes = require('../routes/aiRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 9101;
const ORG_ID = 91;

function authCookie() { return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`]; }

function makeClient() {
  const client = {
    calls: [],
    query: vi.fn(function (sql, params) {
      const s = String(sql).trim();
      client.calls.push({ sql: s, params });
      if (/^INSERT INTO pipelines/i.test(s)) {
        return Promise.resolve({ rows: [{ id: 555, name: params[1], stage_defs: JSON.parse(params[3]), deal_type: params[5], profile: params[6], updated_at: 'now', updated_by: params[7] }] });
      }
      if (/^UPDATE pipelines/i.test(s)) {
        return Promise.resolve({ rows: [{ id: 555, name: params[2], stage_defs: JSON.parse(params[0]), deal_type: null, profile: params[3], updated_at: 'now', updated_by: params[4] }] });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    }),
    release: vi.fn(),
  };
  return client;
}

// SQL-shape router. `profile` drives organizations, `pipelineRow` the org's
// default pipelines row (null = none), `counts` the deals GROUP BY stage for
// deal_type 'default'. Since spec 201: `typeRows` maps deal_type → pipelines
// row and `countsByType` maps deal_type → its GROUP BY stage counts.
function primePool({ profile = 'generic', pipelineRow = null, counts = {}, typeRows = {}, countsByType = {}, orgRole = 'member', admin = null } = {}) {
  mockPool.query.mockImplementation(async (sql, params) => {
    const s = String(sql);
    if (/FROM admin_users/i.test(s)) return { rows: admin ? [admin] : [] };
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
    if (/INSERT INTO audit_log/i.test(s)) return { rows: [] };
    return { rows: [] };
  });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/pipelines', pipelineRoutes);
  app.use('/api/ai', aiRoutes);
  return app;
}

const CUSTOM_STAGES = [
  { id: 'new', label: 'New', tone: 'slate' },
  { id: 'demo', label: 'Demo', tone: 'blue' },
  { id: 'won', label: 'Won', tone: 'green', is_won: true },
  { id: 'lost', label: 'Lost', tone: 'red', is_lost: true },
];

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  pipelines._clearCache();
  featureFlags._clearCache && featureFlags._clearCache();
});

// ===========================================================================
// A. services/pipelines
// ===========================================================================
describe('services/pipelines — effective pipeline', () => {
  test('falls back to the profile default when the org has no pipeline row (generic)', async () => {
    primePool({ profile: 'generic' });
    const p = await pipelines.getEffectivePipeline(ORG_ID);
    expect(p.is_custom).toBe(false);
    expect(p.profile).toBe('generic');
    expect(p.stages.map((s) => s.id)).toEqual(['lead', 'qualified', 'proposal', 'negotiation', 'closed_won', 'closed_lost']);
    expect(p.phases).toHaveLength(1);
    expect(p.default_stage).toBe('lead');
    expect(p.stages.find((s) => s.id === 'closed_won').is_won).toBe(true);
    expect(p.stages.find((s) => s.id === 'closed_lost').is_lost).toBe(true);
  });

  test('zang default carries all 29 Exhibit A stages across three phases', async () => {
    primePool({ profile: 'zang' });
    const p = await pipelines.getEffectivePipeline(ORG_ID);
    expect(p.stages).toHaveLength(29);
    expect(p.phases.map((ph) => ph.id)).toEqual(['pre_sale', 'post_sale', 'post_ship']);
    expect(p.default_stage).toBe('TRIAGE');
  });

  test('jcp default keeps the 7-stage funnel', async () => {
    primePool({ profile: 'jcp' });
    const p = await pipelines.getEffectivePipeline(ORG_ID);
    expect(p.stages.map((s) => s.id)).toEqual(['LEAD', 'INTRO', 'SCOPING', 'PITCH', 'ENGAGED', 'CLOSED_WON', 'CLOSED_LOST']);
  });

  test('an org-less caller gets the profile default without touching the DB', async () => {
    const p = await pipelines.getEffectivePipeline(null, 'generic');
    expect(p.is_custom).toBe(false);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('a custom row wins and is cached for 30s', async () => {
    primePool({ profile: 'generic', pipelineRow: { id: 5, name: 'Sales', stage_defs: CUSTOM_STAGES, profile: 'generic', updated_at: 't', updated_by: 1 } });
    const p = await pipelines.getEffectivePipeline(ORG_ID);
    expect(p.is_custom).toBe(true);
    expect(p.id).toBe(5);
    expect(p.stages.map((s) => s.id)).toEqual(['new', 'demo', 'won', 'lost']);
    const before = mockPool.query.mock.calls.length;
    await pipelines.getEffectivePipeline(ORG_ID);
    expect(mockPool.query.mock.calls.length).toBe(before);
    pipelines.bustCache(ORG_ID);
    await pipelines.getEffectivePipeline(ORG_ID);
    expect(mockPool.query.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('services/pipelines — validateStages', () => {
  test('accepts a well-formed list and normalizes it', () => {
    const v = pipelines.validateStages(CUSTOM_STAGES, 'generic');
    expect(v.ok).toBe(true);
    expect(v.stages[0]).toEqual({ id: 'new', label: 'New', desc: '', tone: 'slate', phase: null, is_won: false, is_lost: false, probability: null });
  });

  test('rejects duplicate slugs, missing won/lost, long labels, and too many stages', () => {
    const dup = pipelines.validateStages([...CUSTOM_STAGES, { id: 'NEW', label: 'Again' }], 'generic');
    expect(dup.ok).toBe(false);
    expect(dup.errors.join(' ')).toMatch(/duplicate stage id/);

    const noWon = pipelines.validateStages([{ id: 'a', label: 'A' }, { id: 'b', label: 'B', is_lost: true }], 'generic');
    expect(noWon.errors.join(' ')).toMatch(/marked as won/);

    const noLost = pipelines.validateStages([{ id: 'a', label: 'A', is_won: true }], 'generic');
    expect(noLost.errors.join(' ')).toMatch(/marked as lost/);

    const longLabel = pipelines.validateStages([{ id: 'a', label: 'x'.repeat(41), is_won: true }, { id: 'b', label: 'B', is_lost: true }], 'generic');
    expect(longLabel.errors.join(' ')).toMatch(/40 characters/);

    const many = Array.from({ length: 16 }, (_, i) => ({ id: `s${i}`, label: `S${i}`, is_won: i === 0, is_lost: i === 1 }));
    const tooMany = pipelines.validateStages(many, 'generic');
    expect(tooMany.errors.join(' ')).toMatch(/at most 15 stages/);
    // Zang's cap is its default + 5, so the same 16 pass there.
    expect(pipelines.validateStages(many, 'zang').ok).toBe(true);

    const both = pipelines.validateStages([{ id: 'a', label: 'A', is_won: true, is_lost: true }], 'generic');
    expect(both.errors.join(' ')).toMatch(/both won and lost/);

    const badSlug = pipelines.validateStages([{ id: '1bad', label: 'A', is_won: true }, { id: 'b', label: 'B', is_lost: true }], 'generic');
    expect(badSlug.errors.join(' ')).toMatch(/must start with a letter/);
  });

  test('derives a slug from the label when id is omitted', () => {
    const v = pipelines.validateStages([{ label: 'Quote Sent!', is_won: true }, { label: 'No Go', is_lost: true }], 'generic');
    expect(v.ok).toBe(true);
    expect(v.stages.map((s) => s.id)).toEqual(['quote_sent', 'no_go']);
  });
});

describe('services/pipelines — savePipeline / resetPipeline', () => {
  test('removing a stage that has deals without moveDealsTo -> 409 and NO write', async () => {
    primePool({ profile: 'generic', counts: { proposal: 3, lead: 1 } });
    const client = makeClient();
    mockPool.connect.mockResolvedValue(client);
    // Drop 'proposal' from the generic default.
    const stages = pipelines.defaultStagesFor('generic').filter((s) => s.id !== 'proposal');
    await expect(pipelines.savePipeline(ORG_ID, stages, USER_ID)).rejects.toMatchObject({
      status: 409,
      body: { error: 'stages_have_deals', stages_with_deals: [{ stage: 'proposal', count: 3 }] },
    });
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  test('with moveDealsTo the deals move in the same transaction as the upsert', async () => {
    primePool({ profile: 'generic', counts: { proposal: 3, lead: 1 } });
    const client = makeClient();
    mockPool.connect.mockResolvedValue(client);
    const stages = pipelines.defaultStagesFor('generic').filter((s) => s.id !== 'proposal');
    const out = await pipelines.savePipeline(ORG_ID, stages, USER_ID, { moveDealsTo: { proposal: 'qualified' } });
    expect(out.moved).toEqual([{ from: 'proposal', to: 'qualified', count: 3 }]);
    expect(out.pipeline.is_custom).toBe(true);
    expect(out.pipeline.stages.map((s) => s.id)).not.toContain('proposal');

    const sqls = client.calls.map((c) => c.sql);
    expect(sqls[0]).toBe('BEGIN');
    const upd = client.calls.find((c) => /^UPDATE deals SET stage/i.test(c.sql));
    // Default-row saves sweep ONLY deal_type='default' deals (spec 201).
    expect(upd.params).toEqual(['qualified', 'pre_sale', ORG_ID, 'proposal', 'default']);
    expect(sqls.some((s) => /^INSERT INTO pipelines/i.test(s))).toBe(true);
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    // Deal moves happen BEFORE the pipeline write, inside the txn.
    expect(sqls.findIndex((s) => /^UPDATE deals/i.test(s))).toBeLessThan(sqls.findIndex((s) => /^INSERT INTO pipelines/i.test(s)));
  });

  test('a single moveDealsTo slug re-homes every stray; an unknown target is a 400', async () => {
    primePool({ profile: 'generic', counts: { proposal: 2, TRIAGE: 4 } });
    const client = makeClient();
    mockPool.connect.mockResolvedValue(client);
    const stages = pipelines.defaultStagesFor('generic').filter((s) => s.id !== 'proposal');
    const out = await pipelines.savePipeline(ORG_ID, stages, USER_ID, { moveDealsTo: 'lead' });
    expect(out.moved.map((m) => m.from).sort()).toEqual(['TRIAGE', 'proposal']);

    pipelines._clearCache();
    await expect(pipelines.savePipeline(ORG_ID, stages, USER_ID, { moveDealsTo: 'nope' })).rejects.toMatchObject({ status: 400 });
  });

  test('invalid stages -> 400 with validation_errors, nothing written', async () => {
    primePool({ profile: 'generic' });
    await expect(pipelines.savePipeline(ORG_ID, [{ id: 'a', label: 'A' }], USER_ID)).rejects.toMatchObject({
      status: 400, body: { error: 'Invalid pipeline' },
    });
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  test('reset deletes the custom row and requires a home for deals the default lacks', async () => {
    primePool({ profile: 'generic', counts: { demo: 2 } });
    await expect(pipelines.resetPipeline(ORG_ID, USER_ID)).rejects.toMatchObject({ status: 409 });
    const client = makeClient();
    mockPool.connect.mockResolvedValue(client);
    const out = await pipelines.resetPipeline(ORG_ID, USER_ID, { moveDealsTo: { demo: 'qualified' } });
    expect(out.pipeline.is_custom).toBe(false);
    expect(client.calls.some((c) => /^DELETE FROM pipelines WHERE org_id/i.test(c.sql))).toBe(true);
    expect(client.calls.find((c) => /^UPDATE deals/i.test(c.sql)).params).toEqual(['qualified', 'pre_sale', ORG_ID, 'demo', 'default']);
  });
});

describe('services/pipelines — applyEdits (chat diff helper)', () => {
  test('add after / rename / remove / reorder resolve ids AND labels', () => {
    const cur = pipelines.defaultStagesFor('generic');
    const out = pipelines.applyEdits(cur, {
      add: [{ label: 'Demo', after: 'Qualified' }],
      rename: { proposal: 'Quote Sent' },
      remove: [{ slug: 'negotiation', moveDealsTo: 'Quote Sent' }],
    });
    expect(out.errors).toEqual([]);
    expect(out.stages.map((s) => s.id)).toEqual(['lead', 'qualified', 'demo', 'proposal', 'closed_won', 'closed_lost']);
    expect(out.stages[3].label).toBe('Quote Sent');
    expect(out.moveDealsTo).toEqual({ negotiation: 'proposal' });
    expect(out.changes.join('; ')).toMatch(/add "Demo" after Qualified/);

    const re = pipelines.applyEdits(cur, { reorder: ['qualified', 'lead'] });
    expect(re.stages.map((s) => s.id).slice(0, 3)).toEqual(['qualified', 'lead', 'proposal']);

    const bad = pipelines.applyEdits(cur, { rename: { nope: 'X' } });
    expect(bad.errors[0]).toMatch(/no stage "nope"/);
  });
});

// ===========================================================================
// B. utils/dealStages
// ===========================================================================
describe('utils/dealStages — pipeline-aware validation', () => {
  const custom = { is_custom: true, stages: CUSTOM_STAGES };
  const generic = { is_custom: false, stages: pipelines.defaultStagesFor('generic') };

  test('custom pipeline: accepts its own slugs only', () => {
    expect(dealStages.isValidStage('demo', custom)).toBe(true);
    expect(dealStages.isValidStage('lead', custom)).toBe(false);
    expect(dealStages.isValidStage('TRIAGE', custom)).toBe(false);
    expect(() => dealStages.assertStage('lead', custom)).toThrow(/Invalid stage/);
  });

  test('profile default: accepts its stages AND the legacy union (zero behaviour change)', () => {
    expect(dealStages.isValidStage('lead', generic)).toBe(true);
    expect(dealStages.isValidStage('TRIAGE', generic)).toBe(true);
    expect(dealStages.isValidStage('bogus', generic)).toBe(false);
    // No pipeline at all → legacy behaviour.
    expect(dealStages.isValidStage('closed_won')).toBe(true);
    expect(dealStages.VALID_STAGES).toContain('INVOICED');
  });

  test('resolveStageId matches ids case-insensitively and by label', () => {
    expect(dealStages.resolveStageId('Demo', custom)).toBe('demo');
    expect(dealStages.resolveStageId('DEMO', custom)).toBe('demo');
    expect(dealStages.resolveStageId('Closed Won', generic)).toBe('closed_won');
    expect(dealStages.resolveStageId('nothing', custom)).toBeNull();
  });

  test('phaseForStage: custom phase wins, legacy derivation otherwise', () => {
    const zangish = { is_custom: true, stages: [{ id: 'ship', label: 'Ship', phase: 'post_ship' }] };
    expect(dealStages.phaseForStage('ship', zangish)).toBe('post_ship');
    expect(dealStages.phaseForStage('INVOICED')).toBe('post_sale');
    expect(dealStages.phaseForStage('lead', generic)).toBe('pre_sale');
  });
});

// ===========================================================================
// C. /api/pipelines
// ===========================================================================
describe('/api/pipelines', () => {
  test('GET: member sees the effective pipeline, counts, and can_edit=false', async () => {
    primePool({ profile: 'generic', counts: { lead: 2 }, orgRole: 'member' });
    const r = await request(buildApp()).get('/api/pipelines').set('Cookie', authCookie());
    expect(r.status).toBe(200);
    expect(r.body.is_custom).toBe(false);
    expect(r.body.can_edit).toBe(false);
    expect(r.body.deal_counts).toEqual({ lead: 2 });
    expect(r.body.default_stages).toHaveLength(6);
    expect(r.body.tones).toContain('blue');
  });

  test('PUT: member -> 403; owner with invalid stages -> 400; owner removing a stage with deals -> 409', async () => {
    primePool({ profile: 'generic', orgRole: 'member' });
    const denied = await request(buildApp()).put('/api/pipelines').set('Cookie', authCookie()).send({ stages: CUSTOM_STAGES });
    expect(denied.status).toBe(403);

    primePool({ profile: 'generic', orgRole: 'owner' });
    const bad = await request(buildApp()).put('/api/pipelines').set('Cookie', authCookie()).send({ stages: [{ id: 'a', label: 'A' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.validation_errors.join(' ')).toMatch(/won/);

    pipelines._clearCache();
    primePool({ profile: 'generic', orgRole: 'owner', counts: { proposal: 2 } });
    const conflict = await request(buildApp()).put('/api/pipelines').set('Cookie', authCookie()).send({ stages: CUSTOM_STAGES });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('stages_have_deals');
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  test('PUT: owner saves and the response carries the new effective pipeline', async () => {
    primePool({ profile: 'generic', orgRole: 'admin' });
    const client = makeClient();
    mockPool.connect.mockResolvedValue(client);
    const r = await request(buildApp()).put('/api/pipelines').set('Cookie', authCookie()).send({ stages: CUSTOM_STAGES });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.pipeline.is_custom).toBe(true);
    expect(r.body.pipeline.stages.map((s) => s.id)).toEqual(['new', 'demo', 'won', 'lost']);
    expect(client.calls.some((c) => /^INSERT INTO pipelines/i.test(c.sql))).toBe(true);
  });

  test('POST /reset: member -> 403', async () => {
    primePool({ profile: 'generic', orgRole: 'member' });
    const r = await request(buildApp()).post('/api/pipelines/reset').set('Cookie', authCookie()).send({});
    expect(r.status).toBe(403);
  });
});

// ===========================================================================
// D. chat — propose_update_pipeline + apply
// ===========================================================================
describe('chat — propose_update_pipeline', () => {
  test('validateAction: pipeline.update spec is a service action with a readable summary', () => {
    const v = chatActions.validateAction({ entity: 'pipeline', op: 'update', fields: { stages: CUSTOM_STAGES, change_summary: 'add "Demo"' } });
    expect(v.ok).toBe(true);
    expect(v.action.summary).toMatch(/add "Demo"/);
    expect(v.action.summary).toMatch(/New → Demo → Won → Lost/);
    expect(chatActions.SPECS['pipeline.update'].requiresAdmin).toBe(true);

    const bad = chatActions.validateAction({ entity: 'pipeline', op: 'update', fields: { stages: [{ id: 'a', label: 'A' }] } });
    expect(bad.ok).toBe(false);
  });

  test('owner: proposes the resulting stage list without writing', async () => {
    primePool({ profile: 'generic', orgRole: 'owner' });
    const runTool = aiRoutes._buildChatToolRunner({ orgId: ORG_ID, userId: USER_ID, orgRole: 'owner', headers: {} });
    const out = await runTool('propose_update_pipeline', { add: [{ label: 'Demo', after: 'qualified' }], rename: { proposal: 'Quote Sent' } });
    expect(out.error).toBeUndefined();
    expect(out.proposal.entity).toBe('pipeline');
    expect(out.proposal.op).toBe('update');
    expect(out.proposal.fields.stages.map((s) => s.id)).toEqual(['lead', 'qualified', 'demo', 'proposal', 'negotiation', 'closed_won', 'closed_lost']);
    expect(out.proposal.summary).toMatch(/Quote Sent/);
    expect(out.resulting_pipeline).toMatch(/Demo/);
    expect(mockPool.connect).not.toHaveBeenCalled();
    expect(mockPool.query.mock.calls.some(([sql]) => /INSERT INTO pipelines|UPDATE pipelines|UPDATE deals/i.test(String(sql)))).toBe(false);
  });

  test('removing a stage with deals needs moveDealsTo; member is not_authorized', async () => {
    primePool({ profile: 'generic', orgRole: 'owner', counts: { negotiation: 5 } });
    const runTool = aiRoutes._buildChatToolRunner({ orgId: ORG_ID, userId: USER_ID, orgRole: 'owner', headers: {} });
    const blocked = await runTool('propose_update_pipeline', { remove: [{ slug: 'negotiation' }] });
    expect(blocked.error).toBe('stages_have_deals');
    expect(blocked.stages_with_deals).toEqual([{ stage: 'negotiation', count: 5 }]);

    const ok = await runTool('propose_update_pipeline', { remove: [{ slug: 'negotiation', moveDealsTo: 'proposal' }] });
    expect(ok.proposal.fields.moveDealsTo).toEqual({ negotiation: 'proposal' });
    expect(ok.deals_to_move).toEqual([{ from: 'negotiation', to: 'proposal', count: 5 }]);

    const member = aiRoutes._buildChatToolRunner({ orgId: ORG_ID, userId: USER_ID, orgRole: 'member', headers: {} });
    const denied = await member('propose_update_pipeline', { add: [{ label: 'Demo' }] });
    expect(denied.error).toBe('not_authorized');
  });

  test('apply: member -> 403 (no write); owner -> savePipeline runs in a txn', async () => {
    const proposal = { entity: 'pipeline', op: 'update', fields: { stages: CUSTOM_STAGES, change_summary: 'x' } };

    primePool({ profile: 'generic', orgRole: 'member' });
    const denied = await request(buildApp()).post('/api/ai/actions/apply').set('Cookie', authCookie()).send({ proposal });
    expect(denied.status).toBe(403);
    expect(mockPool.connect).not.toHaveBeenCalled();

    primePool({ profile: 'generic', orgRole: 'owner' });
    const client = makeClient();
    mockPool.connect.mockResolvedValue(client);
    const ok = await request(buildApp()).post('/api/ai/actions/apply').set('Cookie', authCookie()).send({ proposal });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.result.is_custom).toBe(true);
    expect(ok.body.open_path).toBe('/settings/pipeline');
    expect(client.calls.some((c) => /^INSERT INTO pipelines/i.test(c.sql))).toBe(true);
  });

  test('how_do_i pipeline_stages reports the org\'s effective stages and says they are editable', async () => {
    primePool({ profile: 'generic', orgRole: 'owner', pipelineRow: { id: 5, name: 'Sales', stage_defs: CUSTOM_STAGES, profile: 'generic' } });
    const runTool = aiRoutes._buildChatToolRunner({ orgId: ORG_ID, userId: USER_ID, orgRole: 'owner', headers: {} });
    const out = await runTool('how_do_i', { question: 'can I rename a pipeline stage?' });
    expect(out.capability.topic).toBe('pipeline_stages');
    expect(out.capability.status).toBe('live');
    expect(out.capability.your_pipeline_is_custom).toBe(true);
    expect(out.capability.your_stages.map((s) => s.id)).toEqual(['new', 'demo', 'won', 'lost']);
    expect(out.capability.where).toBe('/settings/pipeline');
  });
});
