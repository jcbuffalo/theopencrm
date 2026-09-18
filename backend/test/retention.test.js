// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Retention & expansion analytics — engine unit tests.
//
// The math core (buildRetention) is pure, so we assert MRR/ARR summing,
// renewal-rate windowing, the NRR/GRR formula on a hand-computed cohort
// fixture, the expansion heuristic, and churn directly. getRetention takes a
// pg-like pool so we can assert the two fetches are ORG-SCOPED with a bound
// param and never reach a real DB.

// describe / test / expect / vi are vitest globals.

const realPool = require('../db');
realPool.query = vi.fn();
realPool.connect = vi.fn();

const ret = require('../services/retention');

// Mock pg pool: routes each query to contract vs. deal rows by inspecting the
// SQL, and records every call so we can assert scoping.
function mockPool({ contracts = [], deals = [] } = {}) {
  return {
    calls: [],
    query: vi.fn(function (sql, params) {
      this.calls.push([sql, params]);
      const rows = /service_contracts/.test(sql) ? contracts : deals;
      return Promise.resolve({ rows });
    }),
  };
}

const NOW = new Date('2026-07-15T00:00:00Z');

describe('monthlyValue / annualValue', () => {
  test('prefers monthly_amount; falls back to annual_value / 12; else 0', () => {
    expect(ret.monthlyValue({ monthly_amount: 1000 })).toBe(1000);
    expect(ret.monthlyValue({ monthly_amount: null, annual_value: 1200 })).toBe(100);
    expect(ret.monthlyValue({ monthly_amount: null, annual_value: null })).toBe(0);
    expect(ret.annualValue({ monthly_amount: 500 })).toBe(6000);
    expect(ret.annualValue({ annual_value: 9000 })).toBe(9000);
  });

  test('monthly_amount = 0 is respected (not treated as missing)', () => {
    expect(ret.monthlyValue({ monthly_amount: 0, annual_value: 1200 })).toBe(0);
  });
});

describe('buildRetention — recurring revenue (MRR/ARR)', () => {
  test('MRR = Σ monthlyValue over currently-active contracts; ARR = MRR × 12', () => {
    const contracts = [
      { status: 'active', monthly_amount: 1000, end_date: null },                 // +1000
      { status: 'active', monthly_amount: 500, end_date: '2026-12-31' },           // +500 (ends in future)
      { status: 'active', monthly_amount: 999, end_date: '2026-06-01' },           // ended → excluded
      { status: 'churned', monthly_amount: 700, end_date: null },                  // not active → excluded
      { status: 'active', monthly_amount: null, annual_value: 1200, end_date: null }, // +100 (annual/12)
    ];
    const r = ret.buildRetention(contracts, [], { now: NOW });
    expect(r.recurring.mrr).toBe(1600);       // 1000 + 500 + 100
    expect(r.recurring.arr).toBe(19200);      // 1600 * 12
    expect(r.recurring.active_contract_count).toBe(3);
  });
});

describe('buildRetention — renewal rate windowing + churn', () => {
  test('classifies in-window end_dates as renewed / churned / unresolved', () => {
    const contracts = [
      { end_date: '2026-06-01', renewal_stage: 'renewed', monthly_amount: 100 },   // renewed
      { end_date: '2026-05-01', renewed_contract_id: 99, monthly_amount: 100 },    // renewed (successor)
      { end_date: '2026-04-01', status: 'churned', monthly_amount: 300 },          // churned → lost 300
      { end_date: '2026-02-01', renewal_stage: 'churned', monthly_amount: 200 },   // churned → lost 200
      { end_date: '2026-06-15', status: 'active', renewal_stage: 'upcoming' },      // unresolved
      { end_date: '2024-01-01', status: 'churned', monthly_amount: 500 },          // out of window → ignored
      { end_date: '2026-09-01', status: 'active' },                                 // future → ignored
    ];
    const r = ret.buildRetention(contracts, [], { now: NOW, renewalWindowDays: 365 });
    expect(r.renewals.rate.renewed).toBe(2);
    expect(r.renewals.rate.churned).toBe(2);
    expect(r.renewals.rate.unresolved).toBe(1);
    expect(r.renewals.rate.rate).toBe(0.5);   // 2 / (2 + 2)
    expect(r.churn.contract_count).toBe(2);
    expect(r.churn.lost_mrr).toBe(500);        // 300 + 200
    expect(r.churn.lost_arr).toBe(6000);
  });

  test('renewal rate is null when nothing resolved in-window', () => {
    const r = ret.buildRetention([{ end_date: '2026-09-01', status: 'active' }], [], { now: NOW });
    expect(r.renewals.rate.rate).toBeNull();
  });
});

