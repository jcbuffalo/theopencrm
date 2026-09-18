// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Generic light-CPQ — server-authoritative money math + org-scoping + the
// catalog-mutation admin gate.
//
// The money core (computeTotals) is pure, so we assert line totals, per-line
// discounts, quote-level discount clamping, and tax directly — and prove a
// client CANNOT inject a bogus total (computeTotals reads ONLY the inputs).
// listProducts/listQuotes take a pg-like pool so we assert the fetch is
// ORG-SCOPED with a bound param and rejects a non-allowlisted scope field
// before any SQL runs.
//
// describe / test / expect / vi are vitest globals.

const salesQuotes = require('../services/salesQuotes');
const { computeTotals, listProducts, listQuotes } = salesQuotes;

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

describe('computeTotals — line totals', () => {
  test('line_total = qty × unit × (1 − discount%/100), rounded to cents', () => {
    const out = computeTotals({
      items: [
        { name: 'Widget', quantity: 3, unit_price: 10, discount_pct: 0 },   // 30
        { name: 'Gadget', quantity: 2, unit_price: 25, discount_pct: 10 },  // 50 * 0.9 = 45
      ],
    });
    expect(out.lines[0].line_total).toBe(30);
    expect(out.lines[1].line_total).toBe(45);
    expect(out.subtotal).toBe(75);
    expect(out.total).toBe(75);
  });

  test('fractional quantity + price rounds at the line boundary', () => {
    const out = computeTotals({
      items: [{ name: 'Consulting', quantity: 1.5, unit_price: 99.99, discount_pct: 0 }],
    });
    // 1.5 * 99.99 = 149.985 → rounds to 149.99 (cents-based)
    expect(out.lines[0].line_total).toBe(149.99);
    expect(out.subtotal).toBe(149.99);
  });

  test('per-line discount_pct is clamped into [0, 100]', () => {
    const out = computeTotals({
      items: [
        { name: 'A', quantity: 1, unit_price: 100, discount_pct: 150 }, // clamp → 100% off → 0
        { name: 'B', quantity: 1, unit_price: 100, discount_pct: -50 }, // clamp → 0% off → 100
      ],
    });
    expect(out.lines[0].line_total).toBe(0);
    expect(out.lines[1].line_total).toBe(100);
    expect(out.subtotal).toBe(100);
  });
});

describe('computeTotals — quote-level discount + tax', () => {
  test('discount amount reduces the taxable base; tax = (subtotal − discount) × rate', () => {
    const out = computeTotals({
      items: [{ name: 'X', quantity: 10, unit_price: 100, discount_pct: 0 }], // 1000
      discount: 100,      // → taxable 900
      tax_rate: 8.5,      // → 76.5
    });
    expect(out.subtotal).toBe(1000);
    expect(out.discount).toBe(100);
    expect(out.tax_rate).toBe(8.5);
    expect(out.tax).toBe(76.5);
    expect(out.total).toBe(976.5); // 900 + 76.5
  });

  test('quote-level discount is clamped to the subtotal (never negative total)', () => {
    const out = computeTotals({
      items: [{ name: 'X', quantity: 1, unit_price: 50, discount_pct: 0 }], // 50
      discount: 999,   // clamped down to 50
      tax_rate: 10,
    });
    expect(out.discount).toBe(50);
    expect(out.tax).toBe(0);   // taxable base is 0
    expect(out.total).toBe(0);
  });

  test('negative tax_rate is floored to 0', () => {
    const out = computeTotals({
      items: [{ name: 'X', quantity: 1, unit_price: 100, discount_pct: 0 }],
      tax_rate: -5,
    });
    expect(out.tax).toBe(0);
    expect(out.total).toBe(100);
  });

  test('empty item set yields all-zero totals', () => {
    const out = computeTotals({ items: [], discount: 50, tax_rate: 10 });
    expect(out.subtotal).toBe(0);
    expect(out.discount).toBe(0); // clamped to subtotal 0
    expect(out.tax).toBe(0);
    expect(out.total).toBe(0);
  });
});

