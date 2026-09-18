// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Recurring tasks / cadences (migration 129) — route + service + worker tests.
//
// taskRoutes is mounted against a tiny Express app; the pg pool is fully
// mocked, each pool.query resolving the next queued response in the order the
// route issues them (pattern mirrors contactCadence.test.js).
//
// Query order per request:
//   POST /api/tasks          1. auth SELECT  2. INSERT (no linked-entity checks
//                               when contact_id/deal_id are absent)
//   PUT  /api/tasks/:id      1. auth SELECT  2. prior SELECT (assigned_to,
//                               status)  3. UPDATE ... RETURNING
//                            4. (only on a transition into 'done' of a live
//                               recurring task) the spawn INSERT
//
// Covered: create persists the rule; the allowlist 400s garbage; completing a
// recurring task spawns exactly one successor with correct due-date math +
// root parent link + copied fields + preserved org scope; double-complete and
// one-off/stopped series spawn nothing; explicit-null clears the rule while
// omission leaves it untouched; nextDueDate calendar math (incl. the monthly
// Jan-31 clamp); and the safety-net worker's lease + sweep + error-release.

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const taskRoutes = require('../routes/taskRoutes');
const recurringTasks = require('../services/recurringTasks');
const recurringTaskWorker = require('../services/recurringTaskWorker');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 4242;
const ORG_ID = 7;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/tasks', taskRoutes);
  return app;
}

// authMiddleware issues SELECT org_id, org_role, status FROM users WHERE id=$1.
function queueAuthRow() {
  mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
}

// A completed weekly occurrence, as UPDATE ... RETURNING would hand it back.
function doneWeeklyRow(overrides = {}) {
  return {
    id: 10,
    user_id: USER_ID,
    org_id: ORG_ID,
    contact_id: 3,
    deal_id: null,
    title: 'Send weekly report',
    description: 'Compile pipeline numbers',
    due_date: '2026-07-10T00:00:00.000Z',
    status: 'done',
    priority: 'high',
    assigned_to: null,
    custom_fields: {},
    recurrence_rule: 'weekly',
    recurrence_parent_id: null,
    recurrence_active: true,
    ...overrides,
  };
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.query.mockResolvedValue({ rows: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// POST /api/tasks — persisting + validating recurrence_rule
// ---------------------------------------------------------------------------
describe('POST /api/tasks recurrence', () => {
  test('persists recurrence_rule on create', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1, title: 'Water plants', recurrence_rule: 'weekly' }] });

    const res = await request(buildApp())
      .post('/api/tasks')
      .set('Cookie', authCookie())
      .send({ title: 'Water plants', recurrence_rule: 'weekly' });

    expect(res.status).toBe(201);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toMatch(/INSERT INTO tasks/);
    expect(sql).toMatch(/recurrence_rule/);
    expect(params[11]).toBe('weekly');
    // Org scope on the new row.
    expect(params[1]).toBe(ORG_ID);
  });

  test('rejects a rule outside the allowlist with 400 before any task SQL', async () => {
    queueAuthRow();

    const res = await request(buildApp())
      .post('/api/tasks')
      .set('Cookie', authCookie())
      .send({ title: 'Nope', recurrence_rule: 'yearly' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/recurrence_rule/);
    // Only the auth lookup ran — garbage never reached the INSERT.
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  test("normalizes '' (frontend None) to null", async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 2 }] });

    const res = await request(buildApp())
      .post('/api/tasks')
      .set('Cookie', authCookie())
      .send({ title: 'One-off', recurrence_rule: '' });

    expect(res.status).toBe(201);
    expect(mockPool.query.mock.calls[1][1][11]).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/tasks/:id — completion spawns the next occurrence
