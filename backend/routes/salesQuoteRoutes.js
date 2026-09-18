// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Generic sales quotes (light CPQ) — a line-item quote builder for
// generic/jcp/rin orgs. Mounted at /api/sales-quotes, gated by the
// `products_enabled` feature flag. Fully org-scoped via qs(req).
//
// MONEY IS SERVER-AUTHORITATIVE. On every create/update we recompute subtotal,
// per-line totals, quote-level discount, tax, and total from the submitted
// inputs via services/salesQuotes.computeTotals — the client-sent subtotal /
// tax / total are DISCARDED. A client can only influence money by sending line
// items, a quote-level discount *amount*, and a tax_rate.
//
// Endpoints (all auth-required, org-scoped):
//   GET    /            — list quotes (optional ?deal_id=)
//   GET    /:id         — quote header + line_items
//   POST   /            — create quote + items (recompute totals)
//   PUT    /:id         — update quote; if items[] present, replace + recompute
//   GET    /:id/pdf     — branded PDF
//   DELETE /:id         — delete (cascades to items)
//
// Separate from the bespoke Zang /api/quotes surface. See migration 120.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const audit = require('../services/audit');
const salesQuotes = require('../services/salesQuotes');
const { renderSalesQuotePdf } = require('../services/pdfSalesQuote');

const router = express.Router();
router.use(authMiddleware);

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// Verify an optional FK points at a row inside the caller's tenancy. Returns
// true when id is null/undefined (nothing to check) or the row is in scope.
async function ownsRow(table, id, sf, sv) {
  if (id == null) return true;
  const r = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1 AND ${sf} = $2`, [id, sv]);
  return r.rows.length > 0;
}

// Persist a quote's line items inside an existing client/transaction. Uses the
// recomputed lines (which already carry the authoritative line_total). Only
// products in-scope keep their product_id link; anything else is snapshotted.
async function insertItems(client, quoteId, lines, inScopeProductIds) {
  for (const l of lines) {
    const productId = l.product_id != null && inScopeProductIds.has(Number(l.product_id))
      ? Number(l.product_id)
      : null;
    await client.query(
      `INSERT INTO sales_quote_items
         (quote_id, product_id, name, quantity, unit_price, discount_pct, line_total, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [quoteId, productId, l.name || '', l.quantity, l.unit_price, l.discount_pct, l.line_total, l.position],
    );
  }
}

// Resolve which of the referenced product_ids actually belong to this tenant.
// Lines pointing at a product outside the org get their FK nulled (the name/
// price are still snapshotted onto the line, so nothing is lost).
async function inScopeProducts(items, sf, sv) {
  const ids = [...new Set((items || [])
    .map((i) => i.product_id)
    .filter((v) => v != null)
    .map(Number)
    .filter(Number.isFinite))];
  if (ids.length === 0) return new Set();
  const r = await pool.query(
    `SELECT id FROM products WHERE ${sf} = $1 AND id = ANY($2::int[])`,
    [sv, ids],
  );
  return new Set(r.rows.map((row) => row.id));
}

// GET / — list quotes.
router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const rows = await salesQuotes.listQuotes(
      { sf, sv, dealId: req.query.deal_id ? Number(req.query.deal_id) : null },
      pool,
    );
    res.json(rows);
  } catch (error) {
    console.error('Error fetching sales quotes:', error);
    res.status(500).json({ error: 'Failed to fetch quotes' });
  }
});

// GET /:id — quote + line items.
router.get('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const q = await pool.query(
      `SELECT q.*, co.name AS customer_name, d.title AS deal_title
         FROM sales_quotes q
         LEFT JOIN companies co ON q.customer_id = co.id
         LEFT JOIN deals d ON q.deal_id = d.id
        WHERE q.id = $1 AND q.${sf} = $2`,
      [req.params.id, sv],
    );
    if (q.rows.length === 0) return res.status(404).json({ error: 'Quote not found' });
    const items = await pool.query(
      `SELECT * FROM sales_quote_items WHERE quote_id = $1 ORDER BY position, id`,
      [req.params.id],
    );
    res.json({ ...q.rows[0], line_items: items.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch quote' });
  }
});

