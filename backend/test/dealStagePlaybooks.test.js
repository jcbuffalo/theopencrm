// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Deal-stage-triggered playbooks (migration 158, CMN_REQUIREMENTS.md §1.2).
//
// Four suites:
//   1. services/playbooks.runPlaybooksForDealStageChange — the deal trigger
//      engine: scope + deal_type threading, task spawning (deal + company
//      linkage), the (playbook, deal) idempotency gate.
//   2. The lifecycle engine stays kind-scoped — its playbook lookup filters
//      trigger_kind so a deal_stage playbook can never fire on a company
//      lifecycle change.
//   3. dealRoutes wiring — PATCH /:id/stage and stage-changing PUT /:id fire
//      the engine best-effort (a playbook blow-up never breaks the update);
//      a PUT that doesn't change the stage doesn't fire.
//   4. playbookRoutes trigger validation — deal_stage stages validate against
//      the org's effective pipeline(s), lifecycle rules are unchanged, and
//      trigger_deal_type is deal_stage-only.
//
// Same harness as playbooks.test.js: tiny Express app, fully mocked pg pool,
// featureFlags.hasFeature stubbed. describe/test/expect/beforeEach/vi are
// vitest globals.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

// Keep the deal-route side effects out of the mocked-pool call ledger (same
// stubs as dealTypePipelines.test.js, plus the playbook-tasks notifier).
vi.mock('../services/v2DualWrite', () => ({
  onDealCreated: vi.fn().mockResolvedValue(null),
  onDealStageChanged: vi.fn().mockResolvedValue(null),
}));
vi.mock('../services/webhookDispatcher', () => ({
  dispatch: vi.fn().mockResolvedValue(null),
}));
vi.mock('../services/notificationDispatcher', () => ({
  notifyDealActivity: vi.fn().mockResolvedValue(null),
  notifyPlaybookTasksCreated: vi.fn().mockResolvedValue(null),
}));

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const playbookService = require('../services/playbooks');
const playbookRoutes = require('../routes/playbookRoutes');
const dealRoutes = require('../routes/dealRoutes');
const featureFlags = require('../services/featureFlags');
const pipelines = require('../services/pipelines');
const { requireFeature } = require('../middleware/featureGate');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 4242;
const ORG_ID = 7;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/playbooks', requireFeature('customer_success_enabled'), playbookRoutes);
  app.use('/deals', dealRoutes);
  return app;
}

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function authAs(role) {
  // authMiddleware — SELECT org_id, org_role, status FROM users.
  mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: role, status: 'active' }] });
}