// ---------------------------------------------------------------------------
describe('PUT /api/tasks/:id completion spawning', () => {
  test('completing a recurring task spawns exactly one successor (due_date +7d, parent link, copied fields, org preserved)', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [{ assigned_to: null, status: 'open' }] }); // prior
    mockPool.query.mockResolvedValueOnce({ rows: [doneWeeklyRow()] });                        // UPDATE
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 11, title: 'Send weekly report' }] }); // spawn

    const res = await request(buildApp())
      .put('/api/tasks/10')
      .set('Cookie', authCookie())
      .send({ status: 'done' });

    expect(res.status).toBe(200);
    // Exactly one spawn, no extra queries: auth, prior, update, insert.
    expect(mockPool.query).toHaveBeenCalledTimes(4);

    // Route-level org scoping is intact on both reads and the write.
    const [priorSql, priorParams] = mockPool.query.mock.calls[1];
    expect(priorSql).toMatch(/org_id = \$2/);
    expect(priorParams[1]).toBe(ORG_ID);
    const updateParams = mockPool.query.mock.calls[2][1];
    expect(updateParams).toContain(ORG_ID);

    const [spawnSql, spawnParams] = mockPool.query.mock.calls[3];
    expect(spawnSql).toMatch(/INSERT INTO tasks/);
    // The atomic duplicate guard rides inside the INSERT itself.
    expect(spawnSql).toMatch(/WHERE NOT EXISTS/);
    expect(spawnSql).toMatch(/status <> 'done'/);
    // Copied + advanced fields: [user, org, contact, deal, title, desc, due,
    // priority, assignee, cf, rule, rootId].
    expect(spawnParams[0]).toBe(USER_ID);
    expect(spawnParams[1]).toBe(ORG_ID);
    expect(spawnParams[2]).toBe(3);
    expect(spawnParams[4]).toBe('Send weekly report');
    expect(spawnParams[5]).toBe('Compile pipeline numbers');
    expect(spawnParams[6]).toBe('2026-07-17T00:00:00.000Z'); // +7 days
    expect(spawnParams[7]).toBe('high');
    expect(spawnParams[10]).toBe('weekly');
    expect(spawnParams[11]).toBe(10); // root = the completed task itself

    // Additive response key so the UI can confirm the next occurrence.
    expect(res.body.spawned_next_occurrence.id).toBe(11);
  });

  test('an occurrence mid-series links back to the ROOT, not to itself', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [{ assigned_to: null, status: 'open' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [doneWeeklyRow({ id: 42, recurrence_parent_id: 10 })] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 43 }] });

    await request(buildApp()).put('/api/tasks/42').set('Cookie', authCookie()).send({ status: 'done' });

    expect(mockPool.query.mock.calls[3][1][11]).toBe(10);
  });

  test('double-complete does not spawn a second successor', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [{ assigned_to: null, status: 'done' }] }); // already done
    mockPool.query.mockResolvedValueOnce({ rows: [doneWeeklyRow()] });

    const res = await request(buildApp())
      .put('/api/tasks/10')
      .set('Cookie', authCookie())
      .send({ status: 'done' });

    expect(res.status).toBe(200);
    expect(mockPool.query).toHaveBeenCalledTimes(3); // no spawn INSERT
    expect(res.body.spawned_next_occurrence).toBeUndefined();
  });

  test('a one-off task spawns nothing', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [{ assigned_to: null, status: 'open' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [doneWeeklyRow({ recurrence_rule: null })] });

    const res = await request(buildApp())
      .put('/api/tasks/10')
      .set('Cookie', authCookie())
      .send({ status: 'done' });

    expect(res.status).toBe(200);
    expect(mockPool.query).toHaveBeenCalledTimes(3);
  });

  test('a stopped series (recurrence_active = false) spawns nothing', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [{ assigned_to: null, status: 'open' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [doneWeeklyRow({ recurrence_active: false })] });

    const res = await request(buildApp())
      .put('/api/tasks/10')
      .set('Cookie', authCookie())
      .send({ status: 'done' });

    expect(res.status).toBe(200);
    expect(mockPool.query).toHaveBeenCalledTimes(3);
  });

  test('explicit null clears the rule; omission leaves it untouched', async () => {
    // Explicit null → provided-flag true, value null.
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [{ assigned_to: null, status: 'open' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [doneWeeklyRow({ status: 'open', recurrence_rule: null })] });
    await request(buildApp()).put('/api/tasks/10').set('Cookie', authCookie()).send({ recurrence_rule: null });
    let updateParams = mockPool.query.mock.calls[2][1];
    expect(updateParams[11]).toBe(true);
    expect(updateParams[12]).toBe(null);

    // Omitted → provided-flag false (rule preserved by the SQL CASE).
    mockPool.query.mockReset();
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [{ assigned_to: null, status: 'open' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [doneWeeklyRow({ status: 'open' })] });
    await request(buildApp()).put('/api/tasks/10').set('Cookie', authCookie()).send({ title: 'Renamed' });
    updateParams = mockPool.query.mock.calls[2][1];
    expect(updateParams[11]).toBe(false);
  });

  test('PUT rejects a rule outside the allowlist', async () => {
    queueAuthRow();
    const res = await request(buildApp())
      .put('/api/tasks/10')
      .set('Cookie', authCookie())
      .send({ recurrence_rule: 'fortnightly-ish' });
    expect(res.status).toBe(400);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  test('a spawn failure never fails the complete itself', async () => {
    queueAuthRow();
    mockPool.query.mockResolvedValueOnce({ rows: [{ assigned_to: null, status: 'open' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [doneWeeklyRow()] });
    mockPool.query.mockRejectedValueOnce(new Error('insert exploded'));

    const res = await request(buildApp())
      .put('/api/tasks/10')
      .set('Cookie', authCookie())
      .send({ status: 'done' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(10);
    expect(res.body.spawned_next_occurrence).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// services/recurringTasks — due-date math + guards
// ---------------------------------------------------------------------------
describe('recurringTasks.nextDueDate', () => {
  test('daily / weekly / biweekly add the right number of days', () => {
    expect(recurringTasks.nextDueDate('daily', '2026-07-01T00:00:00.000Z')).toBe('2026-07-02T00:00:00.000Z');
    expect(recurringTasks.nextDueDate('weekly', '2026-07-01T00:00:00.000Z')).toBe('2026-07-08T00:00:00.000Z');
    expect(recurringTasks.nextDueDate('biweekly', '2026-07-01T00:00:00.000Z')).toBe('2026-07-15T00:00:00.000Z');
  });

  test('monthly is calendar-aware: Jan 31 clamps to Feb 28, month boundaries roll', () => {
    expect(recurringTasks.nextDueDate('monthly', '2026-01-31T00:00:00.000Z')).toBe('2026-02-28T00:00:00.000Z');
    expect(recurringTasks.nextDueDate('monthly', '2026-06-15T00:00:00.000Z')).toBe('2026-07-15T00:00:00.000Z');
    expect(recurringTasks.nextDueDate('monthly', '2026-12-10T00:00:00.000Z')).toBe('2027-01-10T00:00:00.000Z');
  });

  test('unknown rules return null; a missing previous due date falls back to now', () => {
    expect(recurringTasks.nextDueDate('yearly', '2026-07-01T00:00:00.000Z')).toBe(null);
    const before = Date.now();
    const next = new Date(recurringTasks.nextDueDate('daily', null)).getTime();
    expect(next).toBeGreaterThanOrEqual(before + 86400000 - 5000);
    expect(next).toBeLessThanOrEqual(Date.now() + 86400000 + 5000);
  });
});

describe('recurringTasks.spawnNextOccurrence guards', () => {
  test('returns null without touching the DB for non-recurring or stopped rows', async () => {
    expect(await recurringTasks.spawnNextOccurrence({ id: 1, recurrence_rule: null })).toBe(null);
    expect(await recurringTasks.spawnNextOccurrence({ id: 1, recurrence_rule: 'bogus' })).toBe(null);
    expect(await recurringTasks.spawnNextOccurrence({ id: 1, recurrence_rule: 'daily', recurrence_active: false })).toBe(null);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('returns null when the duplicate guard suppressed the insert', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // NOT EXISTS lost
    const out = await recurringTasks.spawnNextOccurrence(doneWeeklyRow());
    expect(out).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// services/recurringTaskWorker — leased safety-net sweep
// ---------------------------------------------------------------------------
describe('recurringTaskWorker.tick', () => {
  test('skips the period entirely when another instance holds the lease', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // claim lost

    const out = await recurringTaskWorker.tick();

    expect(out.skipped).toBe(true);
    expect(out.spawned).toBe(0);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(mockPool.query.mock.calls[0][0]).toMatch(/INSERT INTO worker_runs/);
    expect(mockPool.query.mock.calls[0][1][0]).toBe('recurring_task_spawn');
  });

  test('sweeps orphaned series and spawns their successors', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ claimed_at: new Date().toISOString() }] }); // claim won
    mockPool.query.mockResolvedValueOnce({ rows: [doneWeeklyRow()] });                          // orphan scan
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 99 }] });                               // spawn

    const out = await recurringTaskWorker.tick();

    expect(out).toEqual({ spawned: 1, failed: 0 });
    const orphanSql = mockPool.query.mock.calls[1][0];
    expect(orphanSql).toMatch(/recurrence_rule IS NOT NULL/);
    expect(orphanSql).toMatch(/recurrence_active IS NOT FALSE/);
    expect(orphanSql).toMatch(/NOT EXISTS/);
    const spawnSql = mockPool.query.mock.calls[2][0];
    expect(spawnSql).toMatch(/INSERT INTO tasks/);
  });

  test('releases the lease when the sweep itself fails, so the period can retry', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ claimed_at: new Date().toISOString() }] }); // claim won
    mockPool.query.mockRejectedValueOnce(new Error('db went away'));                            // orphan scan dies
    mockPool.query.mockResolvedValueOnce({ rows: [] });                                         // release

    const out = await recurringTaskWorker.tick();

    expect(out.error).toBe('db went away');
    expect(mockPool.query.mock.calls[2][0]).toMatch(/DELETE FROM worker_runs/);
    expect(mockPool.query.mock.calls[2][1][0]).toBe('recurring_task_spawn');
  });
});
