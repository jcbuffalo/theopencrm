// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Seat + record caps per pricing tier — INERT BY DEFAULT.
//
// Mirrors services/quotaEnforcer.js (the AI-request quota enforcer): a
// tier→limits config map, a typed exceeded-error carrying { orgId, tier,
// metric, limit, current } details, and fail-OPEN behavior on every internal
// error. The 402 response body mirrors middleware/requireAiBilling.js's deny
// shape ({ success, error, code, action }) plus quotaEnforcer's details
// object, so the frontend handles both billing gates the same way.
//
// THE SAFETY CONTRACT (this runs against live production orgs):
//   • organizations.limits_tier is NULL for every org until a super-admin
//     explicitly sets it (migration 136 adds it with no default and no
//     backfill). NULL → UNLIMITED. Enforcement is inert on deploy.
//   • Comped orgs (ai_billing_status = 'comped') → UNLIMITED.
//   • Paid orgs (ai_billing_status = 'active')   → UNLIMITED.
//   • Super-admin callers (admin_users.role = 'super_admin') → UNLIMITED.
//     Per-USER, not per-org — same rationale as requireAiBilling.js: the
//     per-user check is what the rest of the codebase uses for privileged
//     paths and is robust against org-schema changes.
//   • Unknown/garbage limits_tier value → UNLIMITED (fail-open).
//   • Personal (no-org) workspaces → UNLIMITED (no tier to be on).
//   • Any DB error anywhere in the check → UNLIMITED (fail-open, logged).
// Only an org EXPLICITLY assigned a capped tier, that is not comped/paid,
// with a non-super-admin caller, ever sees a 402 from this module.
//
// Caps come from PRICING_AND_FEATURES.md (Free: 1 seat / ≤100 contacts /
// ≤10 deals; Starter: ≤10 seats; Pro: ≤50 seats; Enterprise: negotiated).
// Treat that doc as the config source; keep the numbers in sync manually
// (same convention as quotaEnforcer's TIER_QUOTAS).
//
// No in-process caching (unlike requireAiBilling): creates and invites are
// low-frequency writes, and the two lookups are single-row indexed reads.
// Skipping the cache keeps the module trivially testable.

const pool = require('../db');
const logger = require('./logger');

// Explicit sentinel for "no cap". Infinity so `current >= limit` is never
// true, matching quotaEnforcer's enterprise convention.
const UNLIMITED = Infinity;

// tier → { seats, contacts, deals, companies }. Anything omitted or not a
// finite number is treated as UNLIMITED by limitFor().
const TIER_LIMITS = {
  free: {
    label: 'Free',
    seats: 1,
    contacts: 100,
    deals: 10,
    companies: 100,
  },
  starter: {
    label: 'Starter',
    seats: 10,
    contacts: UNLIMITED,
    deals: UNLIMITED,
    companies: UNLIMITED,
  },
  pro: {
    label: 'Professional',
    seats: 50,
    contacts: UNLIMITED,
    deals: UNLIMITED,
    companies: UNLIMITED,
  },
  enterprise: {
    label: 'Enterprise',
    seats: UNLIMITED,
    contacts: UNLIMITED,
    deals: UNLIMITED,
    companies: UNLIMITED,
  },
};

// Resources we know how to count. Table names are from this fixed map — the
// resource string is NEVER interpolated into SQL directly.
const RESOURCE_TABLES = {
  contacts: 'contacts',
  deals: 'deals',
  companies: 'companies',
};

class TierLimitExceeded extends Error {
  constructor({ orgId, tier, metric, limit, current, message }) {
    super(message || `Tier limit exceeded for ${metric}: ${current}/${limit} on tier ${tier}.`);
    this.code = 'TIER_LIMIT_EXCEEDED';
    this.statusCode = 402;
    this.action = 'upgrade';
    this.details = { orgId, tier, metric, limit, current };
  }

