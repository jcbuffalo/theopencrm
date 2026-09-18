// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Outbound webhook management — /api/webhooks-out.
//
// Session-authenticated + org-admin-gated CRUD for the outbound webhook
// endpoints defined in migration 109. Distinct path from the INBOUND
// /api/webhooks (Teams/Zoom/generic receivers) so the two never collide.
//
// Endpoints:
//   GET    /api/webhooks-out              — list this org's webhooks
//   POST   /api/webhooks-out              — register a webhook (secret generated
//                                           server-side, returned once)
//   DELETE /api/webhooks-out/:id          — remove a webhook
//   POST   /api/webhooks-out/:id/test     — fire a synthetic `ping` event now
//   GET    /api/webhooks-out/:id/deliveries — recent delivery attempts
//
// Org-scoped via qs(req); org-admin-gated. The signing secret is returned in
// full on create (so the customer can configure their receiver) and thereafter
// only ever as a masked hint.

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require('../db');
const { authMiddleware } = require('../auth');
const audit = require('../services/audit');
const webhookDispatcher = require('../services/webhookDispatcher');
const secretCrypto = require('../services/driveTokens');

router.use(authMiddleware);

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['created_by', req.userId]; }

function requireOrgAdmin(req, res, next) {
  if (!req.orgId) return next(); // personal workspace: sole user is admin
  if (req.orgRole !== 'owner' && req.orgRole !== 'admin') {
    return res.status(403).json({ success: false, error: 'Org owner or admin role required to manage webhooks' });
  }
  next();
}

// The domain events a customer can subscribe to today. Kept as an allowlist so
// a typo in the UI doesn't silently register a hook that never fires. `ping` is
// the synthetic event the test-fire endpoint emits.
const KNOWN_EVENTS = ['deal.created', 'deal.stage_changed', 'ping'];

