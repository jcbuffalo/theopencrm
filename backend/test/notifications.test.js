// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// In-app Notification Center — /api/notifications route + service tests.
//
// Mounts notificationRoutes against a tiny Express app (mirrors
// myDay.test.js). The pg pool is fully mocked: each pool.query call resolves
// the next queued response, in the order the route issues them.
//
// Query order for GET / :
//   1. authMiddleware — SELECT org_id, org_role, status FROM users
//   2. listForUser    — SELECT * FROM notifications ...
//   3. unreadCount    — SELECT COUNT(*) ...
//
// The isolation guarantees are asserted at the query-shape level (the same
// way the rest of the suite does with a mocked pool): every read/write is
// parameterized on BOTH the org scope value AND the recipient's user id, so
// another user's or another org's rows are unreachable by construction.

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const notificationRoutes = require('../routes/notificationRoutes');
const notificationsService = require('../services/notifications');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/notifications', notificationRoutes);
  return app;
}

const USER_ID = 4242;
const OTHER_USER_ID = 9999;
const ORG_ID = 7;

function authCookie(userId = USER_ID) {
  return [`${AUTH_COOKIE_NAME}=${generateToken(userId)}`];
}

function mockAuth(orgId = ORG_ID) {
  mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: orgId, org_role: 'member', status: 'active' }] });
}

function notifRow(overrides = {}) {
  return {
    id: 1, org_id: ORG_ID, user_id: USER_ID, type: 'task_assigned',
    title: 'New task: Call Acme', body: 'A new task has been assigned to you.',
    link: '/tasks', entity_type: 'task', entity_id: 11,
    read_at: null, created_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  mockPool.query.mockReset();
});

describe('GET /notifications', () => {
  test('returns the list + unread_count, scoped to org AND recipient', async () => {
    mockAuth();
    mockPool.query.mockResolvedValueOnce({ rows: [notifRow(), notifRow({ id: 2, read_at: new Date().toISOString() })] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ count: 1 }] });

    const res = await request(buildApp())
      .get('/notifications')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(2);
    expect(res.body.notifications[0].title).toBe('New task: Call Acme');
    expect(res.body.unread_count).toBe(1);

    const calls = mockPool.query.mock.calls;
    expect(calls).toHaveLength(3);
    // List: org-scoped ($1) AND recipient-scoped ($2), newest first, limited.
    expect(calls[1][0]).toMatch(/org_id = \$1 AND user_id = \$2/);
    expect(calls[1][0]).toMatch(/ORDER BY created_at DESC/);
    expect(calls[1][1]).toEqual([ORG_ID, USER_ID, 20]);
    // Unread count: same double scope + read_at IS NULL.
    expect(calls[2][0]).toMatch(/org_id = \$1 AND user_id = \$2 AND read_at IS NULL/);
    expect(calls[2][1]).toEqual([ORG_ID, USER_ID]);
  });

  test('?unread=1 filters to unread only; ?limit is respected and capped', async () => {
    mockAuth();
    mockPool.query.mockResolvedValueOnce({ rows: [notifRow()] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ count: 1 }] });

    const res = await request(buildApp())
      .get('/notifications?unread=1&limit=5')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    const listCall = mockPool.query.mock.calls[1];
    expect(listCall[0]).toMatch(/AND read_at IS NULL/);
    expect(listCall[1]).toEqual([ORG_ID, USER_ID, 5]);
  });

  test('an org-less user falls back to user_id scoping (still recipient-bound)', async () => {
    mockAuth(null);
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ count: 0 }] });

    const res = await request(buildApp())
      .get('/notifications')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.notifications).toEqual([]);
    expect(res.body.unread_count).toBe(0);
    const calls = mockPool.query.mock.calls;
    expect(calls[1][0]).toMatch(/user_id = \$1 AND user_id = \$2/);
    expect(calls[1][1]).toEqual([USER_ID, USER_ID, 20]);
  });

  test('requires auth', async () => {
    const res = await request(buildApp()).get('/notifications');
    expect(res.status).toBe(401);
  });
});

describe('PATCH /notifications/:id/read', () => {
  test('marks MY notification read, double-scoped on org + recipient', async () => {
    mockAuth();
    mockPool.query.mockResolvedValueOnce({ rows: [notifRow({ read_at: new Date().toISOString() })] });

    const res = await request(buildApp())
      .patch('/notifications/1/read')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.read_at).not.toBe(null);
    const call = mockPool.query.mock.calls[1];
    expect(call[0]).toMatch(/UPDATE notifications/);
    expect(call[0]).toMatch(/org_id = \$1 AND user_id = \$2 AND id = \$3/);
    expect(call[1]).toEqual([ORG_ID, USER_ID, 1]);
  });

  test("404s on another user's notification (scope excludes it, existence not leaked)", async () => {
    mockAuth();
    // The UPDATE's WHERE user_id = <me> matches nothing → zero rows back.
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .patch('/notifications/1/read')
      .set('Cookie', authCookie(OTHER_USER_ID));

    expect(res.status).toBe(404);
    // The recipient bound is the CALLER's id — other users' rows unreachable.
    expect(mockPool.query.mock.calls[1][1]).toEqual([ORG_ID, OTHER_USER_ID, 1]);
  });

  test('400s on a non-numeric id', async () => {
    mockAuth();
    const res = await request(buildApp())
      .patch('/notifications/abc/read')
      .set('Cookie', authCookie());
    expect(res.status).toBe(400);
    expect(mockPool.query.mock.calls).toHaveLength(1); // auth only — no UPDATE fired
  });
});

describe('POST /notifications/read-all', () => {
  test('marks all MY unread read and returns the count', async () => {
    mockAuth();
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 });

    const res = await request(buildApp())
      .post('/notifications/read-all')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    const call = mockPool.query.mock.calls[1];
    expect(call[0]).toMatch(/org_id = \$1 AND user_id = \$2 AND read_at IS NULL/);
    expect(call[1]).toEqual([ORG_ID, USER_ID]);
  });
});

describe('services/notifications create()', () => {
  test('org-scoped create inserts org_id + recipient', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [notifRow()] });
    await notificationsService.create({
      orgScope: ['org_id', ORG_ID], userId: USER_ID, type: 'task_assigned',
      title: 'T', body: 'B', link: '/tasks', entityType: 'task', entityId: 11,
    });
    const call = mockPool.query.mock.calls[0];
    expect(call[0]).toMatch(/INSERT INTO notifications/);
    expect(call[1]).toEqual([ORG_ID, USER_ID, 'task_assigned', 'T', 'B', '/tasks', 'task', 11]);
  });

  test('user-scoped create stores a NULL org_id', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [notifRow({ org_id: null })] });
    await notificationsService.create({
      orgScope: ['user_id', USER_ID], userId: USER_ID, type: 'weekly_summary', title: 'W',
    });
    expect(mockPool.query.mock.calls[0][1][0]).toBe(null);
  });

  test('rejects a missing recipient and a bogus scope field (SQL-injection guard)', async () => {
    await expect(notificationsService.create({
      orgScope: ['org_id', ORG_ID], userId: null, type: 't', title: 'x',
    })).rejects.toThrow(/userId is required/);
    await expect(notificationsService.listForUser(['1=1; DROP TABLE notifications;--', 1], USER_ID))
      .rejects.toThrow(/invalid orgScope/);
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});