describe('computeTotals — the client cannot inject a bogus total', () => {
  test('client-sent subtotal/tax/total on the payload are ignored entirely', () => {
    const out = computeTotals({
      items: [{ name: 'X', quantity: 2, unit_price: 100, discount_pct: 0 }], // authoritative: 200
      discount: 0,
      tax_rate: 0,
      // Hostile client fields — must have zero effect:
      subtotal: 999999,
      tax: 999999,
      total: 1,
      line_total: 5,
    });
    expect(out.subtotal).toBe(200);
    expect(out.tax).toBe(0);
    expect(out.total).toBe(200);
    // The line total is recomputed from qty×unit, not the client's line_total.
    expect(out.lines[0].line_total).toBe(200);
  });

  test('a hostile per-line line_total field never survives the recompute', () => {
    const out = computeTotals({
      items: [{ name: 'X', quantity: 1, unit_price: 10, discount_pct: 0, line_total: 100000 }],
    });
    expect(out.lines[0].line_total).toBe(10);
    expect(out.total).toBe(10);
  });
});

describe('listProducts / listQuotes — org scoping', () => {
  test('listProducts runs an ORG-SCOPED, bound-param query', async () => {
    const pool = mockPool([{ id: 1, name: 'Widget' }]);
    const rows = await listProducts({ sf: 'org_id', sv: 7 }, pool);
    const [sql, params] = pool.calls[0];
    expect(sql).toMatch(/FROM products/);
    expect(sql).toMatch(/WHERE org_id = \$1/);
    expect(params).toEqual([7]);
    expect(rows).toHaveLength(1);
  });

  test('listProducts activeOnly appends the active filter', async () => {
    const pool = mockPool([]);
    await listProducts({ sf: 'org_id', sv: 7, activeOnly: true }, pool);
    expect(pool.calls[0][0]).toMatch(/active = TRUE/);
  });

  test('listProducts falls back to user_id scoping', async () => {
    const pool = mockPool([]);
    await listProducts({ sf: 'user_id', sv: 4242 }, pool);
    const [sql, params] = pool.calls[0];
    expect(sql).toMatch(/WHERE user_id = \$1/);
    expect(params).toEqual([4242]);
  });

  test('DEFENSE IN DEPTH: a non-allowlisted scope field throws BEFORE querying', async () => {
    const pool = mockPool([]);
    await expect(
      listProducts({ sf: 'evil; DROP TABLE products', sv: 1 }, pool),
    ).rejects.toThrow();
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('listQuotes binds the optional deal_id filter (never interpolates)', async () => {
    const pool = mockPool([]);
    await listQuotes({ sf: 'org_id', sv: 7, dealId: 55 }, pool);
    const [sql, params] = pool.calls[0];
    expect(sql).toMatch(/FROM sales_quotes/);
    expect(sql).toMatch(/WHERE q.org_id = \$1/);
    expect(sql).toMatch(/q.deal_id = \$2/);
    expect(params).toEqual([7, 55]);
  });

  test('listQuotes rejects a bad scope field before querying', async () => {
    const pool = mockPool([]);
    await expect(listQuotes({ sf: 'nope', sv: 1 }, pool)).rejects.toThrow();
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('requireCatalogAdmin — catalog mutation gate', () => {
  const { requireCatalogAdmin } = require('../routes/productRoutes').__test__;

  function run(req) {
    let status = null;
    let body = null;
    let nexted = false;
    const res = {
      status(c) { status = c; return this; },
      json(b) { body = b; return this; },
    };
    requireCatalogAdmin(req, res, () => { nexted = true; });
    return { status, body, nexted };
  }

  test('org member (non-admin) is blocked with 403', () => {
    const r = run({ orgId: 7, orgRole: 'member' });
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/owners\/admins/i);
  });

  test('org owner passes', () => {
    expect(run({ orgId: 7, orgRole: 'owner' }).nexted).toBe(true);
  });

  test('org admin passes', () => {
    expect(run({ orgId: 7, orgRole: 'admin' }).nexted).toBe(true);
  });

  test('personal (org-less) workspace passes — user owns their own catalog', () => {
    expect(run({ orgId: null, userId: 99, orgRole: null }).nexted).toBe(true);
  });
});
