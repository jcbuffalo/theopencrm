// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Custom report builder — safe, org-scoped aggregate query engine.
//
// Powers POST /api/reports/run and the saved-report CRUD. Given a validated
// config { entity, filters, group_by, group_by_granularity, metric, chart_type }
// it builds a *parameterized* aggregate SQL string and runs it inside the
// caller's org scope.
//
// SECURITY MODEL (mirrors services/chatActions.js):
//   - ALLOWLIST-ONLY SQL. Entities, columns, metrics, operators, and date-bin
//     granularities are all drawn from the ALLOWLIST below. No user-supplied
//     string is ever interpolated into SQL — only tokens we have verified are
//     members of the allowlist. Every *value* is a bound parameter ($1..$n).
//   - ORG-SCOPING. Every query begins with `WHERE <sf> = $1`, where <sf> is
//     'org_id' or 'user_id' from qs(req). A cross-org read is structurally
//     impossible without skipping this engine.
//   - DEFENSE IN DEPTH. buildReportQuery re-checks every column against the
//     allowlist even though zod already validated the config, so a bug upstream
//     can't smuggle a raw identifier into the SQL text.

const { z } = require('zod');

// ---------------------------------------------------------------------------
// ALLOWLIST — the only entities/columns/metrics the engine will ever touch.
//
// Per entity:
//   table        — physical table name (never interpolated from user input)
//   columns      — column -> logical type ('text'|'int'|'numeric'|'bool'|
//                  'timestamp'|'date'). Type drives group-by binning + the
//                  builder UI's value-input choice.
//   groupable    — columns permitted in GROUP BY
//   filterable   — columns permitted in a WHERE filter
//   metricFields — numeric columns permitted in sum:/avg: aggregates
// ---------------------------------------------------------------------------
const ENTITIES = {
  deals: {
    label: 'Deals',
    table: 'deals',
    columns: {
      stage: 'text', phase: 'text', hot_flag: 'bool',
      vendor_id: 'int', salesman_id: 'int', customer_id: 'int',
      company_id: 'int', contact_id: 'int', lost_reason: 'text',
      release_status: 'text', currency: 'text',
      amount: 'numeric', closed_amount: 'numeric', probability: 'numeric',
      created_at: 'timestamp', expected_close_date: 'date', closed_date: 'date',
    },
    groupable: ['stage', 'phase', 'hot_flag', 'vendor_id', 'salesman_id',
      'customer_id', 'company_id', 'lost_reason', 'release_status', 'currency',
      'created_at', 'expected_close_date', 'closed_date'],
    filterable: ['stage', 'phase', 'hot_flag', 'vendor_id', 'salesman_id',
      'customer_id', 'company_id', 'lost_reason', 'release_status', 'currency',
      'amount', 'closed_amount', 'probability', 'created_at',
      'expected_close_date', 'closed_date'],
    metricFields: ['amount', 'closed_amount', 'probability'],
  },
  contacts: {
    label: 'Contacts',
    table: 'contacts',
    columns: {
      status: 'text', company_id: 'int', source: 'text', job_title: 'text',
      created_at: 'timestamp',
    },
    groupable: ['status', 'company_id', 'source', 'job_title', 'created_at'],
    filterable: ['status', 'company_id', 'source', 'job_title', 'created_at'],
    metricFields: [], // contacts have no natural numeric measure — count only
  },
  companies: {
    label: 'Companies',
    table: 'companies',
    columns: {
      type: 'text', industry: 'text', status: 'text',
      employee_count: 'numeric', created_at: 'timestamp',
    },
    groupable: ['type', 'industry', 'status', 'created_at'],
    filterable: ['type', 'industry', 'status', 'employee_count', 'created_at'],
    metricFields: ['employee_count'],
  },
  activities: {
    label: 'Activities',
    table: 'activities',
    columns: {
      type: 'text', outcome: 'text', deal_id: 'int', contact_id: 'int',
      duration_minutes: 'numeric', activity_date: 'timestamp', created_at: 'timestamp',
    },
    groupable: ['type', 'outcome', 'deal_id', 'contact_id', 'activity_date', 'created_at'],
    filterable: ['type', 'outcome', 'deal_id', 'contact_id', 'duration_minutes',
      'activity_date', 'created_at'],
    metricFields: ['duration_minutes'],
  },
};

