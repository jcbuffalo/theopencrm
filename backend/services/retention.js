// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Retention & expansion analytics — recurring revenue, renewals, NRR/GRR,
// expansion, and churn. This is the reporting that proves the CRM manages the
// WHOLE customer relationship (recurring revenue + renewals), not just the
// new-business pipeline that services/forecast.js covers.
//
// Pure-math core (buildRetention) is DB-free so it unit-tests cleanly;
// getRetention runs TWO org-scoped, parameterized queries (contracts + deals)
// and hands the raw rows to the pure core.
//
// SQL SAFETY (same contract as services/forecast.js / services/reportBuilder.js):
//   • The only interpolated identifier is the scope field, validated against a
//     two-value allowlist (org_id | user_id) before it can touch SQL.
//   • Every value — the scope value included — is a bound parameter ($1…).
//   • No user input is ever concatenated into a query.
//
// PROFILE AWARENESS: won-deal classification (needed for the expansion
// heuristic) varies per white-label profile. We reuse classifyStage from
// services/forecast.js so the terminal-stage map has a single home and can't
// drift between the forecast and retention surfaces.
//
// HONESTY NOTE: this codebase has no `companies.lifecycle_stage` column today,
// so the churn signal is derived purely from service_contracts (contracts that
// ended and weren't renewed / were marked churned). If a lifecycle_stage column
// lands later, add it to the churn roll-up then — we deliberately don't fake a
// signal the schema can't back up.

const { classifyStage } = require('./forecast');

const SCOPE_FIELDS = new Set(['org_id', 'user_id']);

// Statuses / renewal_stage values that mean "this contract is dead, no more
// recurring revenue". Casing matches what serviceContractRoutes writes.
const CHURNED_STATUSES = new Set(['churned', 'cancelled', 'canceled', 'expired', 'ended', 'lost']);

// --- helpers ----------------------------------------------------------------
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function parseDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// A contract's monthly recurring value. Prefer the explicit monthly_amount;
// fall back to annual_value / 12 when only the annual figure is set; else 0.
function monthlyValue(c) {
  if (c.monthly_amount != null) {
    const m = Number(c.monthly_amount);
    if (Number.isFinite(m)) return m;
  }
  if (c.annual_value != null) {
    const a = Number(c.annual_value);
    if (Number.isFinite(a)) return a / 12;
  }
  return 0;
}

// Annualized value of a contract (for renewal-pipeline value + churn ARR).
function annualValue(c) {
  if (c.annual_value != null) {
    const a = Number(c.annual_value);
    if (Number.isFinite(a)) return a;
  }
  return monthlyValue(c) * 12;
}

// Point-in-time "was this contract live on `date`?" — purely date-based
// (start_date <= date < end_date). Used for the NRR/GRR cohort so the answer is
// a true snapshot, independent of the contract's CURRENT status flag.
function activeOn(c, date) {
  const start = parseDate(c.start_date);
  const end = parseDate(c.end_date);
  if (start && start > date) return false;      // hadn't started yet
  if (end && end <= date) return false;         // already ended
  return true;
}

// "Is this contract recurring revenue RIGHT NOW?" — uses the app's own status
// flag (what the UI calls active) plus a not-yet-ended date guard.
function currentlyActive(c, now) {
  if (String(c.status || '').toLowerCase() !== 'active') return false;
  const end = parseDate(c.end_date);
  if (end && end < now) return false;
  return true;
}

// Has this contract been renewed? Either it was explicitly staged 'renewed',
// its status says so, or it points at a successor contract (renewed_contract_id).
function isRenewed(c) {
  const stage = String(c.renewal_stage || '').toLowerCase();
  const status = String(c.status || '').toLowerCase();
  return stage === 'renewed' || status === 'renewed' || c.renewed_contract_id != null;
}