// A mock pg client whose query() drains a queue of canned responses.
function mockClient(responses) {
  const client = { query: vi.fn(), release: vi.fn() };
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
// 1. The deal trigger engine.
// ---------------------------------------------------------------------------
describe('services/playbooks.runPlaybooksForDealStageChange', () => {
  test('fires a matching deal playbook: run row + one task per step with deal + company linkage', async () => {
    // pool.query #1 — SELECT active deal_stage playbooks for (scope, stage, type).
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 11, name: 'Campaign execution' }] });

    const client = mockClient([
      {},                          // BEGIN
      { rows: [{ id: 901 }] },     // INSERT playbook_runs (won the dedupe)
      { rows: [                    // SELECT steps
        { title: 'Creative brief', description: null, offset_days: 0 },
        { title: 'Install check', description: 'On site', offset_days: 5 },
      ] },
      {}, {},                      // 2× INSERT tasks
      {},                          // COMMIT
    ]);
    mockPool.connect.mockResolvedValueOnce(client);

    const out = await playbookService.runPlaybooksForDealStageChange({
      orgScopeField: 'org_id',
      orgScopeValue: ORG_ID,
      dealId: 77,
      newStage: 'closed_won',
      dealType: 'supply',
      companyId: 42,
      userId: USER_ID,
    });

    expect(out.fired).toEqual([{ playbook_id: 11, name: 'Campaign execution', tasks_created: 2 }]);

    // Lookup: kind-scoped, stage + deal_type threaded.
    const lookup = mockPool.query.mock.calls[0];
    expect(lookup[0]).toMatch(/FROM playbooks/);
    expect(lookup[0]).toMatch(/trigger_kind = 'deal_stage'/);
    expect(lookup[0]).toMatch(/trigger_deal_type IS NULL OR trigger_deal_type = \$3/);
    expect(lookup[1]).toEqual([ORG_ID, 'closed_won', 'supply']);

    // Run insert dedupes on the partial (playbook_id, deal_id) unique index —
    // company_id deliberately NOT written (see migration 158 header).
    const runCall = client.query.mock.calls[1];
    expect(runCall[0]).toMatch(/INSERT INTO playbook_runs \(org_id, playbook_id, deal_id, triggered_stage\)/);
    expect(runCall[0]).toMatch(/ON CONFLICT \(playbook_id, deal_id\) WHERE deal_id IS NOT NULL DO NOTHING/);
    expect(runCall[1]).toEqual([ORG_ID, 11, 77, 'closed_won']);

    // Tasks link to the deal AND its company, due today + offset.
    const task1 = client.query.mock.calls[3];
    expect(task1[0]).toMatch(/INSERT INTO tasks/);
    expect(task1[0]).toMatch(/CURRENT_DATE \+ \$7::int/);
    expect(task1[1]).toEqual([USER_ID, ORG_ID, 77, 42, 'Creative brief', null, 0]);
    const task2 = client.query.mock.calls[4];
    expect(task2[1]).toEqual([USER_ID, ORG_ID, 77, 42, 'Install check', 'On site', 5]);
  });

  test('deal_type defaults to "default" when the deal has no type', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const out = await playbookService.runPlaybooksForDealStageChange({
      orgScopeField: 'org_id', orgScopeValue: ORG_ID,
      dealId: 5, newStage: 'closed_won', userId: USER_ID,
    });
    expect(out.fired).toEqual([]);
    expect(mockPool.query.mock.calls[0][1]).toEqual([ORG_ID, 'closed_won', 'default']);
  });

  test('dedupe: a playbook that already ran for this deal spawns nothing', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 11, name: 'Campaign execution' }] });
    const client = mockClient([
      {},              // BEGIN
      { rows: [] },     // INSERT playbook_runs — lost the dedupe (conflict)
      {},              // ROLLBACK
    ]);
    mockPool.connect.mockResolvedValueOnce(client);

    const out = await playbookService.runPlaybooksForDealStageChange({
      orgScopeField: 'org_id', orgScopeValue: ORG_ID,
      dealId: 77, newStage: 'closed_won', dealType: 'default', userId: USER_ID,
    });

    expect(out.fired).toEqual([]);
    // No task INSERT happened: BEGIN, run INSERT, ROLLBACK only.
    expect(client.query.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(['BEGIN', 'ROLLBACK'])
    );
    expect(client.query.mock.calls.some((c) => /INSERT INTO tasks/.test(c[0]))).toBe(false);
    expect(client.release).toHaveBeenCalled();
  });

  test('rejects a bogus scope field', async () => {
    await expect(playbookService.runPlaybooksForDealStageChange({
      orgScopeField: 'nope', orgScopeValue: 1, dealId: 1, newStage: 'x', userId: 1,
    })).rejects.toThrow(/Invalid scope field/);
  });
});

// ---------------------------------------------------------------------------
// 2. The lifecycle engine stays kind-scoped.
// ---------------------------------------------------------------------------
describe('lifecycle trigger keeps deal_stage playbooks out', () => {
  test('runPlaybooksForStageChange lookup filters on trigger_kind lifecycle_stage', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await playbookService.runPlaybooksForStageChange({
      orgScopeField: 'org_id', orgScopeValue: ORG_ID,
      companyId: 9, newStage: 'onboarding', userId: USER_ID,
    });
    const lookup = mockPool.query.mock.calls[0];
    expect(lookup[0]).toMatch(/COALESCE\(trigger_kind, 'lifecycle_stage'\) = 'lifecycle_stage'/);
    expect(lookup[1]).toEqual([ORG_ID, 'onboarding']);
  });
});

