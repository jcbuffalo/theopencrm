// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// /api/org/ai-key — backend/routes/orgAiKeyRoutes.js (migration 153).
//
// COVERAGE
//   GET    — any member reads the public shape (no key material)
//   PUT    — 403 for a plain member, 200 + audit for an owner, 400 on a
//            malformed key, 422 when Anthropic rejects it, 400 with no org
//   DELETE — 403 member, 200 owner + audit
//
// The service is exercised for real (driveTokens encrypt/decrypt included);
// only pool.query, the Anthropic probe (global fetch) and audit are stubbed.

const crypto = require('crypto');
process.env.DRIVE_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/logger', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), notice: vi.fn(), debug: vi.fn(),
}));

const audit = require('../services/audit');
audit.record  = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

const aiModel = require('../services/aiModel');
aiModel.getOrgAiSettings = vi.fn().mockResolvedValue({ model: 'claude-sonnet-4-6', effort: 'low' });

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');
const driveTokens = require('../services/driveTokens');
const orgAiKeys = require('../services/orgAiKeys');
const orgAiKeyRoutes = require('../routes/orgAiKeyRoutes');

const USER_ID = 5150;
const ORG_ID  = 77;
const GOOD_KEY = 'sk-ant-api03-' + 'B'.repeat(40) + 'k9z2';

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/org/ai-key', orgAiKeyRoutes);
  return app;
}

// SQL-shape router: auth row, then whatever the service asks for.
function wirePool({ orgRole = 'owner', orgId = ORG_ID, stored = null } = {}) {
  const enc = stored ? driveTokens.encrypt(stored) : null;
  mockPool.query.mockImplementation(async (sql, params) => {
    const q = String(sql);
    if (/FROM users WHERE id/i.test(q)) {
      return { rows: [{ org_id: orgId, org_role: orgRole, status: 'active' }] };
    }
    if (/SELECT key_last4/i.test(q)) {
      return stored
        ? { rows: [{ key_last4: stored.slice(-4), last_validated_at: new Date('2026-08-01T00:00:00Z'), last_error: null, updated_at: new Date() }] }
        : { rows: [] };
    }
    if (/SELECT key_ciphertext/i.test(q)) {
      return enc ? { rows: [{ key_ciphertext: enc.ciphertext, key_iv: enc.iv, key_tag: enc.tag }] } : { rows: [] };
    }
    if (/INSERT INTO org_ai_keys/i.test(q)) {
      return { rows: [{ key_last4: params[5], last_validated_at: params[7], last_error: params[8], updated_at: new Date() }] };
    }
    if (/DELETE FROM org_ai_keys/i.test(q)) return { rowCount: stored ? 1 : 0, rows: [] };
    return { rows: [] };
  });
}

beforeEach(() => {
  mockPool.query.mockReset();
  audit.fromReq.mockReset();
  driveTokens._resetForTests();
  orgAiKeys._resetForTests();
  process.env.ORG_AI_KEYS_IN_TESTS = 'true';
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});

afterEach(() => {
  delete process.env.ORG_AI_KEYS_IN_TESTS;
});

describe('GET /api/org/ai-key', () => {
  test('member of an org with a stored key sees last4 + billing_mode, never the key', async () => {
    wirePool({ orgRole: 'member', stored: GOOD_KEY });
    const res = await request(buildApp()).get('/api/org/ai-key').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ configured: true, last4: 'k9z2', billing_mode: 'byo_key', can_manage: false });
    expect(JSON.stringify(res.body)).not.toContain(GOOD_KEY);
  });

  test('no key stored → configured false, platform billing', async () => {
    wirePool({ orgRole: 'owner' });
    const res = await request(buildApp()).get('/api/org/ai-key').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ configured: false, last4: null, billing_mode: 'platform', can_manage: true });
  });

  test('personal workspace (no org) → 400 ORG_REQUIRED', async () => {
    wirePool({ orgId: null });
    const res = await request(buildApp()).get('/api/org/ai-key').set('Cookie', authCookie());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ORG_REQUIRED');
  });
});

describe('PUT /api/org/ai-key', () => {
  test('plain member → 403 ADMIN_REQUIRED, no probe, no write', async () => {
    wirePool({ orgRole: 'member' });
    const res = await request(buildApp()).put('/api/org/ai-key').set('Cookie', authCookie()).send({ key: GOOD_KEY });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockPool.query.mock.calls.some(([sql]) => /INSERT INTO org_ai_keys/i.test(sql))).toBe(false);
  });

  test('owner → 200 with last4 + validated, audit ORG_AI_KEY_SET without the key', async () => {
    wirePool({ orgRole: 'owner' });
    const res = await request(buildApp()).put('/api/org/ai-key').set('Cookie', authCookie()).send({ key: GOOD_KEY });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ configured: true, last4: 'k9z2', billing_mode: 'byo_key', can_manage: true });
    expect(res.body.last_validated_at).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain(GOOD_KEY);

    expect(audit.fromReq).toHaveBeenCalledTimes(1);
    const [, fields] = audit.fromReq.mock.calls[0];
    expect(fields.event).toBe(audit.EVENTS.ORG_AI_KEY_SET);
    expect(fields.meta).toMatchObject({ provider: 'anthropic', key_last4: 'k9z2', validated: true });
    expect(JSON.stringify(fields)).not.toContain(GOOD_KEY);
  });

  test('admin role is also allowed', async () => {
    wirePool({ orgRole: 'admin' });
    const res = await request(buildApp()).put('/api/org/ai-key').set('Cookie', authCookie()).send({ key: GOOD_KEY });
    expect(res.status).toBe(200);
  });

  test('malformed key → 400 INVALID_KEY_FORMAT', async () => {
    wirePool({ orgRole: 'owner' });
    const res = await request(buildApp()).put('/api/org/ai-key').set('Cookie', authCookie()).send({ key: 'hunter2' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_KEY_FORMAT');
    expect(audit.fromReq).not.toHaveBeenCalled();
  });

  test('Anthropic rejects the key → 422 KEY_REJECTED, nothing stored', async () => {
    wirePool({ orgRole: 'owner' });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid x-api-key' } }) });
    const res = await request(buildApp()).put('/api/org/ai-key').set('Cookie', authCookie()).send({ key: GOOD_KEY });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('KEY_REJECTED');
    expect(mockPool.query.mock.calls.some(([sql]) => /INSERT INTO org_ai_keys/i.test(sql))).toBe(false);
  });
});

describe('DELETE /api/org/ai-key', () => {
  test('plain member → 403', async () => {
    wirePool({ orgRole: 'member', stored: GOOD_KEY });
    const res = await request(buildApp()).delete('/api/org/ai-key').set('Cookie', authCookie());
    expect(res.status).toBe(403);
    expect(mockPool.query.mock.calls.some(([sql]) => /DELETE FROM org_ai_keys/i.test(sql))).toBe(false);
  });

  test('owner → 200, removed true, audit ORG_AI_KEY_CLEARED', async () => {
    wirePool({ orgRole: 'owner', stored: GOOD_KEY });
    const res = await request(buildApp()).delete('/api/org/ai-key').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);
    expect(audit.fromReq).toHaveBeenCalledTimes(1);
    expect(audit.fromReq.mock.calls[0][1].event).toBe(audit.EVENTS.ORG_AI_KEY_CLEARED);
  });
});
