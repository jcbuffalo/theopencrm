// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Generic light-CPQ money engine + org-scoped fetch helpers.
//
// The pure math core (computeTotals) is DB-free so it unit-tests cleanly and is
// the ONE place quote money is calculated. Routes call it on every create/
// update and persist its output — the client-sent subtotal/tax/total are never
// trusted (a client can only send the *inputs*: line items, quote-level
// discount amount, and tax_rate).
//
// SQL SAFETY (same contract as services/forecast.js + services/reportBuilder.js):
//   • The only interpolated identifier is the scope field, validated against a
//     two-value allowlist (org_id | user_id) before it can touch SQL.
//   • Every value — the scope value included — is a bound parameter ($1…).
//
// MONEY: all arithmetic happens in integer cents to avoid binary-float drift,
// then converts back to a 2-dp number for storage in the NUMERIC columns.
// Quantities may be fractional (e.g. 1.5 hours) so line math is done in cents
// and rounded once, at the line boundary.

const SCOPE_FIELDS = new Set(['org_id', 'user_id']);

function assertScopeField(sf) {
  if (!SCOPE_FIELDS.has(sf)) {
    throw new Error(`Illegal scope field: ${sf}`);
  }
}

// Dollars (number|string) → integer cents. Non-finite / missing → 0.
function toCents(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

// Integer cents → 2-dp number suitable for a NUMERIC(_, 2) column.
function centsToNum(c) {
  return Math.round(c) / 100;
}

// Clamp a percentage into [0, 100].
function clampPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 100);
}

// Non-negative rate (tax %), unbounded above (some jurisdictions stack).
function nonNegRate(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

// line_total (cents) = quantity × unit_price × (1 − discount_pct/100), rounded.
function lineTotalCents(item) {
  const qtyRaw = Number(item.quantity);
  const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 0;
  const unitCents = toCents(item.unit_price);
  const discPct = clampPct(item.discount_pct);
  const gross = unitCents * qty;
  const net = gross * (1 - discPct / 100);
  return Math.round(net);
}

/**
 * Recompute every money field of a quote from its inputs. This is the single
 * source of truth — routes ignore any client-sent totals and persist THIS.
 *
 * @param {object} input
 * @param {Array}  input.items      line items: { name, quantity, unit_price, discount_pct, product_id? }
 * @param {number} input.discount   quote-level absolute discount amount (dollars)
 * @param {number} input.tax_rate   quote-level tax rate (percent)
 * @returns {{ lines, subtotal, discount, tax_rate, tax, total }}
 */
function computeTotals({ items = [], discount = 0, tax_rate = 0 } = {}) {
  const lines = (Array.isArray(items) ? items : []).map((it, i) => {
    const cents = lineTotalCents(it);
    return {
      product_id: it.product_id != null ? it.product_id : null,
      name: (it.name != null ? String(it.name) : '').trim(),
      quantity: Number.isFinite(Number(it.quantity)) && Number(it.quantity) > 0 ? Number(it.quantity) : 0,
      unit_price: centsToNum(toCents(it.unit_price)),
      discount_pct: clampPct(it.discount_pct),
      line_total: centsToNum(cents),
      line_total_cents: cents,
      position: i,
    };
  });

  const subtotalCents = lines.reduce((s, l) => s + l.line_total_cents, 0);
  // Quote-level discount is an absolute amount, clamped to [0, subtotal].
  const discountCents = Math.min(Math.max(toCents(discount), 0), subtotalCents);
  const taxableCents = subtotalCents - discountCents;
  const rate = nonNegRate(tax_rate);
  const taxCents = Math.round(taxableCents * rate / 100);
  const totalCents = taxableCents + taxCents;

  return {
    lines: lines.map(({ line_total_cents, ...rest }) => rest), // drop the internal cents field
    subtotal: centsToNum(subtotalCents),
    discount: centsToNum(discountCents),
    tax_rate: rate,
    tax: centsToNum(taxCents),
    total: centsToNum(totalCents),
  };
}

/**
 * Org-scoped product fetch. Validates the scope field against the allowlist
 * BEFORE any SQL is built, then runs a single bound-param query.
 */
async function listProducts({ sf, sv, activeOnly = false }, pool) {
  assertScopeField(sf);
  let sql = `SELECT * FROM products WHERE ${sf} = $1`;
  if (activeOnly) sql += ' AND active = TRUE';
  sql += ' ORDER BY name ASC';
  const r = await pool.query(sql, [sv]);
  return r.rows;
}

/**
 * Org-scoped quote list (header rows only). Same allowlist + bound-param
 * contract. Optional deal_id filter is bound, never interpolated.
 */
async function listQuotes({ sf, sv, dealId = null }, pool) {
  assertScopeField(sf);
  let sql = `
    SELECT q.*, co.name AS customer_name, d.title AS deal_title
      FROM sales_quotes q
      LEFT JOIN companies co ON q.customer_id = co.id
      LEFT JOIN deals d ON q.deal_id = d.id
     WHERE q.${sf} = $1`;
  const params = [sv];
  if (dealId != null) {
    sql += ` AND q.deal_id = $${params.length + 1}`;
    params.push(dealId);
  }
  sql += ' ORDER BY q.created_at DESC';
  const r = await pool.query(sql, params);
  return r.rows;
}

module.exports = {
  computeTotals,
  lineTotalCents,
  listProducts,
  listQuotes,
  assertScopeField,
  toCents,
  centsToNum,
  SCOPE_FIELDS,
};
