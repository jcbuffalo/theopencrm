// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Per-org AI model + effort — service + admin route tests.
//
// COVERAGE
//   Service (services/aiModel.js):
//     1. getOrgAiSettings returns defaults when columns null
//     2. Per-org column wins over env
//     3. Env wins over hardcoded default when column null
//     4. Invalid stored value falls back to default (no throw)
//     5. Cache reuses result within the TTL window
//     6. bustCache clears the entry
//     7. effortToThinkingBudget mapping
//
//   Routes (routes/adminAiModelRoutes.js):
//     8. GET /api/admin/ai-model — 403 for non-admin org role
//     9. GET /api/admin/ai-model — 200 with the expected shape for owner/admin
//    10. PATCH /api/admin/ai-model — rejects invalid model
//    11. PATCH /api/admin/ai-model — accepts a valid update, busts cache, audits
//
// DB pool mocking pattern mirrors backend/test/me.test.js — we mutate the live
// pool instance instead of using vi.mock(), because module.exports = pool is
// hostile to vitest's CJS-mock interop.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

// Spy on audit.fromReq so we can assert the SETTINGS_AI_MODEL_CHANGED event
// without having an audit_log INSERT consume one of our queued mock responses.
const audit = require('../services/audit');
audit.record  = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const aiModel = require('../services/aiModel');
const adminAiModelRoutes = require('../routes/adminAiModelRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID  = 4242;
const ORG_ID   = 99;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/admin/ai-model', adminAiModelRoutes);
  return app;
}

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

beforeEach(() => {
  mockPool.query.mockReset();
  aiModel._resetCachesForTests();
  audit.fromReq.mockReset();
  audit.record.mockReset();
  // Make sure we start with a clean env override expectation.
  delete process.env.ANTHROPIC_MODEL;
});

// ===========================================================================
// services/aiModel.js
// ===========================================================================

describe('aiModel.getOrgAiSettings', () => {
  test('returns defaults when both columns are null', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ ai_model: null, ai_effort: null }] });
    const out = await aiModel.getOrgAiSettings(ORG_ID);
    expect(out).toEqual({
      model: aiModel.DEFAULT_MODEL,
      effort: aiModel.DEFAULT_EFFORT,
    });
  });

  test('per-org column wins over ANTHROPIC_MODEL env var', async () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-7';
    mockPool.query.mockResolvedValueOnce({
      rows: [{ ai_model: 'claude-haiku-4-5', ai_effort: 'high' }],
    });
    const out = await aiModel.getOrgAiSettings(ORG_ID);
    expect(out.model).toBe('claude-haiku-4-5');
    expect(out.effort).toBe('high');
  });

  test('env var wins over hardcoded default when column is null', async () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-7';
    mockPool.query.mockResolvedValueOnce({ rows: [{ ai_model: null, ai_effort: null }] });
    const out = await aiModel.getOrgAiSettings(ORG_ID);
    expect(out.model).toBe('claude-opus-4-7');
    // Effort has no env tier — column null → default.
    expect(out.effort).toBe(aiModel.DEFAULT_EFFORT);
  });

  test('invalid stored model falls back to default (no throw)', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ ai_model: 'claude-fictional-99', ai_effort: 'overdrive' }],
    });
    const out = await aiModel.getOrgAiSettings(ORG_ID);
    expect(out.model).toBe(aiModel.DEFAULT_MODEL);
    expect(out.effort).toBe(aiModel.DEFAULT_EFFORT);
  });

  test('cache reuses result within the TTL window (1 DB call on 2 lookups)', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ ai_model: 'claude-haiku-4-5', ai_effort: 'low' }],
    });
    const first  = await aiModel.getOrgAiSettings(ORG_ID);
    const second = await aiModel.getOrgAiSettings(ORG_ID);
    expect(first).toEqual(second);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  test('bustCache clears the entry so the next lookup re-reads', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ ai_model: 'claude-haiku-4-5', ai_effort: 'low' }],
    });
    await aiModel.getOrgAiSettings(ORG_ID);
    aiModel.bustCache(ORG_ID);
    mockPool.query.mockResolvedValueOnce({
      rows: [{ ai_model: 'claude-opus-4-7', ai_effort: 'high' }],
    });
    const after = await aiModel.getOrgAiSettings(ORG_ID);
    expect(after.model).toBe('claude-opus-4-7');
    expect(after.effort).toBe('high');
    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });

  test('returns defaults when orgId is null (no DB hit)', async () => {
    const out = await aiModel.getOrgAiSettings(null);
    expect(out).toEqual({
      model: aiModel.DEFAULT_MODEL,
      effort: aiModel.DEFAULT_EFFORT,
    });
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('DB error falls back to defaults without throwing', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('connection refused'));
    const out = await aiModel.getOrgAiSettings(ORG_ID);
    expect(out).toEqual({
      model: aiModel.DEFAULT_MODEL,
      effort: aiModel.DEFAULT_EFFORT,
    });
  });
});

describe('aiModel.effortToThinkingBudget', () => {
  test('low → null (no extended thinking)', () => {
    expect(aiModel.effortToThinkingBudget('low')).toBeNull();
  });
  test('medium → 2048', () => {
    expect(aiModel.effortToThinkingBudget('medium')).toBe(2048);
  });
  test('high → 8192', () => {
    expect(aiModel.effortToThinkingBudget('high')).toBe(8192);
  });
  test('unrecognized → null', () => {
    expect(aiModel.effortToThinkingBudget('overdrive')).toBeNull();
    expect(aiModel.effortToThinkingBudget(undefined)).toBeNull();
  });
});

// ===========================================================================
// routes/adminAiModelRoutes.js
// ===========================================================================

