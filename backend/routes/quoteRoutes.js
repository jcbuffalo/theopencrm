// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Customer quotes — what the customer sees before sending a PO. Each quote has
// line items and a revision history; the `current_revision` column tracks
// which is the active version.
//
// Endpoints (all auth-required, all org-scoped):
//   GET    /                  — list quotes (filters: deal_id, status)
//   GET    /:id               — fetch quote with embedded line_items + revisions
//   POST   /                  — create quote + initial revision row
//   PUT    /:id               — update quote; pass create_revision=true to bump revision_number and append a row to quote_revisions
//   GET    /:id/pdf           — stream a branded customer-quote PDF (revision-aware)
//   DELETE /:id               — hard delete (cascades to line_items + revisions)
//
// Related: vendor_quotes (per-vendor RFQ comparison) is a separate resource,
// not embedded here. See routes/vendorQuoteRoutes.js.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const { renderQuotePdf } = require('../services/pdfQuote');
const audit = require('../services/audit');
const { validateBody } = require('../middleware/validate');
const { createSchema, updateSchema } = require('../schemas/quotes');
// Plugin trigger engine (migration 164) — fire-and-forget post-commit dispatch.
const pluginEvents = require('../services/pluginEvents');

const router = express.Router();
router.use(authMiddleware);

// Returns [scopeField, scopeValue] for the current request's tenancy.
function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { deal_id, status } = req.query;
    let query = `
      SELECT q.*, co.name AS customer_name, d.title AS deal_title
      FROM quotes q
      LEFT JOIN companies co ON q.customer_id = co.id
      LEFT JOIN deals d ON q.deal_id = d.id
      WHERE q.${sf} = $1
    `;
    const params = [sv];
    if (deal_id) { query += ` AND q.deal_id = $${params.length + 1}`; params.push(deal_id); }
    if (status)  { query += ` AND q.status = $${params.length + 1}`;  params.push(status); }
    query += ' ORDER BY q.created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching quotes:', error);
    res.status(500).json({ error: 'Failed to fetch quotes' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const quote = await pool.query(
      `SELECT q.*, co.name AS customer_name, d.title AS deal_title
       FROM quotes q LEFT JOIN companies co ON q.customer_id = co.id LEFT JOIN deals d ON q.deal_id = d.id
       WHERE q.id = $1 AND q.${sf} = $2`, [req.params.id, sv]
    );
    if (quote.rows.length === 0) return res.status(404).json({ error: 'Quote not found' });

    const lineItems = await pool.query(
      `SELECT li.*, v.name AS vendor_name FROM quote_line_items li
       LEFT JOIN companies v ON li.vendor_id = v.id
       WHERE li.quote_id = $1 ORDER BY li.position, li.id`, [req.params.id]
    );
    const revisions = await pool.query(
      `SELECT * FROM quote_revisions WHERE quote_id = $1 ORDER BY revision_number DESC`, [req.params.id]
    );

    res.json({ ...quote.rows[0], line_items: lineItems.rows, revisions: revisions.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch quote' });
  }
});

router.post('/', validateBody(createSchema), async (req, res) => {
  try {
    const { deal_id, customer_id, title, status, total_amount, valid_until, notes, line_items } = req.body;

    // Multi-tenancy: a quote may only point at a deal / customer in scope.
    const [sf, sv] = qs(req);
    if (deal_id != null) {
      const own = await pool.query(`SELECT 1 FROM deals WHERE id = $1 AND ${sf} = $2`, [deal_id, sv]);
      if (own.rows.length === 0) return res.status(400).json({ error: 'deal_id not found in your organization' });
    }
    if (customer_id != null) {
      const own = await pool.query(`SELECT 1 FROM companies WHERE id = $1 AND ${sf} = $2`, [customer_id, sv]);
      if (own.rows.length === 0) return res.status(400).json({ error: 'customer_id not found in your organization' });
    }

    const result = await pool.query(
      `INSERT INTO quotes (user_id, org_id, deal_id, customer_id, title, status, total_amount, valid_until, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.userId, req.orgId || null, deal_id || null, customer_id || null, title, status || 'draft', total_amount || null, valid_until || null, notes || null]
    );
    const quote = result.rows[0];

    if (Array.isArray(line_items) && line_items.length > 0) {
      for (let i = 0; i < line_items.length; i++) {
        const li = line_items[i];
        await pool.query(
          `INSERT INTO quote_line_items (quote_id, vendor_id, description, quantity, unit_price, markup_pct, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [quote.id, li.vendor_id || null, li.description || '', li.quantity || 1, li.unit_price || null, li.markup_pct || null, i]
        );
      }
    }

    await pool.query(
      `INSERT INTO quote_revisions (quote_id, revision_number, total_amount, notes, created_by) VALUES ($1, 1, $2, $3, $4)`,
      [quote.id, total_amount || null, notes || 'Initial revision', req.userId]
    );

    // Plugin trigger (migration 164): a quote born directly in 'sent' counts
    // as sent. Deduped 'quote.sent:<id>' — fires at most once per quote.
    if (req.orgId && quote && quote.status === 'sent') {
      pluginEvents.emit(req.orgId, 'quote.sent', {
        id: quote.id,
        title: quote.title,
        status: quote.status,
        deal_id: quote.deal_id,
        customer_id: quote.customer_id,
        total_amount: quote.total_amount,
      });
    }

    res.status(201).json(quote);
  } catch (error) {
    console.error('Quote create error:', error);
    res.status(500).json({ error: 'Failed to create quote' });
  }
});

