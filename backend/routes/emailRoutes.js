// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Email-send-from-CRM (COMPETITIVE_REVIEW.md parity gap #1).
//
// Scope discipline: one-off sends only. No drip campaigns, no A/B testing,
// no click tracking, no rich-text composer. The schema lives in migration
// 067; routes here are mounted at /api/emails from index.js.
//
// Endpoints
//   POST   /send                        — compose + send (auth)
//   GET    /templates                   — list org templates (auth)
//   POST   /templates                   — create (auth)
//   PUT    /templates/:id               — update (auth)
//   DELETE /templates/:id               — delete (auth)
//   GET    /sends?contact_id=|deal_id=  — list sends for a record (auth)
//   GET    /track/:id.gif               — 1×1 open-pixel (PUBLIC, no auth)
//   GET    /unsubscribe/:token          — one-click unsubscribe (PUBLIC, no auth)
//
// Tracking: only the open-pixel is supported. The /track route always returns
// a transparent GIF (even on miss) so an invalid id never leaks tracking
// state to a recipient. /unsubscribe inserts a row keyed on (org, email)
// which /send checks before transmitting (returns 409 if recipient is
// unsubscribed).
//
// Graceful fallback: when the underlying email service (services/email.js)
// is not configured, /send still records the row with provider_message_id =
// NULL and returns success. Mirrors the pattern in services/adminNotify.js
// and the SMS service.

const express = require('express');
const crypto = require('crypto');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const email = require('../services/email');
const audit = require('../services/audit');
const { validateBody } = require('../middleware/validate');
const {
  createTemplateSchema,
  updateTemplateSchema,
  previewSchema,
  sendSchema,
} = require('../schemas/emails');

const router = express.Router();

// Returns [scopeField, scopeValue] for the current request's tenancy.
// Falls back to user_id when the user doesn't belong to an org.
function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// EMAIL_SENT isn't in services/audit.js EVENTS yet — fall back to a string
// literal that matches the existing event-naming convention (lowercase,
// dot-separated). Future cleanup: promote to EVENTS in services/audit.js.
const EMAIL_SENT_EVENT = audit.EVENTS.EMAIL_SENT || 'email.sent';

// 1×1 transparent GIF — embedded in HTML wrapper for open tracking.
const TRACKING_PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

// --------------------------------------------------------------------------
// PUBLIC endpoint helpers (the public-by-design routes register BEFORE
// authMiddleware kicks in for the rest of the router).
// --------------------------------------------------------------------------

// Open-pixel. Idempotent (only stamps opened_at when currently NULL). Never
// errors externally — invalid id quietly returns the pixel so we don't leak
// "this id wasn't real" to a recipient or scraper.
router.get('/track/:id.gif', async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isFinite(id) && id > 0) {
    try {
      await pool.query(
        `UPDATE email_sends SET opened_at = NOW()
          WHERE id = $1 AND opened_at IS NULL`,
        [id]
      );
    } catch (err) {
      // Swallow — pixel must always return 200 with the GIF.
      if (req.log) req.log.warn('email_open_track_failed', { id, error: err.message });
    }
  }
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  return res.status(200).end(TRACKING_PIXEL);
});

