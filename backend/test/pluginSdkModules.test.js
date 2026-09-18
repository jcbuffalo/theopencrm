// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Tests for the 2026-09 plugin-SDK module-object expansion:
// leads / cases / quotes / meetings / service_contracts.
//
// We exercise:
//   1. read column allowlists — every new read SELECTs exactly the allowlist,
//      never `*`, and no allowlist anywhere carries a token/secret/portal column
//   2. filter allowlists — allowed keys become parameterized WHERE fragments,
//      unknown keys are silently dropped, meetings after/before build a
//      starts_at range
//   3. budgets — each read charges exactly 1 query
//   4. feature-flag degradation — a flag-OFF module returns []/null + one
//      run-log warning, charges no budget, records no proposal
//   5. dryRun proposals — updateLead/updateCase capture proposals through the
//      same machinery as updateDeal, and pluginActions re-validates them
//   6. validator + generator surface — the new methods author-validate, and
//      the parity between SDK_METHOD_ALLOWLIST / runner bridge / buildContext
//      can never silently drift
//
// Harness mirrors test/plugin-sandbox.test.js: patch the live pool instance
// (pool.connect returns a stub client so we can inspect the exact SQL) and
// live-stub featureFlags.hasFeature (the SDK calls it through the module
// object precisely so tests can do this).

// describe / test / expect / beforeEach / vi are global.

const clientQueryCalls = [];
function makeStubClient(rowsForQuery) {
  return {
    query: vi.fn().mockImplementation((sql, params) => {
      clientQueryCalls.push({ sql, params });
      if (/^BEGIN|^COMMIT|^ROLLBACK|^SET LOCAL/i.test(String(sql).trim())) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return Promise.resolve(rowsForQuery || { rows: [{ id: 1 }], rowCount: 1 });
    }),
    release: vi.fn(),
  };
}

// Patch the live pool instance (see plugin-sandbox.test.js / auth.test.js).
const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

// Live-stub the feature-flag service — default: every module ON.
const featureFlags = require('../services/featureFlags');
featureFlags.hasFeature = vi.fn().mockResolvedValue(true);

const pluginSdk = require('../services/pluginSdk');
const pluginActions = require('../services/pluginActions');
const { validateSpec, SDK_METHOD_ALLOWLIST } = require('../services/pluginSpecValidator');
const pluginRunner = require('../services/pluginRunner');

function buildCtx(overrides = {}) {
  const counters = { db_queries: 0, tasks_created: 0 };
  const logBuffer = [];
  const proposedActions = [];
  const ctx = pluginSdk.buildContext({
    orgId: 7,
    logBuffer,
    counters,
    ...overrides,
    ...(overrides.dryRun ? { proposedActions } : {}),
  });
  return { ctx, counters, logBuffer, proposedActions };
}

// The data-bearing SELECT/UPDATE inside the BEGIN/SET LOCAL/…/COMMIT wrapper.
function lastDataQuery() {
  const data = clientQueryCalls.filter(
    (c) => !/^BEGIN|^COMMIT|^ROLLBACK|^SET LOCAL/i.test(String(c.sql).trim())
  );
  return data[data.length - 1];
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  mockPool.connect.mockImplementation(() => Promise.resolve(makeStubClient()));
  featureFlags.hasFeature.mockReset();
  featureFlags.hasFeature.mockResolvedValue(true);
  clientQueryCalls.length = 0;
});