  // The over-limit 402 body: requireAiBilling's deny() shape + quotaEnforcer's
  // details, so existing 402 handling on the frontend needs no new plumbing.
  toResponseBody() {
    return {
      success: false,
      error: this.message,
      code: this.code,
      action: this.action,
      details: this.details,
    };
  }
}

function upgradeMessage(tierLabel, metric, limit) {
  if (metric === 'seats') {
    return `Your ${tierLabel} plan includes ${limit} seat${limit === 1 ? '' : 's'} and all are in use. Upgrade your plan to invite more teammates.`;
  }
  return `Your ${tierLabel} plan allows up to ${limit} ${metric}. Upgrade your plan to keep adding records.`;
}

// True while the vitest suite runs, unless a tier-enforcement test opts in.
// Same pattern as requireAiBilling.js: the existing route suites queue mocked
// pool responses in strict order, and an always-on gate would consume them.
function bypassedInTests() {
  return process.env.NODE_ENV === 'test' && process.env.TIER_ENFORCEMENT_IN_TESTS !== 'true';
}

// Per-user super-admin check — mirrors requireAiBilling.isSuperAdminCached
// (sans cache). DB error → false (never elevate on error); the enforcement
// paths below still fail open on their own errors.
async function isSuperAdminUser(userId) {
  if (!userId) return false;
  try {
    const r = await pool.query('SELECT role FROM admin_users WHERE user_id = $1', [userId]);
    return r.rows[0]?.role === 'super_admin';
  } catch {
    return false;
  }
}

// Load the columns limitFor() needs. Returns null (→ UNLIMITED) on any error
// or missing row — an org lookup hiccup must never block a write.
async function getOrgLimitsRow(orgId) {
  if (!orgId) return null;
  try {
    const r = await pool.query(
      'SELECT id, limits_tier, ai_billing_status FROM organizations WHERE id = $1',
      [orgId]
    );
    return r.rows[0] || null;
  } catch (err) {
    logger.warn('tier_limits_org_lookup_failed', { orgId, error: err.message });
    return null;
  }
}

/**
 * The cap for one resource on one org, with every exemption applied.
 * `org` is a row containing { id, limits_tier, ai_billing_status } (or null).
 * Returns a finite number ONLY for an org explicitly on a capped tier that
 * is neither comped nor paid. Everything else → UNLIMITED.
 */
function limitFor(org, resource) {
  if (!org) return UNLIMITED; // no org row (or lookup failed) → fail open
  const billing = org.ai_billing_status;
  if (billing === 'comped' || billing === 'active') return UNLIMITED; // comped / paid orgs exempt
  if (!org.limits_tier) return UNLIMITED; // no tier explicitly assigned → inert
  const cfg = TIER_LIMITS[org.limits_tier];
  if (!cfg) return UNLIMITED; // unknown tier value → fail open
  const cap = cfg[resource];
  return typeof cap === 'number' && Number.isFinite(cap) ? cap : UNLIMITED;
}

/**
 * Seat check for the invite flow. Seats = active members + pending unexpired
 * invites (so an owner can't queue invites past the cap).
 * Returns { ok: true } or { ok: false, statusCode: 402, body }.
 * Fail-open: any internal error returns ok.
 */
