// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Success Playbooks — service + route tests (migration 123).
//
// Three suites:
//   1. services/playbooks.runPlaybooksForStageChange — the trigger engine:
//      scope threading, task spawning, the playbook_runs idempotency gate,
//      and per-playbook transaction rollback.
//   2. /playbooks routes — org-scoping, org-admin write gating, validation,
//      and the customer_success_enabled feature gate.
//   3. The companyRoutes wiring — a lifecycle-stage PATCH fires the engine
//      best-effort: a playbook blow-up never breaks the stage update.
//
// Same harness as companyLifecycleStage.test.js: tiny Express app, fully
// mocked pg pool (each pool.query resolves the next queued response in the
// order the code issues them), featureFlags.hasFeature stubbed per test.

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const playbookRoutes = require('../routes/playbookRoutes');
const companyRoutes = require('../routes/companyRoutes');
const playbookService = require('../services/playbooks');
const featureFlags = require('../services/featureFlags');
const { requireFeature } = require('../middleware/featureGate');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 4242;
const ORG_ID = 7;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  // Mirrors the index.js mount: feature-gated at the mount point.
  app.use('/playbooks', requireFeature('customer_success_enabled'), playbookRoutes);
  app.use('/companies', companyRoutes);
  return app;
}

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

// A mock pg client whose query() drains a queue of canned responses. connect()
// hands it out; release() is tracked so we can assert no leaks.
function mockClient(responses) {
  const client = {
    query: vi.fn(),
    release: vi.fn(),
  };
  for (const r of responses) {
    if (r instanceof Error) client.query.mockRejectedValueOnce(r);
    else client.query.mockResolvedValueOnce(r);
  }
  return client;
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  vi.restoreAllMocks();
  vi.spyOn(featureFlags, 'hasFeature').mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// 1. The trigger engine.
// ---------------------------------------------------------------------------
describe('services/playbooks.runPlaybooksForStageChange', () => {
  test('fires a matching playbook: run row + one task per step, org-scoped', async () => {
    // pool.query #1 — SELECT active playbooks for (scope, stage).
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 5, name: 'Onboarding checklist' }] });

    const client = mockClient([
      {},                          // BEGIN
      { rows: [{ id: 900 }] },     // INSERT playbook_runs (won the dedupe)
      { rows: [                    // SELECT steps
        { title: 'Send welcome email', description: 'Use the template', offset_days: 0 },
        { title: 'Kickoff call',       description: null,               offset_days: 3 },
      ] },
      {}, {},                      // 2× INSERT tasks
      {},                          // COMMIT
    ]);
    mockPool.connect.mockResolvedValueOnce(client);

    const out = await playbookService.runPlaybooksForStageChange({
      orgScopeField: 'org_id',
      orgScopeValue: ORG_ID,
      companyId: 99,
      newStage: 'onboarding',
      userId: USER_ID,
    });

    expect(out.fired).toEqual([{ playbook_id: 5, name: 'Onboarding checklist', tasks_created: 2 }]);

    // Playbook lookup threads the scope + stage.
    expect(mockPool.query.mock.calls[0][0]).toMatch(/FROM playbooks/);
    expect(mockPool.query.mock.calls[0][1]).toEqual([ORG_ID, 'onboarding']);

    // Run insert dedupes on the unique (playbook_id, company_id) index.
    const runCall = client.query.mock.calls[1];
    expect(runCall[0]).toMatch(/INSERT INTO playbook_runs/);
    expect(runCall[0]).toMatch(/ON CONFLICT \(playbook_id, company_id\) DO NOTHING/);
    expect(runCall[1]).toEqual([ORG_ID, 5, 99, 'onboarding']);

    // Tasks: user/org/company linkage + title/description + offset due date.
    const task1 = client.query.mock.calls[3];
    expect(task1[0]).toMatch(/INSERT INTO tasks/);
    expect(task1[0]).toMatch(/CURRENT_DATE \+ \$6::int/);
    expect(task1[1]).toEqual([USER_ID, ORG_ID, 99, 'Send welcome email', 'Use the template', 0]);
    const task2 = client.query.mock.calls[4];
    expect(task2[1]).toEqual([USER_ID, ORG_ID, 99, 'Kickoff call', null, 3]);

    expect(client.query.mock.calls[5][0]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  test('is idempotent: an existing run row means no tasks are created', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 5, name: 'Onboarding checklist' }] });
    const client = mockClient([
      {},            // BEGIN
      { rows: [] },  // INSERT run lost the ON CONFLICT — already fired
      {},            // ROLLBACK
    ]);
    mockPool.connect.mockResolvedValueOnce(client);

    const out = await playbookService.runPlaybooksForStageChange({
      orgScopeField: 'org_id',
      orgScopeValue: ORG_ID,
      companyId: 99,
      newStage: 'onboarding',
      userId: USER_ID,
    });

    expect(out.fired).toEqual([]);
    // No task INSERT ever happened: BEGIN, run INSERT, ROLLBACK only.
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query.mock.calls[2][0]).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  test('no matching playbooks: returns empty and never opens a transaction', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const out = await playbookService.runPlaybooksForStageChange({
      orgScopeField: 'user_id',
      orgScopeValue: USER_ID,
      companyId: 99,
      newStage: 'at_risk',
      userId: USER_ID,
    });
    expect(out.fired).toEqual([]);
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  test('user-scoped callers write NULL org_id on run + task rows', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 8, name: 'Solo save motion' }] });
    const client = mockClient([
      {},                                                            // BEGIN
      { rows: [{ id: 901 }] },                                       // INSERT run
      { rows: [{ title: 'Call them', description: null, offset_days: 1 }] }, // steps
      {},                                                            // task
      {},                                                            // COMMIT
    ]);
    mockPool.connect.mockResolvedValueOnce(client);

    await playbookService.runPlaybooksForStageChange({
      orgScopeField: 'user_id',
      orgScopeValue: USER_ID,
      companyId: 42,
      newStage: 'at_risk',
      userId: USER_ID,
    });

    expect(client.query.mock.calls[1][1]).toEqual([null, 8, 42, 'at_risk']); // run: org_id NULL
    expect(client.query.mock.calls[3][1]).toEqual([USER_ID, null, 42, 'Call them', null, 1]); // task: org_id NULL
  });

  test('a mid-flight failure rolls back and releases the client', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 5, name: 'Onboarding' }] });
    const client = mockClient([
      {},                        // BEGIN
      { rows: [{ id: 900 }] },   // INSERT run
      new Error('steps query exploded'),
      {},                        // ROLLBACK
    ]);
    mockPool.connect.mockResolvedValueOnce(client);

    await expect(playbookService.runPlaybooksForStageChange({
      orgScopeField: 'org_id',
      orgScopeValue: ORG_ID,
      companyId: 99,
      newStage: 'onboarding',
      userId: USER_ID,
    })).rejects.toThrow('steps query exploded');

    expect(client.query.mock.calls[3][0]).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  test('rejects an invalid scope field outright', async () => {
    await expect(playbookService.runPlaybooksForStageChange({
      orgScopeField: 'id',
      orgScopeValue: 1,
      companyId: 1,
      newStage: 'active',
      userId: USER_ID,
    })).rejects.toThrow(/Invalid scope field/);
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. The /playbooks routes.
// ---------------------------------------------------------------------------
describe('playbook routes', () => {
  function authAs(role) {
    // authMiddleware — SELECT org_id, org_role, status FROM users.
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: role, status: 'active' }] });
  }

  test('GET / lists org-scoped playbooks with counts + the stage allowlist', async () => {
    authAs('member');
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 1, name: 'Onboarding', trigger_stage: 'onboarding', is_active: true, step_count: 3, run_count: 2 }],
    });

    const res = await request(buildApp()).get('/playbooks').set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.playbooks).toHaveLength(1);
    expect(res.body.stages).toContain('at_risk');
    const listCall = mockPool.query.mock.calls[1];
    expect(listCall[0]).toMatch(/FROM playbooks p/);
    expect(listCall[0]).toMatch(/p\.org_id = \$1/);
    expect(listCall[1]).toEqual([ORG_ID]);
  });

  test('POST / creates a playbook with inline steps in one transaction (org admin)', async () => {
    authAs('admin');
    const client = mockClient([
      {},                                                              // BEGIN
      { rows: [{ id: 11, name: 'At-risk save', trigger_stage: 'at_risk', is_active: true }] },
      { rows: [{ id: 21, playbook_id: 11, title: 'Exec call', sort_order: 0 }] },
      { rows: [{ id: 22, playbook_id: 11, title: 'Discount review', sort_order: 1 }] },
      {},                                                              // COMMIT
    ]);
    mockPool.connect.mockResolvedValueOnce(client);

    const res = await request(buildApp())
      .post('/playbooks')
      .set('Cookie', authCookie())
      .send({
        name: 'At-risk save',
        trigger_stage: 'at_risk',
        steps: [
          { title: 'Exec call', offset_days: 0 },
          { title: 'Discount review', offset_days: 5 },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.steps).toHaveLength(2);
    // Playbook insert carries user + org (+ the migration-158 trigger columns,
    // defaulted to a lifecycle trigger with no deal_type filter).
    expect(client.query.mock.calls[1][1]).toEqual([USER_ID, ORG_ID, 'At-risk save', 'lifecycle_stage', 'at_risk', null, true]);
    expect(client.query.mock.calls[4][0]).toBe('COMMIT');
  });

  test('POST / is rejected for plain members with 403', async () => {
    authAs('member');
    const res = await request(buildApp())
      .post('/playbooks')
      .set('Cookie', authCookie())
      .send({ name: 'Nope', trigger_stage: 'active' });

    expect(res.status).toBe(403);
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  test('POST / rejects a trigger_stage outside the lifecycle allowlist', async () => {
    authAs('owner');
    const res = await request(buildApp())
      .post('/playbooks')
      .set('Cookie', authCookie())
      .send({ name: 'Bad stage', trigger_stage: 'hyperactive' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/trigger_stage must be one of/);
  });

  test('POST /:id/steps rejects a negative offset_days', async () => {
    authAs('owner');
    const res = await request(buildApp())
      .post('/playbooks/1/steps')
      .set('Cookie', authCookie())
      .send({ title: 'Time travel', offset_days: -3 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/offset_days/);
  });

  test('PUT /:id 404s when the playbook is out of the caller scope', async () => {
    authAs('owner');
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE matched nothing

    const res = await request(buildApp())
      .put('/playbooks/123')
      .set('Cookie', authCookie())
      .send({ is_active: false });

    expect(res.status).toBe(404);
    const updCall = mockPool.query.mock.calls[1];
    expect(updCall[0]).toMatch(/UPDATE playbooks/);
    // [name, touchesTrigger, kind, stage, deal_type, is_active, id, scope] —
    // trigger columns untouched on an is_active-only PUT (migration 158).
    expect(updCall[1]).toEqual([null, false, null, null, null, false, '123', ORG_ID]);
  });

  test('DELETE /:id/steps/:stepId only deletes steps of an in-scope playbook', async () => {
    authAs('admin');
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 9, name: 'Onboarding' }] }); // scoped playbook lookup
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 33 }] });                    // DELETE step

    const res = await request(buildApp())
      .delete('/playbooks/9/steps/33')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(mockPool.query.mock.calls[1][0]).toMatch(/FROM playbooks WHERE id = \$1 AND org_id = \$2/);
    expect(mockPool.query.mock.calls[2][1]).toEqual(['33', 9]);
  });

  test('the whole surface 403s when customer_success_enabled is off', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    authAs('owner');

    const res = await request(buildApp()).get('/playbooks').set('Cookie', authCookie());

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
  });
});

