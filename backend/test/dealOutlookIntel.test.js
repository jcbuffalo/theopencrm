// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Per-deal Outlook intel (migration 140 read surface) — route tests.
//
// Follows the portal.test.js pattern: the router is mounted on a tiny
// Express app with the pg pool fully mocked; featureFlags.hasFeature is
// stubbed. Query order through the route: 1 auth session resolve →
// 2 scoped deal fetch → 3 connection check → 4 messages (mail flag on) →
// 5 events (calendar flag on).

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const featureFlags = require('../services/featureFlags');
const dealOutlookIntelRoutes = require('../routes/dealOutlookIntelRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 4242;
const ORG_ID = 7;
const DEAL_ID = 55;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function authRow(orgId = ORG_ID) {
  return { rows: [{ org_id: orgId, org_role: 'member', status: 'active' }] };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  // mergeParams route — mounted exactly like index.js (the router self-gates
  // via requireAnyFeature after its own authMiddleware).
  app.use('/api/deals/:id/outlook-intel', dealOutlookIntelRoutes);
  return app;
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  vi.restoreAllMocks();
  vi.spyOn(featureFlags, 'hasFeature').mockResolvedValue(true);
});

describe('GET /api/deals/:id/outlook-intel', () => {
  test('both flags on: org+deal-scoped lanes, connected=true', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow())                                  // 1 auth
      .mockResolvedValueOnce({ rows: [{ id: DEAL_ID }] })                // 2 deal scoped fetch
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })              // 3 connection
      .mockResolvedValueOnce({ rows: [{ id: 1, subject: 'RE: pricing', body_preview: 'Sounds good', from_addr: 'buyer@acme.test', to_addrs: ['rep@zang.test'], received_at: 'now', web_link: 'https://outlook.test/1' }] }) // 4 messages
      .mockResolvedValueOnce({ rows: [{ id: 2, title: 'Kickoff', start_at: 'now', end_at: 'later', attendees: [], meeting_link: null, web_link: null, organizer_email: 'rep@zang.test', status: 'confirmed', source: 'synced' }] }); // 5 events
    const res = await request(buildApp())
      .get(`/api/deals/${DEAL_ID}/outlook-intel`).set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.events).toHaveLength(1);

    // Deal fetch is tenant-scoped.
    const [dealSql, dealParams] = mockPool.query.mock.calls[1];
    expect(dealSql).toContain('org_id = $2');
    expect(dealParams).toEqual([DEAL_ID, ORG_ID]);

    // Both lanes bind org AND deal.
    for (const i of [3, 4]) {
      const [sql, params] = mockPool.query.mock.calls[i];
      expect(sql).toContain('org_id = $1');
      expect(sql).toContain('deal_id = $2');
      expect(params).toEqual([ORG_ID, DEAL_ID]);
    }
    // The message projection is a whitelist — no Graph ids, no raw tokens.
    const [msgSql] = mockPool.query.mock.calls[3];
    expect(msgSql).not.toContain('msgraph_message_id');
    expect(msgSql).not.toContain('conversation_id');
  });

  test('mail flag off → mail lane omitted, calendar still served', async () => {
    featureFlags.hasFeature.mockImplementation(async (_org, flag) => flag !== 'outlook_mail_enabled');
    mockPool.query
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [{ id: DEAL_ID }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [] });                              // events only
    const res = await request(buildApp())
      .get(`/api/deals/${DEAL_ID}/outlook-intel`).set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.events).toEqual([]);
    // Exactly 4 queries — the messages SELECT never ran.
    expect(mockPool.query.mock.calls).toHaveLength(4);
    expect(mockPool.query.mock.calls[3][0]).toContain('outlook_calendar_events');
  });

  test('both flags off → 403 FEATURE_DISABLED from the router gate', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    mockPool.query.mockResolvedValueOnce(authRow()); // auth resolve only
    const res = await request(buildApp())
      .get(`/api/deals/${DEAL_ID}/outlook-intel`).set('Cookie', authCookie());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
    expect(mockPool.query.mock.calls).toHaveLength(1); // nothing else touched
  });

  test('cross-org deal id → 404, no lane queries', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] });            // scoped deal fetch → miss
    const res = await request(buildApp())
      .get(`/api/deals/424242/outlook-intel`).set('Cookie', authCookie());
    expect(res.status).toBe(404);
    expect(mockPool.query.mock.calls).toHaveLength(2);
  });

  test('no M365 connection → connected=false with empty lanes (still 200)', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [{ id: DEAL_ID }] })
      .mockResolvedValueOnce({ rows: [] })             // no active connection
      .mockResolvedValueOnce({ rows: [] })             // messages
      .mockResolvedValueOnce({ rows: [] });            // events
    const res = await request(buildApp())
      .get(`/api/deals/${DEAL_ID}/outlook-intel`).set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, messages: [], events: [] });
  });

  test('non-numeric deal id → 400 before any deal query', async () => {
    mockPool.query.mockResolvedValueOnce(authRow());
    const res = await request(buildApp())
      .get('/api/deals/abc/outlook-intel').set('Cookie', authCookie());
    expect(res.status).toBe(400);
    expect(mockPool.query.mock.calls).toHaveLength(1);
  });
});
