// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Deal line items — the pure money core + rollup for migration 145.
//
// Mirrors services/salesQuotes.js discipline exactly:
//   • ALL arithmetic in integer cents (no binary-float drift).
//   • The server is the ONLY author of line_total_cents and of the
//     deals.amount rollup — client-sent totals are inputs at best, ignored
//     at worst.
//   • The only interpolated SQL identifier is the scope field, validated
//     against the two-value allowlist (org_id | user_id) via
//     salesQuotes.assertScopeField before it can touch SQL. Every value is a
//     bound parameter.
//
// RELATIONSHIP TO THE CPQ (sales_quote_items, migration 120): deliberately a
// SEPARATE model — quote items belong to a quote document (offer + discount +
// tax); deal line items are the deal's own current composition and drive
// deals.amount. Both reference the same `products` catalog (119). Not unified
// on purpose; see the header comment in migrations/145_deal_line_items.sql.
//
// UNITS: deal_line_items stores integer cents; deals.amount is NUMERIC dollars
// (see dealRoutes.js — amount is written as a plain dollar number everywhere).
// The rollup therefore converts once, at the boundary: amount = cents / 100.

const { toCents, centsToNum, assertScopeField } = require('./salesQuotes');

// Migration 159: every line is either revenue (rolls into deals.amount) or a
// cost (feeds contribution/margin only). App-validated here — the DB column is
// a plain VARCHAR by design.
const LINE_KINDS = new Set(['revenue', 'cost']);

/**
 * Normalize + validate one line item from client input, merged over defaults
 * (product snapshot on create, the existing row on update). Precedence:
 * explicit input > defaults. Returns { line } or { error }.
 *
 * Accepted price inputs: `unit_price_cents` (non-negative integer, preferred)
 * or `unit_price` (non-negative dollars — converted once via toCents).
 * The returned line_total_cents is ALWAYS recomputed here — a client-sent
 * line_total / line_total_cents field never survives.
 */
function normalizeLine(input = {}, defaults = {}) {
  const description = String(
    input.description != null && String(input.description).trim() !== ''
      ? input.description
      : (defaults.description || ''),
  ).trim();
  if (!description) {
    return { error: 'description is required (or provide a product_id)' };
  }
  if (description.length > 500) {
    return { error: 'description must be 500 characters or fewer' };
  }

  const qtyRaw = input.quantity !== undefined ? Number(input.quantity)
    : (defaults.quantity !== undefined ? Number(defaults.quantity) : 1);
  if (!Number.isFinite(qtyRaw) || qtyRaw <= 0) {
    return { error: 'quantity must be a positive number' };
  }

  let unitCents;
  if (input.unit_price_cents !== undefined) {
    const c = Number(input.unit_price_cents);
    if (!Number.isInteger(c) || c < 0) {
      return { error: 'unit_price_cents must be a non-negative integer' };
    }
    unitCents = c;
  } else if (input.unit_price !== undefined) {
    const n = Number(input.unit_price);
    if (!Number.isFinite(n) || n < 0) {
      return { error: 'unit_price must be a non-negative number' };
    }
    unitCents = toCents(n);
  } else if (defaults.unit_price_cents !== undefined) {
    unitCents = Math.max(0, Math.round(Number(defaults.unit_price_cents) || 0));
  } else {
    unitCents = 0;
  }

  let sortOrder = input.sort_order !== undefined ? Number(input.sort_order)
    : (defaults.sort_order !== undefined ? Number(defaults.sort_order) : 0);
  if (!Number.isInteger(sortOrder) || sortOrder < 0) sortOrder = 0;

  // kind (migration 159): 'revenue' | 'cost'. Explicit input > stored/default
  // value > 'revenue' (the pre-159 behavior for every line).
  const kindRaw = input.kind !== undefined ? input.kind
    : (defaults.kind !== undefined ? defaults.kind : 'revenue');
  const kind = String(kindRaw || 'revenue').trim().toLowerCase();
  if (!LINE_KINDS.has(kind)) {
    return { error: "kind must be 'revenue' or 'cost'" };
  }

  // category (migration 159): optional free-text bucket. Empty string clears.
  let category;
  if (input.category !== undefined) {
    category = input.category == null ? null : String(input.category).trim() || null;
  } else {
    category = defaults.category != null ? String(defaults.category) : null;
  }
  if (category != null && category.length > 60) {
    return { error: 'category must be 60 characters or fewer' };
  }

  return {
    line: {
      description,
      quantity: qtyRaw,
      unit_price_cents: unitCents,
      // Cents math, rounded ONCE at the line boundary (fractional qty allowed).
      line_total_cents: Math.round(qtyRaw * unitCents),
      sort_order: sortOrder,
      kind,
      category,
    },
  };
}

