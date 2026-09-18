// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Spec 200 — POST /api/ai/actions/apply (the lone chat write-action writer).
//
// We mount aiRoutes on a tiny Express app with an auth cookie and a fully
// mocked pg pool (same pattern as aiChatAtRisk.test.js). The route is mounted
// bare here, so the only middleware in play is the per-route authMiddleware —
// requireFeature('ai_features_enabled') + CSRF are applied at the index.js
// mount point, not inside the router, and are out of scope for this unit test.
//
// Assertions:
//   • happy path: a deal update runs an org-scoped UPDATE inside a txn and
//     writes an ai.action_applied audit row
//   • a tampered / non-allowlisted field is rejected (400) with no UPDATE
//   • a cross-org target (scoped WHERE returns 0 rows) -> 404, no write
//   • feature_flag.set by a non-admin (org_role 'member') -> 403

// describe / test / expect / beforeEach / afterEach / vi are vitest globals.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

// AI metering / usage writes are fire-and-forget; stub so nothing hits the DB.
vi.mock('../services/usageMeter', () => ({
  increment:     vi.fn().mockResolvedValue(null),
  recordAiUsage: vi.fn().mockResolvedValue(null),
}));
vi.mock('../services/aiMetering', () => ({
  recordUsage: vi.fn().mockResolvedValue(null),
}));

process.env.ANTHROPIC_API_KEY = 'test-key-for-vitest';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const aiRoutes = require('../routes/aiRoutes');
const featureFlags = require('../services/featureFlags');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/ai', aiRoutes);
  return app;
}

const USER_ID = 4242;
const ORG_ID = 7;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

// A fake pg client that records its queries (for BEGIN/UPDATE/COMMIT inspection).
function makeClient(updateRow) {
  return {
    calls: [],
    query: vi.fn(function (sql) {
      this.calls.push(sql);
      if (/^UPDATE|^INSERT/i.test(String(sql).trim())) {
        return Promise.resolve({ rows: updateRow ? [updateRow] : [] });
      }
      return Promise.resolve({ rows: [] });
    }),
    release: vi.fn(),
  };
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
});

describe('POST /api/ai/actions/apply', () => {
  test('happy path: updates a deal and writes an ai.action_applied audit row', async () => {
    const client = makeClient({ id: 5, stage: 'NEGOTIATION' });
    // 1. authMiddleware
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
    // 2. ownership pre-flight: target deal exists in org
    mockPool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    // pool.connect() -> client (BEGIN/UPDATE/COMMIT happen on the client)
    mockPool.connect.mockResolvedValueOnce(client);
    // audit.fromReq -> pool.query (fire-and-forget INSERT into audit_log)
    mockPool.query.mockResolvedValue({ rows: [] });

    const res = await request(buildApp())
      .post('/api/ai/actions/apply')
      .set('Cookie', authCookie())
      .send({ proposal: { entity: 'deal', op: 'update', target_id: 5, fields: { stage: 'NEGOTIATION' } } });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.result.id).toBe(5);

    // The write ran inside a transaction on the client.
    expect(client.calls.some((s) => /BEGIN/.test(s))).toBe(true);
    expect(client.calls.some((s) => /UPDATE deals SET/.test(s))).toBe(true);
    expect(client.calls.some((s) => /COMMIT/.test(s))).toBe(true);
    expect(client.release).toHaveBeenCalled();

    // An ai.action_applied audit row was written via pool.query.
    const auditCall = mockPool.query.mock.calls.find(
      ([sql, params]) => /INSERT INTO audit_log/i.test(String(sql)) && Array.isArray(params) && params.includes('ai.action_applied')
    );
    expect(auditCall).toBeDefined();
  });

  test('rejects a tampered / non-allowlisted field with 400 and no write', async () => {
    // 1. authMiddleware
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });

    const res = await request(buildApp())
      .post('/api/ai/actions/apply')
      .set('Cookie', authCookie())
      .send({ proposal: { entity: 'deal', op: 'update', target_id: 5, fields: { user_id: 1, stage: 'NEGOTIATION' } } });

    expect(res.status).toBe(400);
    expect(mockPool.connect).not.toHaveBeenCalled();
    // No UPDATE was issued on the pool either.
    const wrote = mockPool.query.mock.calls.some(([sql]) => /UPDATE deals/i.test(String(sql)));
    expect(wrote).toBe(false);
  });

  test('cross-org target (scoped WHERE returns 0 rows) -> 404, no write', async () => {
    // 1. authMiddleware
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
    // 2. ownership pre-flight: target NOT found in org
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .post('/api/ai/actions/apply')
      .set('Cookie', authCookie())
      .send({ proposal: { entity: 'deal', op: 'update', target_id: 9999, fields: { stage: 'NEGOTIATION' } } });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found_in_org');
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  test('feature_flag.set by a non-admin (org_role member) -> 403', async () => {
    const spy = vi.spyOn(featureFlags, 'setFeature');
    // 1. authMiddleware (member)
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
    // admin_users lookup -> not a super-admin
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .post('/api/ai/actions/apply')
      .set('Cookie', authCookie())
      .send({ proposal: { entity: 'feature_flag', op: 'set', fields: { flag: 'reports_enabled', enabled: true } } });

    expect(res.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