// One-click unsubscribe. Looks up the token (issued at send time with
// unsubscribed_at = NULL), stamps unsubscribed_at = NOW(). Idempotent — a
// second click is a no-op because the COALESCE keeps the original timestamp.
// We never reveal whether the token was real, so an invalid link returns
// the same confirmation page as a valid one.
router.get('/unsubscribe/:token', async (req, res) => {
  const token = String(req.params.token || '').trim();
  let confirmedEmail = null;

  if (token.length > 0 && token.length <= 64) {
    try {
      const r = await pool.query(
        `UPDATE email_unsubscribes
            SET unsubscribed_at = COALESCE(unsubscribed_at, NOW())
          WHERE token = $1
        RETURNING email`,
        [token]
      );
      if (r.rows.length > 0) confirmedEmail = r.rows[0].email;
    } catch (err) {
      if (req.log) req.log.warn('email_unsubscribe_failed', { token, error: err.message });
    }
  }

  // Always return a friendly page — never leak whether the token was real.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(`<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Unsubscribed</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; margin: 0; padding: 48px 24px; background: #f9fafb; color: #111827; }
  .card { max-width: 480px; margin: 0 auto; background: #fff; padding: 32px; border-radius: 12px; border: 1px solid #e5e7eb; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { font-size: 14px; line-height: 1.5; color: #4b5563; }
</style>
</head><body><div class="card">
  <h1>You've been unsubscribed.</h1>
  <p>You will no longer receive emails sent from this CRM. ${confirmedEmail ? `Address: <code>${escapeHtml(confirmedEmail)}</code>.` : ''}</p>
  <p style="margin-top:16px;color:#9ca3af;font-size:12px;">If this was a mistake, contact the sender directly to be re-added.</p>
</div></body></html>`);
});

// --------------------------------------------------------------------------
// Everything below requires auth. Apply after the public routes so /track
// and /unsubscribe stay reachable without a JWT.
// --------------------------------------------------------------------------

router.use(authMiddleware);

// ============================================================================
// TEMPLATES
// ============================================================================

router.get('/templates', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    // Two modes: default (alphabetical, all templates) and recently_used
    // (last_used_at DESC NULLS LAST, capped at 5). The composer's picker
    // calls both — "Recently used" section above a divider, then "All".
    const wantsRecent = String(req.query.recently_used || '').toLowerCase() === 'true';
    if (wantsRecent) {
      const r = await pool.query(
        `SELECT id, name, subject, body, created_by, created_at, updated_at, last_used_at
           FROM email_templates
          WHERE ${sf} IS NOT DISTINCT FROM $1
            AND last_used_at IS NOT NULL
          ORDER BY last_used_at DESC NULLS LAST
          LIMIT 5`,
        [sv]
      );
      return res.json(r.rows);
    }
    const r = await pool.query(
      `SELECT id, name, subject, body, created_by, created_at, updated_at, last_used_at
         FROM email_templates
        WHERE ${sf} IS NOT DISTINCT FROM $1
        ORDER BY name ASC`,
      [sv]
    );
    res.json(r.rows);
  } catch (err) {
    if (req.log) req.log.error('email_templates_list_failed', { error: err });
    res.status(500).json({ error: 'Failed to list templates' });
  }
});

router.post('/templates', validateBody(createTemplateSchema), async (req, res) => {
  try {
    const { name, subject, body } = req.body;
    const r = await pool.query(
      `INSERT INTO email_templates (org_id, name, subject, body, created_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [req.orgId || null, name, subject, body, req.userId]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (req.log) req.log.error('email_template_create_failed', { error: err });
    res.status(500).json({ error: 'Failed to create template' });
  }
});

router.put('/templates/:id', validateBody(updateTemplateSchema), async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { name, subject, body } = req.body;
    const r = await pool.query(
      `UPDATE email_templates SET
         name    = COALESCE($1, name),
         subject = COALESCE($2, subject),
         body    = COALESCE($3, body),
         updated_at = NOW()
       WHERE id = $4 AND ${sf} IS NOT DISTINCT FROM $5
       RETURNING *`,
      [name, subject, body, req.params.id, sv]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Template not found' });
    res.json(r.rows[0]);
  } catch (err) {
    if (req.log) req.log.error('email_template_update_failed', { error: err });
    res.status(500).json({ error: 'Failed to update template' });
  }
});