// ===========================================================================
// 1. Read column allowlists
// ===========================================================================
describe('module-object reads — column allowlists', () => {
  const CASES = [
    ['listLeads', 'leads'],
    ['listCases', 'cases'],
    ['listQuotes', 'quotes'],
    ['listMeetings', 'meetings'],
    ['listServiceContracts', 'service_contracts'],
  ];

  for (const [method, table] of CASES) {
    test(`crm.${method} SELECTs exactly the ${table} read allowlist (never *)`, async () => {
      const { ctx, counters } = buildCtx();
      await ctx[method]({});
      const q = lastDataQuery();
      const expectedCols = pluginSdk.READ_COLUMN_ALLOWLISTS[table].join(', ');
      expect(q.sql).toContain(`SELECT ${expectedCols} FROM ${table}`);
      expect(q.sql).not.toContain('*');
      // org-scoped by closure: org id is always $1.
      expect(q.params[0]).toBe(7);
      // one read = 1 query budget
      expect(counters.db_queries).toBe(1);
    });
  }

  const GETS = [
    ['getLead', 'leads'],
    ['getCase', 'cases'],
    ['getQuote', 'quotes'],
    ['getMeeting', 'meetings'],
  ];
  for (const [method, table] of GETS) {
    test(`crm.${method} SELECTs the allowlist, id + org scoped`, async () => {
      const { ctx } = buildCtx();
      await ctx[method](42);
      const q = lastDataQuery();
      expect(q.sql).toContain(`FROM ${table} WHERE id = $1 AND org_id = $2`);
      expect(q.sql).not.toContain('*');
      expect(q.params).toEqual([42, 7]);
    });
  }

  test('no read allowlist anywhere carries a token/secret/portal/credential column', () => {
    const forbidden = /(token|secret|password|api_key|public_id|portal_|credential|_hash)/i;
    for (const [table, cols] of Object.entries(pluginSdk.READ_COLUMN_ALLOWLISTS)) {
      for (const col of cols) {
        expect(col, `${table}.${col} looks sensitive`).not.toMatch(forbidden);
      }
    }
  });
});

// ===========================================================================
// 2. Filter allowlists + meetings date range
// ===========================================================================
describe('module-object reads — filters', () => {
  test('listLeads honors status/source/owner_user_id, drops unknown keys', async () => {
    const { ctx } = buildCtx();
    await ctx.listLeads({ status: 'new', source: 'web', owner_user_id: 5, email: 'x@y.z', org_id: 999 });
    const q = lastDataQuery();
    expect(q.sql).toMatch(/status = \$\d/);
    expect(q.sql).toMatch(/source = \$\d/);
    expect(q.sql).toMatch(/owner_user_id = \$\d/);
    expect(q.sql).not.toMatch(/email = \$\d/); // unknown filter key dropped (email is still a SELECT column)
    expect(q.sql).not.toMatch(/org_id = \$[2-9]/); // org_id only as the closure-bound $1
    expect(q.params).toEqual([7, 'new', 'web', 5]);
  });

  test('listCases honors status/priority/company_id', async () => {
    const { ctx } = buildCtx();
    await ctx.listCases({ status: 'open', priority: 'urgent', company_id: 3 });
    const q = lastDataQuery();
    expect(q.params).toEqual([7, 'open', 'urgent', 3]);
  });

  test('listQuotes honors status/deal_id/customer_id', async () => {
    const { ctx } = buildCtx();
    await ctx.listQuotes({ status: 'sent', deal_id: 11, customer_id: 4 });
    const q = lastDataQuery();
    expect(q.params).toEqual([7, 'sent', 11, 4]);
  });

  test('listServiceContracts honors renewal_stage/status/customer_id', async () => {
    const { ctx } = buildCtx();
    await ctx.listServiceContracts({ renewal_stage: 'at_risk', customer_id: 8 });
    const q = lastDataQuery();
    expect(q.sql).toMatch(/renewal_stage = \$\d/);
    expect(q.params).toEqual([7, 'at_risk', 8]);
  });

  test('listMeetings after/before become a parameterized starts_at range', async () => {
    const { ctx } = buildCtx();
    await ctx.listMeetings({ deal_id: 2, after: '2026-09-01', before: '2026-09-30T23:59:59Z' });
    const q = lastDataQuery();
    expect(q.sql).toMatch(/starts_at >= \$\d/);
    expect(q.sql).toMatch(/starts_at <= \$\d/);
    expect(q.params).toEqual([7, 2, '2026-09-01', '2026-09-30T23:59:59Z']);
  });

  test('listMeetings drops an unparseable date and non-string range values', async () => {
    const { ctx } = buildCtx();
    await ctx.listMeetings({ after: 'not-a-date', before: { $gt: 1 } });
    const q = lastDataQuery();
    expect(q.sql).not.toMatch(/starts_at (>=|<=)/); // no range fragment (starts_at is still a SELECT column)
    expect(q.params).toEqual([7]);
  });
});

