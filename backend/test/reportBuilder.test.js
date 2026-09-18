// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Custom report builder — engine unit tests.
//
// validateConfig + buildReportQuery are pure (no DB); runReport takes a pg-like
// pool so we can assert the exact SQL it builds is ORG-SCOPED and only ever
// references ALLOWLISTED columns. We null out the real pool's query/connect so
// nothing reaches a real database (reportBuilder itself requires no db, but the
// harness convention is to be safe).

// describe / test / expect / vi are vitest globals.

const realPool = require('../db');
realPool.query = vi.fn();
realPool.connect = vi.fn();

const rb = require('../services/reportBuilder');

const SCOPE = { sf: 'org_id', sv: 7 };
const USER_SCOPE = { sf: 'user_id', sv: 4242 };

// A mock pg pool whose query() records calls and returns fixed rows.
function mockPool(rows = [{ group_key: 'LEAD', value: 3 }]) {
  return {
    calls: [],
    query: vi.fn(function (sql, params) {
      this.calls.push([sql, params]);
      return Promise.resolve({ rows });
    }),
  };
}

describe('validateConfig (allowlist enforcement)', () => {
  test('accepts a well-formed deals config and applies defaults', () => {
    const v = rb.validateConfig({ entity: 'deals', group_by: 'stage', metric: 'count' });
    expect(v.ok).toBe(true);
    expect(v.config.chart_type).toBe('bar');        // default
    expect(v.config.group_by_granularity).toBe('month'); // default
    expect(v.config.filters).toEqual([]);           // default
  });

  test('rejects a non-allowlisted entity', () => {
    const v = rb.validateConfig({ entity: 'users', metric: 'count' });
    expect(v.ok).toBe(false);
  });

  test('rejects a group_by column that is not in the allowlist', () => {
    const v = rb.validateConfig({ entity: 'deals', group_by: 'password' });
    expect(v.ok).toBe(false);
    expect(v.errors.some(e => e.path === 'group_by')).toBe(true);
  });

  test('rejects a filter field that is not in the allowlist', () => {
    const v = rb.validateConfig({
      entity: 'deals',
      filters: [{ field: 'salesman_id; DROP TABLE deals', op: 'eq', value: 1 }],
    });
    expect(v.ok).toBe(false);
    expect(v.errors.some(e => /filters\.0\.field/.test(e.path))).toBe(true);
  });

  test('rejects sum/avg on a non-numeric column', () => {
    const v = rb.validateConfig({ entity: 'deals', metric: 'sum:stage' });
    expect(v.ok).toBe(false);
    expect(v.errors.some(e => e.path === 'metric')).toBe(true);
  });

  test('rejects a malformed metric string', () => {
    const v = rb.validateConfig({ entity: 'deals', metric: 'median:amount' });
    expect(v.ok).toBe(false);
  });

  test('requires a value for value-bearing operators', () => {
    const v = rb.validateConfig({ entity: 'deals', filters: [{ field: 'stage', op: 'eq' }] });
    expect(v.ok).toBe(false);
    expect(v.errors.some(e => /filters\.0\.value/.test(e.path))).toBe(true);
  });

  test('allows null-check operators without a value', () => {
    const v = rb.validateConfig({ entity: 'deals', filters: [{ field: 'closed_date', op: 'is_null' }] });
    expect(v.ok).toBe(true);
  });
});

