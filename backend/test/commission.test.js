// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Commission & goals — engine unit tests.
//
// The math core (buildCommissionReport / applicablePlan / dealRep) is pure, so
// we assert the rate resolution, period filtering, and closed-won-only
// classification directly. getCommissionReport takes a pg-like pool so we can
// assert every fetch is ORG-SCOPED with a bound param and never reaches a
// real DB. Mirrors test/forecast.test.js.

// describe / test / expect / vi are vitest globals.

const realPool = require('../db');
realPool.query = vi.fn();
realPool.connect = vi.fn();

const cm = require('../services/commission');

// A mock pg pool whose query() records calls and returns fixed rows keyed by
// the table the SQL touches.
function mockPool({ deals = [], plans = [], users = [], companies = [] } = {}) {
  return {
    calls: [],
    query: vi.fn(function (sql, params) {
      this.calls.push([sql, params]);
      if (/FROM deals/.test(sql)) return Promise.resolve({ rows: deals });
      if (/FROM commission_plans/.test(sql)) return Promise.resolve({ rows: plans });
      if (/FROM users/.test(sql)) return Promise.resolve({ rows: users });
      if (/FROM companies/.test(sql)) return Promise.resolve({ rows: companies });
      return Promise.resolve({ rows: [] });
    }),
  };
}

const WINDOW = { from: '2026-01-01', to: '2026-12-31' };

describe('dealRep — rep attribution chain', () => {
  test('prefers owner_user_id, then salesman_id, then user_id (creator)', () => {
    expect(cm.dealRep({ owner_user_id: 3, salesman_id: 5, user_id: 9 })).toBe(3);
    expect(cm.dealRep({ owner_user_id: null, salesman_id: 5, user_id: 9 })).toBe(5);
    expect(cm.dealRep({ owner_user_id: null, salesman_id: null, user_id: 9 })).toBe(9);
    expect(cm.dealRep({})).toBeNull();
  });
});

describe('applicablePlan — effective-date rate resolution', () => {
  const plans = [
    { id: 1, owner_id: null, rate_pct: '2.00', effective_from: '2026-01-01' }, // org default
    { id: 2, owner_id: 7, rate_pct: '5.00', effective_from: '2026-01-01' },    // rep 7
    { id: 3, owner_id: 7, rate_pct: '8.00', effective_from: '2026-06-01' },    // rep 7, raise
  ];

  test('rep-specific plan beats the org default', () => {
    const p = cm.applicablePlan(plans, 7, new Date('2026-03-15T00:00:00Z'));
    expect(p.id).toBe(2);
  });

  test('latest effective_from <= close date wins (historical closes keep historical rates)', () => {
    expect(cm.applicablePlan(plans, 7, new Date('2026-05-31T00:00:00Z')).id).toBe(2);
    expect(cm.applicablePlan(plans, 7, new Date('2026-06-01T00:00:00Z')).id).toBe(3);
  });

  test('reps with no plan fall back to the org default', () => {
    const p = cm.applicablePlan(plans, 42, new Date('2026-03-15T00:00:00Z'));
    expect(p.id).toBe(1);
  });

  test('no plan effective yet → null (rate 0)', () => {
    expect(cm.applicablePlan(plans, 7, new Date('2025-12-31T00:00:00Z'))).toBeNull();
    expect(cm.applicablePlan([], 7, new Date('2026-03-15T00:00:00Z'))).toBeNull();
  });
});

