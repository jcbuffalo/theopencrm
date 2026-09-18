// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Read-only usage endpoint. Surface for the future Usage dashboard (Phase B
// UI). Returns the caller's org's current consumption + costs.
//
//   GET /api/usage             — current month
//   GET /api/usage?period=2026-05 — specific month
//
// Costs returned are our (platform-side) cost estimates. Customer-facing
// pricing comes from PLUGIN_PLATFORM_VISION.md and is applied separately
// by billing (Phase F).

const express = require('express');
const { authMiddleware } = require('../auth');
const usageMeter = require('../services/usageMeter');
const aiMetering = require('../services/aiMetering');
const quotaEnforcer = require('../services/quotaEnforcer');

const router = express.Router();
router.use(authMiddleware);

// Resolve the [from, to) range from query params.
//   ?period=month (default) — current calendar month (UTC)
//   ?period=ytd             — Jan 1 of the current year (UTC) to now
//   ?period=custom&from=YYYY-MM-DD&to=YYYY-MM-DD
//   ?period=YYYY-MM         — back-compat shorthand for a specific month
// Falsy or unknown periods default to current month.
function resolvePeriodRange(query) {
  const now = new Date();
  const period = (query.period || 'month').toLowerCase();

  if (period === 'ytd') {
    const from = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const to = new Date(Date.UTC(now.getUTCFullYear(), 11, 31, 23, 59, 59));
    return { from, to, label: `${now.getUTCFullYear()}-YTD`, legacyPeriod: null };
  }

  if (period === 'custom') {
    const from = parseDateBound(query.from, true);
    const to   = parseDateBound(query.to,   false) || new Date();
    if (!from) {
      // bad input → fall back to current month
      return defaultMonthRange(now);
    }
    return { from, to, label: `custom:${query.from}..${query.to || 'now'}`, legacyPeriod: null };
  }

  // YYYY-MM shorthand
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const from = new Date(Date.UTC(y, mo - 1, 1));
    const to   = new Date(Date.UTC(y, mo,     1));
    return { from, to, label: period, legacyPeriod: period };
  }

  // 'month' or unknown
  return defaultMonthRange(now);
}

function defaultMonthRange(now) {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return { from, to, label: period, legacyPeriod: period };
}

function parseDateBound(str, isLower) {
  if (!str || typeof str !== 'string') return null;
  // Accept YYYY-MM-DD only. Stricter than Date(str) so we don't quietly
  // accept "tomorrow" or other free-form strings.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const d = new Date(str + (isLower ? 'T00:00:00.000Z' : 'T23:59:59.999Z'));
  if (isNaN(d.getTime())) return null;
  return d;
}

router.get('/', async (req, res) => {
  try {
    if (!req.orgId) return res.status(400).json({ success: false, error: 'Org context required' });

    const range = resolvePeriodRange(req.query);

    // legacy usageMeter aggregate is YYYY-MM keyed — pull only when the
    // requested period maps to a single month, otherwise return current.
    const legacyPeriodArg = range.legacyPeriod || null;

    const [usage, tier, seats, aiUsage] = await Promise.all([
      usageMeter.getUsage(req.orgId, legacyPeriodArg),
      quotaEnforcer.getOrgTier(req.orgId),
      quotaEnforcer.getSeatCount(req.orgId),
      aiMetering.summarizeUsage({ orgId: req.orgId, from: range.from, to: range.to }),
    ]);
    const tierQuotas = quotaEnforcer.TIER_QUOTAS[tier] || quotaEnforcer.TIER_QUOTAS.free;

    // Compute end-of-month projection from consumption-so-far × (days-in-month / days-elapsed).
    // Only meaningful when the period is the current month and we have some
    // elapsed time. Returns null for past periods.
    const projection = projectMonthEnd(usage.period, usage.metrics);

    // Effective per-org limits = per-user × seats. Infinity for enterprise.
    const effectiveLimits = {
      ai_requests: tierQuotas.ai_requests_per_user_per_month === Infinity
        ? null
        : tierQuotas.ai_requests_per_user_per_month * seats,
      plugin_runs: tierQuotas.plugin_runs_per_org_per_month === Infinity
        ? null
        : tierQuotas.plugin_runs_per_org_per_month,
    };

    // Straight-line projection for the new ai_usage block. Only meaningful
    // when the requested range is the current calendar month.
    const aiProjection = projectAiUsageMonthEnd(range, aiUsage);

    res.json({
      success: true,
      orgId: req.orgId,
      tier,
      tierLabel: tierQuotas.label,
      seats,
      effectiveLimits,
      overageAllowed: !!tierQuotas.overageAllowed,
      overageRates: tierQuotas.overage || null,
      ...usage,
      // The new period selector (month/ytd/custom). Frontend uses this to
      // label the page; the legacy YYYY-MM `period` field stays on the
      // payload for back-compat with the existing renderer.
      periodLabel: range.label,
      periodFrom:  range.from.toISOString(),
      periodTo:    range.to.toISOString(),
      projection,
      metrics_catalog: usageMeter.METRICS,
      // New: per-call ai_usage_events aggregations. This is the source of
      // truth for the Claude AI token-usage section of /usage and the
      // future Stripe meter push.
      ai_usage: {
        ...aiUsage,
        projected_charged_usd: aiProjection.projected_charged_usd,
        projected_cost_usd:    aiProjection.projected_cost_usd,
        projection_too_early:  aiProjection.tooEarly,
      },
    });
  } catch (err) {
    if (req.log) req.log.error('usage_get_failed', { error: err });
    res.status(500).json({ success: false, error: 'Failed to fetch usage' });
  }
});

