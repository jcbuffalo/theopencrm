// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Route-handler tests for POST /api/plugins/from-template + GET
// /api/plugins/library. Mirrors plugin-from-prompt.test.js shape: mock pg pool
// + feature flag, then drive the router with supertest.
//
// Coverage:
//   • GET /library returns the curated entries
//   • POST /from-template clones a known slug → inserts draft + writes audit
//   • Name-collision suffixes the row with " (Draft)"
//   • Unknown slug → 404 TEMPLATE_NOT_FOUND
//   • Missing template_id in body → 400
//   • Legacy POST /library/:slug/install path works identically

// vitest globals.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const featureFlags = require('../services/featureFlags');
featureFlags.hasFeature = vi.fn().mockResolvedValue(true);

const audit = require('../services/audit');
audit.record  = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

const logger = require('../services/logger');
logger.info  = vi.fn();
logger.warn  = vi.fn();
logger.error = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const pluginRoutes = require('../routes/pluginRoutes');
const pluginLibrary = require('../services/pluginLibrary');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/plugins', pluginRoutes);
  return app;
}

const USER_ID = 4242;
const ORG_ID = 99;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function queueAuthRow() {
  mockPool.query.mockResolvedValueOnce({
    rows: [{ org_id: ORG_ID, org_role: 'admin', status: 'active' }],
  });
}

beforeEach(() => {
  mockPool.query.mockReset();
  audit.fromReq.mockClear();
  featureFlags.hasFeature.mockClear();
  featureFlags.hasFeature.mockResolvedValue(true);
});

describe('GET /api/plugins/library', () => {
  test('returns the curated entry list', async () => {
    queueAuthRow();
    const res = await request(buildApp())
      .get('/api/plugins/library')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    // pluginLibrary ships at least the 5 documented entries — assert presence
    // of one well-known slug to confirm the wiring rather than the count.
    expect(res.body.data.some(it => it.slug === 'stalled-deal-digest')).toBe(true);
  });
});

describe('POST /api/plugins/from-template', () => {
  test('clones a known slug as a draft + writes audit', async () => {
    queueAuthRow();
    // 1) collision check: nothing exists
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // 2) INSERT into plugins → returning row
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 33,
        name: 'stalled-deal-digest',
        public_id: 'uuid',
        status: 'draft',
        source_kind: 'library',
        description: 'Daily 9am digest of deals with no activity in 30+ days. Emailed to the sales lead.',
        trigger_event: 'schedule.daily',
      }],
    });

    const res = await request(buildApp())
      .post('/api/plugins/from-template')
      .set('Cookie', authCookie())
      .send({ template_id: 'stalled-deal-digest' });

    expect(res.status).toBe(201);
    expect(res.body.plugin).toMatchObject({
      id: 33,
      status: 'draft',
      source_kind: 'library',
    });
    expect(res.body.template_slug).toBe('stalled-deal-digest');
    // INSERT params: name = original (no collision)
    const insertCall = mockPool.query.mock.calls[2];
    expect(insertCall[1][1]).toBe('stalled-deal-digest');
    // Audit was written with the right event + meta
    expect(audit.fromReq).toHaveBeenCalledTimes(1);
    const auditCall = audit.fromReq.mock.calls[0][1];
    expect(auditCall.event).toBe(audit.EVENTS.PLUGIN_CLONED_FROM_TEMPLATE);
    expect(auditCall.targetId).toBe(33);
    expect(auditCall.meta.template_slug).toBe('stalled-deal-digest');
  });

  test('name collision suffixes the row with " (Draft)"', async () => {
    queueAuthRow();
    // 1) collision check: name already exists
    mockPool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    // 2) collision check on " (Draft)": clear
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // 3) INSERT
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 34, name: 'stalled-deal-digest (Draft)', public_id: 'uuid',
        status: 'draft', source_kind: 'library', description: 'x', trigger_event: 'schedule.daily',
      }],
    });

    const res = await request(buildApp())
      .post('/api/plugins/from-template')
      .set('Cookie', authCookie())
      .send({ template_id: 'stalled-deal-digest' });

    expect(res.status).toBe(201);
    expect(res.body.plugin.name).toBe('stalled-deal-digest (Draft)');
    // The INSERT was called with the suffixed name.
    const insertCall = mockPool.query.mock.calls[3];
    expect(insertCall[1][1]).toBe('stalled-deal-digest (Draft)');
  });

  test('unknown slug → 404 TEMPLATE_NOT_FOUND', async () => {
    queueAuthRow();
    const res = await request(buildApp())
      .post('/api/plugins/from-template')
      .set('Cookie', authCookie())
      .send({ template_id: 'this-slug-does-not-exist' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEMPLATE_NOT_FOUND');
  });

  test('missing template_id → 400', async () => {
    queueAuthRow();
    const res = await request(buildApp())
      .post('/api/plugins/from-template')
      .set('Cookie', authCookie())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/template_id/);
  });

  test('legacy POST /library/:slug/install path works', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 35, name: 'follow-up-on-quote-sent', public_id: 'uuid',
        status: 'draft', source_kind: 'library', description: 'x', trigger_event: 'quote.sent',
      }],
    });
    const res = await request(buildApp())
      .post('/api/plugins/library/follow-up-on-quote-sent/install')
      .set('Cookie', authCookie())
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.plugin.id).toBe(35);
  });
});

describe('pluginLibrary helper exposure', () => {
  test('every curated entry has a usable spec the validator should accept', () => {
    // Defensive check — the from-template route invokes validateSpec on the
    // projected spec; if a future contributor adds an entry that doesn't
    // validate, this test fails ahead of the runtime.
    const { validateSpec } = require('../services/pluginSpecValidator');
    for (const item of pluginLibrary.list()) {
      const full = pluginLibrary.getBySlug(item.slug);
      const projected = {
        name:          full.spec.name,
        description:   full.summary,
        trigger_event: full.spec.triggerEvent,
        source_kind:   'library',
        spec_json: {
          summary:       full.spec.summary || full.summary,
          triggerEvent:  full.spec.triggerEvent,
          triggerFilter: full.spec.triggerFilter || null,
          actions:       Array.isArray(full.spec.actions) ? full.spec.actions : [],
        },
        source_code: full.spec.source_code || '// library placeholder',
      };
      const r = validateSpec(projected);
      if (!r.ok) {
        throw new Error(`Library entry ${item.slug} failed validation: ${JSON.stringify(r.errors)}`);
      }
      expect(r.ok).toBe(true);
    }
  });
});
