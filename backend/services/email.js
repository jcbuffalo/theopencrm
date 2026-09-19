// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Centralised email sender. Supports Gmail (app password) and SendGrid (API key).
// Falls back to console-logging when neither is configured so dev/preview environments still work.

const nodemailer = require('nodemailer');
const logger = require('./logger');

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SMTP_FROM = process.env.SMTP_FROM || GMAIL_USER || 'noreply@theopencrm.com';

let cachedTransport = null;
let cachedKind = null;
let gmailLimitsWarned = false;

function getTransport() {
  if (cachedTransport) return { transport: cachedTransport, kind: cachedKind };

  if (SENDGRID_API_KEY) {
    cachedTransport = nodemailer.createTransport({
      host: 'smtp.sendgrid.net',
      port: 587,
      secure: false,
      auth: { user: 'apikey', pass: SENDGRID_API_KEY },
    });
    cachedKind = 'sendgrid';
  } else if (GMAIL_USER && GMAIL_APP_PASSWORD) {
    cachedTransport = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
    cachedKind = 'gmail';
    // Once per process: Gmail app-password SMTP is a getting-started
    // transport, not a production one. ~500 sends/day account cap, weaker
    // deliverability for customer-facing volume (no domain-level SPF/DKIM
    // alignment on your own domain), and Google can suspend accounts that
    // look like bulk senders. The sequence worker also enforces a daily
    // soft-cap (see services/sequenceWorker.js GMAIL_DAILY_SEND_CAP).
    if (!gmailLimitsWarned) {
      gmailLimitsWarned = true;
      logger.warn('email_transport_gmail_limits', {
        transport: 'gmail',
        note: 'Gmail SMTP has ~500 sends/day, weaker deliverability, and account-suspension risk at volume. Recommend SendGrid (SENDGRID_API_KEY) with a verified domain sender for customer-facing email.',
      });
    }
  } else {
    cachedTransport = null;
    cachedKind = 'console';
  }
  return { transport: cachedTransport, kind: cachedKind };
}

function isConfigured() {
  const { kind } = getTransport();
  return kind !== 'console';
}

// Which transport is active: 'sendgrid' | 'gmail' | 'console'. Surfaced to
// operators on /api/admin/platform-integrations (the Gmail-limits warning
// card) and consulted by the sequence worker's Gmail daily-cap guard.
function transportKind() {
  return getTransport().kind;
}

// Neutral, current product name — the previous "ZANG Flow" literal leaked one
// white-label tenant's brand into every org's outbound mail (and is a stale
// product name). An org display name, when passed, still fronts the sender.
const PRODUCT_NAME = process.env.PRODUCT_NAME || 'The Open CRM';
// `verbatim` = an org-chosen sender identity (services/senderIdentity.js):
// the name goes on the From: line as-is ("John Coles") instead of the
// "<Org> via <Product>" default used for platform/transactional mail. The
// envelope ADDRESS is always SMTP_FROM either way.
function senderName(orgName, verbatim = false) {
  const clean = orgName ? String(orgName).replace(/["\r\n<>]/g, '').trim() : '';
  if (clean && verbatim) return `"${clean}"`;
  return clean ? `"${clean} via ${PRODUCT_NAME}"` : `"${PRODUCT_NAME}"`;
}

// The From: header string a send would use — surfaced to Settings → Workspace
// so an owner can preview exactly how their mail will show up.
function fromHeader({ fromName, verbatim = false } = {}) {
  return `${senderName(fromName, verbatim)} <${SMTP_FROM}>`;
}

/**
 * Send an email. Returns { ok: true, kind } on success or when console-logged in dev.
 * Throws on real send failure.
 *
 *   fromNameVerbatim — use `fromName` as the whole display name (org sender identity)
 *   listUnsubscribe  — URL for the RFC 2369 List-Unsubscribe header (bulk /
 *                      sequence mail; lets Gmail/Outlook render their own
 *                      one-click unsubscribe next to the footer link)
 */
async function sendMail({ to, replyTo, subject, html, text, attachments, fromName, fromNameVerbatim = false, listUnsubscribe }) {
  if (!to) throw new Error('sendMail: `to` required');
  const { transport, kind } = getTransport();

  if (!transport) {
    console.log('📧 (email not configured — would have sent):', {
      to, subject, replyTo, from: fromHeader({ fromName, verbatim: fromNameVerbatim }),
      preview: (text || html || '').substring(0, 200),
    });
    return { ok: true, kind: 'console' };
  }

  const headers = listUnsubscribe ? { 'List-Unsubscribe': `<${listUnsubscribe}>` } : undefined;
  const info = await transport.sendMail({
    from: fromHeader({ fromName, verbatim: fromNameVerbatim }),
    to,
    replyTo: replyTo || undefined,
    subject,
    html,
    text,
    attachments,
    headers,
  });

  return { ok: true, kind, messageId: info.messageId };
}

module.exports = {
  isConfigured,
  transportKind,
  sendMail,
  fromHeader,
  SMTP_FROM,
};
