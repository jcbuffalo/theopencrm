// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Deal line items (migration 145) — nested CRUD under /api/deals/:dealId/line-items.
// Mounted from routes/dealRoutes.js with mergeParams so :dealId resolves here.
//
// Every route first verifies the DEAL is inside the caller's tenancy (the
// qs(req) convention) — a cross-org deal_id 404s before any line SQL runs.
// Line rows additionally carry their own org_id/user_id scope column and every
// line query filters on it (defense in depth).
//
// MONEY IS SERVER-AUTHORITATIVE (services/dealLineItems.js — mirrors
// services/salesQuotes.js): line_total_cents is always recomputed from
// quantity × unit_price_cents in integer cents; a client-sent total is
// ignored. Every mutation then re-derives deals.amount = Σ line_total_cents
// (converted once to dollars — deals.amount is NUMERIC dollars) inside the
// SAME transaction, so the line change and the rollup commit atomically.
// MIGRATION 159: only kind='revenue' lines roll into deals.amount; 'cost'
// lines feed the revenue/cost/contribution/margin summary on GET / and never
// touch the headline amount. A deal with no REVENUE line items keeps its
// manually-set amount: the rollup only writes while revenue lines exist, and
// removing the last revenue line leaves amount at its final rolled-up value
// (manual-amount mode resumes).
//
// Endpoints (all auth-required, org-scoped):
//   GET    /             — list lines + subtotal_cents (+ resolved product name)
//   POST   /             — add a line (product-backed or free-text)
//   PUT    /:itemId      — update a line (partial; totals recomputed)
//   DELETE /:itemId      — remove a line
//
// product_id is an OPTIONAL link into the shared `products` catalog (119); the
// product's name/price are snapshotted onto the line at add time, so an
// out-of-scope or later-deleted product never dangles. Deliberately a separate
// model from the CPQ's sales_quote_items — see migrations/145_deal_line_items.sql.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const dealLineItems = require('../services/dealLineItems');

const router = express.Router({ mergeParams: true });
router.use(authMiddleware);

// Returns [scopeField, scopeValue] for the current request's tenancy.
function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// The deal must exist INSIDE the caller's tenancy. Cross-org (or nonexistent)
// deal ids get the same 404 — no existence oracle.
async function dealInScope(req, sf, sv) {
  const r = await pool.query(
    `SELECT id, amount FROM deals WHERE id = $1 AND ${sf} = $2`,
    [req.params.dealId, sv],
  );
  return r.rows[0] || null;
}

// Resolve an optional product link. Returns:
//   { ok: true,  productId: null, defaults: {} }            — no product sent
//   { ok: true,  productId, defaults: { description, unit_price_cents } }
//   { ok: false }                                           — out of scope → 400
async function resolveProduct(productId, sf, sv) {
  if (productId == null) return { ok: true, productId: null, defaults: {} };
  const id = Number(productId);
  if (!Number.isInteger(id)) return { ok: false };
  const r = await pool.query(
    `SELECT id, name, unit_price FROM products WHERE id = $1 AND ${sf} = $2`,
    [id, sv],
  );
  if (r.rows.length === 0) return { ok: false };
  const p = r.rows[0];
  return {
    ok: true,
    productId: p.id,
    defaults: {
      description: p.name,
      unit_price_cents: dealLineItems.toCents(p.unit_price),
    },
  };
}

// GET / — list the deal's lines (sorted) + the integer-cents subtotal.
router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const deal = await dealInScope(req, sf, sv);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const r = await pool.query(
      `SELECT li.*, p.name AS product_name
         FROM deal_line_items li
         LEFT JOIN products p ON li.product_id = p.id
        WHERE li.deal_id = $1 AND li.${sf} = $2
        ORDER BY li.sort_order ASC, li.id ASC`,
      [req.params.dealId, sv],
    );
    // P&L summary (migration 159): revenue lines are what deals.amount derives
    // from; cost lines feed contribution/margin only. subtotal_cents keeps its
    // historical meaning — the rollup value (revenue subtotal).
    const pl = dealLineItems.summarize(r.rows);
    res.json({
      line_items: r.rows,
      subtotal_cents: pl.revenue_total_cents,
      revenue_total_cents: pl.revenue_total_cents,
      cost_total_cents: pl.cost_total_cents,
      contribution_cents: pl.contribution_cents,
      margin_pct: pl.margin_pct,
      deal_amount: deal.amount,
    });
  } catch (error) {
    console.error('Deal line items fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch line items' });
  }
});

