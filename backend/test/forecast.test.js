// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Sales forecasting — engine unit tests.
//
// The math core (buildForecast / classifyStage / computeQuotaAttainment) is
// pure, so we assert the weighting, period bucketing, and per-profile won/open
// classification directly. getForecast takes a pg-like pool so we can assert
// the fetch is ORG-SCOPED with a bound param and never reaches a real DB.

// describe / test / expect / vi are vitest globals.

const realPool = require('../db');
realPool.query = vi.fn();
realPool.connect = vi.fn();

const fc = require('../services/forecast');

// A mock pg pool whose query() records calls and returns fixed rows.
function mockPool(rows = []) {
  return {
    calls: [],
    query: vi.fn(function (sql, params) {
      this.calls.push([sql, params]);
      return Promise.resolve({ rows });
    }),
  };
}

const NOW = new Date('2026-07-15T00:00:00Z');

describe('classifyStage (per-profile terminal stages)', () => {
  test('generic won/lost/open', () => {
    expect(fc.classifyStage('generic', 'closed_won')).toBe('won');
    expect(fc.classifyStage('generic', 'closed_lost')).toBe('lost');
    expect(fc.classifyStage('generic', 'proposal')).toBe('open');
  });

  test('jcp uppercase terminals', () => {
    expect(fc.classifyStage('jcp', 'CLOSED_WON')).toBe('won');
    expect(fc.classifyStage('jcp', 'CLOSED_LOST')).toBe('lost');
    expect(fc.classifyStage('jcp', 'ENGAGED')).toBe('open');
  });

  test('zang: invoiced/paid/closed are won, lost/cancelled are lost, in-flight is open', () => {
    expect(fc.classifyStage('zang', 'INVOICED')).toBe('won');
    expect(fc.classifyStage('zang', 'CLOSED_PAID')).toBe('won');
    expect(fc.classifyStage('zang', 'CLOSED')).toBe('won');
    expect(fc.classifyStage('zang', 'LOST')).toBe('lost');
    expect(fc.classifyStage('zang', 'CANCELLED')).toBe('lost');
    expect(fc.classifyStage('zang', 'TRIAGE')).toBe('open');
    expect(fc.classifyStage('zang', 'MONITOR')).toBe('open');
  });

  test('unknown profile falls back to generic map', () => {
    expect(fc.classifyStage('nope', 'closed_won')).toBe('won');
  });
});

describe('effectiveProbability', () => {
  test('prefers an explicit per-deal probability (0-100 → 0-1)', () => {
    expect(fc.effectiveProbability('generic', 'lead', 40)).toBe(0.4);
    expect(fc.effectiveProbability('generic', 'lead', 100)).toBe(1);
    expect(fc.effectiveProbability('generic', 'lead', 150)).toBe(1); // clamped
  });

  test('falls back to the stage default when probability is null/0', () => {
    expect(fc.effectiveProbability('generic', 'qualified', 0)).toBe(0.25);
    expect(fc.effectiveProbability('generic', 'negotiation', null)).toBe(0.75);
    expect(fc.effectiveProbability('jcp', 'ENGAGED', undefined)).toBe(0.85);
  });

  test('falls back to the global default for an unmapped open stage', () => {
    expect(fc.effectiveProbability('generic', 'mystery', 0)).toBe(fc.DEFAULT_OPEN_PROBABILITY);
  });
});

