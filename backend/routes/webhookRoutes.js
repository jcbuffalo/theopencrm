// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Inbound webhook receivers for Teams / Zoom / generic transcription tools.
//
// Each provider posts to a stable URL with a shared secret in either an HMAC
// signature header or a query param. The receiver authenticates, normalizes
// the payload, and inserts a meeting_log row that the deal/contact timeline UI
// reads.
//
// Provider-specific signature verification:
//   - TEAMS_WEBHOOK_SECRET      — for /webhooks/teams (basic shared-secret check)
//   - ZOOM_WEBHOOK_SECRET_TOKEN — for /webhooks/zoom (verifies the SHA-256 HMAC
//                                 sent in the x-zm-signature header per Zoom spec)
//   - GENERIC_WEBHOOK_SECRET    — for /webhooks/generic (?secret=... query)
//
// LIABILITY: webhooks accept potentially-untrusted input. We verify the shared
// secret, store payloads in the raw_payload JSON column, and never execute
// content from the payload. Operators are responsible for setting strong,
// rotated secrets.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db');
const logger = require('../services/logger');

// Default org_id to attribute webhook events to when the webhook payload doesn't
// carry one. Operators can pass ?org=N to override per-webhook.
const DEFAULT_ORG_ID = process.env.WEBHOOK_DEFAULT_ORG_ID || null;

function timingSafeEqual(a, b) {
  try {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  } catch { return false; }
}

