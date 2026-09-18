// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Sales forecasting engine — weighted pipeline, projected-close-by-period, and
// quota attainment. Pure-math core (buildForecast) is DB-free so it unit-tests
// cleanly; getForecast/getQuota run ONE org-scoped, parameterized query and hand
// the raw rows to the pure core.
//
// SQL SAFETY (same contract as services/reportBuilder.js):
//   • The only interpolated identifier is the scope field, which is validated
//     against a two-value allowlist (org_id | user_id) before it can touch SQL.
//   • Every value — the scope value included — is a bound parameter ($1…).
//   • No user input is ever concatenated into a query.
//
// PROFILE AWARENESS: won / lost / open classification varies per white-label
// profile (see frontend/src/stages.js `terminalStageIds`). We keep a small,
// deliberately-explicit per-profile terminal-stage map here — the backend has no
// import path to the frontend stage config, and mirroring it (with a note to
// keep them in sync) is the established pattern for this codebase.

const SCOPE_FIELDS = new Set(['org_id', 'user_id']);

// --- Per-profile terminal stages -------------------------------------------
// won  = revenue realized / deal landed.
// lost = dead, no revenue.
// Anything not in either set is treated as OPEN (still forecastable).
// Casing matches deals.stage exactly (see backend/utils/dealStages.js).
const TERMINAL_STAGES = {
  generic: { won: ['closed_won'],                 lost: ['closed_lost'] },
  rin:     { won: ['closed_won'],                 lost: ['closed_lost'] },
  jcp:     { won: ['CLOSED_WON'],                 lost: ['CLOSED_LOST'] },
  // Zang: INVOICED / CLOSED_PAID / CLOSED are the "revenue realized" terminals
  // (mirrors the metricsRoutes won filter, plus CLOSED = completed-no-billable).
  // LOST / CANCELLED are the dead terminals. Everything from NOT_PROCESSED
  // through TBI/COMM_WATCH is an in-flight post-sale deal → still open.
  zang:    { won: ['INVOICED', 'CLOSED_PAID', 'CLOSED', 'closed_won'], lost: ['LOST', 'CANCELLED', 'closed_lost'] },
};

// Stage-based default win probability, used only when a deal has no explicit
// `probability` set (the column defaults to 0). Keeps the weighted pipeline
// meaningful for orgs that never hand-set per-deal odds. Unknown open stages
// fall back to DEFAULT_OPEN_PROBABILITY.
const DEFAULT_OPEN_PROBABILITY = 0.5;
const STAGE_DEFAULT_PROBABILITY = {
  // generic / rin
  lead: 0.10, qualified: 0.25, proposal: 0.50, negotiation: 0.75,
  // jcp
  LEAD: 0.10, INTRO: 0.25, SCOPING: 0.40, PITCH: 0.60, ENGAGED: 0.85,
  // zang pre-sale
  TRIAGE: 0.10, VENDOR_QUOTING: 0.25, CUSTOMER_QUOTING: 0.40,
  FOLLOW_UP: 0.60, NO_FOLLOW_UP: 0.15, NO_QUOTE: 0.05, COLD: 0.10,
  // zang post-sale (PO in hand → very likely to realize)
  NOT_PROCESSED: 0.90, PROCESSED: 0.90, ORDACK: 0.90, VAP: 0.90, CAP: 0.90,
  RELACK: 0.92, MONITOR: 0.92, COORDINATE: 0.95, WHSE: 0.95,
  TBI: 0.97, COMM_WATCH: 0.98,
};

function terminalStages(profile) {
  return TERMINAL_STAGES[profile] || TERMINAL_STAGES.generic;
}

// Classify a single deal's stage for a profile → 'won' | 'lost' | 'open'.
function classifyStage(profile, stage) {
  const t = terminalStages(profile);
  if (t.won.includes(stage)) return 'won';
  if (t.lost.includes(stage)) return 'lost';
  return 'open';
}

// Effective win probability in [0,1] for an OPEN deal. Prefers the explicit
// per-deal probability (stored as an integer percent 0–100); when that's null
// or ≤0 we fall back to the stage default, then a global default.
function effectiveProbability(profile, stage, probability) {
  const p = Number(probability);
  if (Number.isFinite(p) && p > 0) return Math.min(p, 100) / 100;
  if (Object.prototype.hasOwnProperty.call(STAGE_DEFAULT_PROBABILITY, stage)) {
    return STAGE_DEFAULT_PROBABILITY[stage];
  }
  return DEFAULT_OPEN_PROBABILITY;
}

