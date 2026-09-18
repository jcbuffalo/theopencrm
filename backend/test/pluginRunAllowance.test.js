// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Sell-readiness fix 10: the chat copilot's run_plugin tool must draw from
// the SAME 60/min/user budget as POST /api/plugins/:id/run instead of
// bypassing pluginRunLimiter. consumePluginRunAllowance() is the programmatic
// consumer; these tests drive it through a real Express app (so the
// express-rate-limit internals see a genuine req/res) and then assert the
// chat tool path is denied once the shared budget is exhausted.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/logger', () => ({
  info:   vi.fn(),
  warn:   vi.fn(),
  error:  vi.fn(),
  notice: vi.fn(),
  debug:  vi.fn(),
}));

const audit = require('../services/audit');
audit.record  = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

const express = require('express');
const request = require('supertest');
const { consumePluginRunAllowance } = require('../middleware/rateLimits');
const aiRoutes = require('../routes/aiRoutes');

const ORG_ID = 55;
// Distinct user ids per test so the shared per-worker limiter store never
// bleeds between cases.
let nextUserId = 910000;

function buildApp(userId) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.userId = userId; req.orgId = ORG_ID; next(); });
  app.post('/probe', async (req, res) => {
    const r = await consumePluginRunAllowance(req);
    res.json(r);
  });
  app.post('/tool', async (req, res) => {
    const runTool = aiRoutes._buildChatToolRunner(req);
    const result = await runTool('run_plugin', { plugin_id: 7 });
    res.json(result);
  });
  return app;
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

test('allows up to 60 runs/min per user, then denies', async () => {
  const app = buildApp(nextUserId++);
  for (let i = 0; i < 60; i++) {
    const res = await request(app).post('/probe').send({});
    expect(res.body.allowed).toBe(true);
  }
  const denied = await request(app).post('/probe').send({});
  expect(denied.body.allowed).toBe(false);
});

test('chat run_plugin tool is denied once the shared budget is exhausted', async () => {
  const userId = nextUserId++;
  const app = buildApp(userId);
  for (let i = 0; i < 60; i++) {
    await request(app).post('/probe').send({});
  }
  const res = await request(app).post('/tool').send({});
  expect(res.body.code).toBe('PLUGIN_RUN_RATE_LIMIT');
  // The rate limit fires BEFORE any plugin lookup touches the database.
  const pluginLookup = mockPool.query.mock.calls.find(
    ([sql]) => typeof sql === 'string' && /FROM plugins/.test(sql)
  );
  expect(pluginLookup).toBeUndefined();
});

test('different users have independent budgets', async () => {
  const appA = buildApp(nextUserId++);
  const appB = buildApp(nextUserId++);
  for (let i = 0; i < 60; i++) {
    await request(appA).post('/probe').send({});
  }
  const deniedA = await request(appA).post('/probe').send({});
  expect(deniedA.body.allowed).toBe(false);
  const allowedB = await request(appB).post('/probe').send({});
  expect(allowedB.body.allowed).toBe(true);
});