describe('buildForecast — weighted pipeline + classification', () => {
  test('weighted pipeline = Σ(amount × probability) over OPEN deals only', () => {
    const rows = [
      { stage: 'proposal',    amount: 1000, probability: 50, expected_close_date: '2026-07-10' }, // 500
      { stage: 'negotiation', amount: 2000, probability: 75, expected_close_date: '2026-08-10' }, // 1500
      { stage: 'closed_won',  amount: 5000, closed_amount: 5000, closed_date: '2026-07-01' },      // won, excluded from weighted pipeline
      { stage: 'closed_lost', amount: 9000, probability: 90, expected_close_date: '2026-07-10' },  // lost, excluded entirely
    ];
    const f = fc.buildForecast(rows, { profile: 'generic', now: NOW });
    expect(f.weighted_pipeline).toBe(2000);   // 500 + 1500
    expect(f.open_amount).toBe(3000);          // 1000 + 2000
    expect(f.open_count).toBe(2);
    expect(f.won_amount_total).toBe(5000);
    expect(f.won_count_total).toBe(1);
  });

  test('open deals with no explicit probability use the stage default', () => {
    const rows = [
      { stage: 'qualified', amount: 1000, probability: 0, expected_close_date: '2026-07-10' }, // 0.25 → 250
    ];
    const f = fc.buildForecast(rows, { profile: 'generic', now: NOW });
    expect(f.weighted_pipeline).toBe(250);
  });

  test('lost deals never contribute; won uses closed_amount when present', () => {
    const rows = [
      { stage: 'closed_won', amount: 100, closed_amount: 120, closed_date: '2026-07-05' },
      { stage: 'closed_lost', amount: 999, expected_close_date: '2026-07-05' },
    ];
    const f = fc.buildForecast(rows, { profile: 'generic', now: NOW });
    expect(f.won_amount_total).toBe(120);      // closed_amount, not amount
    expect(f.weighted_pipeline).toBe(0);
  });
});

describe('buildForecast — projected close by period', () => {
  test('buckets committed/best_case/weighted by month, contiguously', () => {
    const rows = [
      { stage: 'closed_won', amount: 4000, closed_amount: 4000, closed_date: '2026-07-02' }, // committed Jul
      { stage: 'proposal',   amount: 2000, probability: 50, expected_close_date: '2026-07-20' }, // Jul open → w 1000
      { stage: 'negotiation',amount: 1000, probability: 80, expected_close_date: '2026-09-10' }, // Sep open → w 800
    ];
    const f = fc.buildForecast(rows, { profile: 'generic', now: NOW });
    const by = Object.fromEntries(f.by_period.map(p => [p.period, p]));

    // Contiguous Jul, Aug, Sep (Aug empty but present, no gap).
    expect(f.by_period.map(p => p.period)).toEqual(['2026-07', '2026-08', '2026-09']);

    expect(by['2026-07'].committed).toBe(4000);
    expect(by['2026-07'].best_case).toBe(6000); // 4000 committed + 2000 open full
    expect(by['2026-07'].weighted).toBe(5000);  // 4000 + 2000*0.5
    expect(by['2026-07'].open_count).toBe(1);
    expect(by['2026-07'].won_count).toBe(1);

    expect(by['2026-08'].committed).toBe(0);
    expect(by['2026-08'].best_case).toBe(0);

    expect(by['2026-09'].best_case).toBe(1000);
    expect(by['2026-09'].weighted).toBe(800);   // 1000*0.8
  });

  test('open deals with no expected_close_date land in unscheduled, not a bucket', () => {
    const rows = [
      { stage: 'proposal', amount: 1000, probability: 50, expected_close_date: null },
    ];
    const f = fc.buildForecast(rows, { profile: 'generic', now: NOW });
    expect(f.unscheduled_open_amount).toBe(1000);
    expect(f.weighted_pipeline).toBe(500);       // still in the headline number
    // Only the current month exists in the series (no dated activity).
    expect(f.by_period.map(p => p.period)).toEqual(['2026-07']);
    expect(f.by_period[0].best_case).toBe(0);
  });

  test('empty deal set yields a single current-month zero row', () => {
    const f = fc.buildForecast([], { profile: 'generic', now: NOW });
    expect(f.weighted_pipeline).toBe(0);
    expect(f.by_period).toEqual([
      { period: '2026-07', committed: 0, best_case: 0, weighted: 0, open_count: 0, won_count: 0 },
    ]);
  });

  test('zang in-flight post-sale deals are open and weighted high', () => {
    const rows = [
      { stage: 'MONITOR', amount: 10000, probability: 0, expected_close_date: '2026-08-01' }, // default 0.92
      { stage: 'INVOICED', amount: 5000, closed_amount: 5000, closed_date: '2026-07-03' },    // won
    ];
    const f = fc.buildForecast(rows, { profile: 'zang', now: NOW });
    expect(f.weighted_pipeline).toBe(9200);   // 10000 * 0.92
    expect(f.won_amount_total).toBe(5000);
  });
});

