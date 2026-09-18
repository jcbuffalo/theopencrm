// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Lead scoring + routing (migration 147).
//
// Org-authored rules — {field, op, value} → points, optionally with a routing
// target — evaluated against a lead's fields. Safety contract mirrors
// services/segments.js:
//
//   1. STRICT ALLOWLIST. field must be one of SCORING_FIELDS and op one of
//      SCORING_OPS or the rule is rejected at write time (RuleError → 400)
//      AND skipped defensively at evaluation time. Field/op names NEVER
//      travel into SQL text — evaluation happens in JS over already-fetched
//      lead fields; the only SQL here is fixed-text, and every user value is
//      bound as a pg parameter.
//   2. The tenancy scope field comes from qs(req) and is still defensively
//      validated against SCOPE_FIELDS before being spliced into SQL.
//
// scoreLead()  — sum of points across matching active rules.
// pickOwner()  — routing: the first matching active rule with a
//                route_to_user_id (highest points first) whose min_score
//                threshold the lead's score meets wins, PROVIDED the target
//                user still belongs to the caller's tenancy; otherwise falls
//                back to leads.assignRoundRobin.

const pool = require('../db');
// NOTE: ./leads is required lazily inside pickOwner — leads.js requires this
// module for scoreLead, so a top-level require here would be circular.

const SCORING_FIELDS = ['source', 'title', 'company_name', 'has_email', 'has_phone'];
const SCORING_OPS = ['eq', 'contains', 'exists'];
const SCOPE_FIELDS = new Set(['org_id', 'user_id']);
const MAX_VALUE_LEN = 255;
const MAX_POINTS = 100000;

// Thrown for any rule the allowlist rejects. Routes map it to 400.
class RuleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuleError';
    this.status = 400;
  }
}

function assertScope([sf]) {
  if (!SCOPE_FIELDS.has(sf)) {
    // qs(req) can only produce org_id/user_id — guards refactors, not users.
    throw new Error(`Invalid scope field: ${sf}`);
  }
}

// Validate a rule payload for create/update. Returns the cleaned rule.
function validateRule(data = {}) {
  const field = data.field;
  if (!SCORING_FIELDS.includes(field)) {
    throw new RuleError(`field must be one of: ${SCORING_FIELDS.join(', ')}`);
  }
  const op = data.op;
  if (!SCORING_OPS.includes(op)) {
    throw new RuleError(`op must be one of: ${SCORING_OPS.join(', ')}`);
  }
  let value = null;
  if (op !== 'exists') {
    if (typeof data.value !== 'string' || data.value.trim() === '') {
      throw new RuleError(`op "${op}" requires a non-empty string value`);
    }
    value = data.value.trim().slice(0, MAX_VALUE_LEN);
  }
  const points = Number(data.points);
  if (!Number.isInteger(points) || Math.abs(points) > MAX_POINTS) {
    throw new RuleError(`points must be an integer between -${MAX_POINTS} and ${MAX_POINTS}`);
  }
  let routeTo = null;
  if (data.route_to_user_id !== undefined && data.route_to_user_id !== null && data.route_to_user_id !== '') {
    if (!Number.isInteger(data.route_to_user_id)) {
      throw new RuleError('route_to_user_id must be an integer user id');
    }
    routeTo = data.route_to_user_id;
  }
  let minScore = null;
  if (data.min_score !== undefined && data.min_score !== null && data.min_score !== '') {
    if (!Number.isInteger(data.min_score)) {
      throw new RuleError('min_score must be an integer');
    }
    minScore = data.min_score;
  }
  const isActive = data.is_active === undefined ? true : !!data.is_active;
  return { field, op, value, points, route_to_user_id: routeTo, min_score: minScore, is_active: isActive };
}

// Derive the comparable value of an allowlisted field from a lead's fields.
// has_email / has_phone are booleans; the rest are strings (or null).
function fieldValue(field, lead = {}) {
  switch (field) {
    case 'source':       return lead.source || null;
    case 'title':        return lead.title || null;
    case 'company_name': return lead.company_name || null;
    case 'has_email':    return !!(lead.email && String(lead.email).trim());
    case 'has_phone':    return !!(lead.phone && String(lead.phone).trim());
    default:             return null; // defensively unreachable (allowlist)
  }
}

// Does one rule match one lead? Pure JS over in-memory values — rule text
// never becomes SQL. Non-allowlisted rows (shouldn't exist) never match.
function ruleMatches(rule, lead) {
  if (!SCORING_FIELDS.includes(rule.field) || !SCORING_OPS.includes(rule.op)) return false;
  const v = fieldValue(rule.field, lead);
  if (typeof v === 'boolean') {
    // Boolean-derived fields: 'exists' (and eq as an alias for truthiness).
    if (rule.op === 'exists') return v;
    if (rule.op === 'eq') return v === (String(rule.value).toLowerCase() === 'true');
    return false; // 'contains' is meaningless on a boolean
  }
  if (rule.op === 'exists') return v !== null && String(v).trim() !== '';
  if (v === null || rule.value === null || rule.value === undefined) return false;
  const lhs = String(v).toLowerCase();
  const rhs = String(rule.value).toLowerCase();
  if (rule.op === 'eq') return lhs === rhs;
  if (rule.op === 'contains') return lhs.includes(rhs);
  return false;
}