// ===========================================================================
// 3. Feature-flag degradation
// ===========================================================================
describe('module-object reads — flag-OFF degradation', () => {
  test('the table → flag map is exactly the documented gating', () => {
    expect(pluginSdk.TABLE_FEATURE_FLAGS).toEqual({
      leads: 'leads_enabled',
      cases: 'customer_success_enabled',
      quotes: 'quotes_enabled',
      service_contracts: 'customer_success_enabled',
    });
    // meetings + the four core tables are deliberately ungated.
    expect(pluginSdk.TABLE_FEATURE_FLAGS.meetings).toBeUndefined();
    expect(pluginSdk.TABLE_FEATURE_FLAGS.deals).toBeUndefined();
  });

  test('flag OFF: list returns [] + one run-log warning, charges no budget', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    const { ctx, counters, logBuffer } = buildCtx();
    const rows = await ctx.listLeads({ status: 'new' });
    expect(rows).toEqual([]);
    expect(counters.db_queries).toBe(0);
    expect(mockPool.connect).not.toHaveBeenCalled();
    expect(logBuffer.length).toBe(1);
    expect(logBuffer[0]).toContain('leads');
    expect(logBuffer[0]).toContain('leads_enabled');
    expect(featureFlags.hasFeature).toHaveBeenCalledWith(7, 'leads_enabled');
  });

  test('flag OFF: get returns null', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    const { ctx, counters } = buildCtx();
    expect(await ctx.getCase(9)).toBeNull();
    expect(counters.db_queries).toBe(0);
    expect(featureFlags.hasFeature).toHaveBeenCalledWith(7, 'customer_success_enabled');
  });

  test('flag OFF: update returns null and records NO proposal (dryRun)', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    const { ctx, counters, proposedActions } = buildCtx({ dryRun: true });
    const out = await ctx.updateLead(5, { status: 'working' });
    expect(out).toBeNull();
    expect(proposedActions).toEqual([]);
    expect(counters.db_queries).toBe(0);
  });

  test('meetings are core — no flag check at all', async () => {
    featureFlags.hasFeature.mockResolvedValue(false); // would break meetings if consulted
    const { ctx } = buildCtx();
    await ctx.listMeetings({});
    expect(featureFlags.hasFeature).not.toHaveBeenCalled();
    expect(lastDataQuery().sql).toContain('FROM meetings');
  });

  test('quotes gate on quotes_enabled; service contracts on customer_success_enabled', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    const { ctx } = buildCtx();
    expect(await ctx.listQuotes({})).toEqual([]);
    expect(await ctx.listServiceContracts({})).toEqual([]);
    expect(featureFlags.hasFeature).toHaveBeenCalledWith(7, 'quotes_enabled');
    expect(featureFlags.hasFeature).toHaveBeenCalledWith(7, 'customer_success_enabled');
  });
});

// ===========================================================================
// 4. Writes — proposal machinery
// ===========================================================================
describe('updateLead / updateCase — confirm-first machinery', () => {
  test('dryRun updateLead records a sanitized proposal and returns the simulated row', async () => {
    const before = { id: 5, name: 'Ada', status: 'new', owner_user_id: null };
    mockPool.connect.mockImplementation(() => Promise.resolve(makeStubClient({ rows: [before], rowCount: 1 })));
    const { ctx, counters, proposedActions } = buildCtx({ dryRun: true });

    const out = await ctx.updateLead(5, { status: 'working', owner_user_id: 3, score: 99, org_id: 1 });
    expect(counters.db_queries).toBe(1); // the before-read still charges
    expect(proposedActions).toHaveLength(1);
    const p = proposedActions[0];
    expect(p.entity).toBe('lead');
    expect(p.table).toBe('leads');
    expect(p.op).toBe('update');
    expect(p.target_id).toBe(5);
    // score + org_id are NOT in UPDATE_ALLOWLISTS.leads — silently dropped.
    expect(p.fields).toEqual({ status: 'working', owner_user_id: 3 });
    expect(p.before).toEqual(before);
    expect(p.summary).toContain('lead #5');
    expect(out).toEqual({ ...before, status: 'working', owner_user_id: 3 });
  });

  test('dryRun updateCase captures status/priority/sla_due_at only', async () => {
    const before = { id: 8, subject: 'It broke', status: 'open', priority: 'normal' };
    mockPool.connect.mockImplementation(() => Promise.resolve(makeStubClient({ rows: [before], rowCount: 1 })));
    const { ctx, proposedActions } = buildCtx({ dryRun: true });

    await ctx.updateCase(8, { status: 'pending', sla_due_at: '2026-10-01T00:00:00Z', resolved_at: 'now' });
    expect(proposedActions[0].fields).toEqual({ status: 'pending', sla_due_at: '2026-10-01T00:00:00Z' });
    expect(proposedActions[0].entity).toBe('case');
  });

  test('committed updateLead issues an org-scoped UPDATE on allowlisted columns', async () => {
    const { ctx } = buildCtx();
    await ctx.updateLead(5, { status: 'qualified', notes: 'hot' });
    const q = lastDataQuery();
    expect(q.sql).toContain('UPDATE leads SET');
    expect(q.sql).toMatch(/WHERE id = \$\d+ AND org_id = \$\d+/);
    expect(q.params).toEqual(['qualified', 'hot', 5, 7]);
  });

  test('a patch with no allowlisted field throws (same contract as updateDeal)', async () => {
    const { ctx } = buildCtx();
    await expect(ctx.updateCase(8, { subject: 'renamed' })).rejects.toThrow(/No allowed fields/);
  });

  test('pluginActions re-validates lead/case update proposals (and rejects creates)', () => {
    const lead = pluginActions.validateProposal({
      entity: 'lead', op: 'update', table: 'leads', target_id: 5,
      fields: { status: 'working', score: 99 },
    });
    expect(lead.ok).toBe(true);
    expect(lead.action.fields).toEqual({ status: 'working' }); // tampered field stripped

    const kase = pluginActions.validateProposal({
      entity: 'case', op: 'update', target_id: 8, fields: { priority: 'high' },
    });
    expect(kase.ok).toBe(true);
    expect(kase.action.table).toBe('cases');

    // create stays tasks-only; read-only entities can never apply.
    expect(pluginActions.validateProposal({ entity: 'lead', op: 'create', fields: { name: 'x' } }).ok).toBe(false);
    expect(pluginActions.validateProposal({ entity: 'quote', op: 'update', target_id: 1, fields: { status: 'sent' } }).ok).toBe(false);
    expect(pluginActions.validateProposal({ entity: 'meeting', op: 'update', target_id: 1, fields: { title: 'x' } }).ok).toBe(false);
  });
});

