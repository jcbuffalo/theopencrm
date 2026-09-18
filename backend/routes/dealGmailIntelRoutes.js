// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Gmail Intel — per-thread summary routes.
//
// Mount path (set by index.js): /api/deals/:id/gmail-intel
//
// All routes:
//   - auth required (authMiddleware)
//   - require the `gmail_intel_enabled` feature flag
//   - org-scoped via qs(req)
//
// Rate limiting:
//   - POST /threads/:threadLinkId/refresh — 5 per 15 min per thread. Keyed on
//     `gmail-intel-refresh:org:{orgId}:deal:{dealId}:thread:{threadLinkId}` so
//     multiple threads on the same deal don't share the same bucket and a
//     noisy thread can't starve other threads.
//
// Audit event emitted:
//   GMAIL_INTEL_GENERATED — on POST /refresh success.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { authMiddleware } = require('../auth');
const { requireFeature } = require('../middleware/featureGate');
const pool   = require('../db');
const audit  = require('../services/audit');
const gmailSummary = require('../services/gmailSummary');

const router = express.Router({ mergeParams: true });
router.use(authMiddleware);
router.use(requireFeature('gmail_intel_enabled'));

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// Per-thread rate limiter — 5 refreshes per 15 minutes. Keyed by thread link
// id so a noisy user on one thread doesn't starve other threads in the same
// deal; the deal id is included so the bucket reads naturally in logs.
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const dealId        = req.params.id ? `deal:${req.params.id}` : 'deal:?';
    const threadLinkId  = req.params.threadLinkId ? `thread:${req.params.threadLinkId}` : 'thread:?';
    const scope         = req.orgId ? `org:${req.orgId}` : `user:${req.userId || ipKeyGenerator(req, res)}`;
    return `gmail-intel-refresh:${scope}:${dealId}:${threadLinkId}`;
  },
  message: {
    error: 'Too many Gmail intel refreshes for this thread. Try again in 15 minutes.',
    code: 'GMAIL_INTEL_RATE_LIMIT',
  },
});

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

async function loadThreadLinkId(req, dealId) {
  const [sf, sv] = qs(req);
  const threadLinkId = Number(req.params.threadLinkId);
  if (!Number.isFinite(threadLinkId)) return null;
  const r = await pool.query(
    `SELECT id FROM deal_email_threads
      WHERE id = $1 AND deal_id = $2 AND ${sf} = $3`,
    [threadLinkId, dealId, sv]
  );
  return r.rows[0]?.id || null;
}

function rowToResponse(row) {
  if (!row) return null;
  // key_facts may come back from pg as either an object/array (jsonb path)
  // or a string (when the driver returns it raw). Normalize either way.
  let keyFacts = row.key_facts;
  if (typeof keyFacts === 'string') {
    try { keyFacts = JSON.parse(keyFacts); } catch { keyFacts = []; }
  }
  if (!Array.isArray(keyFacts)) keyFacts = [];
  return {
    id:                   row.id,
    deal_id:              row.deal_id,
    thread_link_id:       row.thread_link_id,
    summary_md:           row.summary_md,
    key_facts:            keyFacts,
    next_step:            row.next_step,
    prompt_version:       row.prompt_version,
    generated_at:         row.generated_at,
    generated_by_user_id: row.generated_by_user_id,
    ai_input_tokens:      row.ai_input_tokens,
    ai_output_tokens:     row.ai_output_tokens,
    ai_model:             row.ai_model,
  };
}

// GET /threads/:threadLinkId — latest summary for the thread. 404 if none.
router.get('/threads/:threadLinkId', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const dealId = await loadDealId(req);
    if (!dealId) return res.status(404).json({ error: 'Deal not found' });
    const threadLinkId = await loadThreadLinkId(req, dealId);
    if (!threadLinkId) return res.status(404).json({ error: 'Thread link not found for this deal' });

    const r = await pool.query(
      `SELECT * FROM deal_gmail_summaries
        WHERE thread_link_id = $1 AND deal_id = $2 AND ${sf} = $3
        ORDER BY generated_at DESC
        LIMIT 1`,
      [threadLinkId, dealId, sv]
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ error: 'No Gmail intel summary for this thread yet' });
    }
    res.json(rowToResponse(r.rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /threads/:threadLinkId/refresh — generate a new summary. Rate-limited 5/15min per thread.
router.post('/threads/:threadLinkId/refresh', refreshLimiter, async (req, res) => {
  try {
    const dealId = await loadDealId(req);
    if (!dealId) return res.status(404).json({ error: 'Deal not found' });
    const threadLinkId = await loadThreadLinkId(req, dealId);
    if (!threadLinkId) return res.status(404).json({ error: 'Thread link not found for this deal' });

    try {
      const row = await gmailSummary.generate({
        orgId: req.orgId,
        dealId,
        threadLinkId,
        userId: req.userId,
      });
      audit.fromReq(req, {
        event: audit.EVENTS.GMAIL_INTEL_GENERATED,
        targetType: 'deal',
        targetId: dealId,
        meta: {
          deal_id: dealId,
          thread_link_id: threadLinkId,
          // Best-effort messages-analyzed count from the DB; the service
          // doesn't currently round-trip this on the returned row so we
          // omit it rather than mis-report. Token totals are authoritative.
          tokens_input:  row.ai_input_tokens,
          tokens_output: row.ai_output_tokens,
        },
      });
      res.status(201).json(rowToResponse(row));
    } catch (err) {
      const status = err.statusCode || 500;
      res.status(status).json({
        error: err.message,
        code: err.code || 'GMAIL_INTEL_FAILED',
        details: err.details || undefined,
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