// Filter operator -> SQL fragment. Value-bearing ops bind a parameter; the
// null-checks take none. `in` binds a single array param (pg expands ANY()).
const FILTER_OPS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'is_null', 'not_null']);
const BINARY_OP_SQL = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const DATE_GRANULARITIES = new Set(['day', 'week', 'month']);
const TEMPORAL_TYPES = new Set(['timestamp', 'date']);

// ---------------------------------------------------------------------------
// zod config schema. Shape-level validation; cross-field allowlist checks
// (does this entity actually permit this column?) run in superRefine where the
// entity is in scope.
// ---------------------------------------------------------------------------
const filterSchema = z.object({
  field: z.string().max(64),
  op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'is_null', 'not_null']),
  value: z.union([
    z.string(), z.number(), z.boolean(), z.null(),
    z.array(z.union([z.string(), z.number(), z.boolean()])).max(100),
  ]).optional(),
}).strip();

const configSchema = z.object({
  entity: z.enum(['deals', 'contacts', 'companies', 'activities']),
  filters: z.array(filterSchema).max(25).optional().default([]),
  group_by: z.string().max(64).nullable().optional(),
  group_by_granularity: z.enum(['day', 'week', 'month']).optional().default('month'),
  metric: z.string().max(64).optional().default('count'),
  chart_type: z.enum(['bar', 'line', 'pie', 'table']).optional().default('bar'),
}).strip().superRefine((cfg, ctx) => {
  const ent = ENTITIES[cfg.entity];
  if (!ent) return; // enum already guards; nothing else to check

  if (cfg.group_by != null && !ent.groupable.includes(cfg.group_by)) {
    ctx.addIssue({
      code: 'custom', path: ['group_by'],
      message: `group_by must be one of: ${ent.groupable.join(', ')}`,
    });
  }

  const m = parseMetric(cfg.metric);
  if (!m.ok) {
    ctx.addIssue({ code: 'custom', path: ['metric'], message: m.error });
  } else if (m.field && !ent.metricFields.includes(m.field)) {
    ctx.addIssue({
      code: 'custom', path: ['metric'],
      message: ent.metricFields.length
        ? `metric field must be one of: ${ent.metricFields.join(', ')}`
        : `${cfg.entity} supports only the 'count' metric`,
    });
  }

  (cfg.filters || []).forEach((f, i) => {
    if (!ent.filterable.includes(f.field)) {
      ctx.addIssue({
        code: 'custom', path: ['filters', i, 'field'],
        message: `filter field not allowed on ${cfg.entity}: ${f.field}`,
      });
    }
    const needsValue = f.op !== 'is_null' && f.op !== 'not_null';
    if (needsValue && (f.value === undefined || f.value === null)) {
      ctx.addIssue({
        code: 'custom', path: ['filters', i, 'value'],
        message: `operator "${f.op}" requires a value`,
      });
    }
  });
});

// Parse a metric string into { agg, field }. Accepts 'count', 'sum:<field>',
// 'avg:<field>'. The field regex is deliberately narrow (lowercase + _), and
// the caller STILL checks it against metricFields — belt and suspenders.
function parseMetric(metric) {
  if (metric == null || metric === 'count') return { ok: true, agg: 'count', field: null };
  const m = /^(sum|avg):([a-z_]{1,64})$/.exec(String(metric));
  if (!m) return { ok: false, error: "metric must be 'count', 'sum:<field>', or 'avg:<field>'" };
  return { ok: true, agg: m[1], field: m[2] };
}

/**
 * Parse + fully validate a raw config against the allowlist.
 * @returns {{ ok: true, config }} | {{ ok: false, errors: [{path,message}] }}
 */
function validateConfig(raw) {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) };
  }
  return { ok: true, config: parsed.data };
}

/**
 * Build a parameterized, org-scoped aggregate query for a validated config.
 * Pure (no DB). Re-verifies every identifier against the allowlist so no raw
 * user string can reach the SQL text.
 *
 * @param {object} config  a config that passed validateConfig
 * @param {{sf:'org_id'|'user_id', sv:number}} scope  from qs(req)
 * @returns {{ text: string, values: any[] }}
 */
