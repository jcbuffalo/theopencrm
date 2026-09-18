// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Commission & goals engine — per-rep commission over closed-won deals in a
// period. Pure-math core (buildCommissionReport / buildPartnerStatements) is
// DB-free so it unit-tests cleanly; getCommissionReport runs THREE org-scoped,
// parameterized queries (deals, plans, users — plus a companies lookup only
// when partner plans exist) and hands the raw rows to the pure core. Mirrors
// the services/forecast.js structure exactly.
//
// MIGRATION 159a adds PARTNER plans (kind='partner'): a referral/channel fee
// owed to a company rather than a rep, with an optional source_filter matched
// against the deal's custom-field source convention (see dealSource). The rep
// flow is unchanged — applicablePlan skips partner plans.
//
// SQL SAFETY (same contract as services/forecast.js / reportBuilder.js):
//   • The only interpolated identifier is the scope field, which is validated
//     against a two-value allowlist (org_id | user_id) before it can touch SQL.
//   • Every value — the scope value included — is a bound parameter ($1…).
//   • No user input is ever concatenated into a query.
//
// COMMISSION MODEL:
//   commission(rep) = Σ over closed-won deals in [from, to] of
//                       deal value × applicable rate_pct / 100
//   • "closed-won" uses the same per-profile terminal-stage classification as
//     the forecast engine (forecast.classifyStage) — INVOICED/CLOSED_PAID for
//     zang, closed_won for generic/rin, CLOSED_WON for jcp, etc.
//   • deal value = closed_amount when set, else amount (forecast convention).
//   • close date = closed_date, falling back to expected_close_date (forecast
//     convention for bucketing won revenue).
//   • rep = owner_user_id (migration 135 record owner), falling back to
//     salesman_id (the selling rep), falling back to user_id (the creator).
//   • applicable rate = the rep's plan with the latest effective_from that is
//     <= the deal's close date; else the org-default plan (owner_id IS NULL)
//     under the same rule; else 0. Historical closes keep historical rates.
//   • goal/attainment: the plan that supplies the rep's display rate (as of
//     the period end) may carry goal_amount; attainment = won value / goal.

const { classifyStage } = require('./forecast');