describe('GET /api/admin/ai-model', () => {
  test('403 for org members (not owner / admin)', async () => {
    // authMiddleware org/role lookup
    mockPool.query.mockResolvedValueOnce({
      rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }],
    });
    const res = await request(buildApp())
      .get('/admin/ai-model')
      .set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  test('400 when caller has no org context', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ org_id: null, org_role: null, status: 'active' }],
    });
    const res = await request(buildApp())
      .get('/admin/ai-model')
      .set('Cookie', authCookie());
    expect(res.status).toBe(400);
  });

  test('200 with full shape for an owner', async () => {
    // authMiddleware
    mockPool.query.mockResolvedValueOnce({
      rows: [{ org_id: ORG_ID, org_role: 'owner', status: 'active' }],
    });
    // getOrgAiSettings — both columns null → defaults
    mockPool.query.mockResolvedValueOnce({ rows: [{ ai_model: null, ai_effort: null }] });

    const res = await request(buildApp())
      .get('/admin/ai-model')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.model).toBe(aiModel.DEFAULT_MODEL);
    expect(res.body.effort).toBe(aiModel.DEFAULT_EFFORT);
    expect(res.body.default_model).toBe(aiModel.DEFAULT_MODEL);
    expect(res.body.default_effort).toBe(aiModel.DEFAULT_EFFORT);
    expect(Array.isArray(res.body.valid_models)).toBe(true);
    expect(res.body.valid_models.length).toBeGreaterThan(0);
    expect(res.body.valid_efforts).toEqual(['low', 'medium', 'high']);
    expect(typeof res.body.env_override).toBe('boolean');
  });

  test('env_override reflects ANTHROPIC_MODEL presence', async () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-7';
    mockPool.query.mockResolvedValueOnce({
      rows: [{ org_id: ORG_ID, org_role: 'admin', status: 'active' }],
    });
    mockPool.query.mockResolvedValueOnce({ rows: [{ ai_model: null, ai_effort: null }] });
    const res = await request(buildApp())
      .get('/admin/ai-model')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.env_override).toBe(true);
  });
});

describe('PATCH /api/admin/ai-model', () => {
  test('400 when body is empty', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ org_id: ORG_ID, org_role: 'admin', status: 'active' }],
    });
    const res = await request(buildApp())
      .patch('/admin/ai-model')
      .set('Cookie', authCookie())
      .send({});
    expect(res.status).toBe(400);
  });

  test('400 when model is not in the allowlist', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ org_id: ORG_ID, org_role: 'admin', status: 'active' }],
    });
    const res = await request(buildApp())
      .patch('/admin/ai-model')
      .set('Cookie', authCookie())
      .send({ model: 'claude-fictional-99' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid model/i);
  });

  test('400 when effort is not in the allowlist', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ org_id: ORG_ID, org_role: 'admin', status: 'active' }],
    });
    const res = await request(buildApp())
      .patch('/admin/ai-model')
      .set('Cookie', authCookie())
      .send({ effort: 'overdrive' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid effort/i);
  });

  test('200 — writes row, busts cache, fires audit event', async () => {
    // authMiddleware
    mockPool.query.mockResolvedValueOnce({
      rows: [{ org_id: ORG_ID, org_role: 'owner', status: 'active' }],
    });
    // Pre-update getOrgAiSettings snapshot — defaults
    mockPool.query.mockResolvedValueOnce({ rows: [{ ai_model: null, ai_effort: null }] });
    // UPDATE organizations
    mockPool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    // Post-update getOrgAiSettings — new row
    mockPool.query.mockResolvedValueOnce({
      rows: [{ ai_model: 'claude-opus-4-7', ai_effort: 'high' }],
    });

    const res = await request(buildApp())
      .patch('/admin/ai-model')
      .set('Cookie', authCookie())
      .send({ model: 'claude-opus-4-7', effort: 'high' });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe('claude-opus-4-7');
    expect(res.body.effort).toBe('high');

    // Audit event fired with the right shape.
    expect(audit.fromReq).toHaveBeenCalled();
    const auditCall = audit.fromReq.mock.calls[0][1];
    expect(auditCall.event).toBe(audit.EVENTS.SETTINGS_AI_MODEL_CHANGED);
    expect(auditCall.targetType).toBe('organization');
    expect(auditCall.targetId).toBe(ORG_ID);
    expect(auditCall.meta.fields).toEqual(['model', 'effort']);
    expect(auditCall.meta.before).toEqual({
      model: aiModel.DEFAULT_MODEL,
      effort: aiModel.DEFAULT_EFFORT,
    });
    expect(auditCall.meta.after).toEqual({
      model: 'claude-opus-4-7',
      effort: 'high',
    });
  });

  test('PATCH with model=null clears the column (reset to default)', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ org_id: ORG_ID, org_role: 'owner', status: 'active' }],
    });
    // Pre-update snapshot — currently opus
    mockPool.query.mockResolvedValueOnce({
      rows: [{ ai_model: 'claude-opus-4-7', ai_effort: null }],
    });
    // UPDATE — verify it actually sends NULL for ai_model
    mockPool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    // Post-update — column now null → falls back to default
    mockPool.query.mockResolvedValueOnce({ rows: [{ ai_model: null, ai_effort: null }] });

    const res = await request(buildApp())
      .patch('/admin/ai-model')
      .set('Cookie', authCookie())
      .send({ model: null });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe(aiModel.DEFAULT_MODEL);

    // Spot-check: the UPDATE call passed `null` as the bind value.
    const updateCall = mockPool.query.mock.calls[2];
    expect(updateCall[0]).toMatch(/UPDATE organizations/);
    expect(updateCall[1][0]).toBeNull();
  });
});