function buildReportQuery(config, scope) {
  const { sf, sv } = scope || {};
  if (sf !== 'org_id' && sf !== 'user_id') throw new Error('invalid scope field');
  const ent = ENTITIES[config.entity];
  if (!ent) throw new Error(`invalid entity: ${config.entity}`);

  const values = [sv];
  const where = [`${sf} = $1`]; // sf is one of exactly two allowlisted tokens

  for (const f of (config.filters || [])) {
    if (!ent.filterable.includes(f.field)) throw new Error(`filter field not allowed: ${f.field}`);
    if (!FILTER_OPS.has(f.op)) throw new Error(`bad operator: ${f.op}`);
    const col = f.field; // verified member of the allowlist

    if (f.op === 'is_null') { where.push(`${col} IS NULL`); continue; }
    if (f.op === 'not_null') { where.push(`${col} IS NOT NULL`); continue; }
    if (f.op === 'in') {
      values.push(Array.isArray(f.value) ? f.value : [f.value]);
      where.push(`${col} = ANY($${values.length})`);
      continue;
    }
    if (f.op === 'contains') {
      values.push(`%${String(f.value)}%`);
      where.push(`${col} ILIKE $${values.length}`);
      continue;
    }
    values.push(f.value);
    where.push(`${col} ${BINARY_OP_SQL[f.op]} $${values.length}`);
  }

  // Group expression — plain column, or a date_trunc bin for temporal columns.
  let groupExpr = null;
  let groupIsTemporal = false;
  if (config.group_by) {
    if (!ent.groupable.includes(config.group_by)) throw new Error(`group_by not allowed: ${config.group_by}`);
    const type = ent.columns[config.group_by];
    if (TEMPORAL_TYPES.has(type)) {
      groupIsTemporal = true;
      const gran = DATE_GRANULARITIES.has(config.group_by_granularity) ? config.group_by_granularity : 'month';
      groupExpr = `date_trunc('${gran}', ${config.group_by})::date`;
    } else {
      groupExpr = config.group_by;
    }
  }

  // Metric expression.
  const m = parseMetric(config.metric || 'count');
  if (!m.ok) throw new Error(m.error);
  let metricExpr;
  if (m.agg === 'count') {
    metricExpr = 'COUNT(*)';
  } else {
    if (!ent.metricFields.includes(m.field)) throw new Error(`metric field not allowed: ${m.field}`);
    metricExpr = `COALESCE(${m.agg.toUpperCase()}(${m.field}), 0)`;
  }

  let text;
  if (groupExpr) {
    // Temporal groupings read best chronologically; categorical groupings read
    // best largest-first. Cap rows so a high-cardinality group can't blow up.
    const orderBy = groupIsTemporal ? 'group_key ASC' : 'value DESC, group_key ASC';
    text = `SELECT ${groupExpr} AS group_key, ${metricExpr} AS value `
      + `FROM ${ent.table} WHERE ${where.join(' AND ')} `
      + `GROUP BY ${groupExpr} ORDER BY ${orderBy} LIMIT 500`;
  } else {
    text = `SELECT ${metricExpr} AS value FROM ${ent.table} WHERE ${where.join(' AND ')}`;
  }
  return { text, values };
}

/**
 * Validate, build, and execute a report. Graceful: returns a structured error
 * on invalid config rather than throwing.
 *
 * @param {object} rawConfig
 * @param {{sf,sv}} scope
 * @param {{query:Function}} dbPool  a pg pool/client with .query
 */
async function runReport(rawConfig, scope, dbPool) {
  const v = validateConfig(rawConfig);
  if (!v.ok) return { ok: false, errors: v.errors };
  const { text, values } = buildReportQuery(v.config, scope);
  const result = await dbPool.query(text, values);
  const rows = result.rows.map(r => ({
    group_key: r.group_key === undefined ? null : r.group_key,
    value: Number(r.value),
  }));
  return { ok: true, config: v.config, rows };
}

/**
 * Allowlist metadata for the builder UI (entity/column/metric/op choices).
 * No table names leak — the frontend only needs logical names + types.
 */
function describeEntities() {
  const out = {};
  for (const [name, ent] of Object.entries(ENTITIES)) {
    out[name] = {
      label: ent.label,
      columns: ent.columns,
      groupable: ent.groupable,
      filterable: ent.filterable,
      metric_fields: ent.metricFields,
    };
  }
  return {
    entities: out,
    filter_ops: Array.from(FILTER_OPS),
    granularities: Array.from(DATE_GRANULARITIES),
    chart_types: ['bar', 'line', 'pie', 'table'],
  };
}

module.exports = {
  ENTITIES,
  configSchema,
  parseMetric,
  validateConfig,
  buildReportQuery,
  runReport,
  describeEntities,
};