// Has this contract churned? Explicit 'churned' stage, or a dead status.
function isChurned(c) {
  const stage = String(c.renewal_stage || '').toLowerCase();
  const status = String(c.status || '').toLowerCase();
  return stage === 'churned' || CHURNED_STATUSES.has(status);
}

function addDays(date, n) {
  return new Date(date.getTime() + n * 24 * 60 * 60 * 1000);
}

/**
 * Pure retention math. Given raw service_contract rows + deal rows + a profile,
 * compute recurring revenue, renewals, NRR/GRR, expansion, and churn.
 *
 * FORMULAS (documented so a founder can sanity-check them):
 *
 *  • MRR  = Σ monthlyValue(c) over contracts that are currentlyActive(now).
 *    ARR  = MRR × 12.  monthlyValue prefers monthly_amount, else annual_value/12.
 *
 *  • Upcoming renewals (30/60/90d) = active contracts whose end_date is in
 *    [now, now + Nd]. Reported as count + annualized value.
 *
 *  • Renewal rate (trailing `renewalWindowDays`, default 365):
 *      Look at contracts whose end_date fell in [now − window, now] — i.e. they
 *      came up for renewal. Classify each renewed / churned; ignore any that are
 *      still unresolved (reported separately).
 *        renewal_rate = renewed / (renewed + churned)     ∈ [0,1], null if 0 resolved
 *
 *  • NRR / GRR (trailing `nrrWindowDays`, default 365):
 *      Cohort = customers with a contract active (date-based) at windowStart
 *      (= now − window). For each cohort customer:
 *        start_mrr   = Σ monthlyValue of their contracts active at windowStart
 *        current_mrr = Σ monthlyValue of their contracts active NOW
 *      Then:
 *        starting_mrr = Σ start_mrr
 *        NRR = Σ current_mrr / starting_mrr            (includes expansion of existing custs)
 *        GRR = Σ min(current_mrr, start_mrr) / starting_mrr   (caps upside → no expansion)
 *      Both null when starting_mrr = 0 (not enough history to be honest).
 *      Only customers present at windowStart count — brand-new logos after the
 *      window start are new-business, not retention, and are excluded by design.
 *
 *  • Expansion (trailing `expansionWindowDays`, default 365):
 *      A won deal counts as expansion when it closed to a customer who ALREADY
 *      had a relationship before that deal closed — i.e. an existing contract
 *      (start_date < deal.closed_date) OR a prior won deal (closed_date earlier).
 *      Sum of closed_amount (fallback amount) + deal count + distinct customers.
 *
 *  • Churn (trailing `renewalWindowDays`): contracts whose end_date fell in the
 *      window AND isChurned() AND NOT isRenewed(). Reported as count + lost MRR
 *      / lost ARR. (No lifecycle_stage='churned' company signal — see file head.)
 *
 * `now` defaults to new Date().
 */