async function activeRules([sf, sv]) {
  assertScope([sf]);
  const result = await pool.query(
    `SELECT * FROM lead_scoring_rules WHERE ${sf} = $1 AND is_active = TRUE ORDER BY id ASC`,
    [sv]
  );
  return result.rows;
}

/**
 * scoreLead — sum the points of every active rule that matches the lead.
 * @param {[string, any]} scope  qs(req) tuple
 * @param {object} leadFields    { source, title, company_name, email, phone }
 * @returns {Promise<number>}
 */
async function scoreLead(scope, leadFields) {
  const rules = await activeRules(scope);
  return rules.reduce(
    (sum, rule) => (ruleMatches(rule, leadFields) ? sum + (Number(rule.points) || 0) : sum),
    0
  );
}

/**
 * pickOwner — routing. Among active rules that carry a route_to_user_id,
 * take those that match the lead AND whose min_score (when set) the score
 * meets; highest points wins (ties → lowest id, deterministic). The target
 * is re-validated as in-tenancy at pick time — a routed lead can never point
 * at a foreign user. No winner → round-robin.
 * @returns {Promise<number|null>} a user id (or null when the org is empty)
 */
async function pickOwner(scope, leadFields, score) {
  const [sf, sv] = scope;
  assertScope(scope);
  const rules = (await activeRules(scope))
    .filter((r) => Number.isInteger(r.route_to_user_id))
    .filter((r) => r.min_score === null || r.min_score === undefined || Number(score) >= Number(r.min_score))
    .filter((r) => ruleMatches(r, leadFields))
    .sort((a, b) => (Number(b.points) || 0) - (Number(a.points) || 0) || a.id - b.id);

  for (const rule of rules) {
    const target = rule.route_to_user_id;
    // In-tenancy check: org scope → user must be an org member; personal
    // workspace → only the workspace owner themselves.
    if (sf === 'org_id') {
      const member = await pool.query(
        `SELECT id FROM users WHERE id = $1 AND org_id = $2`,
        [target, sv]
      );
      if (member.rows.length > 0) return target;
    } else if (target === sv) {
      return target;
    }
    // Stale target (user left the org / bad row) — try the next rule.
  }
  const { assignRoundRobin } = require('./leads'); // lazy: avoids require cycle
  return assignRoundRobin(scope);
}

// ---------------------------------------------------------------------------
// Rule CRUD — org-scoped exactly like the leads service.
// ---------------------------------------------------------------------------

async function listRules([sf, sv]) {
  assertScope([sf]);
  const result = await pool.query(
    `SELECT * FROM lead_scoring_rules WHERE ${sf} = $1 ORDER BY id ASC`,
    [sv]
  );
  return result.rows;
}

async function createRule(actor, data) {
  const rule = validateRule(data);
  const result = await pool.query(
    `INSERT INTO lead_scoring_rules (user_id, org_id, field, op, value, points, route_to_user_id, min_score, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      actor.userId || null,
      actor.orgId || null,
      rule.field, rule.op, rule.value, rule.points,
      rule.route_to_user_id, rule.min_score, rule.is_active,
    ]
  );
  return result.rows[0];
}

async function updateRule([sf, sv], id, data) {
  assertScope([sf]);
  const existing = await pool.query(
    `SELECT * FROM lead_scoring_rules WHERE id = $1 AND ${sf} = $2`,
    [id, sv]
  );
  if (existing.rows.length === 0) return null;
  // Full-row validation over merged values keeps the allowlist authoritative
  // on partial updates too.
  const cur = existing.rows[0];
  const rule = validateRule({
    field: data.field !== undefined ? data.field : cur.field,
    op: data.op !== undefined ? data.op : cur.op,
    value: data.value !== undefined ? data.value : cur.value,
    points: data.points !== undefined ? data.points : cur.points,
    route_to_user_id: data.route_to_user_id !== undefined ? data.route_to_user_id : cur.route_to_user_id,
    min_score: data.min_score !== undefined ? data.min_score : cur.min_score,
    is_active: data.is_active !== undefined ? data.is_active : cur.is_active,
  });
  const result = await pool.query(
    `UPDATE lead_scoring_rules
        SET field = $1, op = $2, value = $3, points = $4,
            route_to_user_id = $5, min_score = $6, is_active = $7
      WHERE id = $8 AND ${sf} = $9 RETURNING *`,
    [rule.field, rule.op, rule.value, rule.points,
     rule.route_to_user_id, rule.min_score, rule.is_active, id, sv]
  );
  return result.rows[0] || null;
}

async function deleteRule([sf, sv], id) {
  assertScope([sf]);
  const result = await pool.query(
    `DELETE FROM lead_scoring_rules WHERE id = $1 AND ${sf} = $2 RETURNING *`,
    [id, sv]
  );
  return result.rows[0] || null;
}

module.exports = {
  RuleError,
  SCORING_FIELDS,
  SCORING_OPS,
  validateRule,
  ruleMatches,
  scoreLead,
  pickOwner,
  listRules,
  createRule,
  updateRule,
  deleteRule,
};