// ===========================================================================
// 5. Authoring surface parity (validator ↔ runner bridge ↔ buildContext)
// ===========================================================================
describe('authoring surface parity', () => {
  const NEW_METHODS = [
    'getLead', 'listLeads', 'getCase', 'listCases', 'getQuote', 'listQuotes',
    'getMeeting', 'listMeetings', 'listServiceContracts',
    'updateLead', 'updateCase',
  ];

  test('every new method is in SDK_METHOD_ALLOWLIST, the runner bridge, and buildContext', () => {
    const { ctx } = buildCtx();
    for (const m of NEW_METHODS) {
      expect(SDK_METHOD_ALLOWLIST, `validator missing ${m}`).toContain(m);
      expect(pluginRunner._internal.SDK_METHODS, `runner bridge missing ${m}`).toContain(m);
      expect(typeof ctx[m], `buildContext missing ${m}`).toBe('function');
    }
    // no createNote / create* beyond createTask — deliberate (see report).
    expect(SDK_METHOD_ALLOWLIST).not.toContain('createNote');
    expect(ctx.createNote).toBeUndefined();
  });

  test('every runner-bridged method resolves to a buildContext function', () => {
    const { ctx } = buildCtx();
    for (const m of pluginRunner._internal.SDK_METHODS) {
      expect(typeof ctx[m], `bridge names ${m} but buildContext lacks it`).toBe('function');
    }
  });

  test('validateSpec accepts source using the new methods and rejects invented ones', () => {
    const good = validateSpec({
      name: 'renewal-watch',
      trigger_event: 'schedule.daily',
      spec_json: { summary: 'watch renewals', actions: [{ kind: 'create_task' }] },
      source_code: `
        const atRisk = await crm.listServiceContracts({ renewal_stage: 'at_risk' });
        const leads = await crm.listLeads({ status: 'new' });
        const cases = await crm.listCases({ priority: 'urgent' });
        const q = await crm.getQuote(1);
        const mtgs = await crm.listMeetings({ after: '2026-09-01' });
        if (leads[0]) await crm.updateLead(leads[0].id, { status: 'working' });
        if (cases[0]) await crm.updateCase(cases[0].id, { status: 'pending' });
        crm.log({ atRisk: atRisk.length });
      `,
    });
    expect(good.ok).toBe(true);

    const bad = validateSpec({
      name: 'nope',
      trigger_event: 'manual',
      spec_json: {},
      source_code: 'await crm.createLead({ name: "x" });',
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.some((e) => /crm\.createLead/.test(e.message))).toBe(true);
  });
});
