// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Lifecycle Funnel analytics — how the customer base is distributed across the
// account lifecycle (prospect → onboarding → active → at_risk → renewed →
// churned) and what's moving. Sibling of services/retention.js (deliberately a
// separate file so the two analytics surfaces never merge-conflict); reads the
// companies.lifecycle_stage column that migration 122 added.
//
// Pure-math cores (buildDistribution / buildAtRisk / buildMovement) are DB-free
// so they unit-test cleanly; the exported org-scoped entry points run
// parameterized queries and hand the raw rows to the pure cores.
//
// SQL SAFETY (same contract as services/retention.js / services/forecast.js):
//   • The only interpolated identifier is the scope field, validated against a
//     two-value allowlist (org_id | user_id) before it can touch SQL.
//   • Every value — the scope value included — is a bound parameter ($1…).
//   • No user input is ever concatenated into a query.
//
// STAGE CANON: the stage list + order comes from schemas/companies
// (LIFECYCLE_STAGES) — the same allowlist the company write path validates
// against — so this report can't drift from what the API actually stores.
//
// HONESTY NOTE (movement): the lifecycle-stage PATCH in companyRoutes.js does
// NOT record a change history (no audit event, no history table), so true
// stage-to-stage transitions cannot be sourced. buildMovement therefore
// reports "companies touched in the last N days, grouped by their CURRENT
// stage" and labels itself method:'recent_activity'. We deliberately don't
// fabricate transition counts the schema can't back up — if a lifecycle
// history source lands later, switch the method here and keep the shape.

const { LIFECYCLE_STAGES } = require('../schemas/companies');
const { classifyStage } = require('./forecast');
// Reuse retention's contract-value helpers so "MRR" means the same thing on
// every customer-success surface (monthly_amount, else annual_value/12).
const { monthlyValue, currentlyActive } = require('./retention');

const SCOPE_FIELDS = new Set(['org_id', 'user_id']);

// Postgres error codes for "this schema doesn't have that yet" — the defensive
// cases where we degrade to zeros instead of a 500 (mirrors the graceful-
// degradation pattern the integrations use).
const MISSING_RELATION = '42P01'; // undefined_table
const MISSING_COLUMN = '42703';   // undefined_column

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function assertScope(sf) {
  if (!SCOPE_FIELDS.has(sf)) throw new Error(`Illegal scope field: ${sf}`);
}

// --- pure cores --------------------------------------------------------------

/**
 * Zero-filled distribution across the six canonical lifecycle stages.
 * `rows` = [{ stage, count }] from a GROUP BY — any stage value outside the
 * canon (including NULL from pre-122 writes) is reported as `unclassified`,
 * not silently folded into a real stage. Percentages are of the WHOLE base
 * (canonical + unclassified) so they always sum to ~100.
 */
function buildDistribution(rows) {
  const counts = new Map(LIFECYCLE_STAGES.map((s) => [s, 0]));
  let unclassified = 0;
  for (const r of rows || []) {
    const stage = r.stage == null ? null : String(r.stage);
    const n = Number(r.count) || 0;
    if (stage && counts.has(stage)) counts.set(stage, counts.get(stage) + n);
    else unclassified += n;
  }
  let total = unclassified;
  for (const n of counts.values()) total += n;
  const stages = LIFECYCLE_STAGES.map((stage) => {
    const count = counts.get(stage);
    return {
      stage,
      count,
      pct: total > 0 ? round2((count / total) * 100) : 0,
    };
  });
  return { stages, unclassified, total };
}

/**
 * At-risk exposure. `companyCount` = companies currently at_risk;
 * `dealRows` = deals belonging to those companies (stage + amount);
 * `contractRows` = service_contracts belonging to those companies.
 * Open-deal value uses the profile-aware classifyStage (same terminal-stage
 * map as forecast/retention). MRR mirrors retention's monthlyValue +
 * currentlyActive definitions exactly.
 */
function buildAtRisk(companyCount, dealRows, contractRows, { profile = 'generic', now = new Date() } = {}) {
  let openDealCount = 0;
  let openDealValue = 0;
  for (const d of dealRows || []) {
    if (classifyStage(profile, d.stage) !== 'open') continue;
    openDealCount += 1;
    openDealValue += Number(d.amount) || 0;
  }
  let mrrAtRisk = 0;
  let activeContractCount = 0;
  for (const c of contractRows || []) {
    if (!currentlyActive(c, now)) continue;
    activeContractCount += 1;
    mrrAtRisk += monthlyValue(c);
  }
  return {
    company_count: Number(companyCount) || 0,
    open_deal_count: openDealCount,
    open_deal_value: round2(openDealValue),
    active_contract_count: activeContractCount,
    mrr_at_risk: round2(mrrAtRisk),
    arr_at_risk: round2(mrrAtRisk * 12),
  };
}