describe('quotaWindow + computeQuotaAttainment', () => {
  test('month window is [start, start+1month)', () => {
    const w = fc.quotaWindow('month', '2026-07-01');
    expect(w.start.toISOString().slice(0, 10)).toBe('2026-07-01');
    expect(w.end.toISOString().slice(0, 10)).toBe('2026-08-01');
  });

  test('quarter and year windows', () => {
    expect(fc.quotaWindow('quarter', '2026-07-01').end.toISOString().slice(0, 10)).toBe('2026-10-01');
    expect(fc.quotaWindow('year', '2026-01-01').end.toISOString().slice(0, 10)).toBe('2027-01-01');
  });

  test('attainment counts in-window won value; projection adds in-window weighted open', () => {
    const quota = { period_type: 'month', period_start: '2026-07-01', target_amount: 10000, owner_id: null };
    const rows = [
      { stage: 'closed_won', amount: 4000, closed_amount: 4000, closed_date: '2026-07-10' }, // attained 4000
      { stage: 'closed_won', amount: 1000, closed_amount: 1000, closed_date: '2026-06-30' }, // out of window
      { stage: 'proposal',   amount: 2000, probability: 50, expected_close_date: '2026-07-20' }, // +1000 weighted
      { stage: 'proposal',   amount: 8000, probability: 50, expected_close_date: '2026-09-01' }, // out of window
    ];
    const q = fc.computeQuotaAttainment(rows, { profile: 'generic', quota, now: NOW });
    expect(q.attained_amount).toBe(4000);
    expect(q.projected_amount).toBe(5000);     // 4000 + 2000*0.5
    expect(q.attainment_pct).toBe(40);
    expect(q.projected_pct).toBe(50);
  });

  test('per-owner quota only counts that owner\'s deals', () => {
    const quota = { period_type: 'month', period_start: '2026-07-01', target_amount: 1000, owner_id: 7 };
    const rows = [
      { salesman_id: 7, stage: 'closed_won', amount: 500, closed_amount: 500, closed_date: '2026-07-05' },
      { salesman_id: 9, stage: 'closed_won', amount: 900, closed_amount: 900, closed_date: '2026-07-05' },
    ];
    const q = fc.computeQuotaAttainment(rows, { profile: 'generic', quota, now: NOW });
    expect(q.attained_amount).toBe(500);
    expect(q.owner_id).toBe(7);
  });
});

describe('getForecast (with mock pool)', () => {
  test('runs an ORG-SCOPED, bound-param query and returns the forecast', async () => {
    const pool = mockPool([
      { stage: 'proposal', amount: 1000, probability: 50, expected_close_date: '2026-07-10' },
    ]);
    const out = await fc.getForecast({ sf: 'org_id', sv: 7, profile: 'generic', now: NOW }, pool);

    const [sql, params] = pool.calls[0];
    expect(sql).toMatch(/FROM deals/);
    expect(sql).toMatch(/WHERE org_id = \$1/);
    expect(params).toEqual([7]);
    expect(out.weighted_pipeline).toBe(500);
    expect(out.quota).toBeNull();
  });

  test('falls back to user_id scoping', async () => {
    const pool = mockPool([]);
    await fc.getForecast({ sf: 'user_id', sv: 4242, now: NOW }, pool);
    const [sql, params] = pool.calls[0];
    expect(sql).toMatch(/WHERE user_id = \$1/);
    expect(params).toEqual([4242]);
  });

  test('DEFENSE IN DEPTH: throws on a non-allowlisted scope field before querying', async () => {
    const pool = mockPool([]);
    await expect(
      fc.getForecast({ sf: 'evil; DROP TABLE deals', sv: 1, now: NOW }, pool)
    ).rejects.toThrow();
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('includes quota attainment when a quota row is supplied', async () => {
    const pool = mockPool([
      { stage: 'closed_won', amount: 5000, closed_amount: 5000, closed_date: '2026-07-05' },
    ]);
    const quota = { period_type: 'month', period_start: '2026-07-01', target_amount: 10000, owner_id: null };
    const out = await fc.getForecast({ sf: 'org_id', sv: 7, profile: 'generic', now: NOW, quota }, pool);
    expect(out.quota.attained_amount).toBe(5000);
    expect(out.quota.attainment_pct).toBe(50);
  });
});
