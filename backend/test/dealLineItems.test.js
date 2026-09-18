// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Deal line items (migration 145) — server-authoritative money math, the
// deals.amount rollup, and org isolation.
//
// The pg pool is fully mocked (same convention as cases.test.js): pool.query
// resolves queued responses in the order the route issues them, and
// pool.connect hands back a mock client whose queries are queued the same way
// (mutations run in a BEGIN…COMMIT transaction on a dedicated client).
//
// Query order per route (valid requests):
//   every route:    1. authMiddleware — SELECT org_id, org_role, status FROM users
//   GET    /:d/line-items          2. deal-scope SELECT   3. items SELECT
//   POST   /:d/line-items          2. deal-scope SELECT  (3. product SELECT when product_id)
//                                  client: BEGIN → INSERT → SUM/COUNT → UPDATE deals → COMMIT
//   PUT    /:d/line-items/:i       2. deal-scope SELECT   3. item SELECT (4. product SELECT)
//                                  client: BEGIN → UPDATE item → SUM/COUNT → UPDATE deals → COMMIT
//   DELETE /:d/line-items/:i       2. deal-scope SELECT
//                                  client: BEGIN → DELETE → SUM/COUNT → (UPDATE deals if any left) → COMMIT
//
// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const dealRoutes = require('../routes/dealRoutes');
const { normalizeLine, sumCents, summarize, rollupDealAmount } = require('../services/dealLineItems');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/deals', dealRoutes); // same shape as the index.js mount
  return app;
}

const USER_ID = 4242;
const ORG_ID = 7;
const DEAL_ID = 55;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

const AUTH_MEMBER = { rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] };
const AUTH_ORGLESS = { rows: [{ org_id: null, org_role: null, status: 'active' }] };
const DEAL_ROW = { rows: [{ id: DEAL_ID, amount: '100.00' }] };
const EMPTY = { rows: [] };

function mockClient() {
  return { query: vi.fn(), release: vi.fn() };
}

// Rollup aggregate row (migration 159 shape): revenue vs cost split.
function aggRow(revenueCents, costCents = 0, nRevenue = null, n = null) {
  const nr = nRevenue == null ? (revenueCents > 0 ? 1 : 0) : nRevenue;
  return { rows: [{
    revenue_cents: String(revenueCents), cost_cents: String(costCents),
    n_revenue: nr, n: n == null ? nr + (costCents > 0 ? 1 : 0) : n,
  }] };
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
});