function buildRetention(contracts, deals, {
  profile = 'generic',
  now = new Date(),
  renewalWindowDays = 365,
  nrrWindowDays = 365,
  expansionWindowDays = 365,
} = {}) {
  const cs = contracts || [];
  const ds = deals || [];

  // --- Recurring revenue ---------------------------------------------------
  let mrr = 0;
  let activeCount = 0;
  for (const c of cs) {
    if (currentlyActive(c, now)) { mrr += monthlyValue(c); activeCount += 1; }
  }
  const arr = mrr * 12;

  // --- Upcoming renewals (30/60/90d) ---------------------------------------
  const upcomingWindow = (days) => {
    const cutoff = addDays(now, days);
    let count = 0;
    let value = 0;
    for (const c of cs) {
      if (!currentlyActive(c, now)) continue;
      const end = parseDate(c.end_date);
      if (end && end >= now && end <= cutoff) { count += 1; value += annualValue(c); }
    }
    return { count, value: round2(value) };
  };
  const upcoming = { d30: upcomingWindow(30), d60: upcomingWindow(60), d90: upcomingWindow(90) };

  // --- Renewal rate (trailing window) + churn roll-up ----------------------
  const renewalWindowStart = addDays(now, -renewalWindowDays);
  let renewed = 0;
  let churnedResolved = 0;
  let unresolved = 0;
  let churnContractCount = 0;
  let lostMrr = 0;
  for (const c of cs) {
    const end = parseDate(c.end_date);
    if (!end || end < renewalWindowStart || end > now) continue; // came up for renewal in-window
    if (isRenewed(c)) {
      renewed += 1;
    } else if (isChurned(c)) {
      churnedResolved += 1;
      churnContractCount += 1;
      lostMrr += monthlyValue(c);
    } else {
      unresolved += 1; // ended in-window but neither renewed nor marked churned
    }
  }
  const resolved = renewed + churnedResolved;
  const renewalRate = resolved > 0 ? renewed / resolved : null;

  // --- NRR / GRR (cohort MRR movement over trailing window) ----------------
  const nrrWindowStart = addDays(now, -nrrWindowDays);
  // Per-customer start/current MRR. Contracts with no customer_id can't be
  // attributed to a cohort customer, so they're excluded from NRR/GRR.
  const byCustomer = new Map(); // customer_id -> { start, current }
  const ensureCust = (id) => {
    if (!byCustomer.has(id)) byCustomer.set(id, { start: 0, current: 0 });
    return byCustomer.get(id);
  };
  for (const c of cs) {
    if (c.customer_id == null) continue;
    const v = monthlyValue(c);
    if (activeOn(c, nrrWindowStart)) ensureCust(c.customer_id).start += v;
    if (activeOn(c, now)) ensureCust(c.customer_id).current += v;
  }
  let startingMrr = 0;
  let cohortCurrentMrr = 0;
  let grrRetainedMrr = 0;
  let expansionMrr = 0;
  let contractionMrr = 0;
  let churnedMrr = 0;
  let cohortCount = 0;
  for (const { start, current } of byCustomer.values()) {
    if (start <= 0) continue; // not part of the starting cohort
    cohortCount += 1;
    startingMrr += start;
    cohortCurrentMrr += current;
    grrRetainedMrr += Math.min(current, start);
    if (current > start) expansionMrr += current - start;
    else if (current <= 0) churnedMrr += start;
    else if (current < start) contractionMrr += start - current;
  }
  const nrr = startingMrr > 0 ? cohortCurrentMrr / startingMrr : null;
  const grr = startingMrr > 0 ? grrRetainedMrr / startingMrr : null;

  // --- Expansion (won deals to existing customers) -------------------------
  const expWindowStart = addDays(now, -expansionWindowDays);
  // Earliest signal per customer: earliest contract start_date, so we can tell
  // whether a given won deal was a FIRST sale or an EXPANSION to an
  // already-landed customer.
  const earliestContractStart = new Map(); // customer_id -> earliest start_date (ms)
  for (const c of cs) {
    if (c.customer_id == null) continue;
    const start = parseDate(c.start_date);
    if (!start) continue;
    const prev = earliestContractStart.get(c.customer_id);
    if (prev == null || start.getTime() < prev) earliestContractStart.set(c.customer_id, start.getTime());
  }
  // Won deals with a customer + close date, sorted chronologically so we can
  // walk them and know which customers were already "landed" at each point.
  const wonDeals = [];
  for (const d of ds) {
    if (classifyStage(profile, d.stage) !== 'won') continue;
    if (d.customer_id == null) continue;
    const closed = parseDate(d.closed_date);
    if (!closed) continue;
    const value = d.closed_amount != null ? (Number(d.closed_amount) || 0) : (Number(d.amount) || 0);
    wonDeals.push({ customer_id: d.customer_id, closed, value });
  }
  wonDeals.sort((a, b) => a.closed - b.closed);
  const landedCustomers = new Set(); // customers with a prior won deal
  let expansionDeals = 0;
  let expansionAmount = 0;
  const expansionCustomers = new Set();
  for (const d of wonDeals) {
    const priorContract = earliestContractStart.has(d.customer_id)
      && earliestContractStart.get(d.customer_id) < d.closed.getTime();
    const priorWonDeal = landedCustomers.has(d.customer_id);
    const isExpansion = priorContract || priorWonDeal;
    // Only tally expansion deals that closed within the reporting window.
    if (isExpansion && d.closed >= expWindowStart && d.closed <= now) {
      expansionDeals += 1;
      expansionAmount += d.value;
      expansionCustomers.add(d.customer_id);
    }
    landedCustomers.add(d.customer_id); // this deal now makes the customer "landed"
  }

  return {
    profile,
    now: now.toISOString(),
    recurring: {
      mrr: round2(mrr),
      arr: round2(arr),
      active_contract_count: activeCount,
    },
    renewals: {
      upcoming,
      rate: {
        window_days: renewalWindowDays,
        renewed,
        churned: churnedResolved,
        unresolved,
        rate: renewalRate == null ? null : round2(renewalRate),
      },
    },
    retention: {
      window_days: nrrWindowDays,
      cohort_customer_count: cohortCount,
      starting_mrr: round2(startingMrr),
      current_cohort_mrr: round2(cohortCurrentMrr),
      expansion_mrr: round2(expansionMrr),
      contraction_mrr: round2(contractionMrr),
      churned_mrr: round2(churnedMrr),
      nrr: nrr == null ? null : round2(nrr),
      grr: grr == null ? null : round2(grr),
    },
    expansion: {
      window_days: expansionWindowDays,
      deal_count: expansionDeals,
      amount: round2(expansionAmount),
      customer_count: expansionCustomers.size,
    },
    churn: {
      window_days: renewalWindowDays,
      contract_count: churnContractCount,
      lost_mrr: round2(lostMrr),
      lost_arr: round2(lostMrr * 12),
    },
  };
}