// --- date helpers (UTC, no external deps) ----------------------------------
function monthKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function parseDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
// Enumerate contiguous YYYY-MM keys from firstKey..lastKey inclusive.
function monthRange(firstKey, lastKey, cap = 36) {
  const out = [];
  let [y, m] = firstKey.split('-').map(Number);
  const [ly, lm] = lastKey.split('-').map(Number);
  while ((y < ly || (y === ly && m <= lm)) && out.length < cap) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/**
 * Pure forecast math. Given raw deal rows + a profile, compute:
 *   - weighted_pipeline: Σ(amount × effectiveProbability) over OPEN deals
 *   - open_amount / open_count: unweighted open totals
 *   - unscheduled_open_amount: open deals with no expected_close_date (in the
 *     headline weighted pipeline but excluded from the by_period series)
 *   - by_period[]: per-month { period, committed, best_case, weighted, ... }
 *       committed = Σ won-deal value that closed that month
 *       best_case = committed + Σ full open amount expected that month
 *       weighted  = committed + Σ (open amount × probability) that month
 *
 * `rows` fields used: amount, probability, stage, expected_close_date,
 * closed_date, closed_amount. `now` defaults to new Date().
 */
function buildForecast(rows, { profile = 'generic', now = new Date() } = {}) {
  let weightedPipeline = 0;
  let openAmount = 0;
  let openCount = 0;
  let unscheduledOpenAmount = 0;
  let wonAmountTotal = 0;
  let wonCountTotal = 0;

  const buckets = new Map(); // key -> { committed, best_case, weighted, open_count, won_count }
  const ensure = (key) => {
    if (!buckets.has(key)) {
      buckets.set(key, { period: key, committed: 0, best_case: 0, weighted: 0, open_count: 0, won_count: 0 });
    }
    return buckets.get(key);
  };

  for (const r of rows || []) {
    const cls = classifyStage(profile, r.stage);
    const amount = Number(r.amount) || 0;

    if (cls === 'lost') continue; // lost deals never contribute to a forecast

    if (cls === 'won') {
      const value = r.closed_amount != null ? Number(r.closed_amount) || 0 : amount;
      wonAmountTotal += value;
      wonCountTotal += 1;
      // Bucket by close date (fallback expected close) so committed revenue
      // lands in the month it was realized.
      const when = parseDate(r.closed_date) || parseDate(r.expected_close_date);
      if (when) {
        const b = ensure(monthKey(when));
        b.committed += value;
        b.best_case += value;
        b.weighted += value;
        b.won_count += 1;
      }
      continue;
    }

    // OPEN deal
    const prob = effectiveProbability(profile, r.stage, r.probability);
    const weighted = amount * prob;
    weightedPipeline += weighted;
    openAmount += amount;
    openCount += 1;

    const when = parseDate(r.expected_close_date);
    if (!when) {
      unscheduledOpenAmount += amount;
      continue;
    }
    const b = ensure(monthKey(when));
    b.best_case += amount;
    b.weighted += weighted;
    b.open_count += 1;
  }

  // Build a contiguous month series so the chart has no gaps. Range spans from
  // the earliest bucket (or this month) to the latest bucket (or this month).
  const keys = [...buckets.keys()].sort();
  const thisMonth = monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const first = keys.length ? (keys[0] < thisMonth ? keys[0] : thisMonth) : thisMonth;
  const last = keys.length ? (keys[keys.length - 1] > thisMonth ? keys[keys.length - 1] : thisMonth) : thisMonth;
  const by_period = monthRange(first, last).map((k) => {
    const b = buckets.get(k) || { period: k, committed: 0, best_case: 0, weighted: 0, open_count: 0, won_count: 0 };
    return {
      period: k,
      committed: round2(b.committed),
      best_case: round2(b.best_case),
      weighted: round2(b.weighted),
      open_count: b.open_count,
      won_count: b.won_count,
    };
  });

  return {
    profile,
    weighted_pipeline: round2(weightedPipeline),
    open_amount: round2(openAmount),
    open_count: openCount,
    unscheduled_open_amount: round2(unscheduledOpenAmount),
    won_amount_total: round2(wonAmountTotal),
    won_count_total: wonCountTotal,
    by_period,
  };
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// --- quota period math ------------------------------------------------------
// Given a quota row (period_type + period_start) return {start, end} Date
// bounds [start, end). period_start is a DATE (YYYY-MM-DD or Date).
function quotaWindow(periodType, periodStart) {
  const start = parseDate(periodStart);
  if (!start) return null;
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth();
  const d = start.getUTCDate();
  let end;
  if (periodType === 'month') end = new Date(Date.UTC(y, m + 1, d));
  else if (periodType === 'quarter') end = new Date(Date.UTC(y, m + 3, d));
  else if (periodType === 'year') end = new Date(Date.UTC(y + 1, m, d));
  else end = new Date(Date.UTC(y, m + 1, d)); // default: month
  return { start, end };
}

// Compute quota attainment from raw deal rows. attained = won value whose
// close date falls in [start,end); projected = attained + weighted value of
// open deals expected to close in-window.
function computeQuotaAttainment(rows, { profile, quota, now = new Date() }) {
  if (!quota) return null;
  const win = quotaWindow(quota.period_type, quota.period_start);
  if (!win) return null;
  const target = Number(quota.target_amount) || 0;

  const inWindow = (d) => d && d >= win.start && d < win.end;
  let attained = 0;
  let weightedOpenInWindow = 0;

  for (const r of rows || []) {
    // Optional per-owner quota: only count that owner's deals when owner_id set.
    if (quota.owner_id != null && Number(r.salesman_id) !== Number(quota.owner_id)) continue;
    const cls = classifyStage(profile, r.stage);
    if (cls === 'won') {
      const when = parseDate(r.closed_date) || parseDate(r.expected_close_date);
      if (inWindow(when)) {
        attained += r.closed_amount != null ? Number(r.closed_amount) || 0 : Number(r.amount) || 0;
      }
    } else if (cls === 'open') {
      const when = parseDate(r.expected_close_date);
      if (inWindow(when)) {
        weightedOpenInWindow += (Number(r.amount) || 0) * effectiveProbability(profile, r.stage, r.probability);
      }
    }
  }

  const projected = attained + weightedOpenInWindow;
  return {
    period_type: quota.period_type,
    period_start: typeof quota.period_start === 'string'
      ? quota.period_start.slice(0, 10)
      : parseDate(quota.period_start)?.toISOString().slice(0, 10),
    owner_id: quota.owner_id != null ? Number(quota.owner_id) : null,
    target_amount: round2(target),
    attained_amount: round2(attained),
    projected_amount: round2(projected),
    attainment_pct: target > 0 ? Math.round((attained / target) * 100) : null,
    projected_pct: target > 0 ? Math.round((projected / target) * 100) : null,
  };
}

// --- DB-backed entry points -------------------------------------------------
// One org-scoped, parameterized fetch → pure math. sf MUST be an allowlisted
// scope field or we throw before building any SQL (defense in depth).
async function fetchDealRows({ sf, sv }, pool) {
  if (!SCOPE_FIELDS.has(sf)) throw new Error(`Illegal scope field: ${sf}`);
  const { rows } = await pool.query(
    `SELECT id, salesman_id, amount, probability, stage,
            expected_close_date, closed_date, closed_amount
       FROM deals
      WHERE ${sf} = $1`,
    [sv]
  );
  return rows;
}

/**
 * Full forecast summary for a scope. Returns the pure forecast plus, when a
 * `quota` row is supplied, its attainment against the same deal set.
 */
async function getForecast({ sf, sv, profile = 'generic', now = new Date(), quota = null }, pool) {
  const rows = await fetchDealRows({ sf, sv }, pool);
  const forecast = buildForecast(rows, { profile, now });
  const quotaAttainment = quota ? computeQuotaAttainment(rows, { profile, quota, now }) : null;
  return { ...forecast, quota: quotaAttainment };
}

module.exports = {
  TERMINAL_STAGES,
  STAGE_DEFAULT_PROBABILITY,
  DEFAULT_OPEN_PROBABILITY,
  terminalStages,
  classifyStage,
  effectiveProbability,
  quotaWindow,
  buildForecast,
  computeQuotaAttainment,
  fetchDealRows,
  getForecast,
};
