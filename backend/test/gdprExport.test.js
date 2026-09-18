// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// GET /api/me/export — export_version 2 (registry + information_schema
// driven, 2026-09-14 audit). Verifies: newer modules are included, personal
// tables are caller-scoped, BYTEA/secret columns are stripped, and tables
// missing from the deployment are skipped without failing the export.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

const audit = require('../services/audit');
audit.record = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const meRoutes = require('../routes/meRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/me', meRoutes);
  return app;
}

const USER_ID = 777;
function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

// The information_schema fixture: a representative slice of the registry.
// documents carries a BYTEA `content` column that must be stripped;
// `portal_secret_token` exercises the secret-name filter; sequences is
// deliberately ABSENT (deployment without migration 132) and must be skipped.
const COLUMN_FIXTURE = [
  ['companies', 'id', 'integer'], ['companies', 'name', 'text'],
  ['companies', 'user_id', 'integer'], ['companies', 'org_id', 'integer'],
  ['companies', 'created_at', 'timestamp with time zone'],
  ['leads', 'id', 'integer'], ['leads', 'email', 'text'],
  ['leads', 'user_id', 'integer'], ['leads', 'org_id', 'integer'],
  ['leads', 'created_at', 'timestamp with time zone'],
  ['documents', 'id', 'integer'], ['documents', 'filename', 'text'],
  ['documents', 'content', 'bytea'], ['documents', 'portal_secret_token', 'text'],
  ['documents', 'user_id', 'integer'], ['documents', 'org_id', 'integer'],
  ['notifications', 'id', 'integer'], ['notifications', 'user_id', 'integer'],
  ['notifications', 'org_id', 'integer'], ['notifications', 'body', 'text'],
  ['chat_sessions', 'id', 'uuid'], ['chat_sessions', 'user_id', 'integer'],
  ['chat_messages', 'id', 'integer'], ['chat_messages', 'session_id', 'uuid'],
  ['chat_messages', 'content', 'text'],
].map(([table_name, column_name, data_type]) => ({ table_name, column_name, data_type }));

// Route every pool.query on its SQL text. Captures per-table queries so
// assertions can inspect the generated SQL.
const captured = [];
function installQueryRouter() {
  captured.length = 0;
  mockPool.query.mockImplementation((sql, params) => {
    captured.push({ sql, params });
    if (sql.includes('information_schema.columns')) {
      return Promise.resolve({ rows: COLUMN_FIXTURE });
    }
    if (sql.includes('FROM users WHERE id')) {
      return Promise.resolve({ rows: [{ id: USER_ID, email: 'x@y.z', org_id: 42 }] });
    }
    if (sql.includes('FROM organizations WHERE id')) {
      return Promise.resolve({ rows: [{ id: 42, name: 'Org' }] });
    }
    if (sql.includes('FROM audit_log')) {
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes('FROM leads')) {
      return Promise.resolve({ rows: [{ id: 1, email: 'lead@y.z' }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('GET /me/export (export_version 2)', () => {
  let res;
  beforeAll(async () => {
    installQueryRouter();
    // The route reads org context from the auth middleware's user lookup —
    // meRoutes' auth resolves org via the token payload/user row mocked above.
    res = await request(buildApp()).get('/me/export').set('Cookie', authCookie());
  });

  test('responds 200 with export_version 2', () => {
    expect(res.status).toBe(200);
    expect(res.body.export_version).toBe(2);
  });

  test('includes post-2025 modules present in the schema (leads)', () => {
    expect(res.body).toHaveProperty('leads');
    expect(res.body.leads).toEqual([{ id: 1, email: 'lead@y.z' }]);
  });

  test('skips registry tables absent from this deployment (sequences)', () => {
    expect(res.body).not.toHaveProperty('sequences');
    expect(captured.some(c => c.sql.includes('FROM sequences'))).toBe(false);
  });

  test('strips BYTEA and secret-named columns from documents', () => {
    const docQuery = captured.find(c => c.sql.includes('FROM documents'));
    expect(docQuery).toBeTruthy();
    expect(docQuery.sql).toContain('"filename"');
    expect(docQuery.sql).not.toContain('"content"');
    expect(docQuery.sql).not.toContain('portal_secret_token');
  });

  test('personal tables are caller-scoped only (notifications has no org OR-branch)', () => {
    const q = captured.find(c => c.sql.includes('FROM notifications'));
    expect(q).toBeTruthy();
    expect(q.sql).toContain('WHERE user_id = $1');
    expect(q.sql).not.toContain('org_id = $2'); // selecting the column is fine; scoping by it is not
    expect(q.params).toEqual([USER_ID]);
  });

  test('chat messages come via the caller-owned session subquery', () => {
    const q = captured.find(c => c.sql.includes('FROM chat_messages'));
    expect(q).toBeTruthy();
    expect(q.sql).toContain('WHERE user_id = $1');
    expect(q.params).toEqual([USER_ID]);
  });
});
