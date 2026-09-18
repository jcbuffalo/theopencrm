// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Tests for the communications surface — routes/smsRoutes.js + routes/callRoutes.js.
//
// Strategy mirrors test/orgActivityRoutes.test.js: mount the router on a bare
// Express app, mock the pg pool by overwriting query() on the live instance,
// and queue per-call mockResolvedValueOnce() responses in the order the handler
// issues them (authMiddleware SELECT first, then the route's own queries). The
// Twilio adapter (services/sms.js) is module-mocked so no real SMS is sent.
//
// Coverage:
//   • SMS send happy path — sends via the adapter, persists sms_messages, AND
//     logs an activities(type='sms') timeline row.
//   • SMS graceful not-configured — 503 { configured:false }, nothing persisted.
//   • SMS org-scoping — a deal outside the caller's org yields 400, no send.
//   • Call log — writes a scoped activities(type='call') row.
//   • Call log org-scoping — a deal outside the caller's org yields 400.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const sms = require('../services/sms');
const smsRoutes = require('../routes/smsRoutes');
const callRoutes = require('../routes/callRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 4242;
const ORG_ID = 77;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/sms', smsRoutes);
  app.use('/api/calls', callRoutes);
  return app;
}

// authMiddleware issues SELECT org_id, org_role, status FROM users WHERE id=$1.
function queueAuthRow(role = 'member') {
  mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: role, status: 'active' }] });
}

beforeEach(() => {
  mockPool.query.mockReset();
  // Default: any query not explicitly queued (e.g. the fire-and-forget audit
  // INSERT that runs after the handler's own queries) resolves empty.
  mockPool.query.mockResolvedValue({ rows: [] });
  // Spy on the real Twilio adapter object so the route (which requires the same
  // module instance) calls these stubs — the real twilio SDK never loads.
  vi.spyOn(sms, 'isConfigured').mockReturnValue(true);
  vi.spyOn(sms, 'sendSms').mockResolvedValue('sent');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// SMS send
// ---------------------------------------------------------------------------
describe('POST /api/sms — send', () => {
  test('happy path: sends, persists sms_messages, and logs an activity', async () => {
    queueAuthRow();
    // deal ownership lookup → in-scope, carries a POC phone we resolve to.
    mockPool.query.mockResolvedValueOnce({ rows: [{ poc_phone: '+15555550123' }] });
    // INSERT sms_messages
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1, status: 'sent', to_number: '+15555550123' }] });
    // INSERT activities
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 99, type: 'sms', direction: 'outbound' }] });

    const res = await request(buildApp())
      .post('/api/sms')
      .set('Cookie', authCookie())
      .send({ deal_id: 55, body: 'Hi there' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('sent');
    expect(res.body.configured).toBe(true);

    // The adapter was called with the resolved POC number + body.
    expect(sms.sendSms).toHaveBeenCalledWith('+15555550123', 'Hi there');

    const calls = mockPool.query.mock.calls;
    // Persisted the message log row.
    const smsInsert = calls.find(([sql]) => /INSERT INTO sms_messages/i.test(sql));
    expect(smsInsert).toBeDefined();
    // AND logged a timeline activity of type 'sms'.
    const actInsert = calls.find(([sql]) => /INSERT INTO activities/i.test(sql) && /'sms'/.test(sql));
    expect(actInsert).toBeDefined();
  });

  test('graceful not-configured: 503 configured:false, nothing persisted', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [{ poc_phone: '+15555550123' }] });
    sms.isConfigured.mockReturnValue(false);

    const res = await request(buildApp())
      .post('/api/sms')
      .set('Cookie', authCookie())
      .send({ deal_id: 55, body: 'Hi there' });

    expect(res.status).toBe(503);
    expect(res.body.configured).toBe(false);
    expect(sms.sendSms).not.toHaveBeenCalled();

    // No sms_messages row was written.
    const wrote = mockPool.query.mock.calls.some(([sql]) => /INSERT INTO sms_messages/i.test(sql));
    expect(wrote).toBe(false);
  });

  test('org-scoping: a deal outside the org yields 400 and no send', async () => {
    queueAuthRow();
    // Ownership lookup returns no rows → not in caller's org.
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .post('/api/sms')
      .set('Cookie', authCookie())
      .send({ deal_id: 999, body: 'leak attempt' });

    expect(res.status).toBe(400);
    expect(sms.sendSms).not.toHaveBeenCalled();
    const wrote = mockPool.query.mock.calls.some(([sql]) => /INSERT INTO sms_messages/i.test(sql));
    expect(wrote).toBe(false);
  });

  test('the ownership lookup is org-scoped (binds org_id)', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [{ poc_phone: '+15555550123' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1, status: 'sent' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 99 }] });

    await request(buildApp())
      .post('/api/sms')
      .set('Cookie', authCookie())
      .send({ deal_id: 55, body: 'Hi' });

    const ownershipCall = mockPool.query.mock.calls.find(
      ([sql]) => /FROM deals WHERE id = \$1 AND org_id = \$2/i.test(sql)
    );
    expect(ownershipCall).toBeDefined();
    expect(ownershipCall[1]).toEqual([55, ORG_ID]);
  });
});

// ---------------------------------------------------------------------------
// Call logging
// ---------------------------------------------------------------------------
describe('POST /api/calls/log', () => {
  test('writes a scoped activities(type=call) row', async () => {
    queueAuthRow();
    // deal ownership → in scope.
    mockPool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    // INSERT activities
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 7, type: 'call', direction: 'outbound' }] });

    const res = await request(buildApp())
      .post('/api/calls/log')
      .set('Cookie', authCookie())
      .send({ deal_id: 55, direction: 'outbound', duration_minutes: 12, outcome: 'connected', notes: 'Talked pricing' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.activity.type).toBe('call');

    const insert = mockPool.query.mock.calls.find(
      ([sql]) => /INSERT INTO activities/i.test(sql) && /'call'/.test(sql)
    );
    expect(insert).toBeDefined();
    // direction bound as the last param, org_id present.
    expect(insert[1]).toContain('outbound');
    expect(insert[1]).toContain(ORG_ID);
  });

  test('org-scoping: a deal outside the org yields 400, no activity written', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // ownership miss

    const res = await request(buildApp())
      .post('/api/calls/log')
      .set('Cookie', authCookie())
      .send({ deal_id: 999, direction: 'inbound' });

    expect(res.status).toBe(400);
    const wrote = mockPool.query.mock.calls.some(
      ([sql]) => /INSERT INTO activities/i.test(sql)
    );
    expect(wrote).toBe(false);
  });

  test('requires a contact_id or deal_id (schema refine)', async () => {
    queueAuthRow();
    const res = await request(buildApp())
      .post('/api/calls/log')
      .set('Cookie', authCookie())
      .send({ direction: 'outbound', notes: 'orphan call' });
    expect(res.status).toBe(400);
  });
});
