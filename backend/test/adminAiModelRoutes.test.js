// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Per-org AI model + effort admin routes — backend/routes/adminAiModelRoutes.js.
//
// COVERAGE (per spec):
//   GET   /api/admin/ai-model
//     • returns { model, effort, env_override, valid_models, valid_efforts,
//                 default_model, default_effort } shape
//     • 403 for non-org-admin (member role)
//   PATCH /api/admin/ai-model
//     • validates against VALID_MODELS / VALID_EFFORTS allowlists; invalid → 400
//     • successful update writes both columns + busts cache via
//       aiModel.bustCache(orgId) (spied)
//     • emits audit.EVENTS.SETTINGS_AI_MODEL_CHANGED with before/after/fields meta
//     • 403 for non-admin
//
// Note: this file is intentionally complementary to backend/test/aiModel.test.js
// (which covers the same routes from a different angle — full PATCH happy path
// + null-clears-column). Here we focus on the gate semantics and the
// bustCache spy that the spec calls out as the critical fence-post for stale
// reads after a config change.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

// Audit spies — patched in-place so an audit_log INSERT doesn't consume a
// queued mockResolvedValueOnce response.
const audit = require('../services/audit');
audit.record  = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

// Spy bustCache — kept as a vi.spyOn (not a replace) so the real cache
// behavior continues to work and we can confirm the route calls it.
const aiModel = require('../services/aiModel');
const bustCacheSpy = vi.spyOn(aiModel, 'bustCache');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const adminAiModelRoutes = require('../routes/adminAiModelRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 31313;
const ORG_ID  = 88;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/admin/ai-model', adminAiModelRoutes);
  return app;
}

// authMiddleware preflight — populates req.orgId / req.orgRole.
function queueAuthRow(role = 'admin') {
  mockPool.query.mockResolvedValueOnce({
    rows: [{ org_id: ORG_ID, org_role: role, status: 'active' }],
  });
}

beforeEach(() => {
  mockPool.query.mockReset();
  audit.fromReq.mockReset();
  audit.record.mockReset();
  bustCacheSpy.mockClear();
  aiModel._resetCachesForTests();
  delete process.env.ANTHROPIC_MODEL;
});

// ===========================================================================
// GET /api/admin/ai-model
// ===========================================================================

describe('GET /api/admin/ai-model', () => {
  test('200 — returns the expected metadata shape for an admin', async () => {
    queueAuthRow('admin');
    // getOrgAiSettings — both columns null so we fall back to defaults
    mockPool.query.mockResolvedValueOnce({ rows: [{ ai_model: null, ai_effort: null }] });

    const res = await request(buildApp())
      .get('/api/admin/ai-model')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    // Every field documented in the route doc-comment must be present.
    expect(res.body).toHaveProperty('model');
    expect(res.body).toHaveProperty('effort');
    expect(res.body).toHaveProperty('env_override');
    expect(res.body).toHaveProperty('valid_models');
    expect(res.body).toHaveProperty('valid_efforts');
    expect(res.body).toHaveProperty('default_model');
    expect(res.body).toHaveProperty('default_effort');
    // Allowlists are arrays with content.
    expect(Array.isArray(res.body.valid_models)).toBe(true);
    expect(res.body.valid_models.length).toBeGreaterThan(0);
    // Each valid_models entry exposes id + label + family (the picker UI shape).
    for (const m of res.body.valid_models) {
      expect(typeof m.id).toBe('string');
      expect(typeof m.label).toBe('string');
      expect(typeof m.family).toBe('string');
    }
    expect(res.body.valid_efforts).toEqual(['low', 'medium', 'high']);
    expect(typeof res.body.env_override).toBe('boolean');
  });

  test('403 — regular member role rejected', async () => {
    queueAuthRow('member');
    const res = await request(buildApp())
      .get('/api/admin/ai-model')
      .set('Cookie', authCookie());
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner|admin/i);
  });
});

