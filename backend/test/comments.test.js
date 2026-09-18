// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Record comments with @mentions (migration 146) — CRUD org-isolation,
// cross-org entity rejection, author/admin permissions, and mention fan-out.
//
// The pg pool is fully mocked (same convention as dealLineItems.test.js):
// pool.query resolves queued responses in the order the routes issue them.
// notificationDispatcher is module-mocked so we can assert exactly who gets
// notified (and that failures/self-mentions never do).
//
// Query order per route (valid requests):
//   every route:  1. authMiddleware — SELECT org_id, org_role, status FROM users
//   GET    /      2. entity-scope SELECT      3. comments SELECT
//   POST   /      2. entity-scope SELECT     (3. mention-validation SELECT when
//                    mentioned_user_ids non-empty and caller has an org)
//                 4. INSERT
//   PUT    /:id   2. comment SELECT           3. UPDATE
//   DELETE /:id   2. comment SELECT           3. DELETE
//
// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();

// Patch the live dispatcher exports in place (see calendarSync.test.js —
// require caching means commentRoutes sees this same object, so the route's
// notificationDispatcher.notifyMention(...) call hits our spy).
const dispatcher = require('../services/notificationDispatcher');
dispatcher.notifyMention = vi.fn().mockResolvedValue({ email: 'skipped', sms: 'skipped' });

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const commentRoutes = require('../routes/commentRoutes');
const { normalizeBody, isValidEntityType, ENTITY_TABLES } = require('../services/comments');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/comments', commentRoutes); // same shape as the index.js mount
  return app;
}

const USER_ID = 4242;
const OTHER_USER_ID = 5000;
const ORG_ID = 7;
const DEAL_ID = 55;
const COMMENT_ID = 901;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

const AUTH_MEMBER = { rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] };
const AUTH_ADMIN  = { rows: [{ org_id: ORG_ID, org_role: 'admin',  status: 'active' }] };
const AUTH_ORGLESS = { rows: [{ org_id: null, org_role: null, status: 'active' }] };
const ENTITY_OK = { rows: [{ id: DEAL_ID }] };
const EMPTY = { rows: [] };

const COMMENT_ROW = {
  id: COMMENT_ID, org_id: ORG_ID, user_id: USER_ID, entity_type: 'deal',
  entity_id: DEAL_ID, author_user_id: USER_ID, body: 'Hello',
  created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z',
};

beforeEach(() => {
  mockPool.query.mockReset();
  dispatcher.notifyMention.mockClear();
});

// ---------------------------------------------------------------------------
// Pure core — services/comments.js
// ---------------------------------------------------------------------------
describe('comments service core', () => {
  test('entity allowlist covers exactly the five commentable types', () => {
    expect(Object.keys(ENTITY_TABLES).sort()).toEqual(['case', 'company', 'contact', 'deal', 'lead']);
    expect(isValidEntityType('deal')).toBe(true);
    expect(isValidEntityType('users')).toBe(false);       // never SQL-able
    expect(isValidEntityType('record_comments')).toBe(false);
  });

  test('normalizeBody trims, requires content, caps length', () => {
    expect(normalizeBody('  hi  ').body).toBe('hi');
    expect(normalizeBody('').error).toMatch(/required/);
    expect(normalizeBody('   ').error).toMatch(/required/);
    expect(normalizeBody(undefined).error).toMatch(/required/);
    expect(normalizeBody('x'.repeat(5001)).error).toMatch(/5000/);
  });
});

