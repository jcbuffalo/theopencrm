// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

const express = require('express');
const nodemailer = require('nodemailer');
const pool = require('../db');
const { publicFormLimiter } = require('../middleware/rateLimits');
const router = express.Router();

const TO_EMAIL = process.env.CONTACT_TO_EMAIL || 'johnbcoles@gmail.com';
const FROM_EMAIL = process.env.GMAIL_USER;
const APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

// HTML-escape untrusted values before interpolating them into the operator
// notification email. Mirrors the helper in routes/emailRoutes.js. Without this
// a public submitter could inject markup/links into the email we send ourselves.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createTransport() {
  if (!FROM_EMAIL || !APP_PASSWORD) {
    return null;
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: FROM_EMAIL, pass: APP_PASSWORD },
  });
}

// POST /api/contact — public, no auth required. Per-IP rate limited to bound
// spam/abuse of an anonymous endpoint that writes a row and can send an email.
router.post('/', publicFormLimiter, async (req, res) => {
  try {
    const raw = req.body || {};

    if (!raw.name || !raw.email || !raw.message) {
      return res.status(400).json({ success: false, error: 'Name, email, and message are required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(raw.email)) {
      return res.status(400).json({ success: false, error: 'Invalid email address' });
    }

    // Length-cap every anonymous field before it touches the DB. The endpoint
    // is unauthenticated and only volume-limited per-IP; without caps a single
    // request could store up to the 10MB JSON-body limit. Short caps for
    // identity fields, roomier for the free-text message.
    const cap = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
    const name    = cap(raw.name, 255);
    const email   = cap(raw.email, 255);
    const company = cap(raw.company, 255);
    const interest = cap(raw.interest, 255);
    const message = cap(raw.message, 5000);

    // Persist FIRST — email transport is optional in production, and this
    // endpoint also backs the public /data-deletion (GDPR/CCPA) page. A
    // request must never be acknowledged as received unless it is durably
    // stored, regardless of whether the notification email can be sent.
    let submissionId = null;
    try {
      const ins = await pool.query(
        `INSERT INTO contact_submissions (name, email, company, interest, message)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [name, email, company || null, interest || null, message]
      );
      submissionId = ins.rows[0].id;
    } catch (dbErr) {
      // If we cannot persist, do NOT tell the user it was received.
      console.error('Contact form persist error:', dbErr.message);
      return res.status(500).json({ success: false, error: 'Could not record your request. Please try again.' });
    }

    const transport = createTransport();

    if (transport) {
      const subject = interest === 'checklist'
        ? `[Open CRM] Checklist request from ${name}`
        : `[Open CRM] Contact form: ${name}`;

      // Escape every untrusted field before interpolation. `email` is escaped
      // for both the visible text and the mailto: href; `message` is escaped
      // first, then newlines become <br> on the already-safe text.
      const safeName = escapeHtml(name);
      const safeEmail = escapeHtml(email);
      const safeCompany = escapeHtml(company || '');
      const safeInterest = escapeHtml(interest || '');
      const safeMessage = escapeHtml(message).replace(/\n/g, '<br>');

      const html = `
        <h2>New message from theopencrm.com</h2>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold">Name</td><td style="padding:8px;border:1px solid #ddd">${safeName}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold">Email</td><td style="padding:8px;border:1px solid #ddd"><a href="mailto:${safeEmail}">${safeEmail}</a></td></tr>
          ${company ? `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold">Company</td><td style="padding:8px;border:1px solid #ddd">${safeCompany}</td></tr>` : ''}
          ${interest ? `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold">Interest</td><td style="padding:8px;border:1px solid #ddd">${safeInterest}</td></tr>` : ''}
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold">Message</td><td style="padding:8px;border:1px solid #ddd">${safeMessage}</td></tr>
        </table>
        <p style="color:#666;margin-top:16px">Sent from <a href="https://theopencrm.com">theopencrm.com</a></p>
      `;

      try {
        await transport.sendMail({
          from: `"The Open CRM" <${FROM_EMAIL}>`,
          to: TO_EMAIL,
          replyTo: email,
          subject,
          html,
        });
        await pool.query('UPDATE contact_submissions SET email_delivered = TRUE WHERE id = $1', [submissionId])
          .catch(() => {});
      } catch (mailErr) {
        // Persisted already — a failed notification is not a failed request.
        console.error('Contact form email error (request persisted):', mailErr.message);
      }
    }

    res.json({ success: true, message: 'Message sent! We\'ll be in touch within 24 hours.' });
  } catch (error) {
    console.error('Contact form error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to send message. Please try again.' });
  }
});

module.exports = router;
