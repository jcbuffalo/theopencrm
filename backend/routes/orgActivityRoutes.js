// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Per-org activity feed — last-24h "what's happening in my workspace" view.
//
// Mounted at /api/admin/org-activity. ORG-ADMIN-ONLY (org_role = 'owner' |
// 'admin'); regular members get 403. Super-admins see THEIR OWN org's view
// here — cross-org observability lives in the chat `inspect_org` tool.
//
// Closes the "no per-tenant observability" gap from the original onboarding
// inventory: each customer org gets one screen that aggregates audit events,
// AI usage, plugin runs, Drive intel, Gmail intel, and outbound emails over
// a recent window.
//
// READ-ONLY. No new schema. Every query is org-scoped via the standard
// qs(req)-style [scopeField, scopeValue] pattern.

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authMiddleware } = require('../auth');

// ---------------------------------------------------------------------------
// Org-admin gate. Distinct from the system admin_users table — we want any
// owner/admin of THE ORG to see their own workspace's activity, regardless of
// whether they're also platform admins. Mirrors the pattern in
// customFieldsRoutes.requireOrgAdmin / driveAuthRoutes.isAdmin().
// ---------------------------------------------------------------------------
function requireOrgAdmin(req, res, next) {
  if (!req.orgId) {
    return res.status(400).json({ success: false, error: 'Org context required' });
  }
  if (req.orgRole !== 'owner' && req.orgRole !== 'admin') {
    return res.status(403).json({ success: false, error: 'Org admin role required' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Standard org-scope helper. Same convention as every other CRUD route.
// ---------------------------------------------------------------------------
function qs(req) {
  return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId];
}

// ---------------------------------------------------------------------------
// Audit-event denylist. These events fire on every request (or close to it)
// and would drown out everything else in the feed. Keep the security- and
// behavior-meaningful events; drop the per-request noise. Hardcoded so the
// filter is auditable in code review, not buried in config.
// ---------------------------------------------------------------------------
const AUDIT_EVENT_DENYLIST = new Set([
  // Per-call AI metering — already represented in the ai_calls stream.
  'ai.usage_recorded',
  // Per-message chat traffic — too chatty for a 24h summary.
  'chat.message',
  // Per-request HTTP audit (if any module ever emits this — defensive).
  'http.request',
  // CSRF / auth-cookie refreshes — security-relevant but high-volume.
  'auth.csrf_token_issued',
  // Page view / analytics-style events.
  'page.view',
  'feature.view',
]);

// ---------------------------------------------------------------------------
// Window parser. Currently supports `24h`, `1h`, `7d`. Defaults to 24h.
// Returns a JS Date that represents `now - window`.
// ---------------------------------------------------------------------------
function parseSince(raw) {
  const fallback = new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (!raw || typeof raw !== 'string') return fallback;
  const m = /^(\d+)([hd])$/.exec(raw.trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0 || n > 720) return fallback; // cap at 30d
  const unit = m[2] === 'd' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  return new Date(Date.now() - n * unit);
}

// ---------------------------------------------------------------------------
// Page-size clamp. Default 50, max 200. The merge step caps the total
// candidate set per kind at `limit` to bound the in-memory sort.
// ---------------------------------------------------------------------------
function parseLimit(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(n, 200);
}

// ---------------------------------------------------------------------------
// Cursor parser. The cursor is the ISO timestamp of the oldest row in the
// previous page; the next page returns rows STRICTLY OLDER than the cursor.
// Anything that doesn't parse is silently ignored (treated as no cursor) so
// a stale cursor on a re-render doesn't 400 the user.
// ---------------------------------------------------------------------------
function parseCursor(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

// Helper: build a parameterized fragment that anchors the window AND
// optionally the cursor. Returns `{ where, params }` slotted after the
// org-scope param. `tsCol` is the timestamp column (e.g. 'created_at',
// 'started_at', 'sent_at').
function timeFilter(tsCol, since, cursor, startIdx) {
  let where = `${tsCol} >= $${startIdx}`;
  const params = [since];
  let idx = startIdx + 1;
  if (cursor) {
    where += ` AND ${tsCol} < $${idx}`;
    params.push(cursor);
    idx += 1;
  }
  return { where, params, nextIdx: idx };
}

// ---------------------------------------------------------------------------
// Build a short human-readable summary for an audit row. The `meta` JSONB
// can be huge (full payloads, diffs); we shrink it to a 200-char preview so
// the feed stays scannable.
// ---------------------------------------------------------------------------
function summarizeAuditMeta(meta) {
  if (!meta) return null;
  try {
    const s = typeof meta === 'string' ? meta : JSON.stringify(meta);
    return s.length > 200 ? s.slice(0, 197) + '...' : s;
  } catch {
    return null;
  }
}

// micro-dollars → dollars, rounded to 4 decimal places (covers a $0.0001
// floor). Returns 0 if input is null/0.
function microToDollars(micro) {
  if (!micro) return 0;
  const n = Number(micro);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n / 1_000_000) * 10000) / 10000;
}

router.use(authMiddleware);
router.use(requireOrgAdmin);

// ===========================================================================
// GET /api/admin/org-activity/summary?since=24h
// Lightweight counts + cost — used by the stat cards at the top of the page.
// ===========================================================================
router.get('/summary', async (req, res, next) => {
  try {
    const since = parseSince(req.query.since);
    const [scopeField, scopeValue] = qs(req);

    // We run six count queries in parallel. Each is a single-row aggregate
    // that hits the (org_id, time-col DESC) index already on each table.
    const denyArray = Array.from(AUDIT_EVENT_DENYLIST);

    const [
      auditRes,
      aiRes,
      pluginRes,
      driveRes,
      gmailRes,
      emailRes,
      topEndpointRes,
      pluginFailRes,
    ] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS n
           FROM audit_log
          WHERE ${scopeField} = $1
            AND created_at >= $2
            AND event <> ALL($3::text[])`,
        [scopeValue, since, denyArray],
      ),
      pool.query(
        `SELECT COUNT(*)::int                       AS n,
                COALESCE(SUM(charged_usd_micro), 0) AS cost_micro
           FROM ai_usage_events
          WHERE org_id = $1 AND created_at >= $2`,
        [scopeValue, since],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n
           FROM plugin_runs
          WHERE org_id = $1 AND started_at >= $2`,
        [scopeValue, since],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n
           FROM deal_intel_summaries
          WHERE org_id = $1 AND generated_at >= $2`,
        [scopeValue, since],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n
           FROM deal_gmail_summaries
          WHERE org_id = $1 AND generated_at >= $2`,
        [scopeValue, since],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n
           FROM email_sends
          WHERE org_id = $1 AND sent_at >= $2`,
        [scopeValue, since],
      ),
      pool.query(
        `SELECT endpoint, COUNT(*)::int AS n
           FROM ai_usage_events
          WHERE org_id = $1 AND created_at >= $2
          GROUP BY endpoint
          ORDER BY n DESC
          LIMIT 1`,
        [scopeValue, since],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n
           FROM plugin_runs
          WHERE org_id = $1
            AND started_at >= $2
            AND status IN ('error', 'timeout', 'memory_exceeded', 'killed', 'quota_exceeded', 'rejected')`,
        [scopeValue, since],
      ),
    ]);

    res.json({
      success: true,
      data: {
        counts: {
          audit_events:  auditRes.rows[0].n,
          ai_calls:      aiRes.rows[0].n,
          plugin_runs:   pluginRes.rows[0].n,
          drive_intels:  driveRes.rows[0].n,
          gmail_intels:  gmailRes.rows[0].n,
          emails_sent:   emailRes.rows[0].n,
        },
        ai_cost_usd:     microToDollars(aiRes.rows[0].cost_micro),
        plugin_failures: pluginFailRes.rows[0].n,
        top_endpoint:    topEndpointRes.rows[0]?.endpoint || null,
        window: {
          since: since.toISOString(),
          until: new Date().toISOString(),
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// GET /api/admin/org-activity/feed?since=24h&cursor=<iso>&limit=50
// Merged timeline. Returns `items` sorted newest-first plus `next_cursor`.
//
// Strategy: pull the most-recent `limit` rows from each kind (bounded by the
// since window AND the cursor if any), tag them with their `kind`, merge,
// sort by `at` DESC, slice to `limit`, and emit the next cursor as the
// oldest `at` in the slice. Per-kind cap = `limit` keeps the working set
// O(6 × limit) which at the max of 200 is 1200 rows — trivial.
// ===========================================================================
router.get('/feed', async (req, res, next) => {
  try {
    const since  = parseSince(req.query.since);
    const cursor = parseCursor(req.query.cursor);
    const limit  = parseLimit(req.query.limit);
    const [scopeField, scopeValue] = qs(req);

    const denyArray = Array.from(AUDIT_EVENT_DENYLIST);

    // -----------------------------------------------------------------------
    // 1) audit_log — non-noisy events with actor email.
    // -----------------------------------------------------------------------
    const auditTime = timeFilter('a.created_at', since, cursor, 2);
    const auditP    = pool.query(
      `SELECT a.created_at AS at,
              a.event,
              a.success,
              a.meta,
              a.target_type,
              a.target_id,
              u.email AS actor_email
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.${scopeField} = $1
          AND ${auditTime.where}
          AND a.event <> ALL($${auditTime.nextIdx}::text[])
        ORDER BY a.created_at DESC
        LIMIT ${limit}`,
      [scopeValue, ...auditTime.params, denyArray],
    );

    // -----------------------------------------------------------------------
    // 2) ai_usage_events — Claude calls with cost.
    // -----------------------------------------------------------------------
    const aiTime = timeFilter('e.created_at', since, cursor, 2);
    const aiP    = pool.query(
      `SELECT e.created_at AS at,
              e.endpoint,
              e.model,
              e.input_tokens,
              e.output_tokens,
              e.charged_usd_micro,
              u.email AS user_email
         FROM ai_usage_events e
         LEFT JOIN users u ON u.id = e.user_id
        WHERE e.org_id = $1
          AND ${aiTime.where}
        ORDER BY e.created_at DESC
        LIMIT ${limit}`,
      [scopeValue, ...aiTime.params],
    );

    // -----------------------------------------------------------------------
    // 3) plugin_runs — sandbox executions with status + duration.
    // -----------------------------------------------------------------------
    const prTime = timeFilter('r.started_at', since, cursor, 2);
    const pluginP = pool.query(
      `SELECT r.started_at AS at,
              r.ended_at,
              r.status,
              r.cpu_ms,
              r.ai_input_tokens,
              r.ai_output_tokens,
              p.name AS plugin_name,
              p.id   AS plugin_id
         FROM plugin_runs r
         JOIN plugins p ON p.id = r.plugin_id
        WHERE r.org_id = $1
          AND ${prTime.where}
        ORDER BY r.started_at DESC
        LIMIT ${limit}`,
      [scopeValue, ...prTime.params],
    );

    // -----------------------------------------------------------------------
    // 4) deal_intel_summaries — Drive intel generations.
    // -----------------------------------------------------------------------
    const diTime = timeFilter('s.generated_at', since, cursor, 2);
    const driveP = pool.query(
      `SELECT s.generated_at AS at,
              s.deal_id,
              s.files_analyzed_count,
              s.tokens_input,
              s.tokens_output,
              d.title AS deal_title
         FROM deal_intel_summaries s
         LEFT JOIN deals d ON d.id = s.deal_id
        WHERE s.org_id = $1
          AND ${diTime.where}
        ORDER BY s.generated_at DESC
        LIMIT ${limit}`,
      [scopeValue, ...diTime.params],
    );

    // -----------------------------------------------------------------------
    // 5) deal_gmail_summaries — Gmail intel generations.
    // -----------------------------------------------------------------------
    const giTime = timeFilter('s.generated_at', since, cursor, 2);
    const gmailP = pool.query(
      `SELECT s.generated_at AS at,
              s.deal_id,
              s.thread_link_id,
              s.ai_input_tokens,
              s.ai_output_tokens,
              s.next_step,
              d.title AS deal_title
         FROM deal_gmail_summaries s
         LEFT JOIN deals d ON d.id = s.deal_id
        WHERE s.org_id = $1
          AND ${giTime.where}
        ORDER BY s.generated_at DESC
        LIMIT ${limit}`,
      [scopeValue, ...giTime.params],
    );

    // -----------------------------------------------------------------------
    // 6) email_sends — outbound emails.
    // -----------------------------------------------------------------------
    const esTime = timeFilter('s.sent_at', since, cursor, 2);
    const emailP = pool.query(
      `SELECT s.sent_at AS at,
              s.to_email,
              s.subject,
              s.opened_at,
              s.provider_message_id,
              u.email AS sender_email
         FROM email_sends s
         LEFT JOIN users u ON u.id = s.sent_by
        WHERE s.org_id = $1
          AND ${esTime.where}
        ORDER BY s.sent_at DESC
        LIMIT ${limit}`,
      [scopeValue, ...esTime.params],
    );

    const [auditR, aiR, pluginR, driveR, gmailR, emailR] = await Promise.all([
      auditP, aiP, pluginP, driveP, gmailP, emailP,
    ]);

    // -----------------------------------------------------------------------
    // Merge + tag. Each row gets a `kind` and a normalized `at`.
    // -----------------------------------------------------------------------
    const items = [];

    for (const r of auditR.rows) {
      items.push({
        kind: 'audit_event',
        at: r.at,
        event: r.event,
        success: r.success !== false,
        actor_email: r.actor_email || null,
        target_type: r.target_type || null,
        target_id:   r.target_id   || null,
        meta_summary: summarizeAuditMeta(r.meta),
      });
    }

    for (const r of aiR.rows) {
      items.push({
        kind: 'ai_call',
        at: r.at,
        endpoint: r.endpoint,
        model: r.model,
        user_email: r.user_email || null,
        tokens: (r.input_tokens || 0) + (r.output_tokens || 0),
        cost_usd: microToDollars(r.charged_usd_micro),
      });
    }

    for (const r of pluginR.rows) {
      const startedAt = r.at;
      const endedAt   = r.ended_at;
      const durationMs = endedAt && startedAt
        ? new Date(endedAt).getTime() - new Date(startedAt).getTime()
        : null;
      items.push({
        kind: 'plugin_run',
        at: startedAt,
        plugin_id: r.plugin_id,
        plugin_name: r.plugin_name,
        status: r.status,
        duration_ms: durationMs,
        ai_tokens: (r.ai_input_tokens || 0) + (r.ai_output_tokens || 0),
        cpu_ms: r.cpu_ms || 0,
      });
    }

    for (const r of driveR.rows) {
      items.push({
        kind: 'drive_intel',
        at: r.at,
        deal_id: r.deal_id,
        deal_title: r.deal_title || null,
        files_analyzed: r.files_analyzed_count || 0,
        tokens: (r.tokens_input || 0) + (r.tokens_output || 0),
      });
    }

    for (const r of gmailR.rows) {
      items.push({
        kind: 'gmail_intel',
        at: r.at,
        deal_id: r.deal_id,
        deal_title: r.deal_title || null,
        thread_link_id: r.thread_link_id,
        next_step: r.next_step || null,
        tokens: (r.ai_input_tokens || 0) + (r.ai_output_tokens || 0),
      });
    }

    for (const r of emailR.rows) {
      items.push({
        kind: 'email_send',
        at: r.at,
        to: r.to_email,
        subject: r.subject || null,
        sender_email: r.sender_email || null,
        status: r.provider_message_id ? 'sent' : 'pending',
        opened: !!r.opened_at,
      });
    }

    // Sort merged set newest-first. Use getTime() so we get a stable numeric
    // comparison even if `at` is a Date or string.
    items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    const page = items.slice(0, limit);
    const next_cursor = page.length === limit && page.length > 0
      ? new Date(page[page.length - 1].at).toISOString()
      : null;

    res.json({
      success: true,
      data: {
        items: page,
        next_cursor,
        window: {
          since: since.toISOString(),
          until: new Date().toISOString(),
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

// Test hooks — exported so unit tests can exercise the pure helpers without
// hitting the route handler. Not part of the public router contract.
module.exports.__test__ = {
  AUDIT_EVENT_DENYLIST,
  parseSince,
  parseLimit,
  parseCursor,
  summarizeAuditMeta,
  microToDollars,
};