// POST / — add a line. Body: { product_id?, description?, quantity?,
// unit_price? | unit_price_cents?, sort_order?, kind? ('revenue'|'cost',
// default 'revenue'), category? }. Product-backed lines default
// description/price from the catalog snapshot; free-text lines need a
// description. line_total_cents + deals.amount are recomputed server-side.
router.post('/', async (req, res) => {
  const [sf, sv] = qs(req);
  try {
    const deal = await dealInScope(req, sf, sv);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const body = req.body || {};
    const prod = await resolveProduct(body.product_id, sf, sv);
    if (!prod.ok) return res.status(400).json({ error: 'product_id not found in your organization' });

    const norm = dealLineItems.normalizeLine(body, prod.defaults);
    if (norm.error) return res.status(400).json({ error: norm.error });
    const line = norm.line;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO deal_line_items
           (org_id, user_id, deal_id, product_id, description, quantity,
            unit_price_cents, line_total_cents, sort_order, kind, category)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          req.orgId || null, req.userId, req.params.dealId, prod.productId,
          line.description, line.quantity, line.unit_price_cents,
          line.line_total_cents, line.sort_order, line.kind, line.category,
        ],
      );
      const rollup = await dealLineItems.rollupDealAmount(client, req.params.dealId, sf, sv);
      await client.query('COMMIT');
      res.status(201).json({ ...ins.rows[0], deal_amount: rollup.amount, subtotal_cents: rollup.subtotal_cents });
    } catch (txnErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txnErr;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Deal line item create error:', error);
    res.status(500).json({ error: 'Failed to add line item' });
  }
});

// PUT /:itemId — partial update. Unsent fields keep their stored values;
// sending product_id re-snapshots description/price from the catalog (unless
// explicitly overridden in the same request); product_id: null unlinks.
// Totals + deals.amount always recomputed server-side.
router.put('/:itemId', async (req, res) => {
  const [sf, sv] = qs(req);
  try {
    const deal = await dealInScope(req, sf, sv);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const existing = await pool.query(
      `SELECT * FROM deal_line_items WHERE id = $1 AND deal_id = $2 AND ${sf} = $3`,
      [req.params.itemId, req.params.dealId, sv],
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Line item not found' });
    const prev = existing.rows[0];

    const body = req.body || {};
    // product_id semantics: undefined → keep, null → unlink, number → re-link.
    let productId = prev.product_id;
    let productDefaults = {};
    if (body.product_id !== undefined) {
      const prod = await resolveProduct(body.product_id, sf, sv);
      if (!prod.ok) return res.status(400).json({ error: 'product_id not found in your organization' });
      productId = prod.productId;
      productDefaults = prod.defaults;
    }

    const norm = dealLineItems.normalizeLine(body, {
      description: prev.description,
      quantity: prev.quantity,
      unit_price_cents: prev.unit_price_cents,
      sort_order: prev.sort_order,
      kind: prev.kind,
      category: prev.category,
      ...productDefaults, // a newly-linked product's snapshot wins over prev
    });
    if (norm.error) return res.status(400).json({ error: norm.error });
    const line = norm.line;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const upd = await client.query(
        `UPDATE deal_line_items SET
           product_id = $1, description = $2, quantity = $3,
           unit_price_cents = $4, line_total_cents = $5, sort_order = $6,
           kind = $7, category = $8,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $9 AND deal_id = $10 AND ${sf} = $11 RETURNING *`,
        [
          productId, line.description, line.quantity, line.unit_price_cents,
          line.line_total_cents, line.sort_order, line.kind, line.category,
          req.params.itemId, req.params.dealId, sv,
        ],
      );
      const rollup = await dealLineItems.rollupDealAmount(client, req.params.dealId, sf, sv);
      await client.query('COMMIT');
      res.json({ ...upd.rows[0], deal_amount: rollup.amount, subtotal_cents: rollup.subtotal_cents });
    } catch (txnErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txnErr;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Deal line item update error:', error);
    res.status(500).json({ error: 'Failed to update line item' });
  }
});

// DELETE /:itemId — remove a line and re-derive deals.amount. Removing the
// LAST line leaves the amount at its final rolled-up value (see rollup note).
router.delete('/:itemId', async (req, res) => {
  const [sf, sv] = qs(req);
  try {
    const deal = await dealInScope(req, sf, sv);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const del = await client.query(
        `DELETE FROM deal_line_items WHERE id = $1 AND deal_id = $2 AND ${sf} = $3 RETURNING id`,
        [req.params.itemId, req.params.dealId, sv],
      );
      if (del.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Line item not found' });
      }
      const rollup = await dealLineItems.rollupDealAmount(client, req.params.dealId, sf, sv);
      await client.query('COMMIT');
      res.json({
        message: 'Line item removed',
        remaining: rollup.count,
        deal_amount: rollup.amount, // null ⇒ amount untouched (manual mode resumed)
        subtotal_cents: rollup.subtotal_cents,
      });
    } catch (txnErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txnErr;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Deal line item delete error:', error);
    res.status(500).json({ error: 'Failed to remove line item' });
  }
});

module.exports = router;
