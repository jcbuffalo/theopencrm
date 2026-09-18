// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Smoke tests for routes/_bulkOps.js — the shared bulk PATCH/DELETE helper.
//
// We exercise the handler factory directly with a synthetic req/res/qs and a
// stubbed pool. The factory returns an Express-style (req, res) handler;
// no need to spin up a full app.

// describe / test / expect / beforeEach / vi are global.

// Patch live audit exports so audit.fromReq doesn't try to write to a
// non-existent audit_log table in the test environment.
const audit = require('../services/audit');
audit.record  = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

const { buildBulkUpdate, buildBulkDelete } = require('../routes/_bulkOps');

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

function makeReq(body = {}) {
  return {
    body,
    userId: 1,
    orgId: 99,
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  };
}

const qs = () => ['org_id', 99];

describe('bulkUpdate handler', () => {
  test('rejects with 400 when ids array is empty or missing', async () => {
    const pool = { query: vi.fn() };
    const handler = buildBulkUpdate({ resource: 'contacts', table: 'contacts', allowlist: ['status'], qs, pool });
    const res = makeRes();
    await handler(makeReq({ ids: [], patch: { status: 'active' } }), res);
    expect(res.statusCode).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('rejects with 400 when patch contains a disallowed column', async () => {
    const pool = { query: vi.fn() };
    const handler = buildBulkUpdate({ resource: 'contacts', table: 'contacts', allowlist: ['status'], qs, pool });
    const res = makeRes();
    await handler(makeReq({ ids: [1, 2], patch: { evil_column: 'pwn' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/not allowed/i);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('applies allowed column patch and returns updated_count', async () => {
    const pool = { query: vi.fn().mockResolvedValueOnce({ rowCount: 2, rows: [{ id: 1 }, { id: 2 }] }) };
    const handler = buildBulkUpdate({ resource: 'contacts', table: 'contacts', allowlist: ['status'], qs, pool });
    const res = makeRes();
    await handler(makeReq({ ids: [1, 2], patch: { status: 'active' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.updated_count).toBe(2);
    // The SQL should include the SET clause for the allowed column.
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE contacts/i);
    expect(sql).toMatch(/status = \$1/);
    expect(params[0]).toBe('active');
  });

  test('rejects empty patch object', async () => {
    const pool = { query: vi.fn() };
    const handler = buildBulkUpdate({ resource: 'contacts', table: 'contacts', allowlist: ['status'], qs, pool });
    const res = makeRes();
    await handler(makeReq({ ids: [1], patch: {} }), res);
    expect(res.statusCode).toBe(400);
  });
});

describe('bulkDelete handler', () => {
  test('soft-deletes when hasSoftDelete=true', async () => {
    const pool = { query: vi.fn().mockResolvedValueOnce({ rowCount: 3, rows: [{ id: 1 }, { id: 2 }, { id: 3 }] }) };
    const handler = buildBulkDelete({ resource: 'tasks', table: 'tasks', qs, pool, hasSoftDelete: true });
    const res = makeRes();
    await handler(makeReq({ ids: [1, 2, 3] }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.updated_count).toBe(3);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE tasks/i);
    expect(sql).toMatch(/deleted_at/);
  });

  test('hard-deletes when hasSoftDelete=false', async () => {
    const pool = { query: vi.fn().mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7 }] }) };
    const handler = buildBulkDelete({ resource: 'contacts', table: 'contacts', qs, pool, hasSoftDelete: false });
    const res = makeRes();
    await handler(makeReq({ ids: [7] }), res);
    expect(res.statusCode).toBe(200);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM contacts/i);
  });
});