// Show only a short, non-reversible hint of the secret in list responses.
function maskSecret(secret) {
  if (!secret) return null;
  return `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}

// Resolve a row's plaintext signing secret for masking. Post-migration-114 rows
// store it AES-256-GCM encrypted (secret_ct/iv/tag); legacy rows keep it in the
// plaintext `secret` column. Decryption is best-effort here — if the key is
// missing or a ciphertext is bad we just omit the hint rather than 500 the list.
function secretHint(row) {
  try {
    return maskSecret(webhookDispatcher.decryptSecret(row));
  } catch {
    return null;
  }
}

function isHttpsUrl(url) {
  try {
    const u = new URL(url);
    // Require https in production; allow http only for localhost testing.
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

// GET /api/webhooks-out — list (secret masked).
router.get('/', requireOrgAdmin, async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `SELECT id, url, events, active, created_by, created_at, secret, secret_ct, secret_iv, secret_tag
         FROM outbound_webhooks
        WHERE ${sf} IS NOT DISTINCT FROM $1
        ORDER BY created_at DESC`,
      [sv]
    );
    const webhooks = r.rows.map((w) => ({
      id: w.id,
      url: w.url,
      events: w.events,
      active: w.active,
      created_by: w.created_by,
      created_at: w.created_at,
      secret_hint: secretHint(w),
    }));
    res.json({ success: true, webhooks });
  } catch (err) {
    if (req.log) req.log.error('webhooks_out_list_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to list webhooks' });
  }
});

// POST /api/webhooks-out — register. Generates the signing secret server-side.
router.post('/', requireOrgAdmin, async (req, res) => {
  try {
    const url = (req.body?.url || '').toString().trim();
    if (!url) return res.status(400).json({ success: false, error: 'A url is required' });
    if (!isHttpsUrl(url)) return res.status(400).json({ success: false, error: 'url must be an https:// URL (http allowed only for localhost)' });

    let events = Array.isArray(req.body?.events) ? req.body.events : [];
    events = [...new Set(events.map((e) => String(e)))];
    if (events.length === 0) return res.status(400).json({ success: false, error: 'Subscribe to at least one event' });
    const bad = events.filter((e) => !KNOWN_EVENTS.includes(e));
    if (bad.length) return res.status(400).json({ success: false, error: `Unknown event(s): ${bad.join(', ')}. Known: ${KNOWN_EVENTS.join(', ')}` });

    // The signing secret is encrypted at rest with the platform master key.
    // Refuse to create rather than silently fall back to plaintext storage —
    // otherwise the whole point (no plaintext signing secrets in the DB) is lost.
    if (!secretCrypto.isConfigured()) {
      return res.status(503).json({ success: false, error: `Cannot create webhook: signing-secret encryption is not configured (${secretCrypto.configError()})` });
    }

    // 32 bytes hex — a strong per-webhook HMAC signing secret.
    const secret = 'whsec_' + crypto.randomBytes(32).toString('hex');
    // AES-256-GCM encrypt it; store only the {ciphertext, iv, tag} tuple and
    // explicitly NULL the legacy plaintext `secret` column.
    const enc = secretCrypto.encrypt(secret);

    const r = await pool.query(
      `INSERT INTO outbound_webhooks (org_id, url, events, secret, secret_ct, secret_iv, secret_tag, created_by)
       VALUES ($1, $2, $3, NULL, $4, $5, $6, $7)
       RETURNING id, url, events, active, created_by, created_at`,
      [req.orgId || null, url, events, enc.ciphertext, enc.iv, enc.tag, req.userId || null]
    );
    const row = r.rows[0];

    audit.fromReq(req, {
      event: audit.EVENTS.WEBHOOK_CREATED,
      targetType: 'outbound_webhook',
      targetId: String(row.id),
      meta: { webhook_id: row.id, url, events },
    });

    // Return the full secret ONCE so the receiver can be configured with it.
    res.status(201).json({ success: true, secret, warning: 'Store this signing secret now — only a masked hint is shown afterward.', webhook: row });
  } catch (err) {
    if (req.log) req.log.error('webhook_out_create_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to create webhook' });
  }
});

// DELETE /api/webhooks-out/:id
router.delete('/:id', requireOrgAdmin, async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `DELETE FROM outbound_webhooks WHERE id = $1 AND ${sf} IS NOT DISTINCT FROM $2 RETURNING id`,
      [req.params.id, sv]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Webhook not found' });

    audit.fromReq(req, {
      event: audit.EVENTS.WEBHOOK_DELETED,
      targetType: 'outbound_webhook',
      targetId: String(r.rows[0].id),
      meta: { webhook_id: r.rows[0].id },
    });

    res.json({ success: true, deleted: r.rows[0] });
  } catch (err) {
    if (req.log) req.log.error('webhook_out_delete_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to delete webhook' });
  }
});

// POST /api/webhooks-out/:id/test — fire a synthetic `ping` to THIS webhook.
// Verifies ownership, then dispatches a one-off event and returns the delivery
// outcome so the UI can show "delivered / failed" immediately.
router.post('/:id/test', requireOrgAdmin, async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `SELECT id, url, secret, secret_ct, secret_iv, secret_tag FROM outbound_webhooks WHERE id = $1 AND ${sf} IS NOT DISTINCT FROM $2`,
      [req.params.id, sv]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, error: 'Webhook not found' });
    const webhook = r.rows[0];

    const rawBody = JSON.stringify({
      event: 'ping',
      created_at: new Date().toISOString(),
      data: { message: 'This is a test event from The Open CRM.', webhook_id: webhook.id },
    });
    await webhookDispatcher.deliverOne(webhook, 'ping', rawBody);

    // Read back the delivery we just logged so the UI gets status/timing.
    const d = await pool.query(
      `SELECT status_code, ok, response_ms, attempted_at
         FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY attempted_at DESC LIMIT 1`,
      [webhook.id]
    );
    res.json({ success: true, delivery: d.rows[0] || null });
  } catch (err) {
    if (req.log) req.log.error('webhook_out_test_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to test webhook' });
  }
});

// GET /api/webhooks-out/:id/deliveries — recent attempts for one hook.
router.get('/:id/deliveries', requireOrgAdmin, async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    // Ownership check before exposing delivery rows.
    const own = await pool.query(
      `SELECT id FROM outbound_webhooks WHERE id = $1 AND ${sf} IS NOT DISTINCT FROM $2`,
      [req.params.id, sv]
    );
    if (own.rows.length === 0) return res.status(404).json({ success: false, error: 'Webhook not found' });

    const r = await pool.query(
      `SELECT id, event, status_code, ok, response_ms, attempted_at
         FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY attempted_at DESC LIMIT 50`,
      [req.params.id]
    );
    res.json({ success: true, deliveries: r.rows });
  } catch (err) {
    if (req.log) req.log.error('webhook_out_deliveries_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to load deliveries' });
  }
});

module.exports = router;