// ---------------------------------------------------------------------------
// 3. dealRoutes wiring.
// ---------------------------------------------------------------------------
describe('dealRoutes fires deal-stage playbooks best-effort', () => {
  function stubPipeline() {
    vi.spyOn(pipelines, 'getEffectivePipeline').mockResolvedValue({
      is_custom: true,
      default_stage: 'lead',
      stages: [
        { id: 'lead', label: 'Lead' },
        { id: 'closed_won', label: 'Closed Won' },
      ],
    });
  }

  test('PATCH /:id/stage fires the engine after the stage change commits', async () => {
    stubPipeline();
    const fire = vi.spyOn(playbookService, 'runPlaybooksForDealStageChange')
      .mockResolvedValue({ fired: [] });

    authAs('member');
    // ctx lookup: current stage + type + profile.
    mockPool.query.mockResolvedValueOnce({ rows: [{ current_stage: 'lead', deal_type: 'default', profile: 'generic' }] });
    const client = mockClient([
      {},                                                                                   // BEGIN
      { rows: [{ id: 55, title: 'Deal', stage: 'closed_won', deal_type: 'default', company_id: 42 }] }, // UPDATE
      {},                                                                                   // COMMIT
    ]);
    mockPool.connect.mockResolvedValueOnce(client);

    const res = await request(buildApp())
      .patch('/deals/55/stage')
      .set('Cookie', authCookie())
      .send({ stage: 'closed_won' });

    expect(res.status).toBe(200);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith(expect.objectContaining({
      orgScopeField: 'org_id',
      orgScopeValue: ORG_ID,
      dealId: 55,
      newStage: 'closed_won',
      dealType: 'default',
      companyId: 42,
      userId: USER_ID,
    }));
  });

  test('PATCH /:id/stage does not fire when the stage is unchanged', async () => {
    stubPipeline();
    const fire = vi.spyOn(playbookService, 'runPlaybooksForDealStageChange')
      .mockResolvedValue({ fired: [] });

    authAs('member');
    mockPool.query.mockResolvedValueOnce({ rows: [{ current_stage: 'closed_won', deal_type: 'default', profile: 'generic' }] });
    const client = mockClient([
      {},
      { rows: [{ id: 55, title: 'Deal', stage: 'closed_won', deal_type: 'default', company_id: null }] },
      {},
    ]);
    mockPool.connect.mockResolvedValueOnce(client);

    const res = await request(buildApp())
      .patch('/deals/55/stage')
      .set('Cookie', authCookie())
      .send({ stage: 'closed_won' });

    expect(res.status).toBe(200);
    expect(fire).not.toHaveBeenCalled();
  });

  test('a playbook blow-up never breaks the stage PATCH', async () => {
    stubPipeline();
    vi.spyOn(playbookService, 'runPlaybooksForDealStageChange')
      .mockRejectedValue(new Error('playbooks exploded'));

    authAs('member');
    mockPool.query.mockResolvedValueOnce({ rows: [{ current_stage: 'lead', deal_type: 'default', profile: 'generic' }] });
    const client = mockClient([
      {},
      { rows: [{ id: 55, title: 'Deal', stage: 'closed_won', deal_type: 'default', company_id: null }] },
      {},
    ]);
    mockPool.connect.mockResolvedValueOnce(client);

    const res = await request(buildApp())
      .patch('/deals/55/stage')
      .set('Cookie', authCookie())
      .send({ stage: 'closed_won' });

    expect(res.status).toBe(200);
    expect(res.body.stage).toBe('closed_won');
  });

  test('PUT /:id fires when the update moves the deal to a new stage', async () => {
    stubPipeline();
    const fire = vi.spyOn(playbookService, 'runPlaybooksForDealStageChange')
      .mockResolvedValue({ fired: [] });

    authAs('member');
    // current-row lookup (stage + deal_type) — new stage differs.
    mockPool.query.mockResolvedValueOnce({ rows: [{ stage: 'lead', deal_type: 'default' }] });
    // UPDATE ... RETURNING *.
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 55, title: 'Deal', stage: 'closed_won', deal_type: 'default', company_id: 42 }] });

    const res = await request(buildApp())
      .put('/deals/55')
      .set('Cookie', authCookie())
      .send({ stage: 'closed_won' });

    expect(res.status).toBe(200);
    expect(fire).toHaveBeenCalledWith(expect.objectContaining({ dealId: 55, newStage: 'closed_won' }));
  });

  test('PUT /:id does not fire when the stage stays put', async () => {
    stubPipeline();
    const fire = vi.spyOn(playbookService, 'runPlaybooksForDealStageChange')
      .mockResolvedValue({ fired: [] });

    authAs('member');
    mockPool.query.mockResolvedValueOnce({ rows: [{ stage: 'closed_won', deal_type: 'default' }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 55, title: 'Deal', stage: 'closed_won', deal_type: 'default', company_id: null }] });

    const res = await request(buildApp())
      .put('/deals/55')
      .set('Cookie', authCookie())
      .send({ stage: 'closed_won', amount: 1000 });

    expect(res.status).toBe(200);
    expect(fire).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. playbookRoutes trigger validation.
// ---------------------------------------------------------------------------
describe('playbookRoutes deal_stage trigger validation', () => {
  function stubOrgPipelines() {
    vi.spyOn(pipelines, 'listPipelines').mockResolvedValue([
      { deal_type: 'default' }, { deal_type: 'supply' },
    ]);
    vi.spyOn(pipelines, 'getEffectivePipeline').mockImplementation(async (orgId, profile, { dealType } = {}) => ({
      is_custom: true,
      default_stage: 'lead',
      stages: dealType === 'supply'
        ? [{ id: 'spotted', label: 'Spotted' }, { id: 'rights_signed', label: 'Rights Signed' }]
        : [{ id: 'lead', label: 'Lead' }, { id: 'closed_won', label: 'Closed Won' }],
    }));
  }

  test('POST / accepts a deal_stage playbook whose stage is on the typed pipeline', async () => {
    stubOrgPipelines();
    authAs('admin');
    const client = mockClient([
      {},                                                    // BEGIN
      { rows: [{ id: 30, name: 'Supply won', trigger_kind: 'deal_stage', trigger_stage: 'rights_signed', trigger_deal_type: 'supply' }] },
      {},                                                    // COMMIT
    ]);
    mockPool.connect.mockResolvedValueOnce(client);

    const res = await request(buildApp())
      .post('/playbooks')
      .set('Cookie', authCookie())
      .send({ name: 'Supply won', trigger_kind: 'deal_stage', trigger_stage: 'rights_signed', trigger_deal_type: 'supply' });

    expect(res.status).toBe(201);
    const insert = client.query.mock.calls[1];
    expect(insert[0]).toMatch(/INSERT INTO playbooks \(user_id, org_id, name, trigger_kind, trigger_stage, trigger_deal_type, is_active\)/);
    expect(insert[1]).toEqual([USER_ID, ORG_ID, 'Supply won', 'deal_stage', 'rights_signed', 'supply', true]);
  });

  test('POST / rejects a deal_stage playbook whose stage is on no pipeline', async () => {
    stubOrgPipelines();
    authAs('admin');

    const res = await request(buildApp())
      .post('/playbooks')
      .set('Cookie', authCookie())
      .send({ name: 'Bad', trigger_kind: 'deal_stage', trigger_stage: 'not_a_stage' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a stage on any/);
  });

  test('POST / rejects a stage that exists only on ANOTHER type when a filter is set', async () => {
    stubOrgPipelines();
    authAs('admin');

    const res = await request(buildApp())
      .post('/playbooks')
      .set('Cookie', authCookie())
      .send({ name: 'Bad', trigger_kind: 'deal_stage', trigger_stage: 'closed_won', trigger_deal_type: 'supply' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a stage on the "supply" pipeline/);
  });

  test('POST / rejects trigger_deal_type on a lifecycle playbook', async () => {
    authAs('admin');
    const res = await request(buildApp())
      .post('/playbooks')
      .set('Cookie', authCookie())
      .send({ name: 'Bad', trigger_stage: 'onboarding', trigger_deal_type: 'supply' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/only valid for deal_stage/);
  });

  test('POST / lifecycle validation is unchanged (bad stage still 400s with the allowlist)', async () => {
    authAs('admin');
    const res = await request(buildApp())
      .post('/playbooks')
      .set('Cookie', authCookie())
      .send({ name: 'Bad', trigger_stage: 'closed_won' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/trigger_stage must be one of/);
  });

  test('PUT /:id that only toggles is_active skips trigger validation and preserves the trigger', async () => {
    const pipelineSpy = vi.spyOn(pipelines, 'getEffectivePipeline');
    authAs('owner');
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 123, is_active: false, trigger_kind: 'deal_stage' }] }); // UPDATE ... RETURNING

    const res = await request(buildApp())
      .put('/playbooks/123')
      .set('Cookie', authCookie())
      .send({ is_active: false });

    expect(res.status).toBe(200);
    expect(pipelineSpy).not.toHaveBeenCalled();
    const updCall = mockPool.query.mock.calls[1];
    expect(updCall[0]).toMatch(/UPDATE playbooks/);
    // touchesTrigger=false → the CASE keeps trigger columns untouched.
    expect(updCall[1]).toEqual([null, false, null, null, null, false, '123', ORG_ID]);
  });
});
