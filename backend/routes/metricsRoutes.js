// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');

const router = express.Router();
router.use(authMiddleware);

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

router.get('/dashboard', async (req, res) => {
  try {
    const [sf, sv] = qs(req);

    const totals = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE phase = 'pre_sale')                              AS pre_sale_count,
         COUNT(*) FILTER (WHERE phase = 'post_sale')                             AS post_sale_count,
         COUNT(*) FILTER (WHERE phase = 'post_ship')                             AS post_ship_count,
         COUNT(*) FILTER (WHERE stage = 'CLOSED_PAID' OR stage = 'INVOICED')     AS won_count,
         COUNT(*) FILTER (WHERE stage = 'LOST')                                  AS lost_count,
         COUNT(*) FILTER (WHERE hot_flag = TRUE AND phase = 'pre_sale')          AS hot_count,
         COALESCE(SUM(amount) FILTER (WHERE phase = 'pre_sale'), 0)              AS pre_sale_value,
         COALESCE(SUM(amount) FILTER (WHERE phase = 'post_sale'), 0)             AS post_sale_value,
         COALESCE(SUM(amount) FILTER (WHERE stage = 'CLOSED_PAID' OR stage = 'INVOICED'), 0) AS won_value
       FROM deals WHERE ${sf} = $1`,
      [sv]
    );

    const byStage = await pool.query(
      `SELECT stage, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS value
       FROM deals WHERE ${sf} = $1 GROUP BY stage ORDER BY stage`,
      [sv]
    );

    const issues = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'open' AND urgency = 'red')    AS red_open,
         COUNT(*) FILTER (WHERE status = 'open' AND urgency = 'yellow') AS yellow_open,
         COUNT(*) FILTER (WHERE status = 'open' AND urgency = 'green')  AS green_open,
         COUNT(*) FILTER (WHERE status = 'open' AND blocks_workflow)    AS blocking_open
       FROM issues WHERE ${sf} = $1`,
      [sv]
    );

    const tasks = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'open')                                              AS open_tasks,
         COUNT(*) FILTER (WHERE status = 'open' AND due_date < CURRENT_DATE)                  AS overdue_tasks
       FROM tasks WHERE ${sf} = $1`,
      [sv]
    );

    const counts = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM contacts WHERE ${sf} = $1)                                       AS contacts,
         (SELECT COUNT(*) FROM companies WHERE ${sf} = $1 AND type = 'customer')                AS customers,
         (SELECT COUNT(*) FROM companies WHERE ${sf} = $1 AND type = 'vendor')                  AS vendors,
         (SELECT COUNT(*) FROM quotes WHERE ${sf} = $1)                                         AS quotes`,
      [sv]
    );

    const presaleFunnel = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE stage = 'TRIAGE')                       AS triage,
         COUNT(*) FILTER (WHERE stage = 'VENDOR_QUOTING')               AS vendor_quoting,
         COUNT(*) FILTER (WHERE stage = 'CUSTOMER_QUOTING')             AS customer_quoting,
         COUNT(*) FILTER (WHERE stage = 'FOLLOW_UP')                    AS follow_up,
         COUNT(*) FILTER (WHERE stage = 'NO_FOLLOW_UP')                 AS no_follow_up,
         COUNT(*) FILTER (WHERE stage = 'COLD')                         AS cold,
         COUNT(*) FILTER (WHERE stage = 'LOST')                         AS lost
       FROM deals WHERE ${sf} = $1`,
      [sv]
    );

    res.json({
      totals: totals.rows[0],
      by_stage: byStage.rows,
      issues: issues.rows[0],
      tasks: tasks.rows[0],
      counts: counts.rows[0],
      pre_sale_funnel: presaleFunnel.rows[0],
    });
  } catch (error) {
    console.error('Metrics dashboard error:', error);
    res.status(500).json({ error: 'Failed to compute metrics' });
  }
});

router.get('/vendor-performance', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(
      `SELECT v.id, v.name,
              COUNT(vq.id)                                          AS rfqs_sent,
              COUNT(vq.id) FILTER (WHERE vq.status = 'received')    AS quotes_received,
              COUNT(vq.id) FILTER (WHERE vq.is_selected)            AS selected,
              COALESCE(AVG(vq.lead_time_days), 0)                   AS avg_lead_time,
              COALESCE(SUM(vq.amount) FILTER (WHERE vq.is_selected), 0) AS won_value
       FROM companies v
       LEFT JOIN vendor_quotes vq ON vq.vendor_id = v.id
       WHERE v.${sf} = $1 AND v.type = 'vendor'
       GROUP BY v.id, v.name
       ORDER BY won_value DESC NULLS LAST, v.name`,
      [sv]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Vendor performance error:', error);
    res.status(500).json({ error: 'Failed to compute vendor metrics' });
  }
});

// Per-salesman pipeline + commission summary. Aggregates the same numbers as
// the org dashboard but grouped by users.id (the salesman_id on each deal).
router.get('/salesman', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(
      `SELECT u.id, u.email, u.name,
              COUNT(d.id) FILTER (WHERE d.phase = 'pre_sale')                              AS pre_sale_count,
              COUNT(d.id) FILTER (WHERE d.phase = 'post_sale')                             AS post_sale_count,
              COUNT(d.id) FILTER (WHERE d.stage IN ('CLOSED_PAID', 'INVOICED', 'closed_won')) AS won_count,
              COUNT(d.id) FILTER (WHERE d.stage IN ('LOST', 'closed_lost'))                AS lost_count,
              COUNT(d.id) FILTER (WHERE d.hot_flag = TRUE)                                 AS hot_count,
              COALESCE(SUM(d.amount) FILTER (WHERE d.phase = 'pre_sale'), 0)               AS pipeline_value,
              COALESCE(SUM(d.amount) FILTER (WHERE d.stage IN ('CLOSED_PAID', 'INVOICED', 'closed_won')), 0) AS won_value
       FROM users u
       LEFT JOIN deals d ON d.salesman_id = u.id AND d.${sf} = $1
       WHERE u.${sf} = $1
       GROUP BY u.id, u.email, u.name
       ORDER BY won_value DESC, u.name`,
      [sv]
    );
    const rows = result.rows.map(r => {
      const wonCount = Number(r.won_count || 0);
      const lostCount = Number(r.lost_count || 0);
      const hitRate = (wonCount + lostCount) > 0
        ? Math.round((wonCount / (wonCount + lostCount)) * 100)
        : null;
      return { ...r, hit_rate: hitRate };
    });
    res.json({ success: true, salesmen: rows });
  } catch (error) {
    console.error('Salesman metrics error:', error);
    res.status(500).json({ error: 'Failed to compute salesman metrics' });
  }
});

// =============================================================================
// COMPREHENSIVE REPORTS — implements the metrics specified in Exhibit A
// (page 17–18). Returns JSON shaped so a single front-end Reports page can
// render every block. Supports `window=ytd|7d|all` for time-bucketed metrics.
// =============================================================================

// `custom` requires validated YYYY-MM-DD strings (the caller checks them
// before passing). We inline them as `'…'::date` literals after the regex
// match, which is safe — anything that's not exactly ten digit/dash chars is
// rejected upstream. End date is exclusive-of-next-day so it's inclusive in
// human terms.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_WINDOWS = ['7d', 'month', 'quarter', 'ytd', 'all', 'custom'];

function windowClause(window, column = 'created_at', dateFrom = null, dateTo = null) {
  if (window === '7d')      return `${column} >= NOW() - INTERVAL '7 days'`;
  if (window === 'month')   return `${column} >= date_trunc('month', NOW())`;
  if (window === 'quarter') return `${column} >= date_trunc('quarter', NOW())`;
  if (window === 'ytd')     return `${column} >= date_trunc('year', NOW())`;
  if (window === 'custom' && ISO_DATE_RE.test(dateFrom || '') && ISO_DATE_RE.test(dateTo || '')) {
    return `${column} >= '${dateFrom}'::date AND ${column} < ('${dateTo}'::date + INTERVAL '1 day')`;
  }
  return '1=1';
}

// --- Date helpers for the period-over-period comparison + time-bucketed series.
// All ISO strings; we never trust user input here — we compute dates server-side
// from the validated window enum (or from the already-validated custom dates).
function toISODate(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Returns { from, to } for the *current* window in ISO date strings. `to` is
// inclusive. `all` returns nulls (we won't bucket / compare in that case).
function currentRange(window, dateFrom, dateTo, now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (window === '7d') {
    const from = new Date(today); from.setUTCDate(from.getUTCDate() - 6);
    return { from: toISODate(from), to: toISODate(today) };
  }
  if (window === 'month') {
    const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    return { from: toISODate(from), to: toISODate(today) };
  }
  if (window === 'quarter') {
    const q = Math.floor(today.getUTCMonth() / 3);
    const from = new Date(Date.UTC(today.getUTCFullYear(), q * 3, 1));
    return { from: toISODate(from), to: toISODate(today) };
  }
  if (window === 'ytd') {
    const from = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
    return { from: toISODate(from), to: toISODate(today) };
  }
  if (window === 'custom') return { from: dateFrom, to: dateTo };
  return { from: null, to: null };
}

// Returns { from, to } for the *prior* equal-length period — see the route
// docstring for the per-window definition. Returns nulls for `all`.
function priorRange(window, dateFrom, dateTo, now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (window === '7d') {
    // Previous 7-day block: 14 days ago through 8 days ago.
    const to = new Date(today); to.setUTCDate(to.getUTCDate() - 7);
    const from = new Date(to); from.setUTCDate(from.getUTCDate() - 6);
    return { from: toISODate(from), to: toISODate(to) };
  }
  if (window === 'month') {
    const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
    return { from: toISODate(from), to: toISODate(to) };
  }
  if (window === 'quarter') {
    const q = Math.floor(today.getUTCMonth() / 3);
    const from = new Date(Date.UTC(today.getUTCFullYear(), (q - 1) * 3, 1));
    const to = new Date(Date.UTC(today.getUTCFullYear(), q * 3, 0));
    return { from: toISODate(from), to: toISODate(to) };
  }
  if (window === 'ytd') {
    // Same day-of-year previous year through Jan 1 of last year.
    const from = new Date(Date.UTC(today.getUTCFullYear() - 1, 0, 1));
    const to = new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate()));
    return { from: toISODate(from), to: toISODate(to) };
  }
  if (window === 'custom') {
    // Equal-length window immediately before `from`.
    const f = new Date(`${dateFrom}T00:00:00Z`);
    const t = new Date(`${dateTo}T00:00:00Z`);
    const days = Math.round((t - f) / 86400000) + 1; // inclusive
    const prevTo = new Date(f); prevTo.setUTCDate(prevTo.getUTCDate() - 1);
    const prevFrom = new Date(prevTo); prevFrom.setUTCDate(prevFrom.getUTCDate() - (days - 1));
    return { from: toISODate(prevFrom), to: toISODate(prevTo) };
  }
  return { from: null, to: null };
}

// Granularity for the time-bucketed series — chosen per the route spec.
function bucketGranularity(window, dateFrom, dateTo) {
  if (window === '7d')     return 'day';
  if (window === 'month')  return 'day';
  if (window === 'quarter')return 'week';
  if (window === 'ytd')    return 'month';
  if (window === 'all')    return 'month';
  if (window === 'custom') {
    const f = new Date(`${dateFrom}T00:00:00Z`);
    const t = new Date(`${dateTo}T00:00:00Z`);
    const days = Math.round((t - f) / 86400000) + 1;
    if (days <= 60)  return 'day';
    if (days <= 365) return 'week';
    return 'month';
  }
  return 'month';
}

// Postgres `date_trunc` unit name + a comparable JS bucket. Recharts wants
// `YYYY-MM-DD` strings on the x-axis; we keep that shape for all granularities
// (week buckets keyed to the Monday of the week, month buckets to the 1st).
function pgTruncUnit(granularity) {
  return granularity; // 'day' | 'week' | 'month' all valid for date_trunc
}

router.get('/reports', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const window = VALID_WINDOWS.includes(req.query.window) ? req.query.window : 'ytd';

    let dateFrom = null, dateTo = null;
    if (window === 'custom') {
      dateFrom = req.query.from;
      dateTo = req.query.to;
      if (!ISO_DATE_RE.test(dateFrom || '') || !ISO_DATE_RE.test(dateTo || '')) {
        return res.status(400).json({ error: 'custom window requires from=YYYY-MM-DD and to=YYYY-MM-DD' });
      }
      if (dateFrom > dateTo) {
        return res.status(400).json({ error: 'from must be on or before to' });
      }
    }

    const cwSqlDeals = windowClause(window, 'd.created_at', dateFrom, dateTo);

    // ------------- Sales / hit rate / funnel transitions -----------------
    const sales = await pool.query(
      `WITH d AS (SELECT * FROM deals WHERE ${sf} = $1)
       SELECT
         COUNT(*) FILTER (WHERE stage IN ('CLOSED_PAID','INVOICED','closed_won') AND ${cwSqlDeals})         AS won,
         COUNT(*) FILTER (WHERE stage IN ('LOST','closed_lost') AND ${cwSqlDeals})                          AS lost,
         COUNT(*) FILTER (WHERE stage = 'TRIAGE' AND ${cwSqlDeals})                                         AS triage,
         COUNT(*) FILTER (WHERE stage IN ('VENDOR_QUOTING','CUSTOMER_QUOTING') AND ${cwSqlDeals})           AS quoting,
         COUNT(*) FILTER (WHERE stage = 'FOLLOW_UP' AND ${cwSqlDeals})                                      AS follow_up,
         COUNT(*) FILTER (WHERE stage = 'NO_FOLLOW_UP' AND ${cwSqlDeals})                                   AS no_follow_up,
         COUNT(*) FILTER (WHERE stage = 'COLD' AND ${cwSqlDeals})                                           AS cold,
         COALESCE(AVG(EXTRACT(EPOCH FROM (closed_date - created_at)) / 86400.0)
                  FILTER (WHERE closed_date IS NOT NULL AND stage IN ('CLOSED_PAID','INVOICED','closed_won') AND ${cwSqlDeals}), 0) AS avg_days_to_close
       FROM d`,
      [sv]
    );
    const s = sales.rows[0];
    const won = Number(s.won || 0);
    const lost = Number(s.lost || 0);
    const hitRate = (won + lost) > 0 ? Math.round((won / (won + lost)) * 100) : null;

    // ------------- Per-vendor (quoted vs won totals; hit rate) -----------
    const perVendor = await pool.query(
      `SELECT v.id, v.name,
              COALESCE(SUM(vq.amount), 0)                                          AS quoted_total,
              COALESCE(SUM(vq.amount) FILTER (WHERE vq.is_selected), 0)            AS won_total,
              COUNT(DISTINCT vq.deal_id)                                           AS deals_quoted,
              COUNT(DISTINCT vq.deal_id) FILTER (WHERE vq.is_selected)             AS deals_won,
              COALESCE(AVG(vq.lead_time_days), 0)                                  AS avg_lead_time_days
       FROM companies v
       LEFT JOIN vendor_quotes vq ON vq.vendor_id = v.id AND ${windowClause(window, 'vq.created_at', dateFrom, dateTo)}
       WHERE v.${sf} = $1 AND v.type = 'vendor'
       GROUP BY v.id, v.name
       ORDER BY won_total DESC NULLS LAST, v.name`,
      [sv]
    );
    const vendorRows = perVendor.rows.map(r => {
      const dq = Number(r.deals_quoted || 0);
      const dw = Number(r.deals_won || 0);
      return { ...r, vendor_hit_rate: dq > 0 ? Math.round((dw / dq) * 100) : null };
    });

    // ------------- Per-salesman with EOY commission projection -----------
    // Simple linear projection: (won_value YTD / days_elapsed_ytd) * 365
    const perSalesman = await pool.query(
      `WITH d AS (SELECT * FROM deals WHERE ${sf} = $1),
            elapsed AS (SELECT EXTRACT(DAY FROM (NOW() - date_trunc('year', NOW())))::float + 1 AS days)
       SELECT u.id, u.email, u.name,
              COUNT(d.id) FILTER (WHERE d.stage IN ('CLOSED_PAID','INVOICED','closed_won') AND ${cwSqlDeals})   AS won_count,
              COUNT(d.id) FILTER (WHERE d.stage IN ('LOST','closed_lost') AND ${cwSqlDeals})                    AS lost_count,
              COUNT(d.id) FILTER (WHERE d.phase = 'pre_sale')                                                   AS open_pipeline,
              COUNT(d.id) FILTER (WHERE d.hot_flag AND d.phase = 'pre_sale')                                    AS hot,
              COALESCE(SUM(d.amount) FILTER (WHERE d.phase = 'pre_sale'), 0)                                    AS pipeline_value,
              COALESCE(SUM(d.amount) FILTER (WHERE d.stage IN ('CLOSED_PAID','INVOICED','closed_won') AND d.created_at >= date_trunc('year', NOW())), 0) AS ytd_won_value,
              (SELECT days FROM elapsed) AS days_elapsed
       FROM users u
       LEFT JOIN d ON d.salesman_id = u.id
       WHERE u.${sf} = $1
       GROUP BY u.id, u.email, u.name
       ORDER BY ytd_won_value DESC, u.name`,
      [sv]
    );
    const salesmen = perSalesman.rows.map(r => {
      const wc = Number(r.won_count || 0), lc = Number(r.lost_count || 0);
      const ytd = Number(r.ytd_won_value || 0);
      const days = Number(r.days_elapsed || 1);
      const projected = days > 0 ? Math.round((ytd / days) * 365) : 0;
      return {
        ...r,
        hit_rate: (wc + lc) > 0 ? Math.round((wc / (wc + lc)) * 100) : null,
        eoy_projected_won: projected,
      };
    });

    // ------------- Per-stage live counts + value (company-wide) ----------
    const perStage = await pool.query(
      `SELECT stage, phase, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS value
       FROM deals WHERE ${sf} = $1
       GROUP BY stage, phase
       ORDER BY phase, stage`,
      [sv]
    );

    // ------------- Issues breakdown --------------------------------------
    const issuesBreak = await pool.query(
      `SELECT
         category,
         COUNT(*) FILTER (WHERE status = 'open')                                AS open_count,
         COUNT(*)                                                               AS total,
         COUNT(*) FILTER (WHERE urgency = 'red')                                AS red,
         COUNT(*) FILTER (WHERE urgency = 'yellow')                             AS yellow,
         COUNT(*) FILTER (WHERE urgency = 'green')                              AS green,
         COALESCE(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600.0)
                  FILTER (WHERE resolved_at IS NOT NULL), 0)                    AS avg_resolution_hours
       FROM issues WHERE ${sf} = $1 AND ${windowClause(window, 'created_at', dateFrom, dateTo)}
       GROUP BY category
       ORDER BY open_count DESC`,
      [sv]
    );

    // ------------- Issues per salesman + per primary impact --------------
    const issuesPerSalesman = await pool.query(
      `SELECT u.id, u.email, u.name,
              COUNT(i.id) FILTER (WHERE i.status = 'open')   AS open_count,
              COUNT(i.id)                                    AS total
       FROM users u
       LEFT JOIN deals d ON d.salesman_id = u.id AND d.${sf} = $1
       LEFT JOIN issues i ON i.related_type = 'deal' AND i.related_id = d.id AND ${windowClause(window, 'i.created_at', dateFrom, dateTo)}
       WHERE u.${sf} = $1
       GROUP BY u.id, u.email, u.name
       ORDER BY open_count DESC NULLS LAST, u.name`,
      [sv]
    );

    const issuesByImpact = await pool.query(
      `SELECT financial_impact, COUNT(*) AS count
       FROM issues WHERE ${sf} = $1 AND financial_impact IS NOT NULL AND ${windowClause(window, 'created_at', dateFrom, dateTo)}
       GROUP BY financial_impact ORDER BY count DESC`,
      [sv]
    );

    // ------------- New customers / Dormant customers (filter helpers) -----
    const customerFlags = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE first_deal_at >= date_trunc('year', NOW()))     AS new_this_year,
         COUNT(*) FILTER (WHERE first_deal_at >= NOW() - INTERVAL '90 days')    AS new_90d,
         COUNT(*) FILTER (WHERE last_deal_at IS NOT NULL AND last_deal_at < NOW() - INTERVAL '180 days') AS dormant_180d,
         COUNT(*) FILTER (WHERE last_deal_at IS NOT NULL AND last_deal_at < NOW() - INTERVAL '365 days') AS dormant_1y,
         COUNT(*) FILTER (WHERE type = 'customer')                              AS total_customers,
         COUNT(*) FILTER (WHERE type = 'vendor')                                AS total_vendors
       FROM companies WHERE ${sf} = $1`,
      [sv]
    );

    // ------------- Prior-period aggregate (PoP comparison) ---------------
    // Compute the equal-length prior window and run the same `sales` aggregate
    // against it so the FE can render "↑12% vs prior period" deltas. `all`
    // has no meaningful comparator, so we return `null` for prev there.
    let prev = null;
    if (window !== 'all') {
      const pr = priorRange(window, dateFrom, dateTo);
      if (pr.from && pr.to) {
        // We always pass `custom` to windowClause for the prior window because
        // we want it to consume our computed from/to dates verbatim.
        const prevClause = windowClause('custom', 'd.created_at', pr.from, pr.to);
        const prevSales = await pool.query(
          `WITH d AS (SELECT * FROM deals WHERE ${sf} = $1)
           SELECT
             COUNT(*) FILTER (WHERE stage IN ('CLOSED_PAID','INVOICED','closed_won') AND ${prevClause}) AS won,
             COUNT(*) FILTER (WHERE stage IN ('LOST','closed_lost') AND ${prevClause})                  AS lost,
             COALESCE(AVG(EXTRACT(EPOCH FROM (closed_date - created_at)) / 86400.0)
                      FILTER (WHERE closed_date IS NOT NULL AND stage IN ('CLOSED_PAID','INVOICED','closed_won') AND ${prevClause}), 0) AS avg_days_to_close
           FROM d`,
          [sv]
        );
        const ps = prevSales.rows[0];
        const pWon = Number(ps.won || 0);
        const pLost = Number(ps.lost || 0);
        prev = {
          range: pr,
          won: pWon,
          lost: pLost,
          hit_rate: (pWon + pLost) > 0 ? Math.round((pWon / (pWon + pLost)) * 100) : null,
          avg_days_to_close: Math.round(Number(ps.avg_days_to_close || 0)),
        };
      }
    }

    // ------------- Time-bucketed series (chart strip) --------------------
    // We bucket by day / week / month depending on the window size and emit
    // a stable row shape: { bucket_start, won_count, lost_count, won_value,
    // pipeline_value_snapshot }. pipeline_value_snapshot is a running snapshot
    // of pre_sale deals open at the bucket boundary — useful for the Pipeline
    // tab chart.
    const cur = currentRange(window, dateFrom, dateTo);
    const granularity = bucketGranularity(window, dateFrom, dateTo);
    let series = [];
    if (cur.from && cur.to) {
      const unit = pgTruncUnit(granularity);
      // The PoP series uses the same window-clause shape as the rest of the
      // route. We anchor buckets to the truncated boundary of created_at so
      // weekly/monthly aggregates land on predictable dates.
      const seriesQ = await pool.query(
        `WITH d AS (SELECT * FROM deals WHERE ${sf} = $1),
              cur AS (
                SELECT
                  date_trunc('${unit}', created_at)::date AS bucket_start,
                  COUNT(*) FILTER (WHERE stage IN ('CLOSED_PAID','INVOICED','closed_won')) AS won_count,
                  COUNT(*) FILTER (WHERE stage IN ('LOST','closed_lost'))                  AS lost_count,
                  COALESCE(SUM(amount) FILTER (WHERE stage IN ('CLOSED_PAID','INVOICED','closed_won')), 0) AS won_value
                FROM d
                WHERE created_at >= '${cur.from}'::date
                  AND created_at < ('${cur.to}'::date + INTERVAL '1 day')
                GROUP BY bucket_start
              ),
              snap AS (
                -- running pipeline snapshot: sum of pre_sale deal amounts
                -- created on or before each bucket_start.
                SELECT c.bucket_start,
                       COALESCE((SELECT SUM(amount) FROM d
                                 WHERE phase = 'pre_sale'
                                   AND created_at <= c.bucket_start + INTERVAL '1 day'), 0) AS pipeline_value_snapshot
                FROM cur c
              )
         SELECT cur.bucket_start, cur.won_count, cur.lost_count, cur.won_value,
                snap.pipeline_value_snapshot
         FROM cur LEFT JOIN snap USING (bucket_start)
         ORDER BY bucket_start`,
        [sv]
      );
      series = seriesQ.rows.map(r => ({
        bucket_start: toISODate(new Date(r.bucket_start)),
        won_count: Number(r.won_count || 0),
        lost_count: Number(r.lost_count || 0),
        won_value: Number(r.won_value || 0),
        pipeline_value_snapshot: Number(r.pipeline_value_snapshot || 0),
      }));
    }

    // ------------- Top customers per salesman (EOY) ----------------------
    const topCustomers = await pool.query(
      `SELECT u.id AS salesman_id, u.name AS salesman_name,
              c.id AS customer_id, c.name AS customer_name,
              COALESCE(SUM(d.amount), 0) AS value,
              COUNT(d.id) AS deal_count
       FROM deals d
       JOIN users u ON u.id = d.salesman_id
       LEFT JOIN companies c ON c.id = d.customer_id
       WHERE d.${sf} = $1
         AND d.stage IN ('CLOSED_PAID', 'INVOICED', 'closed_won')
         AND d.created_at >= date_trunc('year', NOW())
       GROUP BY u.id, u.name, c.id, c.name
       ORDER BY u.name, value DESC`,
      [sv]
    );

    res.json({
      window,
      sales: {
        won, lost, hit_rate: hitRate,
        triage: Number(s.triage || 0),
        quoting: Number(s.quoting || 0),
        follow_up: Number(s.follow_up || 0),
        no_follow_up: Number(s.no_follow_up || 0),
        cold: Number(s.cold || 0),
        avg_days_to_close: Math.round(Number(s.avg_days_to_close || 0)),
      },
      vendors: vendorRows,
      salesmen,
      per_stage: perStage.rows,
      issues: {
        by_category: issuesBreak.rows,
        per_salesman: issuesPerSalesman.rows,
        by_financial_impact: issuesByImpact.rows,
      },
      customers: customerFlags.rows[0],
      top_customers_per_salesman: topCustomers.rows,
      // PoP comparison + time-bucketed series. `prev` is null for window=all
      // (no comparable prior period). `series` is empty when the current
      // window has no deal activity. `granularity` lets the FE label charts.
      prev,
      series,
      granularity,
      range: cur,
    });
  } catch (error) {
    console.error('Reports error:', error);
    res.status(500).json({ error: 'Failed to compute reports', detail: error.message });
  }
});

module.exports = router;
