// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Lifecycle Funnel analytics — engine unit tests.
//
// The math cores (buildDistribution / buildAtRisk / buildMovement) are pure,
// so we assert zero-fill + canonical ordering + percentage math directly. The
// org-scoped entry points take a pg-like pool so we can assert every query is
// ORG-SCOPED with a bound param (and never reaches a real DB), that an
// unlisted scope field throws before any SQL is built, and that the at-risk
// exposure degrades to zeros when optional tables/columns are absent.

// describe / test / expect / vi are vitest globals.

const realPool = require('../db');
realPool.query = vi.fn();
realPool.connect = vi.fn();

const lf = require('../services/lifecycleFunnel');

const NOW = new Date('2026-07-15T00:00:00Z');
const CANON = ['prospect', 'onboarding', 'active', 'at_risk', 'renewed', 'churned'];

// Mock pg pool: routes each query by inspecting the SQL, and records every
// call so we can assert scoping.
function mockPool({ distribution = [], atRiskCount = 0, atRiskDeals = [], atRiskContracts = [], movement = [] } = {}) {
  return {
    calls: [],
    query: vi.fn(function (sql, params) {
      this.calls.push([sql, params]);
      if (/service_contracts/.test(sql)) return Promise.resolve({ rows: atRiskContracts });
      if (/FROM deals/.test(sql)) return Promise.resolve({ rows: atRiskDeals });
      if (/lifecycle_stage = 'at_risk'/.test(sql)) return Promise.resolve({ rows: [{ count: atRiskCount }] });
      if (/updated_at/.test(sql)) return Promise.resolve({ rows: movement });
      return Promise.resolve({ rows: distribution });
    }),
  };
}

describe('buildDistribution — zero-fill + canonical order + percentages', () => {
  test('returns all six stages in canonical order even with no rows', () => {
    const d = lf.buildDistribution([]);
    expect(d.stages.map((s) => s.stage)).toEqual(CANON);
    expect(d.stages.every((s) => s.count === 0 && s.pct === 0)).toBe(true);
    expect(d.total).toBe(0);
    expect(d.unclassified).toBe(0);
  });

  test('counts + % of base; pg-string counts are coerced', () => {
    const d = lf.buildDistribution([
      { stage: 'active', count: '6' },
      { stage: 'at_risk', count: 2 },
      { stage: 'prospect', count: 2 },
    ]);
    expect(d.total).toBe(10);
    const by = Object.fromEntries(d.stages.map((s) => [s.stage, s]));
    expect(by.active).toMatchObject({ count: 6, pct: 60 });
    expect(by.at_risk).toMatchObject({ count: 2, pct: 20 });
    expect(by.prospect).toMatchObject({ count: 2, pct: 20 });
    expect(by.onboarding).toMatchObject({ count: 0, pct: 0 });
    expect(by.renewed).toMatchObject({ count: 0, pct: 0 });
    expect(by.churned).toMatchObject({ count: 0, pct: 0 });
  });

  test('NULL / off-canon stage values land in unclassified, never a real stage', () => {
    const d = lf.buildDistribution([
      { stage: null, count: 3 },
      { stage: 'zombie', count: 1 },
      { stage: 'active', count: 4 },
    ]);
    expect(d.unclassified).toBe(4);
    expect(d.total).toBe(8);
    const active = d.stages.find((s) => s.stage === 'active');
    expect(active.count).toBe(4);
    expect(active.pct).toBe(50); // % of the WHOLE base incl. unclassified
  });
});

describe('buildAtRisk — open pipeline + MRR mirroring retention semantics', () => {
  test('sums only OPEN deals (profile-aware) and only currently-active contracts', () => {
    const deals = [
      { stage: 'proposal', amount: 5000 },      // open → counted
      { stage: 'lead', amount: '1500' },        // open → counted (string coerced)
      { stage: 'closed_won', amount: 9999 },    // won → excluded
      { stage: 'closed_lost', amount: 400 },    // lost → excluded
    ];
    const contracts = [
      { status: 'active', monthly_amount: 1000, end_date: null },                  // +1000
      { status: 'active', monthly_amount: null, annual_value: 1200, end_date: null }, // +100 (annual/12)
      { status: 'active', monthly_amount: 800, end_date: '2026-01-01' },            // already ended → excluded
      { status: 'churned', monthly_amount: 700, end_date: null },                   // not active → excluded
    ];
    const a = lf.buildAtRisk(3, deals, contracts, { profile: 'generic', now: NOW });
    expect(a.company_count).toBe(3);
    expect(a.open_deal_count).toBe(2);
    expect(a.open_deal_value).toBe(6500);
    expect(a.active_contract_count).toBe(2);
    expect(a.mrr_at_risk).toBe(1100);
    expect(a.arr_at_risk).toBe(13200);
  });

  test('zang profile classifies its own terminal stages as not-open', () => {
    const a = lf.buildAtRisk(1, [
      { stage: 'INVOICED', amount: 100 },   // zang won → excluded
      { stage: 'LOST', amount: 100 },       // zang lost → excluded
      { stage: 'RFQ', amount: 250 },        // open → counted
    ], [], { profile: 'zang', now: NOW });
    expect(a.open_deal_count).toBe(1);
    expect(a.open_deal_value).toBe(250);
  });
});

