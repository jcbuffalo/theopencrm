// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Drive Intel — deal-intel summary routes.
//
// Mount path (set by index.js / integrator): /api/deals/:id/intel
//
// All routes:
//   - auth required (authMiddleware)
//   - require the `drive_intel_enabled` feature flag
//   - org-scoped via qs(req)
//
// Rate limiting:
//   - POST /refresh — 5 per 15 min per deal (per spec). Keyed on
//     (deal_id, user_id) so a user can't bypass by switching deals, and
//     two users on the same deal share the same quota (cheap Claude
//     calls are still cost-attributable to a deal).
//
// Audit event emitted:
//   DRIVE_INTEL_GENERATED — on POST /refresh success.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { authMiddleware } = require('../auth');
const { requireFeature } = require('../middleware/featureGate');
const pool   = require('../db');
const audit  = require('../services/audit');
const intelSummary    = require('../services/intelSummary');
const intelWriteback  = require('../services/intelWriteback');

const router = express.Router({ mergeParams: true });
router.use(authMiddleware);
router.use(requireFeature('drive_intel_enabled'));

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// Per-deal rate limiter — 5 refreshes per 15 minutes. Keyed by deal id
// so a noisy user on one deal doesn't starve other deals; the user id
// is included so the limiter falls back cleanly when deal id is missing
// from the URL for any reason.
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const dealId = req.params.id ? `deal:${req.params.id}` : 'deal:?';
    const scope  = req.orgId ? `org:${req.orgId}` : `user:${req.userId || ipKeyGenerator(req, res)}`;
    return `intel-refresh:${scope}:${dealId}`;
  },
  message: {
    error: 'Too many intel refreshes for this deal. Try again in 15 minutes.',
    code: 'DRIVE_INTEL_RATE_LIMIT',
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

function rowToResponse(row) {
  if (!row) return null;
  // key_facts_json may come back from pg as either an object/array (jsonb
  // path) or a string (when the driver returns it raw). Normalize either way.
  let keyFacts = row.key_facts_json;
  if (typeof keyFacts === 'string') {
    try { keyFacts = JSON.parse(keyFacts); } catch { keyFacts = []; }
  }
  if (!Array.isArray(keyFacts)) keyFacts = [];
  return {
    id:                   row.id,
    deal_id:              row.deal_id,
    folder_link_id:       row.folder_link_id,
    model:                row.model,
    prompt_version:       row.prompt_version,
    summary_md:           row.summary_md,
    key_facts:            keyFacts,
    files_analyzed_count: row.files_analyzed_count,
    tokens_input:         row.tokens_input,
    tokens_output:        row.tokens_output,
    generated_at:         row.generated_at,
    created_by_user_id:   row.created_by_user_id,
  };
}

// GET / — latest summary for the deal. 404 if none.
router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const dealId = await loadDealId(req);
    if (!dealId) return res.status(404).json({ error: 'Deal not found' });

    const r = await pool.query(
      `SELECT * FROM deal_intel_summaries
        WHERE deal_id = $1 AND ${sf} = $2
        ORDER BY generated_at DESC
        LIMIT 1`,
      [dealId, sv]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'No intel summary for this deal yet' });
    res.json(rowToResponse(r.rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /refresh — generate a new summary. Rate-limited 5/15min per deal.
router.post('/refresh', refreshLimiter, async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const dealId = await loadDealId(req);
    if (!dealId) return res.status(404).json({ error: 'Deal not found' });

    const linkRes = await pool.query(
      `SELECT id FROM deal_drive_folders WHERE deal_id = $1 AND ${sf} = $2`,
      [dealId, sv]
    );
    if (linkRes.rows.length === 0) {
      return res.status(400).json({
        error: 'This deal has no Drive folder linked. Link one and run a sync before refreshing intel.',
        code: 'NO_FOLDER_LINK',
      });
    }
    const folderLinkId = linkRes.rows[0].id;

    try {
      const row = await intelSummary.generate({
        orgId: req.orgId,
        dealId,
        folderLinkId,
        userId: req.userId,
      });
      audit.fromReq(req, {
        event: audit.EVENTS.DRIVE_INTEL_GENERATED,
        targetType: 'deal',
        targetId: dealId,
        meta: {
          deal_id: dealId,
          folder_link_id: folderLinkId,
          files_analyzed: row.files_analyzed_count,
          tokens_input:   row.tokens_input,
          tokens_output:  row.tokens_output,
        },
      });
      res.status(201).json(rowToResponse(row));
    } catch (err) {
      const status = err.statusCode || 500;
      res.status(status).json({
        error: err.message,
        code: err.code || 'DRIVE_INTEL_FAILED',
        details: err.details || undefined,
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /history — last 10 summaries (newest first).
router.get('/history', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const dealId = await loadDealId(req);
    if (!dealId) return res.status(404).json({ error: 'Deal not found' });

    const r = await pool.query(
      `SELECT * FROM deal_intel_summaries
        WHERE deal_id = $1 AND ${sf} = $2
        ORDER BY generated_at DESC
        LIMIT 10`,
      [dealId, sv]
    );
    res.json(r.rows.map(rowToResponse));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// WRITE-BACK-TO-CRM SUGGESTIONS — Phase 2, gated additionally by
// `drive_intel_writeback_enabled` (default off; see services/featureFlags.js).
// ============================================================================
//
// All routes below the `writebackGate` require BOTH `drive_intel_enabled`
// (already imposed by router.use above) AND `drive_intel_writeback_enabled`.
// They sit on top of the existing summary surface — the front-end's
// SuggestedUpdatesPanel only renders when the second flag is on for the org.
//
// Routes:
//   POST   /:id/intel/suggest                — generate suggestions off latest summary (5/15min/deal)
//   GET    /:id/intel/suggestions?status=    — list (default status='pending')
//   POST   /:id/intel/suggestions/:sid/apply — write to deal, INSERT writeback row
//   POST   /:id/intel/suggestions/:sid/reject
//   GET    /:id/intel/writebacks?within=7d   — recent applied writebacks
//   POST   /:id/intel/writeback/:wb_id/undo  — restore prior_value, within 7d
//
// Error codes (mirroring services/intelSummary.js shape):
//   404 — deal not found
//   400 — no summary yet to suggest off / bad payload
//   409 — stale-data (current_value mismatch at apply) / undo-window expired
//   402 — AI quota exceeded
//   429 — rate limit
//   503 — AI not configured

const writebackGate = requireFeature('drive_intel_writeback_enabled');

// Per-deal rate limiter — 5 suggest calls per 15 minutes. Clone of the
// refresh limiter pattern above so a noisy deal doesn't burn budget.
const suggestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const dealId = req.params.id ? `deal:${req.params.id}` : 'deal:?';
    const scope  = req.orgId ? `org:${req.orgId}` : `user:${req.userId || ipKeyGenerator(req, res)}`;
    return `intel-suggest:${scope}:${dealId}`;
  },
  message: {
    error: 'Too many writeback-suggestion requests for this deal. Try again in 15 minutes.',
    code: 'DRIVE_INTEL_WRITEBACK_RATE_LIMIT',
  },
});

function suggestionToResponse(row) {
  if (!row) return null;
  return {
    id:                 row.id,
    deal_id:            row.deal_id,
    summary_id:         row.summary_id,
    field:              row.field,
    current_value:      typeof row.current_value === 'string'
                          ? safeJSON(row.current_value, row.current_value)
                          : row.current_value,
    proposed_value:     typeof row.proposed_value === 'string'
                          ? safeJSON(row.proposed_value, row.proposed_value)
                          : row.proposed_value,
    confidence:         row.confidence == null ? null : Number(row.confidence),
    reason:             row.reason || null,
    status:             row.status,
    created_at:         row.created_at,
    decided_at:         row.decided_at,
    decided_by_user_id: row.decided_by_user_id,
  };
}

function writebackToResponse(row) {
  if (!row) return null;
  return {
    id:                 row.id,
    deal_id:            row.deal_id,
    suggestion_id:      row.suggestion_id,
    field:              row.field,
    prior_value:        typeof row.prior_value === 'string'
                          ? safeJSON(row.prior_value, row.prior_value)
                          : row.prior_value,
    new_value:          typeof row.new_value === 'string'
                          ? safeJSON(row.new_value, row.new_value)
                          : row.new_value,
    applied_at:         row.applied_at,
    applied_by_user_id: row.applied_by_user_id,
    undone_at:          row.undone_at,
    undone_by_user_id:  row.undone_by_user_id,
  };
}

function safeJSON(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// POST /:id/intel/suggest — generate suggestions off the latest summary.
router.post('/suggest', writebackGate, suggestLimiter, async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const dealId = await loadDealId(req);
    if (!dealId) return res.status(404).json({ error: 'Deal not found' });

    const latest = await pool.query(
      `SELECT id FROM deal_intel_summaries
        WHERE deal_id = $1 AND ${sf} = $2
        ORDER BY generated_at DESC
        LIMIT 1`,
      [dealId, sv]
    );
    if (latest.rows.length === 0) {
      return res.status(400).json({
        error: 'No intel summary yet — generate one before requesting writeback suggestions.',
        code: 'NO_SUMMARY',
      });
    }
    const summaryId = latest.rows[0].id;

    try {
      const rows = await intelWriteback.proposeUpdates({
        orgId: req.orgId,
        dealId,
        summaryId,
        userId: req.userId,
      });
      audit.fromReq(req, {
        event: audit.EVENTS.DEAL_INTEL_SUGGESTED,
        targetType: 'deal',
        targetId: dealId,
        meta: {
          deal_id: dealId,
          summary_id: summaryId,
          suggestion_count: rows.length,
          fields: rows.map(r => r.field),
        },
      });
      res.status(201).json(rows.map(suggestionToResponse));
    } catch (err) {
      const status = err.statusCode || 500;
      res.status(status).json({
        error: err.message,
        code: err.code || 'DRIVE_INTEL_WRITEBACK_FAILED',
        details: err.details || undefined,
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /:id/intel/suggestions?status=pending — defaults to pending only.
router.get('/suggestions', writebackGate, async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const dealId = await loadDealId(req);
    if (!dealId) return res.status(404).json({ error: 'Deal not found' });

    const status = req.query.status || 'pending';
    const ALLOWED_STATUS = ['pending', 'accepted', 'rejected', 'applied', 'stale', 'all'];
    if (!ALLOWED_STATUS.includes(status)) {
      return res.status(400).json({ error: 'Invalid status filter' });
    }

    let q = `SELECT * FROM deal_intel_suggestions
              WHERE deal_id = $1 AND ${sf} = $2`;
    const params = [dealId, sv];
    if (status !== 'all') {
      q += ` AND status = $3`;
      params.push(status);
    }
    q += ` ORDER BY created_at DESC LIMIT 100`;

    const r = await pool.query(q, params);
    res.json(r.rows.map(suggestionToResponse));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/intel/suggestions/:sid/apply
router.post('/suggestions/:sid/apply', writebackGate, async (req, res) => {
  try {
    const dealId = await loadDealId(req);
    if (!dealId) return res.status(404).json({ error: 'Deal not found' });
    const sid = Number(req.params.sid);
    if (!Number.isFinite(sid)) return res.status(400).json({ error: 'Invalid suggestion id' });

    try {
      const out = await intelWriteback.applySuggestion({
        orgId: req.orgId,
        dealId,
        suggestionId: sid,
        userId: req.userId,
      });
      audit.fromReq(req, {
        event: audit.EVENTS.DEAL_INTEL_APPLIED,
        targetType: 'deal',
        targetId: dealId,
        meta: {
          deal_id: dealId,
          suggestion_id: sid,
          writeback_id: out.writeback.id,
          field: out.writeback.field,
          prior_value: out.priorValue,
          new_value: out.newValue,
        },
      });
      res.status(201).json({
        writeback:  writebackToResponse(out.writeback),
        suggestion: suggestionToResponse(out.suggestion),
      });
    } catch (err) {
      const status = err.statusCode || 500;
      res.status(status).json({
        error: err.message,
        code: err.code || 'DRIVE_INTEL_WRITEBACK_FAILED',
        details: err.details || undefined,
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/intel/suggestions/:sid/reject
router.post('/suggestions/:sid/reject', writebackGate, async (req, res) => {
  try {
    const dealId = await loadDealId(req);
    if (!dealId) return res.status(404).json({ error: 'Deal not found' });
    const sid = Number(req.params.sid);
    if (!Number.isFinite(sid)) return res.status(400).json({ error: 'Invalid suggestion id' });

    try {
      const row = await intelWriteback.rejectSuggestion({
        orgId: req.orgId,
        dealId,
        suggestionId: sid,
        userId: req.userId,
      });
      res.json(suggestionToResponse(row));
    } catch (err) {
      const status = err.statusCode || 500;
      res.status(status).json({
        error: err.message,
        code: err.code || 'DRIVE_INTEL_WRITEBACK_FAILED',
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /:id/intel/writebacks?within=7d — recent writebacks (applied, ordered DESC).
router.get('/writebacks', writebackGate, async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const dealId = await loadDealId(req);
    if (!dealId) return res.status(404).json({ error: 'Deal not found' });

    // Best-effort `within` parser. We accept '7d', '14d', '30d' or a raw
    // number-of-days; anything else falls back to UNDO_WINDOW_DAYS so the
    // UI only shows what can still be undone.
    let withinDays = intelWriteback.UNDO_WINDOW_DAYS;
    if (typeof req.query.within === 'string') {
      const m = /^(\d+)d?$/.exec(req.query.within.trim());
      if (m) withinDays = Math.min(365, Math.max(1, Number(m[1])));
    }
    const r = await pool.query(
      `SELECT * FROM deal_intel_writebacks
        WHERE deal_id = $1 AND ${sf} = $2
          AND applied_at >= NOW() - ($3 || ' days')::interval
        ORDER BY applied_at DESC
        LIMIT 100`,
      [dealId, sv, String(withinDays)]
    );
    res.json(r.rows.map(writebackToResponse));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/intel/writeback/:wb_id/undo
router.post('/writeback/:wb_id/undo', writebackGate, async (req, res) => {
  try {
    const dealId = await loadDealId(req);
    if (!dealId) return res.status(404).json({ error: 'Deal not found' });
    const wbId = Number(req.params.wb_id);
    if (!Number.isFinite(wbId)) return res.status(400).json({ error: 'Invalid writeback id' });

    try {
      const out = await intelWriteback.undoWriteback({
        orgId: req.orgId,
        dealId,
        wbId,
        userId: req.userId,
      });
      audit.fromReq(req, {
        event: audit.EVENTS.DEAL_INTEL_UNDONE,
        targetType: 'deal',
        targetId: dealId,
        meta: {
          deal_id: dealId,
          writeback_id: wbId,
          field: out.writeback.field,
          restored_value: out.restoredValue,
        },
      });
      res.json(writebackToResponse(out.writeback));
    } catch (err) {
      const status = err.statusCode || 500;
      res.status(status).json({
        error: err.message,
        code: err.code || 'DRIVE_INTEL_WRITEBACK_FAILED',
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
