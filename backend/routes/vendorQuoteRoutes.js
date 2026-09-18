// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Vendor quotes — per-vendor RFQ + their quote response. Powers the multi-vendor
// comparison table on the deal drawer. One vendor per row, multiple rows per
// deal. The `is_selected` flag marks the chosen vendor; setting it on one row
// auto-clears it from sibling rows (atomic via the PUT handler).
//
// Endpoints (all auth-required, all org-scoped):
//   GET    /                       — list (filters: deal_id, vendor_id, status)
//   POST   /                       — create vendor RFQ row (status defaults to 'requested')
//   PUT    /:id                    — update; setting is_selected=true clears sibling selections
//   POST   /:id/send-rfq           — email the vendor; updates rfq_sent_at; falls back to console-log if SMTP not configured
//   DELETE /:id                    — remove
//
// Status transitions: requested → received | declined. After received, an
// admin can mark is_selected=true to lock in the winner.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const email = require('../services/email');
const audit = require('../services/audit');
const { validateBody } = require('../middleware/validate');
const { createSchema, updateSchema, sendRfqSchema } = require('../schemas/vendorQuotes');

const router = express.Router();
router.use(authMiddleware);

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

function buildRfqEmail({ vendorName, vendorContactName, dealTitle, dealNotes, vertical, expectedClose, senderName, senderEmail, customMessage, replyTo }) {
  const subject = `RFQ: ${dealTitle}${vertical ? ` (${vertical})` : ''}`;
  const greeting = vendorContactName ? `Hi ${vendorContactName},` : `Hi ${vendorName} team,`;
  const lines = [];
  lines.push(`<p>${greeting}</p>`);
  lines.push(`<p>We have a new opportunity we'd like to request a quote on:</p>`);
  lines.push(`<table style="border-collapse:collapse;margin:12px 0;font-size:14px">`);
  lines.push(`<tr><td style="padding:6px 12px;border:1px solid #e5e7eb;font-weight:bold;background:#f9fafb">Project</td><td style="padding:6px 12px;border:1px solid #e5e7eb">${dealTitle || ''}</td></tr>`);
  if (vertical)        lines.push(`<tr><td style="padding:6px 12px;border:1px solid #e5e7eb;font-weight:bold;background:#f9fafb">Vertical</td><td style="padding:6px 12px;border:1px solid #e5e7eb">${vertical}</td></tr>`);
  if (expectedClose)   lines.push(`<tr><td style="padding:6px 12px;border:1px solid #e5e7eb;font-weight:bold;background:#f9fafb">Target Decision</td><td style="padding:6px 12px;border:1px solid #e5e7eb">${expectedClose}</td></tr>`);
  lines.push(`</table>`);
  if (dealNotes) {
    lines.push(`<p><strong>Scope &amp; specs:</strong></p>`);
    lines.push(`<p style="white-space:pre-wrap;background:#f9fafb;padding:12px;border-left:3px solid #1d4ed8;font-size:13px">${dealNotes.replace(/</g, '&lt;')}</p>`);
  }
  if (customMessage) {
    lines.push(`<p style="white-space:pre-wrap">${customMessage.replace(/</g, '&lt;')}</p>`);
  }
  lines.push(`<p>Please reply with pricing, lead time, and any clarifying questions. Reply directly to this email and your response will route back to me.</p>`);
  lines.push(`<p>Thank you,<br>${senderName || senderEmail}<br><a href="mailto:${senderEmail}">${senderEmail}</a></p>`);
  lines.push(`<hr style="border:none;border-top:1px solid #e5e7eb;margin-top:20px"><p style="color:#6b7280;font-size:11px">Sent via ZANG Flow</p>`);
  return { subject, html: lines.join('\n') };
}