/** Σ line_total_cents over a set of rows (integer cents in, integer cents out). */
function sumCents(rows) {
  return (rows || []).reduce((s, r) => s + (Number(r.line_total_cents) || 0), 0);
}

/**
 * P&L summary over a set of line rows (migration 159). Pre-159 rows have no
 * kind column in old fixtures — treated as revenue, matching the DB default.
 *
 * margin_pct = contribution / revenue × 100, null when there is no revenue
 * (a margin over zero revenue is undefined, not 0 or -Infinity).
 */
function summarize(rows) {
  let revenue = 0;
  let cost = 0;
  for (const r of rows || []) {
    const cents = Number(r.line_total_cents) || 0;
    if ((r.kind || 'revenue') === 'cost') cost += cents;
    else revenue += cents;
  }
  const contribution = revenue - cost;
  return {
    revenue_total_cents: revenue,
    cost_total_cents: cost,
    contribution_cents: contribution,
    margin_pct: revenue > 0 ? Math.round((contribution / revenue) * 10000) / 100 : null,
  };
}

/**
 * Recompute deals.amount from the deal's line items, inside the caller's
 * transaction. Runs against the provided client so a line mutation and its
 * rollup commit (or roll back) atomically.
 *
 * MIGRATION 159: only REVENUE lines roll into deals.amount — cost lines feed
 * the contribution/margin summary and never touch the headline amount. All
 * pre-159 rows default to kind='revenue', so the rolled-up value for existing
 * deals is identical to the old "sum of all lines" behavior.
 *
 * IMPORTANT: only writes deals.amount while REVENUE lines EXIST. When the last
 * revenue line is removed the amount is left at its final rolled-up value and
 * the deal returns to manual-amount mode — a deal that never had revenue lines
 * (none at all, or only cost lines) is never touched.
 *
 * @returns {{ count: number, revenue_count: number, subtotal_cents: number,
 *             cost_cents: number, amount: number|null }}
 *          count is TOTAL remaining lines (any kind); subtotal_cents is the
 *          revenue subtotal (what deals.amount derives from); amount is the
 *          dollars written to the deal, or null if untouched.
 */
async function rollupDealAmount(client, dealId, sf, sv) {
  assertScopeField(sf);
  const agg = await client.query(
    `SELECT COALESCE(SUM(line_total_cents) FILTER (WHERE kind = 'revenue'), 0)::bigint AS revenue_cents,
            COALESCE(SUM(line_total_cents) FILTER (WHERE kind = 'cost'), 0)::bigint AS cost_cents,
            COUNT(*) FILTER (WHERE kind = 'revenue')::int AS n_revenue,
            COUNT(*)::int AS n
       FROM deal_line_items WHERE deal_id = $1 AND ${sf} = $2`,
    [dealId, sv],
  );
  const cents = Number(agg.rows[0]?.revenue_cents || 0);
  const costCents = Number(agg.rows[0]?.cost_cents || 0);
  const revenueCount = Number(agg.rows[0]?.n_revenue || 0);
  const count = Number(agg.rows[0]?.n || 0);
  if (revenueCount === 0) {
    return { count, revenue_count: 0, subtotal_cents: 0, cost_cents: costCents, amount: null };
  }
  const amount = centsToNum(cents); // deals.amount is NUMERIC dollars
  await client.query(
    `UPDATE deals SET amount = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND ${sf} = $3`,
    [amount, dealId, sv],
  );
  return { count, revenue_count: revenueCount, subtotal_cents: cents, cost_cents: costCents, amount };
}

module.exports = {
  normalizeLine,
  sumCents,
  summarize,
  rollupDealAmount,
  toCents,
  centsToNum,
};