// ---------------------------------------------------------------------------
// 3. The lifecycle-stage PATCH fires the engine, best-effort.
// ---------------------------------------------------------------------------
describe('PATCH /companies/:id/lifecycle-stage → playbooks wiring', () => {
  test('a successful stage change invokes the engine with the route scope', async () => {
    const spy = vi.spyOn(playbookService, 'runPlaybooksForStageChange')
      .mockResolvedValue({ fired: [{ playbook_id: 1, name: 'Onboarding', tasks_created: 2 }] });

    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] }); // auth
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 55, lifecycle_stage: 'onboarding' }] });               // UPDATE

    const res = await request(buildApp())
      .patch('/companies/55/lifecycle-stage')
      .set('Cookie', authCookie())
      .send({ lifecycle_stage: 'onboarding' });

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith({
      orgScopeField: 'org_id',
      orgScopeValue: ORG_ID,
      companyId: 55,
      newStage: 'onboarding',
      userId: USER_ID,
    });
  });

  test('a playbook engine failure never breaks the stage update (still 200)', async () => {
    vi.spyOn(playbookService, 'runPlaybooksForStageChange')
      .mockRejectedValue(new Error('playbooks table is on fire'));

    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 55, lifecycle_stage: 'at_risk' }] });

    const res = await request(buildApp())
      .patch('/companies/55/lifecycle-stage')
      .set('Cookie', authCookie())
      .send({ lifecycle_stage: 'at_risk' });

    expect(res.status).toBe(200);
    expect(res.body.lifecycle_stage).toBe('at_risk');
  });

  test('a failed (404) stage change never invokes the engine', async () => {
    const spy = vi.spyOn(playbookService, 'runPlaybooksForStageChange').mockResolvedValue({ fired: [] });

    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE matched nothing

    const res = await request(buildApp())
      .patch('/companies/55/lifecycle-stage')
      .set('Cookie', authCookie())
      .send({ lifecycle_stage: 'churned' });

    expect(res.status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });
});
