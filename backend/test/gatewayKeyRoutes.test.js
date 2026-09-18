// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// AI Gateway key management — /api/billing/ai/gateway-keys (spec 202).
//
// COVERAGE:
//   POST   — 403 for non-admin members; 402 AI_BILLING_REQUIRED_FOR_GATEWAY
//            when the org isn't active/comped; 400 missing label; happy path
//            (active AND comped) returns the ocrm_gw_ plaintext ONCE + audit
//   GET    — lists org keys (no secrets)
//   DELETE — revokes + busts the proxy key cache + audits; 404 cross-org/miss
//
// Mirrors billingAiRoutes.test.js mocking (pool patched at the live
// instance, queued per-call responses; isSuperAdmin satisfied via queued
// admin_users rows).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/logger', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), notice: vi.fn(), debug: vi.fn(),
}));

const audit = require('../services/audit');
audit.record = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

const adminNotify = require('../services/adminNotify');
adminNotify.send = vi.fn().mockResolvedValue({ ok: true });

const aiMetering = require('../services/aiMetering');
aiMetering.summarizeUsage = vi.fn();

const gatewayKeys = require('../services/gatewayKeys');
const bustCacheSpy = vi.spyOn(gatewayKeys, 'bustCache');

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const billingRoutes = require('../routes/billingRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 6001;
const ORG_ID = 300;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/billing', billingRoutes);
  return app;
}

function queueAuthRow(role = 'admin') {
  mockPool.query.mockResolvedValueOnce({
    rows: [{ org_id: ORG_ID, org_role: role, status: 'active' }],
  });
}

function queueIsSuperAdmin(isSuper) {
  mockPool.query.mockResolvedValueOnce({
    rows: isSuper ? [{ id: 1, user_id: USER_ID, role: 'super_admin', permissions: [] }] : [],
  });
}

let app;
beforeEach(() => {
  app = buildApp();
  mockPool.query.mockReset();
  audit.fromReq.mockReset();
  bustCacheSpy.mockClear();
});

describe('POST /api/billing/ai/gateway-keys', () => {
  it('403s for a non-admin member', async () => {
    queueAuthRow('member');
    queueIsSuperAdmin(false);
    const r = await request(app)
      .post('/api/billing/ai/gateway-keys')
      .set('Cookie', authCookie())
      .send({ label: 'my self-host' });
    expect(r.status).toBe(403);
  });

  it('402s when AI billing is not active/comped', async () => {
    queueAuthRow('admin');
    mockPool.query.mockResolvedValueOnce({ rows: [{ ai_billing_status: 'unconfigured' }] });
    const r = await request(app)
      .post('/api/billing/ai/gateway-keys')
      .set('Cookie', authCookie())
      .send({ label: 'my self-host' });
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('AI_BILLING_REQUIRED_FOR_GATEWAY');
  });

  it('400s without a label', async () => {
    queueAuthRow('admin');
    const r = await request(app)
      .post('/api/billing/ai/gateway-keys')
      .set('Cookie', authCookie())
      .send({});
    expect(r.status).toBe(400);
  });

  it('mints for an ACTIVE org: plaintext shown once, hash stored, audit written', async () => {
    queueAuthRow('owner');
    mockPool.query.mockResolvedValueOnce({ rows: [{ ai_billing_status: 'active' }] });
    // INSERT ... RETURNING
    mockPool.query.mockImplementationOnce(async (sql, params) => {
      expect(sql).toMatch(/INSERT INTO ai_gateway_keys/);
      const [orgId, label, keyPrefix, keyHash] = params;
      expect(orgId).toBe(ORG_ID);
      expect(label).toBe('office box');
      expect(keyPrefix).toMatch(/^ocrm_gw_.{8}$/);
      expect(keyHash).toMatch(/^[0-9a-f]{64}$/); // hash, never the plaintext
      return { rows: [{ id: 1, label, key_prefix: keyPrefix, status: 'active', created_at: new Date().toISOString(), requests_count: 0, last_used_at: null, created_by: USER_ID }] };
    });
    const r = await request(app)
      .post('/api/billing/ai/gateway-keys')
      .set('Cookie', authCookie())
      .send({ label: 'office box' });
    expect(r.status).toBe(201);
    expect(r.body.key).toMatch(/^ocrm_gw_[A-Za-z0-9_-]{43}$/);
    expect(r.body.warning).toMatch(/not be shown again/i);
    expect(r.body.record.key_hash).toBeUndefined();
    expect(audit.fromReq).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'ai_gateway.key_created',
    }));
  });

  it('mints for a COMPED org too', async () => {
    queueAuthRow('admin');
    mockPool.query.mockResolvedValueOnce({ rows: [{ ai_billing_status: 'comped' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 2, label: 'lab', key_prefix: 'ocrm_gw_xxxxxxxx', status: 'active' }] });
    const r = await request(app)
      .post('/api/billing/ai/gateway-keys')
      .set('Cookie', authCookie())
      .send({ label: 'lab' });
    expect(r.status).toBe(201);
    expect(r.body.key).toMatch(/^ocrm_gw_/);
  });
});

describe('GET /api/billing/ai/gateway-keys', () => {
  it('lists the org keys without secrets', async () => {
    queueAuthRow('admin');
    mockPool.query.mockImplementationOnce(async (sql, params) => {
      expect(sql).toMatch(/FROM ai_gateway_keys/);
      expect(params).toEqual([ORG_ID]);
      return { rows: [{ id: 1, label: 'office box', key_prefix: 'ocrm_gw_AAAAAAAA', status: 'active', requests_count: 5, last_used_at: null, revoked_at: null, created_at: new Date().toISOString() }] };
    });
    const r = await request(app)
      .get('/api/billing/ai/gateway-keys')
      .set('Cookie', authCookie());
    expect(r.status).toBe(200);
    expect(r.body.keys).toHaveLength(1);
    expect(r.body.keys[0].key_hash).toBeUndefined();
  });

  it('403s for members', async () => {
    queueAuthRow('member');
    queueIsSuperAdmin(false);
    const r = await request(app)
      .get('/api/billing/ai/gateway-keys')
      .set('Cookie', authCookie());
    expect(r.status).toBe(403);
  });
});

describe('DELETE /api/billing/ai/gateway-keys/:id', () => {
  it('revokes, busts the proxy key cache, and audits', async () => {
    queueAuthRow('admin');
    mockPool.query.mockImplementationOnce(async (sql, params) => {
      expect(sql).toMatch(/UPDATE ai_gateway_keys/);
      expect(sql).toMatch(/status = 'revoked'/);
      expect(params).toEqual(['1', ORG_ID]); // org-scoped
      return { rows: [{ id: 1, label: 'office box', key_prefix: 'ocrm_gw_AAAAAAAA', key_hash: 'f'.repeat(64) }] };
    });
    const r = await request(app)
      .delete('/api/billing/ai/gateway-keys/1')
      .set('Cookie', authCookie());
    expect(r.status).toBe(200);
    expect(r.body.revoked.id).toBe(1);
    expect(bustCacheSpy).toHaveBeenCalledWith('f'.repeat(64));
    expect(audit.fromReq).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'ai_gateway.key_revoked',
    }));
  });

  it('404s when the key belongs to another org (or does not exist)', async () => {
    queueAuthRow('admin');
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const r = await request(app)
      .delete('/api/billing/ai/gateway-keys/999')
      .set('Cookie', authCookie());
    expect(r.status).toBe(404);
  });
});