const SCOPE_FIELDS = new Set(['org_id', 'user_id']);

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function parseDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// The rep a deal's revenue (and therefore commission) is attributed to.
// owner_user_id (record owner, migration 135) → salesman_id (selling rep,
// Zang concept) → user_id (creator / scope fallback). Null when none set.
function dealRep(deal) {
  for (const k of ['owner_user_id', 'salesman_id', 'user_id']) {
    const v = Number(deal?.[k]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

// Pick the plan governing `repId` on `asOf` (a Date): the rep-specific plan
// with the latest effective_from <= asOf wins; otherwise the org-default plan
// (owner_id null) under the same rule; otherwise null (→ rate 0).
//
// MIGRATION 159a: kind='partner' plans are SKIPPED here — a partner plan has
// owner_id NULL and would otherwise masquerade as the org-default rep plan.
// Partner fees are resolved by applicablePartnerPlan instead.
function applicablePlan(plans, repId, asOf) {
  if (!asOf) return null;
  let best = null;
  let bestDefault = null;
  for (const p of plans || []) {
    if ((p.kind || 'rep') === 'partner') continue; // never a rep/org-default plan
    const eff = parseDate(p.effective_from);
    if (!eff || eff > asOf) continue;
    const owner = p.owner_id != null ? Number(p.owner_id) : null;
    if (owner != null && repId != null && owner === Number(repId)) {
      if (!best || eff > parseDate(best.effective_from)) best = p;
    } else if (owner == null) {
      if (!bestDefault || eff > parseDate(bestDefault.effective_from)) bestDefault = p;
    }
  }
  return best || bestDefault;
}

// ---------------------------------------------------------------------------
// Partner/channel fee plans (migration 159a, CMN item 1.5)
// ---------------------------------------------------------------------------

// The deal's channel/lead-source value for partner attribution. Deals have NO
// built-in lead-source column (only `leads` carry `source`, and lead→deal
// conversion does not copy it), so the CONVENTION is a deal custom field:
//   custom_fields.channel_source   (the CMN seed's campaign-deal field)
//   → custom_fields.lead_source    (fallback)
//   → custom_fields.source         (fallback)
// Matching is trimmed + case-insensitive. Returns null when no source is set.
function dealSource(deal) {
  let cf = deal?.custom_fields;
  if (typeof cf === 'string') { try { cf = JSON.parse(cf); } catch { cf = null; } }
  if (!cf || typeof cf !== 'object') return null;
  for (const k of ['channel_source', 'lead_source', 'source']) {
    const v = cf[k];
    if (v != null && String(v).trim() !== '') return String(v).trim().toLowerCase();
  }
  return null;
}

// Among ONE partner company's plans, pick the one effective on `asOf`:
// latest effective_from <= asOf (same historical-rate rule as rep plans).
function applicablePartnerPlan(partnerPlans, asOf) {
  if (!asOf) return null;
  let best = null;
  for (const p of partnerPlans || []) {
    const eff = parseDate(p.effective_from);
    if (!eff || eff > asOf) continue;
    if (!best || eff > parseDate(best.effective_from)) best = p;
  }
  return best;
}

// Does this closed-won deal attribute to this partner plan?
//   source_filter set  → the deal's source (dealSource convention above) must
//                        equal it, trimmed + case-insensitive.
//   source_filter NULL → fall back to a direct company link: the partner
//                        company is the deal's company_id or customer_id.
function partnerMatchesDeal(plan, deal) {
  const filter = plan.source_filter != null ? String(plan.source_filter).trim().toLowerCase() : '';
  if (filter) return dealSource(deal) === filter;
  const pid = Number(plan.partner_company_id);
  return Number(deal.company_id) === pid || Number(deal.customer_id) === pid;
}

/**
 * Pure partner-statement math (mirrors buildCommissionReport's conventions:
 * closed-won only, close date = closed_date → expected_close_date, value =
 * closed_amount → amount, per-deal historical rate, inclusive [from, to]).
 *
 * Returns { partners: [...], totals } where each partner row is a statement:
 *   { partner_company_id, partner_name, rate_pct, source_filter, deal_count,
 *     attributed_value, fee, deals: [{ id, title, close_date, value,
 *     rate_pct, fee }] }
 * sorted by fee desc. Partners whose plan is effective by period end appear
 * even with zero attributed deals (zero rows are informative, like reps).
 * A deal can attribute to more than one partner — statements are independent.
 */
function buildPartnerStatements(deals, plans, companies, { profile = 'generic', from, to } = {}) {
  const start = parseDate(from ? `${from}T00:00:00Z` : null);
  const end = parseDate(to ? `${to}T00:00:00Z` : null);
  if (end) end.setUTCDate(end.getUTCDate() + 1); // inclusive `to` → exclusive bound
  const asOfEnd = end ? new Date(end.getTime() - 1) : new Date();

  const companiesById = new Map((companies || []).map(c => [Number(c.id), c]));

  // Group partner plans by partner company.
  const byPartner = new Map();
  for (const p of plans || []) {
    if ((p.kind || 'rep') !== 'partner' || p.partner_company_id == null) continue;
    const key = Number(p.partner_company_id);
    if (!byPartner.has(key)) byPartner.set(key, []);
    byPartner.get(key).push(p);
  }

  const partners = [];
  for (const [partnerId, partnerPlans] of byPartner) {
    const displayPlan = applicablePartnerPlan(partnerPlans, asOfEnd);
    if (!displayPlan) continue; // no plan effective by period end yet

    const rows = [];
    let value = 0;
    let fee = 0;
    for (const d of deals || []) {
      if (classifyStage(profile, d.stage) !== 'won') continue;
      const when = parseDate(d.closed_date) || parseDate(d.expected_close_date);
      if (!when) continue;
      if (start && when < start) continue;
      if (end && when >= end) continue;

      // Historical rates: the plan (and its filter) effective at THIS deal's
      // close date governs both the match and the rate.
      const plan = applicablePartnerPlan(partnerPlans, when);
      if (!plan || !partnerMatchesDeal(plan, d)) continue;

      const dealValue = d.closed_amount != null ? Number(d.closed_amount) || 0 : Number(d.amount) || 0;
      const rate = Number(plan.rate_pct) || 0;
      const dealFee = dealValue * (rate / 100);
      value += dealValue;
      fee += dealFee;
      rows.push({
        id: d.id,
        title: d.title || null,
        close_date: (d.closed_date || d.expected_close_date || null),
        value: round2(dealValue),
        rate_pct: round2(rate),
        fee: round2(dealFee),
      });
    }

    const company = companiesById.get(partnerId);
    partners.push({
      partner_company_id: partnerId,
      partner_name: company?.name || displayPlan.partner_company_name || null,
      rate_pct: round2(displayPlan.rate_pct),
      source_filter: displayPlan.source_filter || null,
      deal_count: rows.length,
      attributed_value: round2(value),
      fee: round2(fee),
      deals: rows,
    });
  }

  partners.sort((a, b) => (b.fee - a.fee) || (b.attributed_value - a.attributed_value) || (a.partner_company_id - b.partner_company_id));

  const totals = partners.reduce((t, p) => ({
    deal_count: t.deal_count + p.deal_count,
    attributed_value: round2(t.attributed_value + p.attributed_value),
    fee: round2(t.fee + p.fee),
  }), { deal_count: 0, attributed_value: 0, fee: 0 });

  return { partners, totals };
}

/**
 * Pure commission math. Given raw deal rows, plan rows, user rows, a profile,
 * and an inclusive [from, to] date window (YYYY-MM-DD strings), compute:
 *   reps[]  — { rep_user_id, name, email, won_count, won_value, rate_pct,
 *               commission, goal_amount, attainment_pct }, sorted by
 *               commission desc then won_value desc.
 *   totals  — { won_count, won_value, commission }
 *
 * Only CLOSED-WON deals whose close date lands inside the window count.
 * rate_pct on a rep row is the DISPLAY rate (the plan effective at period
 * end); the commission number itself is computed per deal at the deal's own
 * close date, so mid-period rate changes are honored exactly.
 */
function buildCommissionReport(deals, plans, users, { profile = 'generic', from, to } = {}) {
  const start = parseDate(from ? `${from}T00:00:00Z` : null);
  const end = parseDate(to ? `${to}T00:00:00Z` : null);
  if (end) end.setUTCDate(end.getUTCDate() + 1); // inclusive `to` → exclusive bound

  const usersById = new Map((users || []).map(u => [Number(u.id), u]));
  const perRep = new Map(); // repId|0 → { won_count, won_value, commission }
  const ensure = (repId) => {
    const key = repId == null ? 0 : Number(repId);
    if (!perRep.has(key)) perRep.set(key, { rep_user_id: repId == null ? null : Number(repId), won_count: 0, won_value: 0, commission: 0 });
    return perRep.get(key);
  };

  for (const d of deals || []) {
    if (classifyStage(profile, d.stage) !== 'won') continue; // open + lost never pay commission
    const when = parseDate(d.closed_date) || parseDate(d.expected_close_date);
    if (!when) continue;
    if (start && when < start) continue;
    if (end && when >= end) continue;

    const value = d.closed_amount != null ? Number(d.closed_amount) || 0 : Number(d.amount) || 0;
    const rep = dealRep(d);
    const plan = applicablePlan(plans, rep, when);
    const rate = plan ? Number(plan.rate_pct) || 0 : 0;

    const row = ensure(rep);
    row.won_count += 1;
    row.won_value += value;
    row.commission += value * (rate / 100);
  }

  // Also surface reps who have a rep-specific plan but no wins in the window,
  // so the report shows the whole comped team (zero rows are informative).
  const asOfEnd = end ? new Date(end.getTime() - 1) : new Date();
  for (const p of plans || []) {
    if (p.owner_id != null && parseDate(p.effective_from) && parseDate(p.effective_from) <= asOfEnd) {
      ensure(Number(p.owner_id));
    }
  }

  const reps = [...perRep.values()].map(r => {
    const u = r.rep_user_id != null ? usersById.get(r.rep_user_id) : null;
    const displayPlan = applicablePlan(plans, r.rep_user_id, asOfEnd);
    const goal = displayPlan && displayPlan.goal_amount != null ? Number(displayPlan.goal_amount) : null;
    return {
      rep_user_id: r.rep_user_id,
      name: u?.name || null,
      email: u?.email || null,
      won_count: r.won_count,
      won_value: round2(r.won_value),
      rate_pct: displayPlan ? round2(displayPlan.rate_pct) : 0,
      commission: round2(r.commission),
      goal_amount: goal != null && goal > 0 ? round2(goal) : null,
      attainment_pct: goal != null && goal > 0 ? Math.round((r.won_value / goal) * 100) : null,
    };
  }).sort((a, b) => (b.commission - a.commission) || (b.won_value - a.won_value) || ((a.rep_user_id || 0) - (b.rep_user_id || 0)));

  const totals = reps.reduce((t, r) => ({
    won_count: t.won_count + r.won_count,
    won_value: round2(t.won_value + r.won_value),
    commission: round2(t.commission + r.commission),
  }), { won_count: 0, won_value: 0, commission: 0 });

  return { profile, from: from || null, to: to || null, reps, totals };
}

// --- DB-backed entry point ---------------------------------------------------
// Three org-scoped, parameterized fetches → pure math. sf MUST be an
// allowlisted scope field or we throw before building any SQL.
async function fetchCommissionData({ sf, sv }, pool) {
  if (!SCOPE_FIELDS.has(sf)) throw new Error(`Illegal scope field: ${sf}`);
  const [deals, plans, users] = await Promise.all([
    // title/company_id/customer_id/custom_fields feed the partner statements
    // (migration 159a); the rep math ignores them.
    pool.query(
      `SELECT id, title, owner_user_id, salesman_id, user_id, stage,
              amount, closed_amount, closed_date, expected_close_date,
              company_id, customer_id, custom_fields
         FROM deals
        WHERE ${sf} = $1`,
      [sv]
    ),
    pool.query(
      `SELECT id, owner_id, rate_pct, goal_amount, effective_from,
              kind, partner_company_id, source_filter
         FROM commission_plans
        WHERE ${sf} = $1
        ORDER BY effective_from DESC, id DESC`,
      [sv]
    ),
    // For org scope, all members; for the no-org user_id fallback the only
    // visible "team" is the user themself (users has no user_id column).
    pool.query(
      `SELECT id, name, email FROM users WHERE ${sf === 'org_id' ? 'org_id' : 'id'} = $1`,
      [sv]
    ),
  ]);

  // Partner display names — only fetched when partner plans exist, so the
  // rep-only path issues exactly the original three queries.
  let companies = [];
  const partnerIds = [...new Set(
    plans.rows
      .filter(p => (p.kind || 'rep') === 'partner' && p.partner_company_id != null)
      .map(p => Number(p.partner_company_id))
  )];
  if (partnerIds.length > 0) {
    const r = await pool.query(
      `SELECT id, name FROM companies WHERE ${sf} = $1 AND id = ANY($2::int[])`,
      [sv, partnerIds]
    );
    companies = r.rows;
  }

  return { deals: deals.rows, plans: plans.rows, users: users.rows, companies };
}

/**
 * Full commission report for a scope + inclusive [from, to] window.
 * The rep report is unchanged (partner plans never reach the rep math);
 * `partners` / `partner_totals` carry the per-partner statements (159a).
 */
async function getCommissionReport({ sf, sv, profile = 'generic', from, to }, pool) {
  const { deals, plans, users, companies } = await fetchCommissionData({ sf, sv }, pool);
  const report = buildCommissionReport(deals, plans, users, { profile, from, to });
  const partnerOut = buildPartnerStatements(deals, plans, companies, { profile, from, to });
  return { ...report, partners: partnerOut.partners, partner_totals: partnerOut.totals };
}

module.exports = {
  dealRep,
  dealSource,
  applicablePlan,
  applicablePartnerPlan,
  partnerMatchesDeal,
  buildCommissionReport,
  buildPartnerStatements,
  fetchCommissionData,
  getCommissionReport,
};