async function enforceSeatLimit(orgScope, org) {
  try {
    const cap = limitFor(org, 'seats');
    if (cap === UNLIMITED) return { ok: true };

    const [scopeField, scopeValue] = orgScope;
    if (scopeField !== 'org_id') return { ok: true }; // personal workspaces have no seats

    const r = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM users
           WHERE org_id = $1 AND status = 'active')
       + (SELECT COUNT(*)::int FROM org_invites
           WHERE org_id = $1 AND accepted_at IS NULL AND expires_at > NOW()) AS seats`,
      [scopeValue]
    );
    const current = Number(r.rows[0]?.seats || 0);
    if (current >= cap) {
      const tier = org.limits_tier;
      const label = TIER_LIMITS[tier]?.label || tier;
      const exceeded = new TierLimitExceeded({
        orgId: org.id, tier, metric: 'seats', limit: cap, current,
        message: upgradeMessage(label, 'seats', cap),
      });
      return { ok: false, statusCode: exceeded.statusCode, body: exceeded.toResponseBody() };
    }
    return { ok: true };
  } catch (err) {
    logger.warn('tier_seat_check_failed', { orgId: org?.id, error: err.message });
    return { ok: true }; // fail open
  }
}

/**
 * Record-count check for create handlers. `resource` ∈ contacts|deals|companies.
 * Returns { ok: true } or { ok: false, statusCode: 402, body }.
 * Fail-open: unknown resource or any internal error returns ok.
 */
async function enforceRecordLimit(orgScope, org, resource) {
  try {
    const table = RESOURCE_TABLES[resource];
    if (!table) return { ok: true }; // unknown resource → fail open

    const cap = limitFor(org, resource);
    if (cap === UNLIMITED) return { ok: true };

    const [scopeField, scopeValue] = orgScope;
    if (scopeField !== 'org_id' && scopeField !== 'user_id') return { ok: true };

    const r = await pool.query(
      `SELECT COUNT(*)::int AS c FROM ${table} WHERE ${scopeField} = $1`,
      [scopeValue]
    );
    const current = Number(r.rows[0]?.c || 0);
    if (current >= cap) {
      const tier = org.limits_tier;
      const label = TIER_LIMITS[tier]?.label || tier;
      const exceeded = new TierLimitExceeded({
        orgId: org.id, tier, metric: resource, limit: cap, current,
        message: upgradeMessage(label, resource, cap),
      });
      return { ok: false, statusCode: exceeded.statusCode, body: exceeded.toResponseBody() };
    }
    return { ok: true };
  } catch (err) {
    logger.warn('tier_record_check_failed', { orgId: org?.id, resource, error: err.message });
    return { ok: true }; // fail open
  }
}

// ---------------------------------------------------------------------------
// Route-facing gates. One call per handler:
//
//   const gate = await tierLimits.recordLimitGate(req, 'contacts');
//   if (gate) return res.status(gate.statusCode).json(gate.body);
//
// Returns null when allowed (which is almost always), or { statusCode, body }.
// Both gates own the full exemption ladder so route code stays one line.
// ---------------------------------------------------------------------------

async function seatLimitGate(req) {
  try {
    if (bypassedInTests()) return null;
    if (!req.orgId) return null; // personal workspace → no seats to cap
    if (await isSuperAdminUser(req.userId)) return null;
    const org = await getOrgLimitsRow(req.orgId);
    if (!org || !org.limits_tier) return null; // no explicit tier → inert (skip counting entirely)
    const check = await enforceSeatLimit(['org_id', req.orgId], org);
    return check.ok ? null : { statusCode: check.statusCode, body: check.body };
  } catch (err) {
    logger.warn('tier_seat_gate_failed_open', { orgId: req.orgId, error: err.message });
    return null; // fail open
  }
}

async function recordLimitGate(req, resource) {
  try {
    if (bypassedInTests()) return null;
    if (!req.orgId) return null; // personal workspace → no tier to be on
    if (await isSuperAdminUser(req.userId)) return null;
    const org = await getOrgLimitsRow(req.orgId);
    if (!org || !org.limits_tier) return null; // no explicit tier → inert (skip counting entirely)
    const check = await enforceRecordLimit(['org_id', req.orgId], org, resource);
    return check.ok ? null : { statusCode: check.statusCode, body: check.body };
  } catch (err) {
    logger.warn('tier_record_gate_failed_open', { orgId: req.orgId, resource, error: err.message });
    return null; // fail open
  }
}

module.exports = {
  UNLIMITED,
  TIER_LIMITS,
  TierLimitExceeded,
  limitFor,
  enforceSeatLimit,
  enforceRecordLimit,
  seatLimitGate,
  recordLimitGate,
  getOrgLimitsRow,
  isSuperAdminUser,
};