router.delete('/templates/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `DELETE FROM email_templates WHERE id = $1 AND ${sf} IS NOT DISTINCT FROM $2 RETURNING id`,
      [req.params.id, sv]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Template not found' });
    res.json({ ok: true, id: r.rows[0].id });
  } catch (err) {
    if (req.log) req.log.error('email_template_delete_failed', { error: err });
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

// Preview / dry-run render. Resolves merge fields and returns the rendered
// subject + HTML + plain text WITHOUT writing an email_sends row and
// WITHOUT firing the transport. Two ways to target merge resolution:
//   - default: against the current user (notification_email || users.email)
//     as a "what would this look like in MY inbox" preview
//   - body { to_email }: against an arbitrary recipient (still no send)
// Note that {{contact.name}} / {{deal.title}} only resolve when the caller
// passes contact_id / deal_id explicitly, just like the real send. The
// "preview against myself" path is mostly useful for verifying subject
// formatting and the markdown→HTML wrapper, not the merge content.
router.post('/templates/:id/preview', validateBody(previewSchema), async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const tplRes = await pool.query(
      `SELECT id, subject, body FROM email_templates
        WHERE id = $1 AND ${sf} IS NOT DISTINCT FROM $2`,
      [req.params.id, sv]
    );
    if (tplRes.rows.length === 0) return res.status(404).json({ error: 'Template not found' });
    const tpl = tplRes.rows[0];

    const { to_email, to_contact_id, to_deal_id } = req.body;

    // Resolve the "preview target" email — only used in the audit log; the
    // merge resolution itself uses contact_id / deal_id when supplied.
    // Fallback chain: explicit body.to_email > user.notification_email >
    // user.email. The "send to myself" UI hits POST /send, not /preview;
    // /preview never actually delivers.
    let previewTarget = (typeof to_email === 'string' && to_email.trim()) || null;
    if (!previewTarget) {
      try {
        const u = await pool.query(
          `SELECT email, notification_email FROM users WHERE id = $1`,
          [req.userId]
        );
        previewTarget = u.rows[0]?.notification_email || u.rows[0]?.email || null;
      } catch { /* non-fatal */ }
    }

    const resolvedSubject = await resolveMergeFields(tpl.subject, {
      contactId: to_contact_id, dealId: to_deal_id,
      orgId: req.orgId, userId: req.userId,
    });
    const resolvedBody = await resolveMergeFields(tpl.body, {
      contactId: to_contact_id, dealId: to_deal_id,
      orgId: req.orgId, userId: req.userId,
    });

    // Audit (best-effort).
    try {
      await audit.fromReq(req, {
        event: audit.EVENTS.EMAIL_TEMPLATE_PREVIEW,
        targetType: 'email_template',
        targetId: tpl.id,
        meta: { to_email: previewTarget, to_contact_id: to_contact_id || null, to_deal_id: to_deal_id || null },
      });
    } catch { /* non-fatal */ }

    return res.json({
      subject:   resolvedSubject,
      body_html: plainToHtml(resolvedBody),
      body_text: resolvedBody,
    });
  } catch (err) {
    if (req.log) req.log.error('email_template_preview_failed', { error: err });
    res.status(500).json({ error: 'Failed to preview template' });
  }
});

// ============================================================================
// SENDS (timeline)
// ============================================================================

router.get('/sends', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { contact_id, deal_id } = req.query;
    if (!contact_id && !deal_id) {
      return res.status(400).json({ error: 'contact_id or deal_id required' });
    }
    let query = `
      SELECT id, sent_by, to_contact_id, to_deal_id, to_email, subject,
             template_id, opened_at, sent_at, provider_message_id
        FROM email_sends
       WHERE ${sf} IS NOT DISTINCT FROM $1
    `;
    const params = [sv];
    if (contact_id) { query += ` AND to_contact_id = $${params.length + 1}`; params.push(contact_id); }
    if (deal_id)    { query += ` AND to_deal_id    = $${params.length + 1}`; params.push(deal_id); }
    query += ' ORDER BY sent_at DESC LIMIT 100';
    const r = await pool.query(query, params);
    res.json(r.rows);
  } catch (err) {
    if (req.log) req.log.error('email_sends_list_failed', { error: err });
    res.status(500).json({ error: 'Failed to list sends' });
  }
});

// ============================================================================
// SEND
// ============================================================================

// Merge-field resolver. Two fields supported by design:
//   {{contact.name}} — resolved from to_contact_id
//   {{deal.title}}   — resolved from to_deal_id
// Unresolved tokens are left as literals (spec: don't drop the email).
async function resolveMergeFields(text, { contactId, dealId, orgId, userId }) {
  if (typeof text !== 'string' || text.indexOf('{{') === -1) return text;
  const replacements = {};
  const sf = orgId ? 'org_id' : 'user_id';
  const sv = orgId || userId;

  if (text.includes('{{contact.name}}') && contactId) {
    try {
      const r = await pool.query(
        `SELECT first_name, last_name FROM contacts WHERE id = $1 AND ${sf} IS NOT DISTINCT FROM $2`,
        [contactId, sv]
      );
      if (r.rows.length > 0) {
        const c = r.rows[0];
        const name = `${c.first_name || ''} ${c.last_name || ''}`.trim();
        if (name) replacements['{{contact.name}}'] = name;
      }
    } catch { /* leave literal */ }
  }

  if (text.includes('{{deal.title}}') && dealId) {
    try {
      const r = await pool.query(
        `SELECT title FROM deals WHERE id = $1 AND ${sf} IS NOT DISTINCT FROM $2`,
        [dealId, sv]
      );
      if (r.rows.length > 0 && r.rows[0].title) {
        replacements['{{deal.title}}'] = r.rows[0].title;
      }
    } catch { /* leave literal */ }
  }

  let out = text;
  for (const [k, v] of Object.entries(replacements)) {
    out = out.split(k).join(v);
  }
  return out;
}