// ---------------------------------------------------------------------------
// GET — list + org isolation
// ---------------------------------------------------------------------------
describe('GET /comments', () => {
  test('lists a record thread oldest→newest, org-scoped', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(ENTITY_OK)
      .mockResolvedValueOnce({ rows: [COMMENT_ROW] });
    const res = await request(buildApp())
      .get(`/comments?entity_type=deal&entity_id=${DEAL_ID}`)
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(COMMENT_ID);
    // Entity check scoped to the caller's org…
    expect(mockPool.query.mock.calls[1][0]).toMatch(/FROM deals WHERE id = \$1 AND org_id = \$2/);
    expect(mockPool.query.mock.calls[1][1]).toEqual([DEAL_ID, ORG_ID]);
    // …and the list itself is org-scoped + oldest-first.
    expect(mockPool.query.mock.calls[2][0]).toMatch(/c\.org_id = \$3/);
    expect(mockPool.query.mock.calls[2][0]).toMatch(/ORDER BY c\.created_at ASC/);
    expect(mockPool.query.mock.calls[2][1]).toEqual(['deal', DEAL_ID, ORG_ID]);
  });

  test('cross-org (or nonexistent) entity → 404, no comment SQL runs', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(EMPTY); // deal not in this org
    const res = await request(buildApp())
      .get(`/comments?entity_type=deal&entity_id=${DEAL_ID}`)
      .set('Cookie', authCookie());
    expect(res.status).toBe(404);
    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });

  test('unknown entity_type → 400 before any scoped SQL', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);
    const res = await request(buildApp())
      .get('/comments?entity_type=users&entity_id=1')
      .set('Cookie', authCookie());
    expect(res.status).toBe(400);
    expect(mockPool.query).toHaveBeenCalledTimes(1); // auth only
  });

  test('org-less workspace falls back to user_id scoping', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_ORGLESS)
      .mockResolvedValueOnce(ENTITY_OK)
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp())
      .get(`/comments?entity_type=deal&entity_id=${DEAL_ID}`)
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(mockPool.query.mock.calls[1][0]).toMatch(/user_id = \$2/);
    expect(mockPool.query.mock.calls[1][1]).toEqual([DEAL_ID, USER_ID]);
  });
});