describe('buildRetention — upcoming renewals (30/60/90d)', () => {
  test('buckets active contracts by end_date proximity, annualized value', () => {
    const contracts = [
      { status: 'active', end_date: '2026-08-01', monthly_amount: 100 }, // +17d → 30/60/90
      { status: 'active', end_date: '2026-09-01', monthly_amount: 200 }, // +48d → 60/90
      { status: 'active', end_date: '2026-10-10', monthly_amount: 300 }, // +87d → 90 only
      { status: 'active', end_date: '2026-11-30', monthly_amount: 400 }, // beyond 90
      { status: 'churned', end_date: '2026-08-01', monthly_amount: 999 }, // not active → excluded
    ];
    const r = ret.buildRetention(contracts, [], { now: NOW });
    expect(r.renewals.upcoming.d30.count).toBe(1);
    expect(r.renewals.upcoming.d30.value).toBe(1200);          // 100 * 12
    expect(r.renewals.upcoming.d60.count).toBe(2);
    expect(r.renewals.upcoming.d60.value).toBe(3600);          // (100 + 200) * 12
    expect(r.renewals.upcoming.d90.count).toBe(3);
    expect(r.renewals.upcoming.d90.value).toBe(7200);          // (100 + 200 + 300) * 12
  });
});

describe('buildRetention — NRR / GRR on a hand-computed cohort', () => {
  // Window start = NOW − 365d = 2025-07-15.
  //   Cust A: expands  → start 1000, current 1500
  //   Cust B: churns   → start  800, current    0
  //   Cust C: contracts→ start 1600, current  600
  // starting_mrr = 3400; cohort_current = 2100.
  const contracts = [
    // A — active across the whole window, plus an add-on that started mid-window.
    { customer_id: 'A', start_date: '2025-01-01', end_date: '2026-12-31', monthly_amount: 1000 },
    { customer_id: 'A', start_date: '2026-01-01', end_date: '2026-12-31', monthly_amount: 500 },
    // B — active at window start, fully ended before now.
    { customer_id: 'B', start_date: '2025-01-01', end_date: '2026-03-01', monthly_amount: 800 },
    // C — one contract ended (contraction), one smaller continues.
    { customer_id: 'C', start_date: '2025-01-01', end_date: '2026-06-01', monthly_amount: 1000 },
    { customer_id: 'C', start_date: '2025-01-01', end_date: '2026-12-31', monthly_amount: 600 },
  ];

  test('NRR = Σcurrent / Σstart; GRR = Σmin(current,start) / Σstart', () => {
    const r = ret.buildRetention(contracts, [], { now: NOW, nrrWindowDays: 365 });
    expect(r.retention.starting_mrr).toBe(3400);
    expect(r.retention.current_cohort_mrr).toBe(2100);
    expect(r.retention.cohort_customer_count).toBe(3);
    expect(r.retention.expansion_mrr).toBe(500);   // A: 1500 − 1000
    expect(r.retention.contraction_mrr).toBe(1000); // C: 1600 − 600
    expect(r.retention.churned_mrr).toBe(800);      // B → 0
    expect(r.retention.nrr).toBe(0.62);             // 2100 / 3400 = 0.6176
    expect(r.retention.grr).toBe(0.47);             // (1000+0+600)/3400 = 0.4706
  });

  test('NRR/GRR null when there is no starting cohort MRR', () => {
    const r = ret.buildRetention([], [], { now: NOW });
    expect(r.retention.nrr).toBeNull();
    expect(r.retention.grr).toBeNull();
  });

  test('contracts with no customer_id are excluded from the cohort', () => {
    const r = ret.buildRetention(
      [{ customer_id: null, start_date: '2025-01-01', end_date: '2026-12-31', monthly_amount: 5000 }],
      [], { now: NOW }
    );
    expect(r.retention.starting_mrr).toBe(0);
    expect(r.retention.nrr).toBeNull();
  });
});