describe('buildMovement — honest recent-activity labeling', () => {
  test('labels itself recent_activity and zero-fills all stages', () => {
    const m = lf.buildMovement([{ stage: 'onboarding', count: 2 }], { windowDays: 30 });
    expect(m.method).toBe('recent_activity');
    expect(m.window_days).toBe(30);
    expect(m.note).toMatch(/not true stage-to-stage transitions/i);
    expect(m.stages.map((s) => s.stage)).toEqual(CANON);
    expect(m.stages.find((s) => s.stage === 'onboarding').count).toBe(2);
    expect(m.stages.find((s) => s.stage === 'churned').count).toBe(0);
  });
});

describe('org scoping — every query binds the scope value and uses the allowlisted field', () => {
  test('getLifecycleFunnel scopes every SQL statement to org_id = $1', async () => {
    const pool = mockPool({
      distribution: [{ stage: 'active', count: 2 }],
      atRiskCount: 1,
      atRiskDeals: [{ stage: 'proposal', amount: 100 }],
      atRiskContracts: [{ status: 'active', monthly_amount: 50, end_date: null }],
      movement: [{ stage: 'active', count: 1 }],
    });
    const out = await lf.getLifecycleFunnel({ sf: 'org_id', sv: 42, profile: 'generic', now: NOW }, pool);

    expect(pool.calls.length).toBeGreaterThanOrEqual(4);
    for (const [sql, params] of pool.calls) {
      expect(sql).toMatch(/org_id = \$1/);
      expect(sql).not.toMatch(/user_id/);
      expect(params[0]).toBe(42);
      expect(sql).not.toContain('42'); // scope value bound, never inlined
    }
    expect(out.distribution.total).toBe(2);
    expect(out.atRisk.company_count).toBe(1);
    expect(out.atRisk.open_deal_value).toBe(100);
    expect(out.atRisk.mrr_at_risk).toBe(50);
    expect(out.movement.method).toBe('recent_activity');
  });

  test('falls back to user_id scoping for org-less users', async () => {
    const pool = mockPool({});
    await lf.lifecycleDistribution({ sf: 'user_id', sv: 7 }, pool);
    const [sql, params] = pool.calls[0];
    expect(sql).toMatch(/user_id = \$1/);
    expect(params).toEqual([7]);
  });

  test('an unlisted scope field throws BEFORE any SQL is built', async () => {
    const pool = mockPool({});
    await expect(lf.lifecycleDistribution({ sf: 'id; DROP TABLE companies;--', sv: 1 }, pool))
      .rejects.toThrow(/Illegal scope field/);
    await expect(lf.atRiskExposure({ sf: 'email', sv: 1 }, pool)).rejects.toThrow(/Illegal scope field/);
    await expect(lf.stageMovement({ sf: 'evil', sv: 1 }, pool)).rejects.toThrow(/Illegal scope field/);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('defensive degradation — optional tables/columns absent', () => {
  test('at-risk exposure returns zeros (not a throw) when deals.customer_id / service_contracts are missing', async () => {
    const missing = (code) => Object.assign(new Error('missing'), { code });
    const pool = {
      calls: [],
      query: vi.fn(function (sql, params) {
        this.calls.push([sql, params]);
        if (/service_contracts/.test(sql)) return Promise.reject(missing('42P01')); // undefined_table
        if (/FROM deals/.test(sql)) return Promise.reject(missing('42703'));        // undefined_column
        return Promise.resolve({ rows: [{ count: 2 }] });
      }),
    };
    const a = await lf.atRiskExposure({ sf: 'org_id', sv: 9, now: NOW }, pool);
    expect(a.company_count).toBe(2);
    expect(a.open_deal_count).toBe(0);
    expect(a.open_deal_value).toBe(0);
    expect(a.mrr_at_risk).toBe(0);
    expect(a.arr_at_risk).toBe(0);
  });

  test('unexpected DB errors still propagate (no silent swallowing)', async () => {
    const pool = {
      query: vi.fn((sql) => {
        if (/FROM deals/.test(sql)) return Promise.reject(Object.assign(new Error('boom'), { code: '57014' }));
        return Promise.resolve({ rows: [{ count: 0 }] });
      }),
    };
    await expect(lf.atRiskExposure({ sf: 'org_id', sv: 9, now: NOW }, pool)).rejects.toThrow('boom');
  });
});