router.put('/:id', validateBody(updateSchema), async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { title, status, total_amount, valid_until, notes, customer_id, create_revision } = req.body;

    const existing = await pool.query(
      `SELECT * FROM quotes WHERE id = $1 AND ${sf} = $2`, [req.params.id, sv]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Quote not found' });

    let newRev = existing.rows[0].current_revision;
    if (create_revision) {
      newRev = (existing.rows[0].current_revision || 1) + 1;
      await pool.query(
        `INSERT INTO quote_revisions (quote_id, revision_number, total_amount, notes, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.params.id, newRev, total_amount ?? existing.rows[0].total_amount, notes || `Revision ${newRev}`, req.userId]
      );
    }

    const result = await pool.query(
      `UPDATE quotes SET title = COALESCE($1, title), status = COALESCE($2, status),
        total_amount = COALESCE($3, total_amount), valid_until = COALESCE($4, valid_until),
        notes = COALESCE($5, notes), customer_id = COALESCE($6, customer_id),
        current_revision = $7, updated_at = CURRENT_TIMESTAMP
       WHERE id = $8 AND ${sf} = $9 RETURNING *`,
      [title, status, total_amount, valid_until, notes, customer_id, newRev, req.params.id, sv]
    );
    // Plugin trigger (migration 164): fires when this PUT TRANSITIONS the
    // quote into 'sent' (not on a save that leaves it 'sent'). Deduped
    // 'quote.sent:<id>' — at most once per quote even across retries.
    if (req.orgId && status === 'sent' && existing.rows[0].status !== 'sent' && result.rows[0]) {
      pluginEvents.emit(req.orgId, 'quote.sent', {
        id: result.rows[0].id,
        title: result.rows[0].title,
        status: result.rows[0].status,
        deal_id: result.rows[0].deal_id,
        customer_id: result.rows[0].customer_id,
        total_amount: result.rows[0].total_amount,
      });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Quote update error:', error);
    res.status(500).json({ error: 'Failed to update quote' });
  }
});

router.get('/:id/pdf', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const quoteRes = await pool.query(
      `SELECT q.*, co.name AS customer_name, co.location AS customer_location, co.website AS customer_website, co.phone AS customer_phone,
              d.title AS deal_title
       FROM quotes q LEFT JOIN companies co ON q.customer_id = co.id LEFT JOIN deals d ON q.deal_id = d.id
       WHERE q.id = $1 AND q.${sf} = $2`,
      [req.params.id, sv]
    );
    if (quoteRes.rows.length === 0) return res.status(404).json({ error: 'Quote not found' });

    const itemsRes = await pool.query(
      `SELECT li.*, v.name AS vendor_name FROM quote_line_items li
       LEFT JOIN companies v ON li.vendor_id = v.id
       WHERE li.quote_id = $1 ORDER BY li.position, li.id`,
      [req.params.id]
    );

    let orgName = null;
    if (req.orgId) {
      const orgRes = await pool.query(`SELECT name FROM organizations WHERE id = $1`, [req.orgId]);
      orgName = orgRes.rows[0]?.name || null;
    }

    const quote = { ...quoteRes.rows[0], line_items: itemsRes.rows };
    const customer = quote.customer_id ? {
      name: quote.customer_name,
      location: quote.customer_location,
      website: quote.customer_website,
      phone: quote.customer_phone,
    } : null;

    const safeName = (quote.title || `quote-${quote.id}`).replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}-r${quote.current_revision || 1}.pdf"`);
    audit.fromReq(req, { event: audit.EVENTS.QUOTE_PDF_GENERATED, targetType: 'quote', targetId: quote.id, meta: { revision: quote.current_revision } });
    renderQuotePdf({ quote, customer, orgName }, res);
  } catch (error) {
    console.error('Quote PDF error:', error);
    res.status(500).json({ error: 'Failed to generate quote PDF' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(`DELETE FROM quotes WHERE id = $1 AND ${sf} = $2 RETURNING *`, [req.params.id, sv]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Quote not found' });
    res.json({ message: 'Quote deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete quote' });
  }
});

module.exports = router;