describe('buildReportQuery — org scoping + allowlisted SQL', () => {
  test('count grouped by a categorical column is org-scoped and allowlist-only', () => {
    const { text, values } = rb.buildReportQuery(
      { entity: 'deals', group_by: 'stage', metric: 'count', filters: [] }, SCOPE);

    expect(text).toMatch(/FROM deals/);
    expect(text).toMatch(/WHERE org_id = \$1/);   // org-scoped, bound param
    expect(text).toMatch(/SELECT stage AS group_key/);
    expect(text).toMatch(/COUNT\(\*\) AS value/);
    expect(text).toMatch(/GROUP BY stage/);
    expect(text).toMatch(/ORDER BY value DESC/);   // categorical → largest first
    expect(text).toMatch(/LIMIT 500/);
    expect(values).toEqual([7]);                    // scope value only
    // Nothing off-allowlist leaked in.
    expect(text).not.toMatch(/DROP|user_id\s*=\s*\$2|password/i);
  });

  test('falls back to user_id scoping when sf is user_id', () => {
    const { text, values } = rb.buildReportQuery(
      { entity: 'contacts', group_by: 'status', metric: 'count', filters: [] }, USER_SCOPE);
    expect(text).toMatch(/WHERE user_id = \$1/);
    expect(values).toEqual([4242]);
  });

  test('bins a temporal group_by with date_trunc at the requested granularity', () => {
    const monthly = rb.buildReportQuery(
      { entity: 'deals', group_by: 'created_at', group_by_granularity: 'month', metric: 'count', filters: [] }, SCOPE);
    expect(monthly.text).toMatch(/date_trunc\('month', created_at\)::date AS group_key/);
    expect(monthly.text).toMatch(/GROUP BY date_trunc\('month', created_at\)::date/);
    expect(monthly.text).toMatch(/ORDER BY group_key ASC/); // temporal → chronological

    const weekly = rb.buildReportQuery(
      { entity: 'activities', group_by: 'activity_date', group_by_granularity: 'week', metric: 'count', filters: [] }, SCOPE);
    expect(weekly.text).toMatch(/date_trunc\('week', activity_date\)::date/);
  });

  test('sum/avg metric emits COALESCE(SUM|AVG(<allowlisted field>), 0)', () => {
    const sum = rb.buildReportQuery(
      { entity: 'deals', group_by: 'salesman_id', metric: 'sum:amount', filters: [] }, SCOPE);
    expect(sum.text).toMatch(/COALESCE\(SUM\(amount\), 0\) AS value/);

    const avg = rb.buildReportQuery(
      { entity: 'companies', group_by: 'industry', metric: 'avg:employee_count', filters: [] }, SCOPE);
    expect(avg.text).toMatch(/COALESCE\(AVG\(employee_count\), 0\) AS value/);
  });

  test('filters bind values as parameters after the scope param', () => {
    const { text, values } = rb.buildReportQuery({
      entity: 'deals', group_by: 'stage', metric: 'count',
      filters: [
        { field: 'hot_flag', op: 'eq', value: true },
        { field: 'amount', op: 'gte', value: 1000 },
        { field: 'stage', op: 'in', value: ['LEAD', 'QUALIFIED'] },
        { field: 'lost_reason', op: 'contains', value: 'price' },
        { field: 'closed_date', op: 'is_null' },
      ],
    }, SCOPE);

    expect(text).toMatch(/hot_flag = \$2/);
    expect(text).toMatch(/amount >= \$3/);
    expect(text).toMatch(/stage = ANY\(\$4\)/);
    expect(text).toMatch(/lost_reason ILIKE \$5/);
    expect(text).toMatch(/closed_date IS NULL/);       // no param bound
    expect(values).toEqual([7, true, 1000, ['LEAD', 'QUALIFIED'], '%price%']);
  });

  test('no group_by returns a single scalar aggregate (no GROUP BY)', () => {
    const { text } = rb.buildReportQuery({ entity: 'deals', metric: 'sum:amount', filters: [] }, SCOPE);
    expect(text).toMatch(/SELECT COALESCE\(SUM\(amount\), 0\) AS value FROM deals WHERE org_id = \$1/);
    expect(text).not.toMatch(/GROUP BY/);
  });

  test('DEFENSE IN DEPTH: throws if handed an off-allowlist column directly', () => {
    expect(() => rb.buildReportQuery(
      { entity: 'deals', group_by: 'evil_col', metric: 'count', filters: [] }, SCOPE)).toThrow();
    expect(() => rb.buildReportQuery(
      { entity: 'deals', metric: 'count', filters: [{ field: 'evil_col', op: 'eq', value: 1 }] }, SCOPE)).toThrow();
    expect(() => rb.buildReportQuery(
      { entity: 'deals', metric: 'count', filters: [] }, { sf: 'evil', sv: 1 })).toThrow();
  });
});

describe('runReport (with mock pool)', () => {
  test('runs the org-scoped query and returns numeric-coerced rows', async () => {
    const pool = mockPool([{ group_key: 'LEAD', value: '5' }, { group_key: 'WON', value: '2' }]);
    const out = await rb.runReport({ entity: 'deals', group_by: 'stage', metric: 'count' }, SCOPE, pool);

    expect(out.ok).toBe(true);
    const [sql, params] = pool.calls[0];
    expect(sql).toMatch(/WHERE org_id = \$1/);
    expect(params).toEqual([7]);
    expect(out.rows).toEqual([
      { group_key: 'LEAD', value: 5 },
      { group_key: 'WON', value: 2 },
    ]);
  });

  test('returns a structured error (and never queries) on invalid config', async () => {
    const pool = mockPool();
    const out = await rb.runReport({ entity: 'deals', group_by: 'nope' }, SCOPE, pool);
    expect(out.ok).toBe(false);
    expect(out.errors.length).toBeGreaterThan(0);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('describeEntities (builder metadata)', () => {
  test('exposes only the four allowlisted entities with column metadata', () => {
    const meta = rb.describeEntities();
    expect(Object.keys(meta.entities).sort()).toEqual(['activities', 'companies', 'contacts', 'deals']);
    expect(meta.entities.deals.metric_fields).toContain('amount');
    expect(meta.chart_types).toContain('bar');
    expect(meta.filter_ops).toContain('contains');
  });
});