/**
 * Best-effort movement. No lifecycle change history exists (see file head), so
 * this is companies whose updated_at falls in the trailing window, grouped by
 * CURRENT stage — recent activity, not true transitions. The method/label
 * fields make that impossible for a consumer to misread.
 */
function buildMovement(rows, { windowDays = 30 } = {}) {
  const { stages } = buildDistribution(rows); // same zero-fill + canon-order logic
  return {
    method: 'recent_activity',
    window_days: windowDays,
    label: `Accounts updated in the last ${windowDays} days, by current stage`,
    note: 'No lifecycle change history is recorded, so these are recently-touched accounts grouped by their current stage — not true stage-to-stage transitions.',
    stages: stages.map(({ stage, count }) => ({ stage, count })),
  };
}

// --- org-scoped entry points --------------------------------------------------
// Each validates the scope field against the allowlist BEFORE building SQL,
// binds every value, and hands rows to the pure core above.

async function lifecycleDistribution({ sf, sv }, pool) {
  assertScope(sf);
  const { rows } = await pool.query(
    `SELECT lifecycle_stage AS stage, COUNT(*)::int AS count
       FROM companies
      WHERE ${sf} = $1
      GROUP BY lifecycle_stage`,
    [sv]
  );
  return buildDistribution(rows);
}

async function atRiskExposure({ sf, sv, profile = 'generic', now = new Date() }, pool) {
  assertScope(sf);
  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS count
       FROM companies
      WHERE ${sf} = $1 AND lifecycle_stage = 'at_risk'`,
    [sv]
  );
  const companyCount = countRes.rows[0]?.count || 0;

  // Open pipeline attached to at-risk accounts. deals.customer_id → companies.id
  // (migration 037); the join re-checks the company's scope so a cross-tenant
  // customer_id could never leak rows even if a deal row were mis-scoped.
  let dealRows = [];
  try {
    const r = await pool.query(
      `SELECT d.stage, d.amount
         FROM deals d
         JOIN companies c ON c.id = d.customer_id AND c.${sf} = $1
        WHERE d.${sf} = $1 AND c.lifecycle_stage = 'at_risk'`,
      [sv]
    );
    dealRows = r.rows;
  } catch (err) {
    if (err.code !== MISSING_RELATION && err.code !== MISSING_COLUMN) throw err;
    // deals.customer_id predates some deployments — degrade to zero pipeline.
  }

  // Recurring revenue attached to at-risk accounts. service_contracts is an
  // optional module table — degrade to zero MRR when it (or its columns)
  // doesn't exist rather than 500ing the whole report.
  let contractRows = [];
  try {
    const r = await pool.query(
      `SELECT sc.status, sc.end_date, sc.monthly_amount, sc.annual_value
         FROM service_contracts sc
         JOIN companies c ON c.id = sc.customer_id AND c.${sf} = $1
        WHERE sc.${sf} = $1 AND c.lifecycle_stage = 'at_risk'`,
      [sv]
    );
    contractRows = r.rows;
  } catch (err) {
    if (err.code !== MISSING_RELATION && err.code !== MISSING_COLUMN) throw err;
  }

  return buildAtRisk(companyCount, dealRows, contractRows, { profile, now });
}

async function stageMovement({ sf, sv, windowDays = 30 }, pool) {
  assertScope(sf);
  const days = Number.isFinite(Number(windowDays)) && Number(windowDays) > 0
    ? Math.min(Math.floor(Number(windowDays)), 365)
    : 30;
  const { rows } = await pool.query(
    `SELECT lifecycle_stage AS stage, COUNT(*)::int AS count
       FROM companies
      WHERE ${sf} = $1
        AND updated_at >= NOW() - make_interval(days => $2)
      GROUP BY lifecycle_stage`,
    [sv, days]
  );
  return buildMovement(rows, { windowDays: days });
}

/** Full funnel payload for a scope: { distribution, atRisk, movement }. */
async function getLifecycleFunnel({ sf, sv, profile = 'generic', now = new Date(), movementWindowDays = 30 }, pool) {
  const [distribution, atRisk, movement] = await Promise.all([
    lifecycleDistribution({ sf, sv }, pool),
    atRiskExposure({ sf, sv, profile, now }, pool),
    stageMovement({ sf, sv, windowDays: movementWindowDays }, pool),
  ]);
  return { distribution, atRisk, movement };
}

module.exports = {
  SCOPE_FIELDS,
  LIFECYCLE_STAGES,
  buildDistribution,
  buildAtRisk,
  buildMovement,
  lifecycleDistribution,
  atRiskExposure,
  stageMovement,
  getLifecycleFunnel,
};