// ---------------------------------------------------------------------------
// POST — create + mention fan-out
// ---------------------------------------------------------------------------
describe('POST /comments', () => {
  test('creates a comment and notifies each valid in-org mention', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(ENTITY_OK)
      .mockResolvedValueOnce({ rows: [{ id: OTHER_USER_ID }] }) // mention validation
      .mockResolvedValueOnce({ rows: [COMMENT_ROW] });          // INSERT
    const res = await request(buildApp())
      .post('/comments')
      .set('Cookie', authCookie())
      .send({ entity_type: 'deal', entity_id: DEAL_ID, body: 'Ping @Other', mentioned_user_ids: [OTHER_USER_ID] });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(COMMENT_ID);
    // Mention validation is org-bound…
    expect(mockPool.query.mock.calls[2][1]).toEqual([[OTHER_USER_ID], ORG_ID]);
    // …and exactly the mentioned in-org teammate is notified.
    expect(dispatcher.notifyMention).toHaveBeenCalledTimes(1);
    expect(dispatcher.notifyMention).toHaveBeenCalledWith(COMMENT_ID, OTHER_USER_ID, USER_ID);
  });

  test('cross-org entity rejected with 404 — nothing inserted, no one notified', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(EMPTY); // target deal not in this org
    const res = await request(buildApp())
      .post('/comments')
      .set('Cookie', authCookie())
      .send({ entity_type: 'deal', entity_id: DEAL_ID, body: 'sneaky', mentioned_user_ids: [OTHER_USER_ID] });
    expect(res.status).toBe(404);
    expect(mockPool.query).toHaveBeenCalledTimes(2); // no mention SELECT, no INSERT
    expect(dispatcher.notifyMention).not.toHaveBeenCalled();
  });

  test('out-of-org mention rejected with 400 — nothing inserted, no one notified', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(ENTITY_OK)
      .mockResolvedValueOnce(EMPTY); // mentioned user is NOT in this org
    const res = await request(buildApp())
      .post('/comments')
      .set('Cookie', authCookie())
      .send({ entity_type: 'deal', entity_id: DEAL_ID, body: 'hey', mentioned_user_ids: [9999] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/outside your organization/);
    expect(mockPool.query).toHaveBeenCalledTimes(3); // no INSERT
    expect(dispatcher.notifyMention).not.toHaveBeenCalled();
  });

  test('self-mention is silently dropped (comment saves, author not notified)', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(ENTITY_OK)
      .mockResolvedValueOnce({ rows: [{ id: USER_ID }] }) // self IS in-org — valid
      .mockResolvedValueOnce({ rows: [COMMENT_ROW] });    // INSERT
    const res = await request(buildApp())
      .post('/comments')
      .set('Cookie', authCookie())
      .send({ entity_type: 'deal', entity_id: DEAL_ID, body: 'note to self', mentioned_user_ids: [USER_ID] });
    expect(res.status).toBe(201);
    expect(res.body.mentioned_user_ids).toEqual([]);
    expect(dispatcher.notifyMention).not.toHaveBeenCalled();
  });

  test('empty body → 400 with no scoped SQL beyond auth', async () => {
    mockPool.query.mockResolvedValueOnce(AUTH_MEMBER);
    const res = await request(buildApp())
      .post('/comments')
      .set('Cookie', authCookie())
      .send({ entity_type: 'deal', entity_id: DEAL_ID, body: '   ' });
    expect(res.status).toBe(400);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  test('org-less caller cannot mention anyone else (no users query needed)', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_ORGLESS)
      .mockResolvedValueOnce(ENTITY_OK); // entity in personal scope
    const res = await request(buildApp())
      .post('/comments')
      .set('Cookie', authCookie())
      .send({ entity_type: 'deal', entity_id: DEAL_ID, body: 'hi', mentioned_user_ids: [OTHER_USER_ID] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/outside your organization/);
    expect(mockPool.query).toHaveBeenCalledTimes(2); // in-scope set is just the caller — no extra SELECT
    expect(dispatcher.notifyMention).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PUT — author-only edit
// ---------------------------------------------------------------------------
describe('PUT /comments/:id', () => {
  test('author can edit their own comment', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce({ rows: [{ id: COMMENT_ID, author_user_id: USER_ID }] })
      .mockResolvedValueOnce({ rows: [{ ...COMMENT_ROW, body: 'Edited' }] });
    const res = await request(buildApp())
      .put(`/comments/${COMMENT_ID}`)
      .set('Cookie', authCookie())
      .send({ body: 'Edited' });
    expect(res.status).toBe(200);
    expect(res.body.body).toBe('Edited');
    expect(mockPool.query.mock.calls[2][0]).toMatch(/UPDATE record_comments/);
  });

  test('non-author gets 403 even inside the same org (admins included)', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_ADMIN) // even an admin can't rewrite words
      .mockResolvedValueOnce({ rows: [{ id: COMMENT_ID, author_user_id: OTHER_USER_ID }] });
    const res = await request(buildApp())
      .put(`/comments/${COMMENT_ID}`)
      .set('Cookie', authCookie())
      .send({ body: 'hijack' });
    expect(res.status).toBe(403);
    expect(mockPool.query).toHaveBeenCalledTimes(2); // no UPDATE
  });

  test('cross-org comment id → 404 (scoped SELECT finds nothing)', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(EMPTY);
    const res = await request(buildApp())
      .put(`/comments/${COMMENT_ID}`)
      .set('Cookie', authCookie())
      .send({ body: 'nope' });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE — author or org-admin
// ---------------------------------------------------------------------------
describe('DELETE /comments/:id', () => {
  test('author can delete their own comment', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce({ rows: [{ id: COMMENT_ID, author_user_id: USER_ID }] })
      .mockResolvedValueOnce({ rows: [] }); // DELETE
    const res = await request(buildApp())
      .delete(`/comments/${COMMENT_ID}`)
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(mockPool.query.mock.calls[2][0]).toMatch(/DELETE FROM record_comments/);
  });

  test("non-author non-admin member gets 403 on someone else's comment", async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce({ rows: [{ id: COMMENT_ID, author_user_id: OTHER_USER_ID }] });
    const res = await request(buildApp())
      .delete(`/comments/${COMMENT_ID}`)
      .set('Cookie', authCookie());
    expect(res.status).toBe(403);
    expect(mockPool.query).toHaveBeenCalledTimes(2); // no DELETE
  });

  test("org admin can moderate (delete someone else's comment)", async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_ADMIN)
      .mockResolvedValueOnce({ rows: [{ id: COMMENT_ID, author_user_id: OTHER_USER_ID }] })
      .mockResolvedValueOnce({ rows: [] }); // DELETE
    const res = await request(buildApp())
      .delete(`/comments/${COMMENT_ID}`)
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(mockPool.query.mock.calls[2][0]).toMatch(/DELETE FROM record_comments/);
    expect(mockPool.query.mock.calls[2][1]).toEqual([String(COMMENT_ID), ORG_ID]);
  });

  test('cross-org comment id → 404, no delete issued', async () => {
    mockPool.query
      .mockResolvedValueOnce(AUTH_MEMBER)
      .mockResolvedValueOnce(EMPTY);
    const res = await request(buildApp())
      .delete(`/comments/${COMMENT_ID}`)
      .set('Cookie', authCookie());
    expect(res.status).toBe(404);
    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });
});
