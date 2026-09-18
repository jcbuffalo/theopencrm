// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Outbound webhook dispatcher.
//
// dispatch(orgId, event, payload) finds every ACTIVE webhook in the org that
// subscribes to `event`, POSTs the JSON payload to each, and records the
// outcome in webhook_deliveries. It is the OUTBOUND counterpart to the inbound
// receivers in routes/webhookRoutes.js.
//
// SIGNING (mirrors the inbound Zoom/Teams HMAC, in reverse)
//   We serialize the body ONCE, compute HMAC-SHA256 over those exact bytes with
//   the webhook's per-row secret, and send it as `X-Signature: sha256=<hex>`.
//   The receiver recomputes the HMAC over the raw bytes it received and
//   compares — a timing-safe check on their side proves the payload came from
//   us and wasn't tampered with in flight. We sign the SAME string we send so
//   the two never diverge (the false-mismatch trap the inbound Zoom handler
//   documents).
//
// BEST-EFFORT
//   dispatch() never throws to its caller. A failed HTTP post, a DNS error, a
//   timeout — all are caught, logged to webhook_deliveries (ok=false), and
//   swallowed. Domain-event call sites (deal create, stage change) stay a
//   single un-awaited line and are never blocked by a slow or dead endpoint.

const crypto = require('crypto');
const pool = require('../db');
const logger = require('./logger');
const secretCrypto = require('./driveTokens');

// Per-attempt timeout. A dead endpoint shouldn't tie up a socket for long.
const DELIVERY_TIMEOUT_MS = Number(process.env.WEBHOOK_DELIVERY_TIMEOUT_MS) || 5000;

function signBody(rawBody, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

// Resolve a webhook row's HMAC signing secret to plaintext. Rows created after
// migration 114 store the secret AES-256-GCM encrypted in secret_ct/iv/tag
// (keyed by DRIVE_TOKEN_ENCRYPTION_KEY, via services/driveTokens.js); we decrypt
// on read. Rows created before 114 kept the plaintext in the `secret` column —
// we fall back to it so legacy hooks keep signing. (No re-encrypt-on-read is
// performed here — out of scope; a legacy row is only migrated to ciphertext if
// the customer re-creates the webhook.) A tampered/wrong-key ciphertext throws
// inside decrypt(); deliverOne catches it and logs a failed delivery.
function decryptSecret(row) {
  if (row && row.secret_ct) {
    return secretCrypto.decrypt({ ciphertext: row.secret_ct, iv: row.secret_iv, tag: row.secret_tag });
  }
  return row ? row.secret : undefined;
}

async function recordDelivery({ webhookId, event, statusCode, ok, responseMs }) {
  try {
    await pool.query(
      `INSERT INTO webhook_deliveries (webhook_id, event, status_code, ok, response_ms)
       VALUES ($1, $2, $3, $4, $5)`,
      [webhookId, event, statusCode ?? null, !!ok, responseMs ?? null]
    );
  } catch (err) {
    // Even the audit write is best-effort; a logging-table failure must not
    // surface into the dispatch loop.
    logger.warn('webhook_delivery_log_failed', { webhookId, event, error: err.message });
  }
}

// Deliver a single event to a single webhook. Returns nothing; records the
// outcome. Never throws.
async function deliverOne(webhook, event, rawBody) {
  const startedAt = Date.now();
  let statusCode = null;
  let ok = false;
  try {
    const signature = signBody(rawBody, decryptSecret(webhook));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    try {
      const res = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': signature,
          'X-Webhook-Event': event,
          'User-Agent': 'TheOpenCRM-Webhooks/1.0',
        },
        body: rawBody,
        signal: controller.signal,
      });
      statusCode = res.status;
      ok = res.status >= 200 && res.status < 300;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // Network error / timeout / abort — statusCode stays null, ok stays false.
    logger.warn('webhook_delivery_failed', { webhookId: webhook.id, event, error: err.message });
  } finally {
    await recordDelivery({
      webhookId: webhook.id,
      event,
      statusCode,
      ok,
      responseMs: Date.now() - startedAt,
    });
  }
}

// Fan out `event` to every active org webhook subscribed to it. Best-effort:
// resolves once all deliveries have been attempted (and logged), never rejects.
async function dispatch(orgId, event, payload) {
  if (!orgId || !event) return;
  try {
    const r = await pool.query(
      `SELECT id, url, secret, secret_ct, secret_iv, secret_tag, events
         FROM outbound_webhooks
        WHERE org_id = $1 AND active = TRUE AND $2 = ANY(events)`,
      [orgId, event]
    );
    if (r.rows.length === 0) return;

    // Serialize the envelope ONCE so every subscriber gets byte-identical,
    // consistently-signed content.
    const rawBody = JSON.stringify({
      event,
      created_at: new Date().toISOString(),
      data: payload ?? {},
    });

    await Promise.all(r.rows.map((w) => deliverOne(w, event, rawBody)));
  } catch (err) {
    // A failure enumerating webhooks (DB down, etc.) must not bubble into the
    // domain event that triggered the dispatch.
    logger.warn('webhook_dispatch_failed', { orgId, event, error: err.message });
  }
}

module.exports = { dispatch, signBody, deliverOne, decryptSecret };
