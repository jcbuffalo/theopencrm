// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Gmail integration — thread search + deal↔thread linkage + sync routes.
//
// Two router exports; the integrator mounts them at:
//
//   /api/gmail/threads             → searchRouter  (thread search picker)
//   /api/deals/:id/gmail-threads   → router        (deal-scoped link list /
//                                                   add / unlink / sync)
//
// Both routers:
//   - auth required (authMiddleware)
//   - require the `gmail_intel_enabled` feature flag (applied at the
//     mount layer by index.js — kept here as a defense-in-depth check
//     so a future re-mount can't accidentally bypass)
//   - org-scoped via qs(req)
//   - return 503 with a clear message when Gmail OAuth isn't configured,
//     mirroring services/email.js's graceful-degradation pattern.
//
// RATE LIMITING
//   The `/sync` endpoint is per-org-IP limited at 10 / 15min keyed on
//   `gmail-sync:org:{orgId}:ip:{ip}` per the spec.
//
// AUDIT EVENTS
//   GMAIL_THREAD_LINKED, GMAIL_THREAD_UNLINKED,
//   GMAIL_THREAD_SYNCED, GMAIL_THREAD_SYNC_FAILED.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { authMiddleware } = require('../auth');
const { requireFeature } = require('../middleware/featureGate');
const pool   = require('../db');
const gmail  = require('../services/gmail');
const gmailSync = require('../services/gmailSync');
const audit  = require('../services/audit');

// router        = mounted at /api/deals/:id/gmail-threads (mergeParams so
//                 :id from the parent path propagates)
// searchRouter  = mounted at /api/gmail/threads (top-level search picker)
const router       = express.Router({ mergeParams: true });
const searchRouter = express.Router();

router.use(authMiddleware);
router.use(requireFeature('gmail_intel_enabled'));
searchRouter.use(authMiddleware);
searchRouter.use(requireFeature('gmail_intel_enabled'));

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

function notConfigured(res) {
  return res.status(503).json({
    configured: false,
    error: 'Gmail integration is not configured on this backend. ' +
           'Set GOOGLE_GMAIL_CLIENT_ID + GOOGLE_GMAIL_CLIENT_SECRET to enable.',
  });
}

// Rate limiter for /sync — keyed on (org_id, ip) so a single deal can't
// be hammered across rotating IPs from one org, and the cap is org-wide
// not per-user. 10/15min matches the spec.
const syncLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const ip = ipKeyGenerator(req, res);
    const scope = req.orgId ? `org:${req.orgId}` : `user:${req.userId || 'anon'}`;
    return `gmail-sync:${scope}:${ip}`;
  },
  message: { error: 'Too many Gmail sync requests. Try again in 15 minutes.', code: 'GMAIL_SYNC_RATE_LIMIT' },
});

/**
 * Verify the deal exists in the caller's org. Returns the deal id (numeric)
 * or null if not found.
 */
async function loadDealId(req) {
  const [sf, sv] = qs(req);
  const dealId = Number(req.params.id);
  if (!Number.isFinite(dealId)) return null;
  const r = await pool.query(
    `SELECT id FROM deals WHERE id = $1 AND ${sf} = $2`,
    [dealId, sv]
  );
  return r.rows[0]?.id || null;
}

// ============================================================================
// /api/gmail/threads/search — thread picker (mounted at /api/gmail/threads)
// ============================================================================