// ===========================================================================
// PATCH /api/admin/ai-model — validation
// ===========================================================================

describe('PATCH /api/admin/ai-model — validation', () => {
  test('400 — model not in VALID_MODELS allowlist', async () => {
    queueAuthRow('admin');
    const res = await request(buildApp())
      .patch('/api/admin/ai-model')
      .set('Cookie', authCookie())
      .send({ model: 'claude-not-a-real-model' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid model/i);
    // Critical: a bad value must not write or bust cache.
    expect(bustCacheSpy).not.toHaveBeenCalled();
    expect(audit.fromReq).not.toHaveBeenCalled();
  });

  test('400 — effort not in VALID_EFFORTS allowlist', async () => {
    queueAuthRow('admin');
    const res = await request(buildApp())
      .patch('/api/admin/ai-model')
      .set('Cookie', authCookie())
      .send({ effort: 'turbo' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid effort/i);
    expect(bustCacheSpy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// PATCH /api/admin/ai-model — happy path: write + cache bust + audit
// ===========================================================================

describe('PATCH /api/admin/ai-model — happy path', () => {
  test('writes both columns, busts cache, emits SETTINGS_AI_MODEL_CHANGED', async () => {
    queueAuthRow('owner');
    // Pre-update getOrgAiSettings (the `before` snapshot) — defaults
    mockPool.query.mockResolvedValueOnce({ rows: [{ ai_model: null, ai_effort: null }] });
    // UPDATE organizations
    mockPool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    // Post-update getOrgAiSettings (the `after` snapshot) — new values
    mockPool.query.mockResolvedValueOnce({
      rows: [{ ai_model: 'claude-haiku-4-5', ai_effort: 'high' }],
    });

    const res = await request(buildApp())
      .patch('/api/admin/ai-model')
      .set('Cookie', authCookie())
      .send({ model: 'claude-haiku-4-5', effort: 'high' });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe('claude-haiku-4-5');
    expect(res.body.effort).toBe('high');

    // 1. bustCache fired with the right org id.
    expect(bustCacheSpy).toHaveBeenCalledWith(ORG_ID);

    // 2. The UPDATE bound both ai_model and ai_effort + the org id.
    const updateCall = mockPool.query.mock.calls.find(
      ([sql]) => /UPDATE organizations/i.test(sql) && /ai_model/i.test(sql) && /ai_effort/i.test(sql)
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[1]).toEqual(['claude-haiku-4-5', 'high', ORG_ID]);

    // 3. Audit fired with the documented meta shape.
    expect(audit.fromReq).toHaveBeenCalledTimes(1);
    const auditArg = audit.fromReq.mock.calls[0][1];
    expect(auditArg.event).toBe(audit.EVENTS.SETTINGS_AI_MODEL_CHANGED);
    expect(auditArg.targetType).toBe('organization');
    expect(auditArg.targetId).toBe(ORG_ID);
    expect(auditArg.meta.fields).toEqual(['model', 'effort']);
    expect(auditArg.meta.before).toEqual({
      model: aiModel.DEFAULT_MODEL,
      effort: aiModel.DEFAULT_EFFORT,
    });
    expect(auditArg.meta.after).toEqual({
      model: 'claude-haiku-4-5',
      effort: 'high',
    });
  });
});

// ===========================================================================
// PATCH /api/admin/ai-model — role gate
// ===========================================================================

describe('PATCH /api/admin/ai-model — role gate', () => {
  test('403 — non-admin member cannot PATCH', async () => {
    queueAuthRow('member');
    const res = await request(buildApp())
      .patch('/api/admin/ai-model')
      .set('Cookie', authCookie())
      .send({ model: 'claude-opus-4-7' });
    expect(res.status).toBe(403);
    // No writes happened.
    expect(bustCacheSpy).not.toHaveBeenCalled();
    expect(audit.fromReq).not.toHaveBeenCalled();
  });
});
