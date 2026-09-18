// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Relationship Segments — the criteria compiler + evaluator + bulk executor.
//
// A segment's `criteria` column is a JSONB array of {field, op, value} rows
// authored by end users. THIS FILE IS THE ONLY PLACE THAT TURNS THAT JSON INTO
// SQL, and it does so under two hard rules:
//
//   1. STRICT ALLOWLIST. Every (entity_type, field, op) triple must exist in
//      FIELD_ALLOWLIST below or compilation throws CriteriaError (→ 400 at the
//      route). Field names and operators are NEVER interpolated from user
//      input — the SQL text comes exclusively from the fragment builders in
//      this file.
//   2. FULL PARAMETERIZATION. User VALUES only ever travel as pg parameters
//      ($2..$n). The compiled WHERE text contains zero user-supplied bytes.
//
// Compiler contract (shared by every consumer):
//   • The tenancy scope value is ALWAYS $1. compile() emits fragments that
//     reference `$1` for org-scoping inside correlated subqueries, and pushes
//     its own params starting at $2.
//   • The scope FIELD (org_id | user_id) comes from qs(req) — a two-value
//     internal enum — and is still defensively validated here before being
//     spliced into SQL.
//   • Table aliases are fixed: companies → `c`, contacts → `ct`.
//
// Field semantics worth knowing:
//   • company.last_touch_older_than_days — mirrors the Accounts-home
//     derivation (routes/accountRoutes.js): last touch = the newest activity
//     attached to any of the company's deals (customer_id) or contacts
//     (company_id). A company with NO activity at all counts as "older than
//     any N" (never-touched is the coldest cohort — same treatment as the
//     gone-quiet rollup).
//   • contact.cadence_overdue — true ⇢ no activity referencing the contact in
//     the last CADENCE_OVERDUE_DAYS (30) days, including never-touched.
//
// Bulk actions (runBulkAction) are equally allowlist-driven: four verbs, each
// a single org-scoped statement whose member set is the compiled criteria
// subquery — membership is re-evaluated at write time, so the action hits the
// segment's CURRENT members, never a stale snapshot.

const pool = require('../db');
const { LIFECYCLE_STAGES } = require('../schemas/companies');

const CADENCE_OVERDUE_DAYS = 30;
const MAX_CRITERIA = 20;
const MAX_MEMBER_LIMIT = 200;
const DEFAULT_MEMBER_LIMIT = 50;
// Safety rail on bulk writes (security review P3): a single confirm-first bulk
// action can rewrite every matching row in the caller's own tenant. That's the
// point of the feature, but an unbounded blast radius is worth a guard — past
// this many current members we refuse and ask the user to narrow the segment,
// so a fat-fingered broad segment can't silently rewrite an entire book of
// business in one click. Generous enough that real batch cleanup still works.
const MAX_BULK_AFFECTED = 5000;

const ENTITY_TYPES = ['company', 'contact'];
const SCOPE_FIELDS = new Set(['org_id', 'user_id']);

// Thrown for any criteria/action the allowlist rejects. Routes map it to 400.
class CriteriaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CriteriaError';
    this.status = 400;
  }
}

// ---------------------------------------------------------------------------
// Value validators — throw CriteriaError with a message that names the field.
// ---------------------------------------------------------------------------

function expectNonEmptyString(field, v, maxLen = 255) {
  if (typeof v !== 'string' || v.trim() === '' || v.length > maxLen) {
    throw new CriteriaError(`"${field}" expects a non-empty string (max ${maxLen} chars)`);
  }
  return v.trim();
}

function expectStringArray(field, v, maxLen = 255, maxItems = 50) {
  if (!Array.isArray(v) || v.length === 0 || v.length > maxItems) {
    throw new CriteriaError(`"${field}" with op "in" expects a non-empty array (max ${maxItems} items)`);
  }
  return v.map((item) => expectNonEmptyString(field, item, maxLen));
}

function expectPosInt(field, v, max = 1000000000) {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? parseInt(v, 10) : v;
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new CriteriaError(`"${field}" expects a positive integer (max ${max})`);
  }
  return n;
}

function expectBool(field, v) {
  if (typeof v !== 'boolean') throw new CriteriaError(`"${field}" expects true or false`);
  return v;
}