describe('buildRetention — expansion heuristic (won deals to existing customers)', () => {
  test('counts won deals to customers with a prior contract or prior won deal', () => {
    const contracts = [
      { customer_id: 10, start_date: '2025-01-01' }, // customer 10 already had a contract
    ];
    const deals = [
      // Cust 10: prior contract (2025-01-01) → expansion; in window.
      { customer_id: 10, stage: 'closed_won', amount: 5000, closed_date: '2026-03-01' },
      // Cust 10: also expansion-flagged but OUT of window → not counted.
      { customer_id: 10, stage: 'closed_won', amount: 100, closed_date: '2025-02-01' },
      // Cust 20: first won deal (no prior signal) → NOT expansion; in window.
      { customer_id: 20, stage: 'closed_won', amount: 1000, closed_date: '2025-09-01' },
      // Cust 20: second won deal → prior won deal exists → expansion; in window.
      { customer_id: 20, stage: 'closed_won', amount: 2000, closed_date: '2026-01-01' },
      // Cust 30: first + only won deal, no prior → NOT expansion.
      { customer_id: 30, stage: 'closed_won', amount: 999, closed_date: '2026-06-01' },
      // Open deal → never counts.
      { customer_id: 10, stage: 'proposal', amount: 9999, closed_date: '2026-06-01' },
    ];
    const r = ret.buildRetention(contracts, deals, { profile: 'generic', now: NOW, expansionWindowDays: 365 });
    expect(r.expansion.deal_count).toBe(2);       // cust10(5000) + cust20 2nd(2000)
    expect(r.expansion.amount).toBe(7000);
    expect(r.expansion.customer_count).toBe(2);   // {10, 20}
  });

  test('respects per-profile won classification (jcp uppercase)', () => {
    const contracts = [{ customer_id: 1, start_date: '2025-01-01' }];
    const deals = [{ customer_id: 1, stage: 'CLOSED_WON', amount: 4000, closed_date: '2026-02-01' }];
    const r = ret.buildRetention(contracts, deals, { profile: 'jcp', now: NOW });
    expect(r.expansion.deal_count).toBe(1);
    expect(r.expansion.amount).toBe(4000);
  });
});

describe('getRetention (with mock pool)', () => {
  test('runs TWO ORG-SCOPED, bound-param queries and returns the summary', async () => {
    const pool = mockPool({
      contracts: [{ status: 'active', monthly_amount: 1000, end_date: null }],
      deals: [],
    });
    const out = await ret.getRetention({ sf: 'org_id', sv: 7, profile: 'generic', now: NOW }, pool);

    const sqls = pool.calls.map((c) => c[0]);
    expect(sqls.some((s) => /FROM service_contracts/.test(s))).toBe(true);
    expect(sqls.some((s) => /FROM deals/.test(s))).toBe(true);
    for (const [sql, params] of pool.calls) {
      expect(sql).toMatch(/WHERE org_id = \$1/);
      expect(params).toEqual([7]);
    }
    expect(out.recurring.mrr).toBe(1000);
  });

  test('falls back to user_id scoping', async () => {
    const pool = mockPool();
    await ret.getRetention({ sf: 'user_id', sv: 4242, now: NOW }, pool);
    for (const [sql, params] of pool.calls) {
      expect(sql).toMatch(/WHERE user_id = \$1/);
      expect(params).toEqual([4242]);
    }
  });

  test('DEFENSE IN DEPTH: throws on a non-allowlisted scope field before querying', async () => {
    const pool = mockPool();
    await expect(
      ret.getRetention({ sf: 'evil; DROP TABLE service_contracts', sv: 1, now: NOW }, pool)
    ).rejects.toThrow();
    expect(pool.query).not.toHaveBeenCalled();
  });
});