router.post('/:id/send-rfq', validateBody(sendRfqSchema), async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { recipient_email, recipient_name, custom_message } = req.body;

    const rows = await pool.query(
      `SELECT vq.*, v.name AS vendor_name, d.title AS deal_title, d.notes AS deal_notes,
              d.vertical, d.expected_close_date, u.email AS sender_email, u.name AS sender_name
       FROM vendor_quotes vq
       JOIN deals d ON vq.deal_id = d.id
       JOIN companies v ON vq.vendor_id = v.id
       LEFT JOIN users u ON u.id = vq.user_id
       WHERE vq.id = $1 AND vq.${sf} = $2`,
      [req.params.id, sv]
    );
    if (rows.rows.length === 0) return res.status(404).json({ error: 'Vendor quote not found' });
    const vq = rows.rows[0];

    const senderEmailRow = await pool.query(`SELECT email, name FROM users WHERE id = $1`, [req.userId]);
    const sender = senderEmailRow.rows[0] || {};

    const { subject, html } = buildRfqEmail({
      vendorName: vq.vendor_name,
      vendorContactName: recipient_name,
      dealTitle: vq.deal_title,
      dealNotes: vq.deal_notes,
      vertical: vq.vertical,
      expectedClose: vq.expected_close_date ? new Date(vq.expected_close_date).toLocaleDateString() : null,
      senderName: sender.name || sender.email,
      senderEmail: sender.email,
      customMessage: custom_message,
    });

    let orgName = null;
    if (req.orgId) {
      const orgRes = await pool.query(`SELECT name FROM organizations WHERE id = $1`, [req.orgId]);
      orgName = orgRes.rows[0]?.name || null;
    }

    const result = await email.sendMail({
      to: recipient_email,
      replyTo: sender.email || undefined,
      subject,
      html,
      fromName: orgName,
    });

    await pool.query(
      `UPDATE vendor_quotes SET rfq_sent_at = CURRENT_TIMESTAMP, status = CASE WHEN status = 'requested' THEN 'requested' ELSE status END, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [vq.id]
    );

    audit.fromReq(req, {
      event: audit.EVENTS.RFQ_SENT,
      targetType: 'vendor_quote',
      targetId: vq.id,
      meta: {
        vendorId: vq.vendor_id,
        dealId: vq.deal_id,
        recipient: recipient_email,
        transport: result.kind,
      },
    });

    res.json({
      ok: true,
      transport: result.kind,
      configured: email.isConfigured(),
      message: email.isConfigured()
        ? `RFQ email sent to ${recipient_email}`
        : `Email not configured — RFQ marked as sent for tracking, but no message was actually delivered. Set GMAIL_USER + GMAIL_APP_PASSWORD or SENDGRID_API_KEY to enable real send.`,
    });
  } catch (error) {
    console.error('Send RFQ error:', error);
    res.status(500).json({ error: error.message || 'Failed to send RFQ' });
  }
});

router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { deal_id, vendor_id, status } = req.query;
    let query = `
      SELECT vq.*, v.name AS vendor_name, d.title AS deal_title
      FROM vendor_quotes vq
      LEFT JOIN companies v ON vq.vendor_id = v.id
      LEFT JOIN deals d ON vq.deal_id = d.id
      WHERE vq.${sf} = $1
    `;
    const params = [sv];
    if (deal_id)   { query += ` AND vq.deal_id = $${params.length + 1}`;   params.push(deal_id); }
    if (vendor_id) { query += ` AND vq.vendor_id = $${params.length + 1}`; params.push(vendor_id); }
    if (status)    { query += ` AND vq.status = $${params.length + 1}`;    params.push(status); }
    query += ' ORDER BY vq.amount NULLS LAST, vq.created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Vendor quote fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch vendor quotes' });
  }
});

router.post('/', validateBody(createSchema), async (req, res) => {
  try {
    const { deal_id, vendor_id, status, rfq_sent_at, quote_received_at, amount, lead_time_days, notes } = req.body;

    // Multi-tenancy: the parent deal and the vendor company must both live in
    // the caller's scope, otherwise a member could attach a vendor quote to
    // another org's deal (or leak another org's vendor).
    const [sf, sv] = qs(req);
    const dealOwn = await pool.query(`SELECT 1 FROM deals WHERE id = $1 AND ${sf} = $2`, [deal_id, sv]);
    if (dealOwn.rows.length === 0) return res.status(400).json({ error: 'deal_id not found in your organization' });
    const vendorOwn = await pool.query(`SELECT 1 FROM companies WHERE id = $1 AND ${sf} = $2`, [vendor_id, sv]);
    if (vendorOwn.rows.length === 0) return res.status(400).json({ error: 'vendor_id not found in your organization' });

    const result = await pool.query(
      `INSERT INTO vendor_quotes (user_id, org_id, deal_id, vendor_id, status, rfq_sent_at, quote_received_at, amount, lead_time_days, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [req.userId, req.orgId || null, deal_id, vendor_id, status || 'requested', rfq_sent_at || null, quote_received_at || null, amount || null, lead_time_days || null, notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Vendor quote create error:', error);
    res.status(500).json({ error: 'Failed to create vendor quote' });
  }
});

router.put('/:id', validateBody(updateSchema), async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { status, rfq_sent_at, quote_received_at, amount, lead_time_days, is_selected, notes } = req.body;

    if (is_selected) {
      const existing = await pool.query(`SELECT deal_id FROM vendor_quotes WHERE id = $1 AND ${sf} = $2`, [req.params.id, sv]);
      if (existing.rows.length > 0) {
        await pool.query(`UPDATE vendor_quotes SET is_selected = FALSE WHERE deal_id = $1 AND id != $2 AND ${sf} = $3`, [existing.rows[0].deal_id, req.params.id, sv]);
      }
    }

    const result = await pool.query(
      `UPDATE vendor_quotes SET status = COALESCE($1, status), rfq_sent_at = COALESCE($2, rfq_sent_at),
        quote_received_at = COALESCE($3, quote_received_at), amount = COALESCE($4, amount),
        lead_time_days = COALESCE($5, lead_time_days), is_selected = COALESCE($6, is_selected),
        notes = COALESCE($7, notes), updated_at = CURRENT_TIMESTAMP
       WHERE id = $8 AND ${sf} = $9 RETURNING *`,
      [status, rfq_sent_at, quote_received_at, amount, lead_time_days, is_selected, notes, req.params.id, sv]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Vendor quote not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update vendor quote' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(`DELETE FROM vendor_quotes WHERE id = $1 AND ${sf} = $2 RETURNING *`, [req.params.id, sv]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Vendor quote not found' });
    res.json({ message: 'Vendor quote deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete vendor quote' });
  }
});

module.exports = router;