// Minimum-viable markdown→HTML wrapper. We DON'T pull a library — five cases
// is enough for "well, but not bloated". Anything not matched falls through
// as text wrapped in <p>/<br> for whitespace preservation. Escape HTML first
// so the recipient can't be smuggled markup via subject/body.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function plainToHtml(body) {
  const escaped = escapeHtml(body);
  // **bold**, *italic*, `code` — applied to escaped text, so markup is safe.
  let html = escaped
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // newlines → <br>; keep blank lines visible as paragraph spacing.
  html = html.replace(/\r\n/g, '\n').replace(/\n/g, '<br>\n');
  return html;
}

// Best-effort backend URL for the unsubscribe + tracking-pixel links.
// FRONTEND_URL is the existing canonical env var (see backend/index.js, used
// also in orgRoutes.js for accept-invite URLs). We don't have a dedicated
// BACKEND_URL so we accept either env var — fall through to the production
// Cloud Run URL embedded in CLAUDE.md as a last-resort default.
function publicApiBase() {
  return (
    process.env.PUBLIC_BACKEND_URL
    || process.env.BACKEND_URL
    || 'https://app.theopencrm.com'
  ).replace(/\/$/, '');
}

router.post('/send', validateBody(sendSchema), async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      to_email, to_contact_id, to_deal_id,
      subject, body, template_id,
    } = req.body;
    // zod has already enforced: to_email/subject/body present + non-empty,
    // to_email matches the EMAIL_RX and is ≤254 chars. Defense-in-depth
    // (unsubscribe gate, merge-field resolution) still runs below.

    // Unsubscribe gate — refuse with 409 (spec). Org-scoped so opting out of
    // one tenant doesn't suppress legitimate mail from a different tenant.
    // We only count CONFIRMED opt-outs (unsubscribed_at NOT NULL); pending
    // token rows that haven't been clicked don't suppress.
    const unsubRes = await client.query(
      `SELECT 1 FROM email_unsubscribes
        WHERE org_id IS NOT DISTINCT FROM $1
          AND LOWER(email) = LOWER($2)
          AND unsubscribed_at IS NOT NULL
        LIMIT 1`,
      [req.orgId || null, to_email]
    );
    if (unsubRes.rows.length > 0) {
      return res.status(409).json({
        error: 'Recipient has unsubscribed from your messages',
        code: 'UNSUBSCRIBED',
      });
    }

    // Resolve merge fields in BOTH subject and body. Unresolved literals
    // pass through (spec).
    const resolvedSubject = await resolveMergeFields(subject, {
      contactId: to_contact_id, dealId: to_deal_id,
      orgId: req.orgId, userId: req.userId,
    });
    const resolvedBody = await resolveMergeFields(body, {
      contactId: to_contact_id, dealId: to_deal_id,
      orgId: req.orgId, userId: req.userId,
    });

    // Insert the send row up-front so we have an id for the tracking pixel.
    // provider_message_id stays NULL until the transport returns. This also
    // ensures DB failures fail the whole request — never half-sent state.
    await client.query('BEGIN');

    const insertRes = await client.query(
      `INSERT INTO email_sends
         (org_id, sent_by, to_contact_id, to_deal_id, to_email, subject, body, template_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        req.orgId || null,
        req.userId,
        to_contact_id || null,
        to_deal_id || null,
        to_email,
        resolvedSubject,
        resolvedBody,
        template_id || null,
      ]
    );
    const sendId = insertRes.rows[0].id;

    // Generate unsubscribe token + persist alongside the recipient address.
    // This row is the source of truth the /unsubscribe handler reads to
    // confirm the opt-out.
    // Issue an unsubscribe token paired with this send. unsubscribed_at
    // stays NULL until/unless the recipient clicks the footer link — the
    // gate above (LOWER(email) AND unsubscribed_at NOT NULL) is what
    // actually suppresses future sends.
    const unsubToken = crypto.randomBytes(24).toString('hex'); // 48 chars
    await client.query(
      `INSERT INTO email_unsubscribes (org_id, email, contact_id, token)
       VALUES ($1, $2, $3, $4)`,
      [req.orgId || null, to_email, to_contact_id || null, unsubToken]
    );

    await client.query('COMMIT');

    // Stamp the template's last_used_at so the composer's "Recently used"
    // section ranks it correctly. Done OUTSIDE the transaction (and tolerated
    // to fail) so a stale template_id, mismatched org, or schema drift can't
    // roll back a real send. Spec: record use even if transport is fallback.
    if (template_id) {
      try {
        await pool.query(
          `UPDATE email_templates
              SET last_used_at = NOW()
            WHERE id = $1 AND org_id IS NOT DISTINCT FROM $2`,
          [template_id, req.orgId || null]
        );
      } catch (err) {
        if (req.log) req.log.warn('email_template_last_used_stamp_failed', { template_id, error: err.message });
      }
    }

    // Build the HTML wrapper. Plain text body is preserved for clients that
    // ignore HTML. Unsubscribe footer + tracking pixel get appended to the
    // HTML version only.
    const apiBase = publicApiBase();
    const unsubUrl = `${apiBase}/api/emails/unsubscribe/${unsubToken}`;
    const pixelUrl = `${apiBase}/api/emails/track/${sendId}.gif`;

    const htmlBody = `${plainToHtml(resolvedBody)}
<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px;">
<p style="font-size:11px;color:#9ca3af;">
  <a href="${unsubUrl}" style="color:#9ca3af;">Unsubscribe</a> from these messages.
</p>
<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none;">`;

    // Look up sender info for the From: header.
    let senderRow = {};
    try {
      const r = await pool.query(`SELECT email, name FROM users WHERE id = $1`, [req.userId]);
      senderRow = r.rows[0] || {};
    } catch { /* non-fatal */ }

    let orgName = null;
    if (req.orgId) {
      try {
        const r = await pool.query(`SELECT name FROM organizations WHERE id = $1`, [req.orgId]);
        orgName = r.rows[0]?.name || null;
      } catch { /* non-fatal */ }
    }

    // Send. The email service handles its own graceful fallback to console
    // when neither SMTP nor SendGrid is configured — we get { ok, kind, messageId }
    // back either way and update provider_message_id accordingly. Failure
    // here is logged but does NOT roll back the row — the spec wants a
    // record either way (matches adminNotify + SMS pattern).
    let providerMessageId = null;
    let transportKind = 'console';
    try {
      const result = await email.sendMail({
        to: to_email,
        replyTo: senderRow.email || undefined,
        subject: resolvedSubject,
        html: htmlBody,
        text: resolvedBody,
        fromName: orgName,
      });
      transportKind = result.kind;
      providerMessageId = result.messageId || null;
      if (providerMessageId) {
        await pool.query(
          `UPDATE email_sends SET provider_message_id = $1 WHERE id = $2`,
          [providerMessageId, sendId]
        );
      }
    } catch (sendErr) {
      // Transport failed (e.g. SendGrid 401). Per spec, don't fail the
      // request — record the row and log. This matches services/adminNotify.js.
      if (req.log) req.log.warn('email_send_transport_failed', { sendId, error: sendErr.message });
      else console.warn('Email transport failed (recorded anyway):', sendErr.message);
    }

    // Audit (best-effort — never blocks).
    try {
      await audit.fromReq(req, {
        event: EMAIL_SENT_EVENT,
        targetType: 'email_send',
        targetId: sendId,
        meta: {
          to_email,
          to_contact_id: to_contact_id || null,
          to_deal_id: to_deal_id || null,
          template_id: template_id || null,
          transport: transportKind,
          configured: email.isConfigured(),
        },
      });
    } catch { /* audit failures are non-fatal */ }

    return res.json({
      success: true,
      send_id: sendId,
      transport: transportKind,
      configured: email.isConfigured(),
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* */ }
    if (req.log) req.log.error('email_send_failed', { error: err });
    else console.error('Email send failed:', err);
    res.status(500).json({ error: 'Failed to send email' });
  } finally {
    client.release();
  }
});

module.exports = router;