function expectStage(field, v) {
  if (!LIFECYCLE_STAGES.includes(v)) {
    throw new CriteriaError(`"${field}" expects one of: ${LIFECYCLE_STAGES.join(', ')}`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// The allowlist. entity_type → field → op → builder({ value, push, sf }) → SQL
// fragment. `push(v)` registers a parameter and returns its `$n` placeholder
// ($1 is reserved for the scope value). `sf` is the pre-validated scope field.
// ---------------------------------------------------------------------------

// The Accounts-home last-touch derivation, as a correlated scalar subquery on
// companies alias `c`. COALESCE to epoch so never-touched compares as ancient.
function companyLastTouchSql(sf) {
  return `COALESCE((
    SELECT MAX(COALESCE(a.activity_date, a.created_at))
      FROM activities a
     WHERE a.${sf} = $1
       AND ( a.deal_id    IN (SELECT d.id FROM deals    d WHERE d.customer_id = c.id AND d.${sf} = $1)
          OR a.contact_id IN (SELECT k.id FROM contacts k WHERE k.company_id  = c.id AND k.${sf} = $1) )
  ), to_timestamp(0))`;
}

const FIELD_ALLOWLIST = {
  company: {
    lifecycle_stage: {
      eq: ({ value, push }) => `c.lifecycle_stage = ${push(expectStage('lifecycle_stage', value))}`,
      in: ({ value, push }) => {
        if (!Array.isArray(value) || value.length === 0) {
          throw new CriteriaError('"lifecycle_stage" with op "in" expects a non-empty array');
        }
        return `c.lifecycle_stage = ANY(${push(value.map((v) => expectStage('lifecycle_stage', v)))})`;
      },
    },
    industry: {
      eq:    ({ value, push }) => `c.industry = ${push(expectNonEmptyString('industry', value))}`,
      in:    ({ value, push }) => `c.industry = ANY(${push(expectStringArray('industry', value))})`,
      ilike: ({ value, push }) => `c.industry ILIKE ${push('%' + expectNonEmptyString('industry', value) + '%')}`,
    },
    last_touch_older_than_days: {
      gt: ({ value, push, sf }) =>
        `${companyLastTouchSql(sf)} < NOW() - make_interval(days => ${push(expectPosInt('last_touch_older_than_days', value, 3650))}::int)`,
    },
  },
  contact: {
    owner_user_id: {
      eq: ({ value, push }) => `ct.owner_id = ${push(expectPosInt('owner_user_id', value))}::int`,
    },
    title: {
      ilike: ({ value, push }) => `ct.job_title ILIKE ${push('%' + expectNonEmptyString('title', value) + '%')}`,
    },
    cadence_overdue: {
      // Polarity comes from the (validated) boolean; the value itself never
      // enters the SQL text. CADENCE_OVERDUE_DAYS is a module constant.
      eq: ({ value, sf }) => {
        const overdue = expectBool('cadence_overdue', value);
        return `${overdue ? 'NOT ' : ''}EXISTS (
          SELECT 1 FROM activities a
           WHERE a.${sf} = $1 AND a.contact_id = ct.id
             AND COALESCE(a.activity_date, a.created_at) >= NOW() - INTERVAL '${CADENCE_OVERDUE_DAYS} days'
        )`;
      },
    },
  },
};

// ---------------------------------------------------------------------------
// compileCriteria — the single JSON→SQL gate.
// ---------------------------------------------------------------------------

/**
 * @param {'company'|'contact'} entityType
 * @param {'org_id'|'user_id'} scopeField  — from qs(req); re-validated here.
 * @param {Array<{field:string,op:string,value:any}>} criteria
 * @returns {{ whereSql: string, params: any[] }}  whereSql is '' or
 *   ' AND (frag) AND (frag)…'; params are the values for $2..$n ($1 = scope).
 */
function compileCriteria(entityType, scopeField, criteria) {
  if (!SCOPE_FIELDS.has(scopeField)) {
    // qs(req) can only produce org_id/user_id — this guards refactors, not users.
    throw new Error(`Invalid scope field: ${scopeField}`);
  }
  if (!ENTITY_TYPES.includes(entityType)) {
    throw new CriteriaError(`entity_type must be one of: ${ENTITY_TYPES.join(', ')}`);
  }
  if (!Array.isArray(criteria)) {
    throw new CriteriaError('criteria must be an array of {field, op, value} rows');
  }
  if (criteria.length > MAX_CRITERIA) {
    throw new CriteriaError(`criteria supports at most ${MAX_CRITERIA} rows`);
  }

  const params = [];
  const push = (v) => {
    params.push(v);
    return `$${params.length + 1}`; // $1 is the scope value
  };

  const fragments = criteria.map((row, i) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new CriteriaError(`criteria[${i}] must be an object with field/op/value`);
    }
    const { field, op } = row;
    const fields = FIELD_ALLOWLIST[entityType];
    if (typeof field !== 'string' || !Object.prototype.hasOwnProperty.call(fields, field)) {
      throw new CriteriaError(
        `criteria[${i}]: field "${field}" is not filterable for ${entityType}s. Allowed: ${Object.keys(fields).join(', ')}`
      );
    }
    const ops = fields[field];
    if (typeof op !== 'string' || !Object.prototype.hasOwnProperty.call(ops, op)) {
      throw new CriteriaError(
        `criteria[${i}]: op "${op}" is not allowed for "${field}". Allowed: ${Object.keys(ops).join(', ')}`
      );
    }
    return ops[op]({ value: row.value, push, sf: scopeField });
  });

  const whereSql = fragments.length ? ` AND (${fragments.join(') AND (')})` : '';
  return { whereSql, params };
}

// Display-field SELECT lists, keyed by entity type. Fixed text, never user input.
const MEMBER_SELECT = {
  company: {
    from: 'companies c',
    idCol: 'c.id',
    cols: 'c.id, c.name, c.industry, c.type, c.status, c.lifecycle_stage, c.owner_id',
    order: 'ORDER BY c.name ASC, c.id ASC',
  },
  contact: {
    from: 'contacts ct',
    idCol: 'ct.id',
    cols: 'ct.id, ct.first_name, ct.last_name, ct.email, ct.job_title, ct.owner_id',
    order: 'ORDER BY ct.last_name ASC NULLS LAST, ct.first_name ASC, ct.id ASC',
  },
};

function scopedBase(entityType, scopeField) {
  const m = MEMBER_SELECT[entityType];
  const alias = entityType === 'company' ? 'c' : 'ct';
  return { m, scopeClause: `${alias}.${scopeField} = $1` };
}

/**
 * evaluate — the segment's current members (display fields), paginated/capped.
 * @param {{scopeField:string, scopeValue:any}} scope
 * @param {{entity_type:string, criteria:Array}} segment
 */
async function evaluate(scope, segment, { limit = DEFAULT_MEMBER_LIMIT, offset = 0 } = {}) {
  const { whereSql, params } = compileCriteria(segment.entity_type, scope.scopeField, segment.criteria);
  const { m, scopeClause } = scopedBase(segment.entity_type, scope.scopeField);
  const cappedLimit = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_MEMBER_LIMIT, 1), MAX_MEMBER_LIMIT);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);
  const result = await pool.query(
    `SELECT ${m.cols} FROM ${m.from} WHERE ${scopeClause}${whereSql} ${m.order}
      LIMIT $${params.length + 2} OFFSET $${params.length + 3}`,
    [scope.scopeValue, ...params, cappedLimit, safeOffset]
  );
  return result.rows;
}