searchRouter.get('/search', async (req, res) => {
  try {
    if (!(await gmail.isConfigured())) return notConfigured(res);
    if (!req.orgId) {
      return res.status(400).json({ error: 'Org context required' });
    }
    const q = String(req.query.q || '').trim();
    try {
      const threads = await gmail.searchThreads(req.orgId, q, 25);
      res.json({ threads });
    } catch (err) {
      const code = err.code || 'GMAIL_SEARCH_FAILED';
      const status = code === 'GMAIL_NOT_CONNECTED' || code === 'GMAIL_CONNECTION_INACTIVE'
        ? 409
        : code === 'GMAIL_TOKEN_REVOKED'
          ? 401
          : 500;
      res.status(status).json({ error: err.message, code });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// /api/deals/:id/gmail-threads
// ============================================================================

// GET — list every thread linked to this deal.
router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const dealId = await loadDealId(req);
    if (!dealId) return res.status(404).json({ error: 'Deal not found' });

    const r = await pool.query(
      `SELECT id, deal_id, gmail_thread_id, subject, participants,
              last_message_at, message_count,
              last_sync_at, last_sync_status, last_sync_error,
              created_at, updated_at
         FROM deal_email_threads
        WHERE deal_id = $1 AND ${sf} = $2
        ORDER BY last_message_at DESC NULLS LAST, id DESC`,
      [dealId, sv]
    );
    res.json({ threads: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST — link a thread.
router.post('/', async (req, res) => {
  try {
    if (!(await gmail.isConfigured())) return notConfigured(res);
    const dealId = await loadDealId(req);
    if (!dealId) return res.status(404).json({ error: 'Deal not found' });

    const { gmail_thread_id, subject: subjectHint } = req.body || {};
    if (!gmail_thread_id || typeof gmail_thread_id !== 'string') {
      return res.status(400).json({ error: 'gmail_thread_id is required' });
    }

    // Verify we can actually read the thread via Gmail. Catches "wrong
    // org connected" / "no longer accessible" / "deleted thread" before
    // we persist a useless row.
    let meta;
    try {
      meta = await gmail.getThreadMeta(req.orgId, gmail_thread_id);
    } catch (err) {
      const code = err.code || 'GMAIL_LOOKUP_FAILED';
      if (code === 'GMAIL_NOT_CONNECTED' || code === 'GMAIL_CONNECTION_INACTIVE') {
        return res.status(409).json({ error: err.message, code });
      }
      return res.status(400).json({ error: `Could not verify Gmail thread: ${err.message}` });
    }

    const resolvedSubject = String(subjectHint || meta.subject || '(no subject)').slice(0, 1000);

    // Upsert by (deal_id, gmail_thread_id) — clicking "link" twice on the
    // same thread is a no-op, not an error.
    const ins = await pool.query(
      `INSERT INTO deal_email_threads
         (org_id, deal_id, gmail_thread_id, subject, participants,
          last_message_at, message_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (deal_id, gmail_thread_id) DO UPDATE
         SET subject         = EXCLUDED.subject,
             participants    = EXCLUDED.participants,
             last_message_at = EXCLUDED.last_message_at,
             message_count   = EXCLUDED.message_count,
             updated_at      = NOW()
       RETURNING *`,
      [
        req.orgId || null,
        dealId,
        gmail_thread_id,
        resolvedSubject,
        meta.participants || [],
        meta.last_message_at || null,
        meta.message_count || 0,
      ]
    );
    const row = ins.rows[0];

    audit.fromReq(req, {
      event: audit.EVENTS.GMAIL_THREAD_LINKED,
      targetType: 'deal',
      targetId:   dealId,
      meta: { deal_id: dealId, gmail_thread_id, subject: resolvedSubject },
    });

    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE — unlink a single thread (by thread-link id). Cascades the
// per-message cache rows via the FK ON DELETE CASCADE on
// email_thread_messages.thread_link_id.
router.delete('/:threadLinkId', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const dealId = await loadDealId(req);
    if (!dealId) return res.status(404).json({ error: 'Deal not found' });

    const threadLinkId = Number(req.params.threadLinkId);
    if (!Number.isFinite(threadLinkId)) {
      return res.status(400).json({ error: 'Invalid threadLinkId' });
    }

    const existing = await pool.query(
      `SELECT id, gmail_thread_id FROM deal_email_threads
        WHERE id = $1 AND deal_id = $2 AND ${sf} = $3`,
      [threadLinkId, dealId, sv]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Thread link not found for this deal' });
    }

    await pool.query(
      `DELETE FROM deal_email_threads WHERE id = $1`,
      [existing.rows[0].id]
    );
    audit.fromReq(req, {
      event: audit.EVENTS.GMAIL_THREAD_UNLINKED,
      targetType: 'deal',
      targetId: dealId,
      meta: { deal_id: dealId, gmail_thread_id: existing.rows[0].gmail_thread_id },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /:threadLinkId/sync — trigger a synchronous sync of a single thread.
router.post('/:threadLinkId/sync', syncLimiter, async (req, res) => {
  try {
    if (!(await gmail.isConfigured())) return notConfigured(res);
    const [sf, sv] = qs(req);
    const dealId = await loadDealId(req);
    if (!dealId) return res.status(404).json({ error: 'Deal not found' });

    const threadLinkId = Number(req.params.threadLinkId);
    if (!Number.isFinite(threadLinkId)) {
      return res.status(400).json({ error: 'Invalid threadLinkId' });
    }

    const linkRes = await pool.query(
      `SELECT id FROM deal_email_threads
        WHERE id = $1 AND deal_id = $2 AND ${sf} = $3`,
      [threadLinkId, dealId, sv]
    );
    if (linkRes.rows.length === 0) {
      return res.status(404).json({ error: 'Thread link not found for this deal' });
    }

    try {
      const result = await gmailSync.sync({
        orgId: req.orgId,
        dealId,
        threadLinkId,
      });
      audit.fromReq(req, {
        event: audit.EVENTS.GMAIL_THREAD_SYNCED,
        targetType: 'deal',
        targetId: dealId,
        meta: {
          deal_id: dealId,
          thread_link_id: threadLinkId,
          messages_synced:  result.synced,
          messages_skipped: result.skipped,
          errors:           result.errors.length,
        },
      });
      res.json({
        synced:  result.synced,
        skipped: result.skipped,
        errors:  result.errors,
        messages_total: result.messages_total,
      });
    } catch (err) {
      audit.fromReq(req, {
        event: audit.EVENTS.GMAIL_THREAD_SYNC_FAILED,
        targetType: 'deal',
        targetId: dealId,
        meta: { deal_id: dealId, thread_link_id: threadLinkId, error: err.message },
        success: false,
      });
      const code = err.code || 'GMAIL_SYNC_FAILED';
      const status = code === 'GMAIL_NOT_CONNECTED' || code === 'GMAIL_CONNECTION_INACTIVE'
        ? 409
        : code === 'GMAIL_TOKEN_REVOKED'
          ? 401
          : 500;
      res.status(status).json({ error: err.message, code });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.searchRouter = searchRouter;