async function insertMeetingLog({ orgId, source, externalId, title, participants, occurredAt, durationMinutes, recordingUrl, transcript, summary, rawPayload }) {
  const r = await pool.query(
    `INSERT INTO meeting_logs (org_id, source, external_id, title, participants, occurred_at, duration_minutes, recording_url, transcript, summary, raw_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [
      orgId || DEFAULT_ORG_ID || null, source,
      externalId || null, title || null, participants || null,
      occurredAt || null, durationMinutes || null,
      recordingUrl || null, transcript || null, summary || null,
      rawPayload ? JSON.stringify(rawPayload) : null,
    ]
  );
  return r.rows[0].id;
}

// ---------------------------------------------------------------------------
// Teams (Microsoft 365 / Power Automate flows can hit this)
// ---------------------------------------------------------------------------
router.post('/teams', express.json({ limit: '5mb' }), async (req, res) => {
  const expected = process.env.TEAMS_WEBHOOK_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'TEAMS_WEBHOOK_SECRET not configured' });
  const provided = req.headers['x-teams-secret'] || req.query.secret;
  if (!timingSafeEqual(expected, String(provided || ''))) {
    logger.warn('teams_webhook_unauthorized', { ip: req.ip });
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  try {
    const p = req.body || {};
    const id = await insertMeetingLog({
      orgId: req.query.org || null,
      source: 'teams',
      externalId: p.id || p.meetingId || null,
      title: p.subject || p.title || null,
      participants: Array.isArray(p.participants) ? p.participants.join(', ') : p.participants || null,
      occurredAt: p.occurredAt || p.startTime || null,
      durationMinutes: p.durationMinutes || null,
      recordingUrl: p.recordingUrl || null,
      transcript: p.transcript || null,
      summary: p.summary || null,
      rawPayload: p,
    });
    res.json({ ok: true, id });
  } catch (err) {
    logger.error('teams_webhook_failed', { error: err.message });
    res.status(500).json({ ok: false, error: 'failed' });
  }
});

// ---------------------------------------------------------------------------
// Zoom — handles Zoom's URL validation handshake AND meeting-ended events.
// Zoom uses x-zm-signature: v0=<HMAC-SHA256 of "v0:{timestamp}:{body}"> with
// the secret token. Doc: https://developers.zoom.us/docs/api/webhooks/
// ---------------------------------------------------------------------------
router.post('/zoom', express.json({ limit: '5mb' }), async (req, res) => {
  const secret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
  if (!secret) return res.status(503).json({ ok: false, error: 'ZOOM_WEBHOOK_SECRET_TOKEN not configured' });

  // Endpoint validation handshake
  if (req.body?.event === 'endpoint.url_validation') {
    const plainToken = req.body.payload?.plainToken;
    const encrypted = crypto.createHmac('sha256', secret).update(String(plainToken)).digest('hex');
    return res.json({ plainToken, encryptedToken: encrypted });
  }

  // Signature check. Zoom signs "v0:{timestamp}:{raw request body}" — the HMAC
  // must be computed over the EXACT bytes Zoom sent, not a re-serialization.
  //
  // LIMITATION (raw bytes): the global `express.json()` mounted in index.js
  // fires for every path except the Stripe webhook, so by the time this router
  // runs the request stream is already consumed and parsed. The route-level
  // `express.json()` above is therefore a no-op (`req._body` is already set) and
  // a `verify` callback on it would never fire — capturing the true raw bytes
  // here would require adding a `verify` hook to the GLOBAL parser in index.js
  // (out of scope for this file). Until then we fall back to re-serializing
  // `req.body`, which matches Zoom's compact JSON in the common case but can
  // yield a false mismatch if serialization diverges (e.g. non-ASCII escaping,
  // integer-like key reordering).
  //
  // Forward-compatible: if index.js is ever updated to stash the raw buffer on
  // `req.rawBody` (via a `verify` callback), this code picks it up automatically
  // and the HMAC becomes byte-exact with no further change here.
  const ts = req.headers['x-zm-request-timestamp'];
  const sig = req.headers['x-zm-signature'];
  if (!ts || !sig) return res.status(401).json({ ok: false, error: 'missing signature' });
  const rawBody = Buffer.isBuffer(req.rawBody)
    ? req.rawBody
    : Buffer.from(JSON.stringify(req.body || {}), 'utf8');
  const message = Buffer.concat([Buffer.from(`v0:${ts}:`, 'utf8'), rawBody]);
  const expected = `v0=${crypto.createHmac('sha256', secret).update(message).digest('hex')}`;
  if (!timingSafeEqual(expected, String(sig))) {
    logger.warn('zoom_webhook_signature_mismatch');
    return res.status(401).json({ ok: false, error: 'bad signature' });
  }

  try {
    const event = req.body?.event;
    const obj = req.body?.payload?.object || {};
    if (event === 'meeting.ended' || event === 'recording.transcript_completed') {
      await insertMeetingLog({
        orgId: req.query.org || null,
        source: 'zoom',
        externalId: obj.uuid || obj.id || null,
        title: obj.topic || null,
        participants: obj.host_email || null,
        occurredAt: obj.start_time || null,
        durationMinutes: obj.duration || null,
        recordingUrl: obj.share_url || obj.download_url || null,
        transcript: null,
        summary: null,
        rawPayload: req.body,
      });
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error('zoom_webhook_failed', { error: err.message });
    res.status(500).json({ ok: false, error: 'failed' });
  }
});

// ---------------------------------------------------------------------------
// Generic (Otter.ai, Fireflies, custom Zapier flows, etc.)
// ---------------------------------------------------------------------------
router.post('/generic', express.json({ limit: '5mb' }), async (req, res) => {
  const expected = process.env.GENERIC_WEBHOOK_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'GENERIC_WEBHOOK_SECRET not configured' });
  if (!timingSafeEqual(expected, String(req.query.secret || ''))) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  try {
    const p = req.body || {};
    const id = await insertMeetingLog({
      orgId: req.query.org || null,
      source: p.source || 'generic',
      externalId: p.external_id || null,
      title: p.title || null,
      participants: p.participants || null,
      occurredAt: p.occurred_at || null,
      durationMinutes: p.duration_minutes || null,
      recordingUrl: p.recording_url || null,
      transcript: p.transcript || null,
      summary: p.summary || null,
      rawPayload: p,
    });
    res.json({ ok: true, id });
  } catch (err) {
    logger.error('generic_webhook_failed', { error: err.message });
    res.status(500).json({ ok: false, error: 'failed' });
  }
});

// ---------------------------------------------------------------------------
// Listing endpoint (auth required) so the UI can show ingested meetings
// ---------------------------------------------------------------------------
const { authMiddleware } = require('../auth');
router.get('/meetings', authMiddleware, async (req, res) => {
  const { related_type, related_id, limit = 50 } = req.query;
  // Org-scope, falling back to user_id for org-less users (mirrors qs()).
  // Previously this left `where = '1=1'` when req.orgId was absent, returning
  // every org's meeting_logs to any authenticated user without an org.
  const sf = req.orgId ? 'org_id' : 'user_id';
  const sv = req.orgId || req.userId;

  const params = [sv];
  let where = `${sf} = $${params.length}`;
  if (related_type) { params.push(related_type); where += ` AND related_type = $${params.length}`; }
  if (related_id) { params.push(related_id); where += ` AND related_id = $${params.length}`; }
  params.push(Math.min(Number(limit) || 50, 200));

  const r = await pool.query(
    `SELECT id, source, external_id, title, participants, occurred_at, duration_minutes,
            recording_url, summary, created_at
     FROM meeting_logs WHERE ${where} ORDER BY occurred_at DESC NULLS LAST, created_at DESC LIMIT $${params.length}`,
    params
  );
  res.json({ success: true, meetings: r.rows });
});

module.exports = router;