// --- DB-backed entry point --------------------------------------------------
// Two org-scoped, parameterized fetches → pure math. sf MUST be an allowlisted
// scope field or we throw before building any SQL (defense in depth).
async function fetchContractRows({ sf, sv }, pool) {
  if (!SCOPE_FIELDS.has(sf)) throw new Error(`Illegal scope field: ${sf}`);
  const { rows } = await pool.query(
    `SELECT id, customer_id, start_date, end_date, monthly_amount, annual_value,
            status, renewal_stage, renewed_contract_id
       FROM service_contracts
      WHERE ${sf} = $1`,
    [sv]
  );
  return rows;
}

async function fetchWonDealRows({ sf, sv }, pool) {
  if (!SCOPE_FIELDS.has(sf)) throw new Error(`Illegal scope field: ${sf}`);
  const { rows } = await pool.query(
    `SELECT customer_id, amount, closed_amount, stage, closed_date
       FROM deals
      WHERE ${sf} = $1
        AND customer_id IS NOT NULL`,
    [sv]
  );
  return rows;
}

/**
 * Full retention summary for a scope. Runs the two scoped fetches then the pure
 * core. Options (renewalWindowDays / nrrWindowDays / expansionWindowDays) pass
 * straight through to buildRetention.
 */
async function getRetention({ sf, sv, profile = 'generic', now = new Date(), ...opts }, pool) {
  const [contracts, deals] = await Promise.all([
    fetchContractRows({ sf, sv }, pool),
    fetchWonDealRows({ sf, sv }, pool),
  ]);
  return buildRetention(contracts, deals, { profile, now, ...opts });
}

module.exports = {
  SCOPE_FIELDS,
  monthlyValue,
  annualValue,
  activeOn,
  currentlyActive,
  isRenewed,
  isChurned,
  buildRetention,
  fetchContractRows,
  fetchWonDealRows,
  getRetention,
};