// ---------------------------------------------------------------------------
// Pure money core — normalizeLine / sumCents (mirrors salesQuotes discipline)
// ---------------------------------------------------------------------------
describe('normalizeLine — integer-cents math', () => {
  test('line_total_cents = round(qty × unit_price_cents); dollars input converts once', () => {
    const { line } = normalizeLine({ description: 'Widget', quantity: 3, unit_price: 19.99 });
    expect(line.unit_price_cents).toBe(1999);
    expect(line.line_total_cents).toBe(5997);
  });

  test('no binary-float drift: 3 × $0.10 is exactly 30 cents', () => {
    // Naive float math: 3 * 0.1 * 100 = 30.000000000000004
    const { line } = normalizeLine({ description: 'Dime', quantity: 3, unit_price: 0.1 });
    expect(line.line_total_cents).toBe(30);
    expect(Number.isInteger(line.line_total_cents)).toBe(true);
  });

  test('fractional quantity rounds ONCE at the line boundary', () => {
    const { line } = normalizeLine({ description: 'Hours', quantity: 1.5, unit_price: 99.99 });
    expect(line.line_total_cents).toBe(14999); // round(1.5 × 9999)
  });

  test('explicit unit_price_cents wins and must be a non-negative integer', () => {
    expect(normalizeLine({ description: 'X', quantity: 2, unit_price_cents: 250 }).line.line_total_cents).toBe(500);
    expect(normalizeLine({ description: 'X', unit_price_cents: 10.5 }).error).toMatch(/non-negative integer/);
    expect(normalizeLine({ description: 'X', unit_price_cents: -1 }).error).toMatch(/non-negative integer/);
  });

  test('a hostile client-sent line total NEVER survives the recompute', () => {
    const { line } = normalizeLine({
      description: 'X', quantity: 1, unit_price: 10,
      line_total: 999999, line_total_cents: 999999, // hostile
    });
    expect(line.line_total_cents).toBe(1000);
  });

  test('validation: description required (unless defaulted), quantity > 0', () => {
    expect(normalizeLine({ quantity: 1, unit_price: 5 }).error).toMatch(/description/);
    expect(normalizeLine({ description: 'X', quantity: 0 }).error).toMatch(/quantity/);
    expect(normalizeLine({ description: 'X', quantity: -2 }).error).toMatch(/quantity/);
    // defaults (product snapshot / existing row) fill the gaps
    const { line } = normalizeLine({ quantity: 2 }, { description: 'Catalog widget', unit_price_cents: 1234 });
    expect(line.description).toBe('Catalog widget');
    expect(line.line_total_cents).toBe(2468);
  });

  test('explicit input beats defaults (partial update semantics)', () => {
    const { line } = normalizeLine(
      { unit_price: 5 },
      { description: 'Existing', quantity: '4.000', unit_price_cents: 9999 }, // pg returns NUMERIC as string
    );
    expect(line.quantity).toBe(4);
    expect(line.unit_price_cents).toBe(500);
    expect(line.line_total_cents).toBe(2000);
  });

  test('sumCents adds integer cents without drift', () => {
    expect(sumCents([{ line_total_cents: 30 }, { line_total_cents: 30 }, { line_total_cents: 30 }])).toBe(90);
    expect(sumCents([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Migration 159 — kind ('revenue'|'cost') + category validation, margin math
// ---------------------------------------------------------------------------
describe('normalizeLine — kind + category (migration 159)', () => {
  test("kind defaults to 'revenue' (pre-159 behavior for every line)", () => {
    const { line } = normalizeLine({ description: 'X', quantity: 1, unit_price: 10 });
    expect(line.kind).toBe('revenue');
    expect(line.category).toBeNull();
  });

  test("accepts 'cost' (case-insensitive) and rejects anything else", () => {
    expect(normalizeLine({ description: 'X', kind: 'cost' }).line.kind).toBe('cost');
    expect(normalizeLine({ description: 'X', kind: 'Cost' }).line.kind).toBe('cost');
    expect(normalizeLine({ description: 'X', kind: 'revenue' }).line.kind).toBe('revenue');
    expect(normalizeLine({ description: 'X', kind: 'profit' }).error).toMatch(/kind/);
    expect(normalizeLine({ description: 'X', kind: 'COGS' }).error).toMatch(/kind/);
  });

  test('partial-update semantics: stored kind/category survive when unsent, explicit input wins', () => {
    const stored = { description: 'Install', quantity: 1, unit_price_cents: 5000, kind: 'cost', category: 'install' };
    expect(normalizeLine({ quantity: 2 }, stored).line.kind).toBe('cost');
    expect(normalizeLine({ quantity: 2 }, stored).line.category).toBe('install');
    expect(normalizeLine({ kind: 'revenue' }, stored).line.kind).toBe('revenue');
    // category: null / '' clears
    expect(normalizeLine({ category: null }, stored).line.category).toBeNull();
    expect(normalizeLine({ category: '  ' }, stored).line.category).toBeNull();
  });

  test('category is trimmed and capped at 60 chars', () => {
    expect(normalizeLine({ description: 'X', category: ' production ' }).line.category).toBe('production');
    expect(normalizeLine({ description: 'X', category: 'x'.repeat(61) }).error).toMatch(/category/);
  });
});

describe('summarize — contribution + margin math (migration 159)', () => {
  test('contribution = revenue − cost; margin_pct = contribution / revenue', () => {
    const s = summarize([
      { kind: 'revenue', line_total_cents: 100000 }, // $1000 revenue
      { kind: 'cost', line_total_cents: 25000 },     // $250 cost
      { kind: 'cost', line_total_cents: 15000 },     // $150 cost
    ]);
    expect(s.revenue_total_cents).toBe(100000);
    expect(s.cost_total_cents).toBe(40000);
    expect(s.contribution_cents).toBe(60000);
    expect(s.margin_pct).toBe(60);
  });

  test('rows with no kind (pre-159 fixtures / DB default) count as revenue', () => {
    const s = summarize([{ line_total_cents: 500 }, { kind: 'cost', line_total_cents: 100 }]);
    expect(s.revenue_total_cents).toBe(500);
    expect(s.contribution_cents).toBe(400);
    expect(s.margin_pct).toBe(80);
  });

  test('no revenue → margin_pct null (undefined, not 0 or -Infinity); costs can exceed revenue', () => {
    expect(summarize([{ kind: 'cost', line_total_cents: 100 }]).margin_pct).toBeNull();
    expect(summarize([]).margin_pct).toBeNull();
    const underwater = summarize([
      { kind: 'revenue', line_total_cents: 100 },
      { kind: 'cost', line_total_cents: 300 },
    ]);
    expect(underwater.contribution_cents).toBe(-200);
    expect(underwater.margin_pct).toBe(-200);
  });
});

describe('rollupDealAmount — deals.amount derivation', () => {
  test('writes amount = Σ revenue cents / 100 (dollars) while revenue lines exist', async () => {
    const client = mockClient();
    client.query
      .mockResolvedValueOnce(aggRow(5997, 0, 2, 2)) // SUM/COUNT
      .mockResolvedValueOnce({ rows: [] });         // UPDATE deals
    const out = await rollupDealAmount(client, DEAL_ID, 'org_id', ORG_ID);
    expect(out).toEqual({ count: 2, revenue_count: 2, subtotal_cents: 5997, cost_cents: 0, amount: 59.97 });
    const [updSql, updParams] = client.query.mock.calls[1];
    expect(updSql).toMatch(/UPDATE deals SET amount = \$1/);
    expect(updParams).toEqual([59.97, DEAL_ID, ORG_ID]);
  });

  test('REVENUE-ONLY rollup (migration 159): cost lines never touch deals.amount', async () => {
    const client = mockClient();
    client.query
      .mockResolvedValueOnce(aggRow(10000, 4000, 1, 3)) // 1 revenue + 2 cost lines
      .mockResolvedValueOnce({ rows: [] });             // UPDATE deals
    const out = await rollupDealAmount(client, DEAL_ID, 'org_id', ORG_ID);
    expect(out.amount).toBe(100); // $100 revenue — the $40 of costs are excluded
    expect(out.subtotal_cents).toBe(10000);
    expect(out.cost_cents).toBe(4000);
    // The aggregate itself filters by kind — revenue and cost split in SQL.
    expect(client.query.mock.calls[0][0]).toMatch(/FILTER \(WHERE kind = 'revenue'\)/);
    expect(client.query.mock.calls[1][1]).toEqual([100, DEAL_ID, ORG_ID]);
  });

  test('ZERO lines: deals.amount is left alone (manual-amount mode)', async () => {
    const client = mockClient();
    client.query.mockResolvedValueOnce(aggRow(0, 0, 0, 0));
    const out = await rollupDealAmount(client, DEAL_ID, 'org_id', ORG_ID);
    expect(out.amount).toBeNull();
    expect(client.query).toHaveBeenCalledTimes(1); // no UPDATE issued
  });

  test('COST-ONLY lines: deals.amount is left alone too (manual-amount mode preserved)', async () => {
    const client = mockClient();
    client.query.mockResolvedValueOnce(aggRow(0, 2500, 0, 2));
    const out = await rollupDealAmount(client, DEAL_ID, 'org_id', ORG_ID);
    expect(out.amount).toBeNull();      // adding a cost line never clobbers a manual amount
    expect(out.count).toBe(2);          // the cost lines still count as remaining lines
    expect(out.cost_cents).toBe(2500);
    expect(client.query).toHaveBeenCalledTimes(1); // no UPDATE issued
  });

  test('DEFENSE IN DEPTH: non-allowlisted scope field throws before any SQL', async () => {
    const client = mockClient();
    await expect(rollupDealAmount(client, DEAL_ID, 'evil; DROP TABLE deals', 1)).rejects.toThrow();
    expect(client.query).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET — list + org isolation
// ---------------------------------------------------------------------------
describe('GET /deals/:dealId/line-items', () => {
  test('org-scoped list with integer-cents subtotal', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(DEAL_ROW)
      .mockResolvedValueOnce({ rows: [
        { id: 1, line_total_cents: 1000 },
        { id: 2, line_total_cents: 2350 },
      ] });

    const res = await request(buildApp())
      .get(`/deals/${DEAL_ID}/line-items`)
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.line_items).toHaveLength(2);
    expect(res.body.subtotal_cents).toBe(3350);

    // Both the deal check and the item list are org-scoped, bound-param queries.
    const [dealSql, dealParams] = mockPool.query.mock.calls[1];
    expect(dealSql).toMatch(/FROM deals WHERE id = \$1 AND org_id = \$2/);
    expect(dealParams).toEqual([String(DEAL_ID), ORG_ID]);
    const [itemSql, itemParams] = mockPool.query.mock.calls[2];
    expect(itemSql).toMatch(/li\.org_id = \$2/);
    expect(itemParams).toEqual([String(DEAL_ID), ORG_ID]);
  });

  test('cross-org (or nonexistent) deal_id → 404, no line SQL runs', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(EMPTY); // deal not in this org's scope

    const res = await request(buildApp())
      .get(`/deals/9999/line-items`)
      .set('Cookie', authCookie());

    expect(res.status).toBe(404);
    expect(mockPool.query).toHaveBeenCalledTimes(2); // auth + deal check only
  });

  test('org-less user falls back to user_id scoping', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_ORGLESS)
      .mockResolvedValueOnce(DEAL_ROW)
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .get(`/deals/${DEAL_ID}/line-items`)
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    const [dealSql, dealParams] = mockPool.query.mock.calls[1];
    expect(dealSql).toMatch(/AND user_id = \$2/);
    expect(dealParams).toEqual([String(DEAL_ID), USER_ID]);
  });
});

// ---------------------------------------------------------------------------
// POST — server-computed totals + rollup
// ---------------------------------------------------------------------------
describe('POST /deals/:dealId/line-items', () => {
  test('computes line_total_cents server-side and rolls deals.amount up in the same txn', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(DEAL_ROW);
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({})                                             // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 9, deal_id: DEAL_ID, line_total_cents: 5997 }] }) // INSERT
      .mockResolvedValueOnce(aggRow(5997, 0, 1, 1))                          // SUM/COUNT
      .mockResolvedValueOnce({ rows: [] })                                   // UPDATE deals
      .mockResolvedValueOnce({});                                            // COMMIT
    mockPool.connect.mockResolvedValue(client);

    const res = await request(buildApp())
      .post(`/deals/${DEAL_ID}/line-items`)
      .set('Cookie', authCookie())
      .send({ description: 'Widget', quantity: 3, unit_price: 19.99, line_total_cents: 999999 }); // hostile total

    expect(res.status).toBe(201);
    expect(res.body.deal_amount).toBe(59.97);

    // INSERT got the SERVER-computed cents, not the hostile client value.
    const [insSql, insParams] = client.query.mock.calls[1];
    expect(insSql).toMatch(/INSERT INTO deal_line_items/);
    expect(insParams[6]).toBe(1999); // unit_price_cents
    expect(insParams[7]).toBe(5997); // line_total_cents — NOT 999999

    // The rollup UPDATE wrote dollars derived from integer cents.
    const [updSql, updParams] = client.query.mock.calls[3];
    expect(updSql).toMatch(/UPDATE deals SET amount = \$1/);
    expect(updParams).toEqual([59.97, String(DEAL_ID), ORG_ID]);
    expect(client.query.mock.calls[4][0]).toBe('COMMIT');
  });

  test('no float drift on the rollup: 3 lines of 3 × $0.10 sum to exactly $0.90', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(DEAL_ROW);
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({})                                   // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 12 }] })               // INSERT (3rd line)
      .mockResolvedValueOnce(aggRow(90, 0, 3, 3))                  // SUM/COUNT
      .mockResolvedValueOnce({ rows: [] })                         // UPDATE deals
      .mockResolvedValueOnce({});                                  // COMMIT
    mockPool.connect.mockResolvedValue(client);

    const res = await request(buildApp())
      .post(`/deals/${DEAL_ID}/line-items`)
      .set('Cookie', authCookie())
      .send({ description: 'Dime pack', quantity: 3, unit_price: 0.1 });

    expect(res.status).toBe(201);
    expect(client.query.mock.calls[1][1][7]).toBe(30);   // 3 × 10¢, integer
    expect(client.query.mock.calls[3][1][0]).toBe(0.9);  // exactly 0.9 dollars
    expect(res.body.deal_amount).toBe(0.9);
  });

  test('cross-org deal_id → 404 before any write', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(EMPTY);

    const res = await request(buildApp())
      .post(`/deals/${DEAL_ID}/line-items`)
      .set('Cookie', authCookie())
      .send({ description: 'X', quantity: 1, unit_price: 10 });

    expect(res.status).toBe(404);
    expect(mockPool.connect).not.toHaveBeenCalled(); // no txn was ever opened
  });

  test('out-of-scope product_id → 400, no txn', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(DEAL_ROW)
      .mockResolvedValueOnce(EMPTY); // product lookup in THIS org finds nothing

    const res = await request(buildApp())
      .post(`/deals/${DEAL_ID}/line-items`)
      .set('Cookie', authCookie())
      .send({ product_id: 31337, quantity: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/product_id/);
    expect(mockPool.connect).not.toHaveBeenCalled();
    // The product lookup itself was org-scoped.
    const [prodSql, prodParams] = mockPool.query.mock.calls[2];
    expect(prodSql).toMatch(/FROM products WHERE id = \$1 AND org_id = \$2/);
    expect(prodParams).toEqual([31337, ORG_ID]);
  });

  test('in-scope product snapshots name + catalog price onto the line', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(DEAL_ROW)
      .mockResolvedValueOnce({ rows: [{ id: 3, name: 'Catalog widget', unit_price: '12.34' }] });
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({})                                  // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 13 }] })              // INSERT
      .mockResolvedValueOnce(aggRow(2468, 0, 1, 1))               // SUM/COUNT
      .mockResolvedValueOnce({ rows: [] })                        // UPDATE deals
      .mockResolvedValueOnce({});                                 // COMMIT
    mockPool.connect.mockResolvedValue(client);

    const res = await request(buildApp())
      .post(`/deals/${DEAL_ID}/line-items`)
      .set('Cookie', authCookie())
      .send({ product_id: 3, quantity: 2 }); // no description / price — catalog fills them

    expect(res.status).toBe(201);
    const insParams = client.query.mock.calls[1][1];
    expect(insParams[3]).toBe(3);                // product_id
    expect(insParams[4]).toBe('Catalog widget'); // snapshotted description
    expect(insParams[6]).toBe(1234);             // snapshotted unit_price_cents
    expect(insParams[7]).toBe(2468);             // 2 × 1234
  });

  test('validation error (no description, no product) → 400', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(DEAL_ROW);

    const res = await request(buildApp())
      .post(`/deals/${DEAL_ID}/line-items`)
      .set('Cookie', authCookie())
      .send({ quantity: 1, unit_price: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/description/);
    expect(mockPool.connect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PUT — partial update, totals recomputed
// ---------------------------------------------------------------------------
describe('PUT /deals/:dealId/line-items/:itemId', () => {
  const PREV = { rows: [{
    id: 9, deal_id: DEAL_ID, org_id: ORG_ID, product_id: null,
    description: 'Widget', quantity: '3.000', unit_price_cents: 1999,
    line_total_cents: 5997, sort_order: 0,
  }] };

  test('changing quantity recomputes line_total_cents AND deals.amount', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(DEAL_ROW)
      .mockResolvedValueOnce(PREV);
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({})                                  // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 9 }] })               // UPDATE item
      .mockResolvedValueOnce(aggRow(9995, 0, 1, 1))               // SUM/COUNT
      .mockResolvedValueOnce({ rows: [] })                        // UPDATE deals
      .mockResolvedValueOnce({});                                 // COMMIT
    mockPool.connect.mockResolvedValue(client);

    const res = await request(buildApp())
      .put(`/deals/${DEAL_ID}/line-items/9`)
      .set('Cookie', authCookie())
      .send({ quantity: 5 }); // keeps existing description + 19.99 price

    expect(res.status).toBe(200);
    const updParams = client.query.mock.calls[1][1];
    expect(updParams[1]).toBe('Widget'); // description kept from the stored row
    expect(updParams[3]).toBe(1999);     // unit_price_cents kept
    expect(updParams[4]).toBe(9995);     // 5 × 1999, server-computed
    expect(client.query.mock.calls[3][1]).toEqual([99.95, String(DEAL_ID), ORG_ID]);
    expect(res.body.deal_amount).toBe(99.95);
  });

  test('item outside the deal/org → 404', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(DEAL_ROW)
      .mockResolvedValueOnce(EMPTY); // item lookup (scoped) misses

    const res = await request(buildApp())
      .put(`/deals/${DEAL_ID}/line-items/777`)
      .set('Cookie', authCookie())
      .send({ quantity: 2 });

    expect(res.status).toBe(404);
    expect(mockPool.connect).not.toHaveBeenCalled();
    const [itemSql, itemParams] = mockPool.query.mock.calls[2];
    expect(itemSql).toMatch(/WHERE id = \$1 AND deal_id = \$2 AND org_id = \$3/);
    expect(itemParams).toEqual(['777', String(DEAL_ID), ORG_ID]);
  });
});

// ---------------------------------------------------------------------------
// DELETE — removal + the manual-amount mode boundary
// ---------------------------------------------------------------------------
describe('DELETE /deals/:dealId/line-items/:itemId', () => {
  test('removing a line re-derives the amount from the remaining lines', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(DEAL_ROW);
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({})                                  // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 9 }] })               // DELETE
      .mockResolvedValueOnce(aggRow(2350, 0, 1, 1))               // SUM/COUNT (one left)
      .mockResolvedValueOnce({ rows: [] })                        // UPDATE deals
      .mockResolvedValueOnce({});                                 // COMMIT
    mockPool.connect.mockResolvedValue(client);

    const res = await request(buildApp())
      .delete(`/deals/${DEAL_ID}/line-items/9`)
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.remaining).toBe(1);
    expect(res.body.deal_amount).toBe(23.5);
    expect(client.query.mock.calls[3][1]).toEqual([23.5, String(DEAL_ID), ORG_ID]);
  });

  test('removing the LAST line leaves deals.amount untouched (manual mode resumes)', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(DEAL_ROW);
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({})                                // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 9 }] })             // DELETE
      .mockResolvedValueOnce(aggRow(0, 0, 0, 0))                // SUM/COUNT — none left
      .mockResolvedValueOnce({});                               // COMMIT
    mockPool.connect.mockResolvedValue(client);

    const res = await request(buildApp())
      .delete(`/deals/${DEAL_ID}/line-items/9`)
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.remaining).toBe(0);
    expect(res.body.deal_amount).toBeNull(); // amount NOT clobbered to 0
    // 4 client calls total: BEGIN, DELETE, SUM/COUNT, COMMIT — no deals UPDATE.
    expect(client.query).toHaveBeenCalledTimes(4);
    const sqls = client.query.mock.calls.map(c => c[0]);
    expect(sqls.some(s => /UPDATE deals/.test(s))).toBe(false);
  });

  test('unknown item → 404 and the txn rolls back', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(DEAL_ROW);
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({})      // BEGIN
      .mockResolvedValueOnce(EMPTY)   // DELETE hits nothing
      .mockResolvedValueOnce({});     // ROLLBACK
    mockPool.connect.mockResolvedValue(client);

    const res = await request(buildApp())
      .delete(`/deals/${DEAL_ID}/line-items/424242`)
      .set('Cookie', authCookie());

    expect(res.status).toBe(404);
    expect(client.query.mock.calls[2][0]).toBe('ROLLBACK');
  });
});