// POST / — create quote + items with server-recomputed totals.
router.post('/', async (req, res) => {
  const [sf, sv] = qs(req);
  const { deal_id, customer_id, title, status, currency, notes, items, discount, tax_rate } = req.body || {};

  // Tenancy: optional FKs must point inside the org.
  if (!(await ownsRow('deals', deal_id, sf, sv))) {
    return res.status(400).json({ error: 'deal_id not found in your organization' });
  }
  if (!(await ownsRow('companies', customer_id, sf, sv))) {
    return res.status(400).json({ error: 'customer_id not found in your organization' });
  }

  // AUTHORITATIVE recompute — ignore any client-sent subtotal/tax/total.
  const totals = salesQuotes.computeTotals({ items, discount, tax_rate });
  const scopeProducts = await inScopeProducts(items, sf, sv);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const qr = await client.query(
      `INSERT INTO sales_quotes
         (org_id, user_id, deal_id, customer_id, title, status, currency, notes,
          subtotal, discount, tax_rate, tax, total, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        req.orgId || null, req.userId, deal_id || null, customer_id || null,
        title ? String(title).trim() : null,
        status ? String(status).trim() : 'draft',
        currency ? String(currency).trim() : 'USD',
        notes ? String(notes) : null,
        totals.subtotal, totals.discount, totals.tax_rate, totals.tax, totals.total,
        req.userId,
      ],
    );
    const quote = qr.rows[0];
    await insertItems(client, quote.id, totals.lines, scopeProducts);
    await client.query('COMMIT');

    audit.fromReq(req, {
      event: audit.EVENTS.SALES_QUOTE_CREATED,
      targetType: 'sales_quote',
      targetId: quote.id,
      meta: { item_count: totals.lines.length, total: totals.total },
    });
    res.status(201).json({ ...quote, line_items: totals.lines });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Sales quote create error:', error);
    res.status(500).json({ error: 'Failed to create quote' });
  } finally {
    client.release();
  }
});

// PUT /:id — update header; when items[] is supplied, replace them and
// recompute. When items[] is omitted, recompute totals from the EXISTING
// stored lines so a discount/tax_rate change alone still stays consistent.
router.put('/:id', async (req, res) => {
  const [sf, sv] = qs(req);
  const { deal_id, customer_id, title, status, currency, notes, items, discount, tax_rate } = req.body || {};

  const existing = await pool.query(
    `SELECT * FROM sales_quotes WHERE id = $1 AND ${sf} = $2`,
    [req.params.id, sv],
  );
  if (existing.rows.length === 0) return res.status(404).json({ error: 'Quote not found' });
  const prev = existing.rows[0];

  if (deal_id !== undefined && !(await ownsRow('deals', deal_id, sf, sv))) {
    return res.status(400).json({ error: 'deal_id not found in your organization' });
  }
  if (customer_id !== undefined && !(await ownsRow('companies', customer_id, sf, sv))) {
    return res.status(400).json({ error: 'customer_id not found in your organization' });
  }

  const replacingItems = Array.isArray(items);
  let sourceItems = items;
  if (!replacingItems) {
    const cur = await pool.query(
      `SELECT product_id, name, quantity, unit_price, discount_pct FROM sales_quote_items WHERE quote_id = $1 ORDER BY position, id`,
      [req.params.id],
    );
    sourceItems = cur.rows;
  }
  const totals = salesQuotes.computeTotals({
    items: sourceItems,
    discount: discount !== undefined ? discount : prev.discount,
    tax_rate: tax_rate !== undefined ? tax_rate : prev.tax_rate,
  });
  const scopeProducts = await inScopeProducts(sourceItems, sf, sv);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const qr = await client.query(
      `UPDATE sales_quotes SET
         deal_id     = COALESCE($1, deal_id),
         customer_id = COALESCE($2, customer_id),
         title       = COALESCE($3, title),
         status      = COALESCE($4, status),
         currency    = COALESCE($5, currency),
         notes       = COALESCE($6, notes),
         subtotal    = $7,
         discount    = $8,
         tax_rate    = $9,
         tax         = $10,
         total       = $11,
         updated_at  = CURRENT_TIMESTAMP
       WHERE id = $12 AND ${sf} = $13 RETURNING *`,
      [
        deal_id ?? null, customer_id ?? null,
        title != null ? String(title).trim() : null,
        status != null ? String(status).trim() : null,
        currency != null ? String(currency).trim() : null,
        notes != null ? String(notes) : null,
        totals.subtotal, totals.discount, totals.tax_rate, totals.tax, totals.total,
        req.params.id, sv,
      ],
    );
    if (replacingItems) {
      await client.query('DELETE FROM sales_quote_items WHERE quote_id = $1', [req.params.id]);
      await insertItems(client, req.params.id, totals.lines, scopeProducts);
    }
    await client.query('COMMIT');
    res.json({ ...qr.rows[0], line_items: totals.lines });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Sales quote update error:', error);
    res.status(500).json({ error: 'Failed to update quote' });
  } finally {
    client.release();
  }
});

// GET /:id/pdf — branded PDF.
router.get('/:id/pdf', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const qr = await pool.query(
      `SELECT q.*, co.name AS customer_name, co.location AS customer_location,
              co.website AS customer_website, co.phone AS customer_phone,
              d.title AS deal_title
         FROM sales_quotes q
         LEFT JOIN companies co ON q.customer_id = co.id
         LEFT JOIN deals d ON q.deal_id = d.id
        WHERE q.id = $1 AND q.${sf} = $2`,
      [req.params.id, sv],
    );
    if (qr.rows.length === 0) return res.status(404).json({ error: 'Quote not found' });
    const items = await pool.query(
      `SELECT * FROM sales_quote_items WHERE quote_id = $1 ORDER BY position, id`,
      [req.params.id],
    );

    let orgName = null;
    if (req.orgId) {
      const orgRes = await pool.query('SELECT name FROM organizations WHERE id = $1', [req.orgId]);
      orgName = orgRes.rows[0]?.name || null;
    }

    const quote = { ...qr.rows[0], line_items: items.rows };
    const customer = quote.customer_id ? {
      name: quote.customer_name,
      location: quote.customer_location,
      website: quote.customer_website,
      phone: quote.customer_phone,
    } : null;

    const safeName = (quote.title || `quote-${quote.id}`).replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);
    audit.fromReq(req, {
      event: audit.EVENTS.SALES_QUOTE_PDF_GENERATED,
      targetType: 'sales_quote',
      targetId: quote.id,
    });
    renderSalesQuotePdf({ quote, customer, orgName }, res);
  } catch (error) {
    console.error('Sales quote PDF error:', error);
    res.status(500).json({ error: 'Failed to generate quote PDF' });
  }
});

// DELETE /:id — cascades to items via FK.
router.delete('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `DELETE FROM sales_quotes WHERE id = $1 AND ${sf} = $2 RETURNING id`,
      [req.params.id, sv],
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Quote not found' });
    res.json({ message: 'Quote deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete quote' });
  }
});

module.exports = router;