describe('buildCommissionReport — commission math', () => {
  test('rep plan rate applied: Σ(closed-won value) × rate', () => {
    const deals = [
      { owner_user_id: 7, stage: 'closed_won', amount: 10000, closed_date: '2026-03-01' },
      { owner_user_id: 7, stage: 'closed_won', amount: 5000, closed_date: '2026-04-01' },
    ];
    const plans = [{ id: 2, owner_id: 7, rate_pct: '5.00', effective_from: '2026-01-01' }];
    const r = cm.buildCommissionReport(deals, plans, [{ id: 7, name: 'Ray', email: 'ray@x.com' }], WINDOW);
    expect(r.reps).toHaveLength(1);
    expect(r.reps[0].rep_user_id).toBe(7);
    expect(r.reps[0].name).toBe('Ray');
    expect(r.reps[0].won_count).toBe(2);
    expect(r.reps[0].won_value).toBe(15000);
    expect(r.reps[0].rate_pct).toBe(5);
    expect(r.reps[0].commission).toBe(750); // 15000 × 5%
    expect(r.totals).toEqual({ won_count: 2, won_value: 15000, commission: 750 });
  });

  test('org-default fallback for a rep with no rep-specific plan', () => {
    const deals = [{ salesman_id: 9, stage: 'closed_won', amount: 10000, closed_date: '2026-03-01' }];
    const plans = [
      { id: 1, owner_id: null, rate_pct: '2.50', effective_from: '2026-01-01' },
      { id: 2, owner_id: 7, rate_pct: '5.00', effective_from: '2026-01-01' }, // someone else's plan
    ];
    const r = cm.buildCommissionReport(deals, plans, [], WINDOW);
    const rep9 = r.reps.find(x => x.rep_user_id === 9);
    expect(rep9.commission).toBe(250); // 10000 × 2.5%
  });

  test('zero rate when no plan exists at all', () => {
    const deals = [{ salesman_id: 9, stage: 'closed_won', amount: 10000, closed_date: '2026-03-01' }];
    const r = cm.buildCommissionReport(deals, [], [], WINDOW);
    expect(r.reps[0].won_value).toBe(10000);
    expect(r.reps[0].rate_pct).toBe(0);
    expect(r.reps[0].commission).toBe(0);
    expect(r.totals.commission).toBe(0);
  });

  test('mid-period rate change: each deal pays at the rate effective on ITS close date', () => {
    const deals = [
      { owner_user_id: 7, stage: 'closed_won', amount: 10000, closed_date: '2026-03-01' }, // 5% era → 500
      { owner_user_id: 7, stage: 'closed_won', amount: 10000, closed_date: '2026-07-01' }, // 8% era → 800
    ];
    const plans = [
      { id: 2, owner_id: 7, rate_pct: '5.00', effective_from: '2026-01-01' },
      { id: 3, owner_id: 7, rate_pct: '8.00', effective_from: '2026-06-01' },
    ];
    const r = cm.buildCommissionReport(deals, plans, [], WINDOW);
    expect(r.reps[0].commission).toBe(1300);
    expect(r.reps[0].rate_pct).toBe(8); // display rate = plan effective at period end
  });

  test('period filtering: deals closing outside [from, to] are excluded (bounds inclusive)', () => {
    const deals = [
      { owner_user_id: 7, stage: 'closed_won', amount: 1000, closed_date: '2026-02-01' }, // in
      { owner_user_id: 7, stage: 'closed_won', amount: 2000, closed_date: '2026-02-28' }, // in (inclusive to)
      { owner_user_id: 7, stage: 'closed_won', amount: 4000, closed_date: '2026-01-31' }, // out (before from)
      { owner_user_id: 7, stage: 'closed_won', amount: 8000, closed_date: '2026-03-01' }, // out (after to)
    ];
    const plans = [{ id: 1, owner_id: null, rate_pct: '10.00', effective_from: '2026-01-01' }];
    const r = cm.buildCommissionReport(deals, plans, [], { from: '2026-02-01', to: '2026-02-28' });
    expect(r.reps[0].won_value).toBe(3000);
    expect(r.reps[0].commission).toBe(300);
  });

  test('only closed-won counts — open and lost deals never pay commission', () => {
    const deals = [
      { owner_user_id: 7, stage: 'closed_won', amount: 1000, closed_date: '2026-02-01' },
      { owner_user_id: 7, stage: 'proposal', amount: 9000, closed_date: '2026-02-01' },     // open
      { owner_user_id: 7, stage: 'negotiation', amount: 9000, closed_date: '2026-02-01' },  // open
      { owner_user_id: 7, stage: 'closed_lost', amount: 9000, closed_date: '2026-02-01' },  // lost
    ];
    const plans = [{ id: 1, owner_id: null, rate_pct: '10.00', effective_from: '2026-01-01' }];
    const r = cm.buildCommissionReport(deals, plans, [], WINDOW);
    expect(r.reps[0].won_count).toBe(1);
    expect(r.reps[0].won_value).toBe(1000);
    expect(r.reps[0].commission).toBe(100);
  });

  test('profile-aware won classification (zang INVOICED counts, generic would not)', () => {
    const deals = [{ salesman_id: 7, stage: 'INVOICED', amount: 10000, closed_date: '2026-02-01' }];
    const plans = [{ id: 1, owner_id: null, rate_pct: '5.00', effective_from: '2026-01-01' }];
    const zang = cm.buildCommissionReport(deals, plans, [], { ...WINDOW, profile: 'zang' });
    expect(zang.totals.commission).toBe(500);
    const generic = cm.buildCommissionReport(deals, plans, [], { ...WINDOW, profile: 'generic' });
    expect(generic.totals.commission).toBe(0);
  });

  test('won value prefers closed_amount over amount; expected_close_date is the date fallback', () => {
    const deals = [
      { owner_user_id: 7, stage: 'closed_won', amount: 100, closed_amount: 120, closed_date: '2026-02-01' },
      { owner_user_id: 7, stage: 'closed_won', amount: 300, closed_date: null, expected_close_date: '2026-02-15' },
    ];
    const plans = [{ id: 1, owner_id: null, rate_pct: '10.00', effective_from: '2026-01-01' }];
    const r = cm.buildCommissionReport(deals, plans, [], WINDOW);
    expect(r.reps[0].won_value).toBe(420);
    expect(r.reps[0].commission).toBe(42);
  });

  test('goal attainment: attainment_pct = won value / goal_amount', () => {
    const deals = [{ owner_user_id: 7, stage: 'closed_won', amount: 5000, closed_date: '2026-02-01' }];
    const plans = [{ id: 2, owner_id: 7, rate_pct: '5.00', goal_amount: '10000.00', effective_from: '2026-01-01' }];
    const r = cm.buildCommissionReport(deals, plans, [], WINDOW);
    expect(r.reps[0].goal_amount).toBe(10000);
    expect(r.reps[0].attainment_pct).toBe(50);
  });

  test('no goal → attainment is null; rep with a plan but no wins still gets a zero row', () => {
    const plans = [{ id: 2, owner_id: 7, rate_pct: '5.00', effective_from: '2026-01-01' }];
    const r = cm.buildCommissionReport([], plans, [{ id: 7, name: 'Ray', email: 'r@x.com' }], WINDOW);
    expect(r.reps).toHaveLength(1);
    expect(r.reps[0].rep_user_id).toBe(7);
    expect(r.reps[0].won_count).toBe(0);
    expect(r.reps[0].commission).toBe(0);
    expect(r.reps[0].goal_amount).toBeNull();
    expect(r.reps[0].attainment_pct).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Partner/channel plans (migration 159a)
// ---------------------------------------------------------------------------

describe('rep flow regression — partner plans never leak into the rep math', () => {
  const PARTNER_PLAN = {
    id: 50, owner_id: null, kind: 'partner', partner_company_id: 88,
    rate_pct: '3.00', effective_from: '2026-01-01', source_filter: null,
  };

  test('applicablePlan SKIPS partner plans (owner_id NULL must not read as org default)', () => {
    // With ONLY a partner plan, a rep resolves to no plan at all — not 3%.
    expect(cm.applicablePlan([PARTNER_PLAN], 7, new Date('2026-03-15T00:00:00Z'))).toBeNull();
    // With both, the true org default wins over the partner plan.
    const orgDefault = { id: 1, owner_id: null, kind: 'rep', rate_pct: '2.00', effective_from: '2026-01-01' };
    expect(cm.applicablePlan([PARTNER_PLAN, orgDefault], 7, new Date('2026-03-15T00:00:00Z')).id).toBe(1);
    // Pre-159a rows carry no kind field at all — still resolved as rep plans.
    const legacy = { id: 2, owner_id: 7, rate_pct: '5.00', effective_from: '2026-01-01' };
    expect(cm.applicablePlan([PARTNER_PLAN, legacy], 7, new Date('2026-03-15T00:00:00Z')).id).toBe(2);
  });

  test('buildCommissionReport output is identical with partner plans present', () => {
    const deals = [{ owner_user_id: 7, stage: 'closed_won', amount: 10000, closed_date: '2026-03-01' }];
    const repPlans = [{ id: 2, owner_id: 7, kind: 'rep', rate_pct: '5.00', effective_from: '2026-01-01' }];
    const without = cm.buildCommissionReport(deals, repPlans, [], WINDOW);
    const withPartner = cm.buildCommissionReport(deals, [...repPlans, PARTNER_PLAN], [], WINDOW);
    expect(withPartner).toEqual(without); // byte-for-byte
    expect(withPartner.reps).toHaveLength(1); // no phantom row for the partner plan
    expect(withPartner.totals.commission).toBe(500);
  });
});

describe('dealSource — the deal custom-field source convention', () => {
  test('channel_source → lead_source → source, trimmed + lowercased', () => {
    expect(cm.dealSource({ custom_fields: { channel_source: ' Dealer-Assoc ' } })).toBe('dealer-assoc');
    expect(cm.dealSource({ custom_fields: { lead_source: 'Referral' } })).toBe('referral');
    expect(cm.dealSource({ custom_fields: { source: 'web' } })).toBe('web');
    expect(cm.dealSource({ custom_fields: { channel_source: 'A', lead_source: 'B' } })).toBe('a'); // precedence
  });

  test('tolerates JSON-string custom_fields (raw pg text) and garbage', () => {
    expect(cm.dealSource({ custom_fields: '{"channel_source":"Assoc"}' })).toBe('assoc');
    expect(cm.dealSource({ custom_fields: 'not json' })).toBeNull();
    expect(cm.dealSource({ custom_fields: null })).toBeNull();
    expect(cm.dealSource({})).toBeNull();
    expect(cm.dealSource({ custom_fields: { channel_source: '   ' } })).toBeNull();
  });
});

describe('buildPartnerStatements — attribution + statement math', () => {
  const COMPANIES = [{ id: 88, name: 'Dealer Association' }];
  const SRC_PLAN = {
    id: 50, owner_id: null, kind: 'partner', partner_company_id: 88,
    rate_pct: '3.00', effective_from: '2026-01-01', source_filter: 'dealer-assoc',
  };

  test('source_filter attribution: fee = rate% × value over matching closed-won deals', () => {
    const deals = [
      { id: 1, title: 'Campaign A', stage: 'closed_won', amount: 10000, closed_date: '2026-03-01',
        custom_fields: { channel_source: 'Dealer-Assoc' } },                 // matches (case-insensitive)
      { id: 2, title: 'Campaign B', stage: 'closed_won', amount: 5000, closed_date: '2026-04-01',
        custom_fields: { channel_source: 'web' } },                          // wrong source
      { id: 3, title: 'Open one', stage: 'proposal', amount: 9000, closed_date: '2026-04-01',
        custom_fields: { channel_source: 'dealer-assoc' } },                 // not won
      { id: 4, title: 'Out of window', stage: 'closed_won', amount: 9000, closed_date: '2027-04-01',
        custom_fields: { channel_source: 'dealer-assoc' } },                 // outside window
    ];
    const out = cm.buildPartnerStatements(deals, [SRC_PLAN], COMPANIES, WINDOW);
    expect(out.partners).toHaveLength(1);
    const p = out.partners[0];
    expect(p.partner_company_id).toBe(88);
    expect(p.partner_name).toBe('Dealer Association');
    expect(p.source_filter).toBe('dealer-assoc');
    expect(p.deal_count).toBe(1);
    expect(p.attributed_value).toBe(10000);
    expect(p.fee).toBe(300); // 10000 × 3%
    expect(p.deals).toEqual([{ id: 1, title: 'Campaign A', close_date: '2026-03-01', value: 10000, rate_pct: 3, fee: 300 }]);
    expect(out.totals).toEqual({ deal_count: 1, attributed_value: 10000, fee: 300 });
  });

  test('no source_filter → falls back to a direct company link (company_id / customer_id)', () => {
    const plan = { ...SRC_PLAN, id: 51, source_filter: null };
    const deals = [
      { id: 1, stage: 'closed_won', amount: 4000, closed_date: '2026-03-01', company_id: 88 },
      { id: 2, stage: 'closed_won', amount: 6000, closed_date: '2026-03-02', customer_id: 88 },
      { id: 3, stage: 'closed_won', amount: 9000, closed_date: '2026-03-03', company_id: 12 },
    ];
    const out = cm.buildPartnerStatements(deals, [plan], COMPANIES, WINDOW);
    expect(out.partners[0].deal_count).toBe(2);
    expect(out.partners[0].attributed_value).toBe(10000);
    expect(out.partners[0].fee).toBe(300);
  });

  test('historical rates: each deal pays the partner rate effective at ITS close date', () => {
    const plans = [
      SRC_PLAN,                                                             // 3% from Jan 1
      { ...SRC_PLAN, id: 52, rate_pct: '5.00', effective_from: '2026-06-01' }, // raise to 5%
    ];
    const deals = [
      { id: 1, stage: 'closed_won', amount: 10000, closed_date: '2026-03-01', custom_fields: { channel_source: 'dealer-assoc' } },
      { id: 2, stage: 'closed_won', amount: 10000, closed_date: '2026-07-01', custom_fields: { channel_source: 'dealer-assoc' } },
    ];
    const out = cm.buildPartnerStatements(deals, plans, COMPANIES, WINDOW);
    expect(out.partners[0].fee).toBe(800);       // 300 + 500
    expect(out.partners[0].rate_pct).toBe(5);    // display rate = plan at period end
  });

  test('closed_amount preferred; won-only + profile-aware classification; value/date conventions match the rep report', () => {
    const deals = [
      { id: 1, stage: 'INVOICED', amount: 100, closed_amount: 120, closed_date: '2026-02-01',
        custom_fields: { channel_source: 'dealer-assoc' } },
    ];
    const zang = cm.buildPartnerStatements(deals, [SRC_PLAN], COMPANIES, { ...WINDOW, profile: 'zang' });
    expect(zang.partners[0].attributed_value).toBe(120);
    const generic = cm.buildPartnerStatements(deals, [SRC_PLAN], COMPANIES, { ...WINDOW, profile: 'generic' });
    expect(generic.partners[0].deal_count).toBe(0); // INVOICED isn't won for generic
  });

  test('a partner with a plan but no attributed deals still gets a zero statement row', () => {
    const out = cm.buildPartnerStatements([], [SRC_PLAN], COMPANIES, WINDOW);
    expect(out.partners).toHaveLength(1);
    expect(out.partners[0].deal_count).toBe(0);
    expect(out.partners[0].fee).toBe(0);
  });

  test('rep plans never produce a partner statement', () => {
    const repPlans = [
      { id: 1, owner_id: null, kind: 'rep', rate_pct: '2.00', effective_from: '2026-01-01' },
      { id: 2, owner_id: 7, rate_pct: '5.00', effective_from: '2026-01-01' }, // legacy, no kind
    ];
    const deals = [{ id: 1, owner_user_id: 7, stage: 'closed_won', amount: 10000, closed_date: '2026-03-01' }];
    const out = cm.buildPartnerStatements(deals, repPlans, [], WINDOW);
    expect(out.partners).toHaveLength(0);
    expect(out.totals.fee).toBe(0);
  });
});

describe('getCommissionReport (with mock pool) — org isolation', () => {
  test('every fetch is ORG-SCOPED with a bound param', async () => {
    const pool = mockPool({
      deals: [{ owner_user_id: 7, stage: 'closed_won', amount: 1000, closed_date: '2026-02-01' }],
      plans: [{ id: 1, owner_id: null, rate_pct: '10.00', effective_from: '2026-01-01' }],
      users: [{ id: 7, name: 'Ray', email: 'r@x.com' }],
    });
    const out = await cm.getCommissionReport({ sf: 'org_id', sv: 7, profile: 'generic', ...WINDOW }, pool);

    expect(pool.calls).toHaveLength(3);
    for (const [sql, params] of pool.calls) {
      expect(sql).toMatch(/WHERE org_id = \$1/);
      expect(params).toEqual([7]);
    }
    expect(out.totals.commission).toBe(100);
    expect(out.reps[0].name).toBe('Ray');
  });

  test('falls back to user_id scoping (users looked up by id, not a user_id column)', async () => {
    const pool = mockPool({});
    await cm.getCommissionReport({ sf: 'user_id', sv: 4242, ...WINDOW }, pool);
    const dealsCall = pool.calls.find(([sql]) => /FROM deals/.test(sql));
    const usersCall = pool.calls.find(([sql]) => /FROM users/.test(sql));
    expect(dealsCall[0]).toMatch(/WHERE user_id = \$1/);
    expect(dealsCall[1]).toEqual([4242]);
    expect(usersCall[0]).toMatch(/WHERE id = \$1/);
  });

  test('DEFENSE IN DEPTH: throws on a non-allowlisted scope field before querying', async () => {
    const pool = mockPool({});
    await expect(
      cm.getCommissionReport({ sf: 'evil; DROP TABLE deals', sv: 1, ...WINDOW }, pool)
    ).rejects.toThrow();
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('rep-only scope issues exactly the original three queries (no companies fetch)', async () => {
    const pool = mockPool({
      plans: [{ id: 1, owner_id: null, kind: 'rep', rate_pct: '10.00', effective_from: '2026-01-01' }],
    });
    const out = await cm.getCommissionReport({ sf: 'org_id', sv: 7, profile: 'generic', ...WINDOW }, pool);
    expect(pool.calls).toHaveLength(3);
    expect(pool.calls.some(([sql]) => /FROM companies/.test(sql))).toBe(false);
    expect(out.partners).toEqual([]);
    expect(out.partner_totals).toEqual({ deal_count: 0, attributed_value: 0, fee: 0 });
  });

  test('partner plans trigger an ORG-SCOPED companies lookup and land in `partners`', async () => {
    const pool = mockPool({
      deals: [{ id: 1, title: 'Campaign', stage: 'closed_won', amount: 10000, closed_date: '2026-02-01',
                custom_fields: { channel_source: 'assoc' } }],
      plans: [{ id: 50, owner_id: null, kind: 'partner', partner_company_id: 88,
                rate_pct: '3.00', effective_from: '2026-01-01', source_filter: 'assoc' }],
      companies: [{ id: 88, name: 'Dealer Association' }],
    });
    const out = await cm.getCommissionReport({ sf: 'org_id', sv: 7, profile: 'generic', ...WINDOW }, pool);

    const companiesCall = pool.calls.find(([sql]) => /FROM companies/.test(sql));
    expect(companiesCall).toBeTruthy();
    expect(companiesCall[0]).toMatch(/WHERE org_id = \$1/);
    expect(companiesCall[1]).toEqual([7, [88]]);

    expect(out.partners).toHaveLength(1);
    expect(out.partners[0].partner_name).toBe('Dealer Association');
    expect(out.partners[0].fee).toBe(300);
    expect(out.partner_totals.fee).toBe(300);
    // The partner plan changed nothing on the rep side.
    expect(out.totals.commission).toBe(0);
  });
});