// ---------------------------------------------------------------------------
// Cost lines end-to-end (migration 159): kind/category through the routes
// ---------------------------------------------------------------------------
describe('cost lines through the routes (migration 159)', () => {
  test('POST a cost line: kind + category stored; a manual deal amount is NOT clobbered', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(DEAL_ROW); // deal has a manual amount of $100
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({})                     // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 21, kind: 'cost', category: 'install' }] }) // INSERT
      .mockResolvedValueOnce(aggRow(0, 4500, 0, 1))  // SUM/COUNT — cost-only deal
      .mockResolvedValueOnce({});                    // COMMIT (no deals UPDATE)
    mockPool.connect.mockResolvedValue(client);

    const res = await request(buildApp())
      .post(`/deals/${DEAL_ID}/line-items`)
      .set('Cookie', authCookie())
      .send({ description: 'Install crew', quantity: 1, unit_price: 45, kind: 'cost', category: 'install' });

    expect(res.status).toBe(201);
    const insParams = client.query.mock.calls[1][1];
    expect(insParams[9]).toBe('cost');     // kind
    expect(insParams[10]).toBe('install'); // category
    expect(res.body.deal_amount).toBeNull(); // manual amount untouched
    // No deals UPDATE was issued: BEGIN, INSERT, SUM/COUNT, COMMIT only.
    expect(client.query).toHaveBeenCalledTimes(4);
    expect(client.query.mock.calls.map(c => c[0]).some(s => /UPDATE deals/.test(s))).toBe(false);
  });

  test('POST rejects an invalid kind with 400 before any write', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(DEAL_ROW);

    const res = await request(buildApp())
      .post(`/deals/${DEAL_ID}/line-items`)
      .set('Cookie', authCookie())
      .send({ description: 'X', quantity: 1, unit_price: 10, kind: 'expense' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/kind/);
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  test('GET returns the P&L summary; subtotal_cents stays the revenue rollup', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(DEAL_ROW)
      .mockResolvedValueOnce({ rows: [
        { id: 1, kind: 'revenue', line_total_cents: 100000 },
        { id: 2, kind: 'cost', line_total_cents: 25000, category: 'production' },
        { id: 3, kind: 'cost', line_total_cents: 15000, category: 'install' },
      ] });

    const res = await request(buildApp())
      .get(`/deals/${DEAL_ID}/line-items`)
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.subtotal_cents).toBe(100000); // revenue only — what deals.amount derives from
    expect(res.body.revenue_total_cents).toBe(100000);
    expect(res.body.cost_total_cents).toBe(40000);
    expect(res.body.contribution_cents).toBe(60000);
    expect(res.body.margin_pct).toBe(60);
  });

  test('PUT can flip a revenue line to cost (kind toggle)', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(DEAL_ROW)
      .mockResolvedValueOnce({ rows: [{
        id: 9, deal_id: DEAL_ID, org_id: ORG_ID, product_id: null,
        description: 'Site fee', quantity: '1.000', unit_price_cents: 5000,
        line_total_cents: 5000, sort_order: 0, kind: 'revenue', category: null,
      }] });
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({})                     // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 9 }] })  // UPDATE item
      .mockResolvedValueOnce(aggRow(20000, 5000, 1, 2)) // SUM/COUNT after the flip
      .mockResolvedValueOnce({ rows: [] })           // UPDATE deals (revenue lines remain)
      .mockResolvedValueOnce({});                    // COMMIT
    mockPool.connect.mockResolvedValue(client);

    const res = await request(buildApp())
      .put(`/deals/${DEAL_ID}/line-items/9`)
      .set('Cookie', authCookie())
      .send({ kind: 'cost' });

    expect(res.status).toBe(200);
    const updParams = client.query.mock.calls[1][1];
    expect(updParams[6]).toBe('cost');   // kind flipped
    expect(updParams[1]).toBe('Site fee'); // everything else kept
    expect(client.query.mock.calls[3][1]).toEqual([200, String(DEAL_ID), ORG_ID]);
    expect(res.body.deal_amount).toBe(200); // re-derived from remaining revenue
  });
});