/**
 * Linear month-end projection on the new ai_usage aggregate. Only meaningful
 * for the current calendar month. Returns null fields for ytd/custom/past
 * months — the frontend hides the projection card in those cases.
 */
function projectAiUsageMonthEnd(range, aiUsage) {
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const monthEnd   = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  // Only project if the requested range matches the current calendar month
  // (within a 1-second tolerance — clocks aren't perfectly synced).
  const rangeFromMs = range.from.getTime();
  const rangeToMs   = range.to.getTime();
  if (Math.abs(rangeFromMs - monthStart) > 1000 || Math.abs(rangeToMs - monthEnd) > 1000) {
    return { projected_charged_usd: null, projected_cost_usd: null, tooEarly: false };
  }
  const elapsedMs = now.getTime() - monthStart;
  const totalMs   = monthEnd - monthStart;
  const hoursElapsed = elapsedMs / (1000 * 60 * 60);
  if (hoursElapsed < 24) {
    return { projected_charged_usd: null, projected_cost_usd: null, tooEarly: true };
  }
  const ratio = totalMs / elapsedMs;
  return {
    projected_charged_usd: Math.round(aiUsage.total_charged_usd * ratio * 100) / 100,
    projected_cost_usd:    Math.round(aiUsage.total_cost_usd    * ratio * 100) / 100,
    tooEarly: false,
  };
}

/**
 * Linear straight-line projection: assume the rest of the month consumes at
 * the same rate as the elapsed portion. Useful for warning "you're on pace
 * to hit your quota in 4 days." Returns null for non-current-month periods
 * or if the period is too young (< 24h elapsed).
 */
function projectMonthEnd(period, metrics) {
  if (!period) return null;
  const [yearStr, monthStr] = period.split('-');
  const y = Number(yearStr), m = Number(monthStr);
  if (!y || !m) return null;
  const now = new Date();
  if (now.getUTCFullYear() !== y || now.getUTCMonth() + 1 !== m) return null;

  const monthStart = Date.UTC(y, m - 1, 1);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthEnd = Date.UTC(y, m - 1, daysInMonth, 23, 59, 59);
  const elapsedMs = now.getTime() - monthStart;
  const totalMs   = monthEnd - monthStart;
  const hoursElapsed = elapsedMs / (1000 * 60 * 60);
  if (hoursElapsed < 24) return { tooEarly: true };

  const ratio = totalMs / elapsedMs;
  const out = {};
  for (const [name, m_] of Object.entries(metrics || {})) {
    out[name] = {
      projectedCount: Math.round((m_.count || 0) * ratio),
      projectedCostCents: Math.round((m_.estimatedCostCents || 0) * ratio),
    };
  }
  return { tooEarly: false, projection: out };
}

module.exports = router;