/**
 * memberIds — the segment's current member ids (bounded by `max`). For
 * service-style bulk verbs that need explicit ids rather than an IN-subquery
 * (e.g. the chat cohort harness batching contacts into sequences.enroll).
 * Same compiled WHERE as evaluate/count; same deterministic ordering.
 */
async function memberIds(scope, segment, { max = MAX_BULK_AFFECTED } = {}) {
  const { whereSql, params } = compileCriteria(segment.entity_type, scope.scopeField, segment.criteria);
  const { m, scopeClause } = scopedBase(segment.entity_type, scope.scopeField);
  const result = await pool.query(
    `SELECT ${m.idCol} AS id FROM ${m.from} WHERE ${scopeClause}${whereSql} ${m.order}
      LIMIT $${params.length + 2}`,
    [scope.scopeValue, ...params, max]
  );
  return result.rows.map((r) => r.id);
}

/** count — total current members. Same compiled WHERE as evaluate. */
async function count(scope, segment) {
  const { whereSql, params } = compileCriteria(segment.entity_type, scope.scopeField, segment.criteria);
  const { m, scopeClause } = scopedBase(segment.entity_type, scope.scopeField);
  const result = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ${m.from} WHERE ${scopeClause}${whereSql}`,
    [scope.scopeValue, ...params]
  );
  return result.rows[0].n;
}

// ---------------------------------------------------------------------------
// Bulk actions — allowlisted verbs over the segment's CURRENT members.
// Each verb is one org-scoped statement; the member set is the compiled
// criteria as an IN-subquery, so nothing outside the caller's tenancy (or
// outside the segment) can be touched.
// ---------------------------------------------------------------------------

const BULK_ACTIONS = ['set_lifecycle_stage', 'assign_owner', 'create_task', 'open_case'];
const CASE_PRIORITIES = ['low', 'normal', 'high', 'urgent'];

/**
 * @param {{scopeField:string, scopeValue:any, userId:number, orgId:?number}} scope
 * @param {{entity_type:string, criteria:Array, name:string}} segment
 * @param {string} action — one of BULK_ACTIONS
 * @param {object} actionParams — verb-specific payload (validated here)
 * @returns {{ affected: number }}
 */
async function runBulkAction(scope, segment, action, actionParams = {}) {
  if (!BULK_ACTIONS.includes(action)) {
    throw new CriteriaError(`Unknown bulk action "${action}". Allowed: ${BULK_ACTIONS.join(', ')}`);
  }
  const entityType = segment.entity_type;

  // Blast-radius guard (P3): refuse a bulk write whose current member set
  // exceeds MAX_BULK_AFFECTED. Bounds the worst case and nudges the user to
  // narrow an over-broad segment rather than rewrite their whole book at once.
  const memberCount = await count(scope, segment);
  if (memberCount > MAX_BULK_AFFECTED) {
    throw new CriteriaError(
      `This segment matches ${memberCount} records — over the ${MAX_BULK_AFFECTED} limit for a single bulk action. Narrow the segment (add a rule) and try again.`
    );
  }

  const { whereSql, params } = compileCriteria(entityType, scope.scopeField, segment.criteria);
  const { m, scopeClause } = scopedBase(entityType, scope.scopeField);
  const sf = scope.scopeField;
  const memberSubquery = `SELECT ${m.idCol} FROM ${m.from} WHERE ${scopeClause}${whereSql}`;
  const next = () => `$${params.length + 2}`; // placeholder AFTER pushing below

  if (action === 'set_lifecycle_stage') {
    if (entityType !== 'company') {
      throw new CriteriaError('set_lifecycle_stage only applies to company segments');
    }
    const stage = expectStage('lifecycle_stage', actionParams.lifecycle_stage);
    const ph = next(); params.push(stage);
    const result = await pool.query(
      `UPDATE companies SET lifecycle_stage = ${ph}, updated_at = CURRENT_TIMESTAMP
        WHERE ${sf} = $1 AND id IN (${memberSubquery})`,
      [scope.scopeValue, ...params]
    );
    return { affected: result.rowCount };
  }

  if (action === 'assign_owner') {
    const ownerId = expectPosInt('owner_id', actionParams.owner_id);
    // The new owner must live inside the caller's tenancy — otherwise a bulk
    // write could point records at an arbitrary foreign user id.
    if (scope.orgId) {
      const member = await pool.query(
        `SELECT id FROM users WHERE id = $1 AND org_id = $2`, [ownerId, scope.orgId]
      );
      if (member.rows.length === 0) {
        throw new CriteriaError('owner_id must be a member of your organization');
      }
    } else if (ownerId !== scope.userId) {
      throw new CriteriaError('owner_id must be your own user id in a personal workspace');
    }
    const table = entityType === 'company' ? 'companies' : 'contacts';
    const ph = next(); params.push(ownerId);
    const result = await pool.query(
      `UPDATE ${table} SET owner_id = ${ph}::int, updated_at = CURRENT_TIMESTAMP
        WHERE ${sf} = $1 AND id IN (${memberSubquery})`,
      [scope.scopeValue, ...params]
    );
    return { affected: result.rowCount };
  }

  if (action === 'create_task') {
    // create_task — one open task per current member. Contacts link via
    // tasks.contact_id; companies (tasks has no company_id column) carry the
    // company name in the title so the task is self-describing.
    const title = expectNonEmptyString('title', actionParams.title, 200);
    const description = actionParams.description == null
      ? null
      : expectNonEmptyString('description', actionParams.description, 2000);
    let dueDate = null;
    if (actionParams.due_date != null && actionParams.due_date !== '') {
      if (typeof actionParams.due_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(actionParams.due_date)) {
        throw new CriteriaError('"due_date" expects YYYY-MM-DD');
      }
      dueDate = actionParams.due_date;
    }

    const pUser = `$${params.length + 2}`;  params.push(scope.userId);
    const pOrg = `$${params.length + 2}`;   params.push(scope.orgId || null);
    const pTitle = `$${params.length + 2}`; params.push(title);
    const pDesc = `$${params.length + 2}`;  params.push(description);
    const pDue = `$${params.length + 2}`;   params.push(dueDate);

    let insertSql;
    if (entityType === 'contact') {
      insertSql =
        `INSERT INTO tasks (user_id, org_id, contact_id, title, description, due_date, status, priority)
         SELECT ${pUser}, ${pOrg}, ct.id, ${pTitle}, ${pDesc}, ${pDue}::date, 'open', 'medium'
           FROM contacts ct WHERE ${scopeClause}${whereSql}`;
    } else {
      insertSql =
        `INSERT INTO tasks (user_id, org_id, title, description, due_date, status, priority)
         SELECT ${pUser}, ${pOrg}, ${pTitle} || ' — ' || c.name, ${pDesc}, ${pDue}::date, 'open', 'medium'
           FROM companies c WHERE ${scopeClause}${whereSql}`;
    }
    const result = await pool.query(insertSql, [scope.scopeValue, ...params]);
    return { affected: result.rowCount };
  }

  // open_case — one open support case per current member (the chat cohort
  // harness's open_case_for_each). Company members link via cases.company_id,
  // contact members via cases.contact_id — same columns POST /api/cases
  // writes. status is always 'open'; resolution transitions stay in
  // caseRoutes.js (they stamp resolved_at).
  const subject = expectNonEmptyString('subject', actionParams.subject, 500);
  const caseDescription = actionParams.description == null
    ? null
    : expectNonEmptyString('description', actionParams.description, 8000);
  const priority = actionParams.priority == null ? 'normal' : actionParams.priority;
  if (!CASE_PRIORITIES.includes(priority)) {
    throw new CriteriaError(`"priority" expects one of: ${CASE_PRIORITIES.join(', ')}`);
  }

  const cUser = `$${params.length + 2}`;  params.push(scope.userId);
  const cOrg = `$${params.length + 2}`;   params.push(scope.orgId || null);
  const cSubj = `$${params.length + 2}`;  params.push(subject);
  const cDesc = `$${params.length + 2}`;  params.push(caseDescription);
  const cPrio = `$${params.length + 2}`;  params.push(priority);

  let caseSql;
  if (entityType === 'contact') {
    caseSql =
      `INSERT INTO cases (user_id, org_id, contact_id, subject, description, status, priority)
       SELECT ${cUser}, ${cOrg}, ct.id, ${cSubj}, ${cDesc}, 'open', ${cPrio}
         FROM contacts ct WHERE ${scopeClause}${whereSql}`;
  } else {
    caseSql =
      `INSERT INTO cases (user_id, org_id, company_id, subject, description, status, priority)
       SELECT ${cUser}, ${cOrg}, c.id, ${cSubj}, ${cDesc}, 'open', ${cPrio}
         FROM companies c WHERE ${scopeClause}${whereSql}`;
  }
  const result = await pool.query(caseSql, [scope.scopeValue, ...params]);
  return { affected: result.rowCount };
}

// Machine-readable allowlist for the frontend builder (GET /api/segments/schema).
function describeAllowlist() {
  const out = {};
  for (const entity of ENTITY_TYPES) {
    out[entity] = Object.entries(FIELD_ALLOWLIST[entity]).map(([field, ops]) => ({
      field,
      ops: Object.keys(ops),
    }));
  }
  return out;
}

module.exports = {
  CriteriaError,
  compileCriteria,
  evaluate,
  count,
  memberIds,
  runBulkAction,
  describeAllowlist,
  BULK_ACTIONS,
  ENTITY_TYPES,
  CADENCE_OVERDUE_DAYS,
  MAX_MEMBER_LIMIT,
  MAX_BULK_AFFECTED,
};
