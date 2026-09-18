// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Autonomous run mode (migration 167) — the owner-authorized, opt-in-per-
// plugin reversal of the "a plugin can never write directly" invariant.
//
// Covered here:
//   1. run_mode='autonomous': a successful run's proposals are COMMITTED
//      (task actually inserted) through pluginActions.applyRunProposals —
//      the same commit machinery as POST /:id/apply — and the run row is
//      stamped applied_at/applied_result.
//   2. run_mode='preview' (default): identical run still only PROPOSES —
//      no task insert, auto_apply null.
//   3. Triggered runs honor the plugin's mode (pluginEvents.runTriggeredPlugin
//      through the REAL runner).
//   4. Caps stay enforced in autonomous mode: the createTask budget still
//      trips, and a failed run never auto-applies (proposals aren't even
//      persisted for non-success runs).
//   5. Auto-pause bookkeeping is unaffected: a failed autonomous triggered
//      run still increments consecutive_trigger_failures.
//   6. PATCH /api/plugins/:id/run-mode is owner/admin-gated, validates the
//      value, and audits plugin.run_mode_changed with meta { old, new }.
//   7. installLibraryTemplate({ runMode }) inserts the clone with the
//      requested run_mode; the from-template route 403s a member asking for
//      autonomous.
//   8. applyRunProposals idempotency: an already-applied run returns 409.

// describe / test / expect / beforeEach / vi are vitest globals.

process.env.PLUGIN_EVENTS_IN_TESTS = 'true';

// ---------------------------------------------------------------------------
// Live-module pool stub (same approach as plugin-runner.test.js).
// ---------------------------------------------------------------------------
const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

const audit = require('../services/audit');
audit.record = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

const usageMeter = require('../services/usageMeter');
usageMeter.increment = vi.fn().mockResolvedValue(null);
usageMeter.recordAiUsage = vi.fn().mockResolvedValue(null);

const logger = require('../services/logger');
logger.info = vi.fn();
logger.warn = vi.fn();
logger.error = vi.fn();
logger.notice = vi.fn();
logger.debug = vi.fn();

const quotaEnforcer = require('../services/quotaEnforcer');
const origGetOrgTier = quotaEnforcer.getOrgTier;
quotaEnforcer.getOrgTier = vi.fn().mockResolvedValue('enterprise');

const featureFlags = require('../services/featureFlags');
featureFlags.hasFeature = vi.fn().mockResolvedValue(true);

const notifications = require('../services/notifications');
notifications.create = vi.fn().mockResolvedValue({ id: 1 });

const pluginRunner = require('../services/pluginRunner');
const pluginActions = require('../services/pluginActions');
const pluginEvents = require('../services/pluginEvents');
const extensionInstall = require('../services/extensionInstall');
const pluginLibrary = require('../services/pluginLibrary');

const ORG_ID = 7;
const USER_ID = 4242;

// ---------------------------------------------------------------------------
// Stateful pool.query router for the runner + auto-apply flow. Captures the
// finalize UPDATE's proposals/run_mode into runRows so the subsequent
// applyRunProposals load (SELECT ... FROM plugin_runs r JOIN plugins p) can
// serve them back — exactly what the real DB does.
// ---------------------------------------------------------------------------
let pluginRow = null;
let runIdCounter = 0;
let runRows = {};             // runId -> { status, proposed_actions, run_mode, applied_at }
let taskInserts = [];         // captured INSERT INTO tasks calls (client-side)
let appliedUpdates = [];      // captured UPDATE plugin_runs SET applied_at calls
let failureStreakUpdates = []; // captured consecutive_trigger_failures bumps
let lastFinalize = null;

function runnerPoolQuery(sql, params) {
  const text = String(sql).trim();
  if (/FROM organizations/i.test(text)) {
    return Promise.resolve({ rows: [{ tier: 'enterprise' }], rowCount: 1 });
  }
  if (/COUNT\(\*\)/i.test(text) && /plugin_runs/i.test(text)) {
    return Promise.resolve({ rows: [{ c: 0 }], rowCount: 1 });
  }
  if (/INSERT INTO plugin_trigger_dedupe/i.test(text)) {
    return Promise.resolve({ rows: [{ plugin_id: params[0] }], rowCount: 1 });
  }
  // applyRunProposals run load — MUST match before the generic plugins SELECT.
  if (/FROM plugin_runs r/i.test(text) && /JOIN plugins p/i.test(text)) {
    const runId = params[0];
    const row = runRows[runId];
    if (!row) return Promise.resolve({ rows: [], rowCount: 0 });
    return Promise.resolve({
      rows: [{
        id: runId, plugin_id: params[1], org_id: params[2],
        status: row.status || 'success',
        proposed_actions: row.proposed_actions,
        applied_at: row.applied_at || null,
      }],
      rowCount: 1,
    });
  }
  // ref ownership pre-flight (SELECT 1 FROM deals/contacts ...)
  if (/^SELECT 1 FROM (deals|contacts)/i.test(text)) {
    return Promise.resolve({ rows: [{ ok: 1 }], rowCount: 1 });
  }
  // runner's plugin load
  if (/FROM plugins WHERE id = \$1 AND org_id = \$2/i.test(text)) {
    return Promise.resolve({ rows: pluginRow ? [pluginRow] : [], rowCount: pluginRow ? 1 : 0 });
  }
  if (/INSERT INTO plugin_runs/i.test(text)) {
    runIdCounter += 1;
    runRows[runIdCounter] = { applied_at: null, proposed_actions: null };
    return Promise.resolve({ rows: [{ id: runIdCounter }], rowCount: 1 });
  }
  // finalizeRun — proposed_actions at $9, run_mode at $10, runId at $11.
  if (/UPDATE plugin_runs/i.test(text) && /SET ended_at/i.test(text)) {
    const runId = params[10];
    const row = runRows[runId] || (runRows[runId] = {});
    row.status = params[0];
    row.proposed_actions = params[8] ? JSON.parse(params[8]) : null;
    row.run_mode = params[9];
    lastFinalize = { ...row, runId };
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  // recordTriggerOutcome bookkeeping
  if (/UPDATE plugins/i.test(text) && /consecutive_trigger_failures \+ 1/i.test(text)) {
    failureStreakUpdates.push(params);
    return Promise.resolve({ rows: [{ consecutive_trigger_failures: 1, name: 'x' }], rowCount: 1 });
  }
  if (/UPDATE plugins/i.test(text) && /last_triggered_at/i.test(text)) {
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

// Shared connect() client — serves both the SDK's scoped queries (BEGIN /
// SET LOCAL / SELECT) and the auto-apply transaction (FOR UPDATE lock,
// INSERT INTO tasks, applied_at stamp).
function makeClient() {
  return {
    query: vi.fn().mockImplementation((sql, params) => {
      const text = String(sql).trim();
      if (/^BEGIN|^COMMIT|^ROLLBACK|^SET LOCAL/i.test(text)) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (/SELECT applied_at FROM plugin_runs/i.test(text) && /FOR UPDATE/i.test(text)) {
        const row = runRows[params[0]];
        if (!row) return Promise.resolve({ rows: [], rowCount: 0 });
        return Promise.resolve({ rows: [{ applied_at: row.applied_at || null }], rowCount: 1 });
      }
      if (/INSERT INTO tasks/i.test(text)) {
        taskInserts.push(params);
        return Promise.resolve({ rows: [{ id: 555, title: params[4] }], rowCount: 1 });
      }
      if (/UPDATE plugin_runs SET applied_at/i.test(text)) {
        appliedUpdates.push(params);
        const row = runRows[params[2]];
        if (row) row.applied_at = new Date();
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (/^UPDATE (deals|contacts|companies|tasks)/i.test(text)) {
        return Promise.resolve({ rows: [{ id: params[params.length - 2] }], rowCount: 1 });
      }
      // SDK reads default to empty
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release: vi.fn(),
  };
}

function setPlugin(sourceCode, opts = {}) {
  pluginRow = {
    id: opts.id || 100,
    name: opts.name || 'test-plugin',
    status: opts.status || 'active',
    source_code: sourceCode,
    spec_json: null,
    run_mode: opts.run_mode || 'preview',
  };
}

beforeEach(() => {
  pluginRow = null;
  runIdCounter = 0;
  runRows = {};
  taskInserts = [];
  appliedUpdates = [];
  failureStreakUpdates = [];
  lastFinalize = null;
  mockPool.query.mockReset();
  mockPool.query.mockImplementation(runnerPoolQuery);
  mockPool.connect.mockReset();
  mockPool.connect.mockImplementation(() => Promise.resolve(makeClient()));
  quotaEnforcer.getOrgTier.mockReset();
  quotaEnforcer.getOrgTier.mockResolvedValue('enterprise');
  featureFlags.hasFeature.mockReset();
  featureFlags.hasFeature.mockResolvedValue(true);
  audit.record.mockClear();
  audit.fromReq.mockClear();
  pluginRunner._internal.concurrentRunsByOrg.clear();
});

afterAll(() => {
  quotaEnforcer.getOrgTier = origGetOrgTier;
});

const sandboxAvailable = pluginRunner._internal.isSandboxAvailable();
const describeIfSandbox = sandboxAvailable ? describe : describe.skip;

const CREATE_TASK_SRC = `await crm.createTask({ title: 'Auto task', priority: 'high' });`;

// =============================================================================
// 1 + 2. Autonomous commits, preview still proposes
// =============================================================================
describeIfSandbox('run_mode governs whether proposals auto-apply', () => {
  test('autonomous: successful run COMMITS its writes via the shared apply machinery', async () => {
    setPlugin(CREATE_TASK_SRC, { run_mode: 'autonomous' });
    const result = await pluginRunner.run(100, null, { orgId: ORG_ID, userId: USER_ID, triggerSource: 'manual' });

    expect(result.ok).toBe(true);
    expect(result.run_mode).toBe('autonomous');
    // The task was ACTUALLY inserted — through pluginActions.applyRunProposals'
    // transaction (client-side INSERT INTO tasks), not a second write path.
    expect(taskInserts.length).toBe(1);
    expect(taskInserts[0]).toContain('Auto task');
    // org_id bound from scope (first insert param)
    expect(taskInserts[0][0]).toBe(ORG_ID);
    // Run row mirrors a committed apply: applied_at stamped with applied_by +
    // applied_result, and the finalize recorded run_mode + the proposals.
    expect(appliedUpdates.length).toBe(1);
    expect(appliedUpdates[0][0]).toBe(USER_ID); // applied_by
    const appliedResult = JSON.parse(appliedUpdates[0][1]);
    expect(appliedResult.applied_count).toBe(1);
    expect(lastFinalize.run_mode).toBe('autonomous');
    expect(lastFinalize.proposed_actions.length).toBe(1);
    // Caller-visible outcome
    expect(result.auto_apply).toEqual(expect.objectContaining({ applied: true }));
    expect(result.auto_apply.result.applied_count).toBe(1);
    // Per-write audit with autonomous:true
    const applyAudits = audit.record.mock.calls.filter(([a]) => a.event === audit.EVENTS.PLUGIN_ACTION_APPLIED);
    expect(applyAudits.length).toBe(1);
    expect(applyAudits[0][0].meta.autonomous).toBe(true);
  });

  test('preview (default): identical run only PROPOSES — nothing written', async () => {
    setPlugin(CREATE_TASK_SRC, { run_mode: 'preview' });
    const result = await pluginRunner.run(100, null, { orgId: ORG_ID, userId: USER_ID, triggerSource: 'manual' });

    expect(result.ok).toBe(true);
    expect(result.run_mode).toBe('preview');
    expect(result.proposed_actions.length).toBe(1);
    expect(result.auto_apply).toBeNull();
    expect(taskInserts.length).toBe(0);
    expect(appliedUpdates.length).toBe(0);
    expect(lastFinalize.run_mode).toBe('preview');
  });

  test('a plugin row with no run_mode column value behaves as preview', async () => {
    setPlugin(CREATE_TASK_SRC, {});
    pluginRow.run_mode = undefined; // pre-167 row shape
    const result = await pluginRunner.run(100, null, { orgId: ORG_ID, userId: USER_ID, triggerSource: 'manual' });
    expect(result.run_mode).toBe('preview');
    expect(taskInserts.length).toBe(0);
  });
});

// =============================================================================
// 3. Triggered runs honor the plugin's mode (one coherent rule)
// =============================================================================
describeIfSandbox('triggered runs honor run_mode', () => {
  test('an event-triggered run of an autonomous plugin commits its writes', async () => {
    setPlugin(CREATE_TASK_SRC, { run_mode: 'autonomous' });
    const result = await pluginEvents.runTriggeredPlugin(
      { id: 100, name: 'test-plugin' }, ORG_ID, 'deal.created', { id: 5 },
      { dedupeKey: 'deal.created:5', triggerKind: 'event' }
    );
    expect(result.ok).toBe(true);
    expect(result.run_mode).toBe('autonomous');
    expect(result.auto_apply).toEqual(expect.objectContaining({ applied: true }));
    expect(taskInserts.length).toBe(1);
  });

  test('an event-triggered run of a preview plugin leaves proposals pending', async () => {
    setPlugin(CREATE_TASK_SRC, { run_mode: 'preview' });
    const result = await pluginEvents.runTriggeredPlugin(
      { id: 100, name: 'test-plugin' }, ORG_ID, 'deal.created', { id: 5 },
      { dedupeKey: 'deal.created:5b', triggerKind: 'event' }
    );
    expect(result.ok).toBe(true);
    expect(result.proposed_actions.length).toBe(1);
    expect(taskInserts.length).toBe(0);
    // Proposals persisted on the run row for the runs-page Apply affordance.
    expect(lastFinalize.proposed_actions.length).toBe(1);
  });
});

// =============================================================================
// 4 + 5. Caps + auto-pause bookkeeping unaffected by autonomous mode
// =============================================================================
describeIfSandbox('caps and auto-pause stay enforced in autonomous mode', () => {
  test('createTask budget still trips, and NOTHING is committed on a failed run', async () => {
    const src = `for (let i = 0; i < 11; i++) { await crm.createTask({ title: 'task ' + i }); }`;
    setPlugin(src, { run_mode: 'autonomous' });
    const result = await pluginRunner.run(100, null, { orgId: ORG_ID, userId: USER_ID, triggerSource: 'manual' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('task_budget_exceeded');
    // Non-success ⇒ proposals not persisted ⇒ auto-apply never runs.
    expect(result.auto_apply).toBeNull();
    expect(result.proposed_actions).toEqual([]);
    expect(taskInserts.length).toBe(0);
    expect(appliedUpdates.length).toBe(0);
  });

  test('a failed autonomous triggered run still feeds the auto-pause failure streak', async () => {
    setPlugin(`throw new Error('boom');`, { run_mode: 'autonomous' });
    const result = await pluginEvents.runTriggeredPlugin(
      { id: 100, name: 'test-plugin' }, ORG_ID, 'deal.created', { id: 6 },
      { dedupeKey: 'deal.created:6', triggerKind: 'event' }
    );
    expect(result.ok).toBe(false);
    expect(failureStreakUpdates.length).toBe(1);
    expect(taskInserts.length).toBe(0);
  });
});

// =============================================================================
// 8. applyRunProposals idempotency (shared machinery)
// =============================================================================
describe('pluginActions.applyRunProposals', () => {
  test('refuses an already-applied run with 409/ALREADY_APPLIED', async () => {
    runRows[77] = {
      status: 'success',
      applied_at: new Date('2026-09-01T00:00:00Z'),
      proposed_actions: [{ entity: 'task', op: 'create', table: 'tasks', fields: { title: 'x' } }],
    };
    const out = await pluginActions.applyRunProposals({ runId: 77, pluginId: 100, orgId: ORG_ID, appliedBy: USER_ID });
    expect(out.ok).toBe(false);
    expect(out.http).toBe(409);
    expect(out.code).toBe('ALREADY_APPLIED');
  });

  test('404s a run outside the org', async () => {
    const out = await pluginActions.applyRunProposals({ runId: 999, pluginId: 100, orgId: ORG_ID, appliedBy: USER_ID });
    expect(out.ok).toBe(false);
    expect(out.http).toBe(404);
  });
});

// =============================================================================
// 6 + 7. Routes: PATCH /:id/run-mode gate + audit; install with runMode
// =============================================================================
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const pluginRoutes = require('../routes/pluginRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/plugins', pluginRoutes);
  return app;
}
function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

// Pattern-routed pool stub for route tests (mirrors extensionInstall.test.js).
function stubPool({ orgRole = 'admin', handlers = [] } = {}) {
  mockPool.query.mockReset();
  mockPool.query.mockImplementation((sql, params) => {
    const s = String(sql);
    for (const [re, rows] of handlers) {
      if (re.test(s)) {
        const out = typeof rows === 'function' ? rows(s, params) : rows;
        return Promise.resolve({ rows: out });
      }
    }
    if (/FROM users WHERE id/i.test(s)) {
      return Promise.resolve({ rows: [{ org_id: ORG_ID, org_role: orgRole, status: 'active' }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('PATCH /api/plugins/:id/run-mode', () => {
  test('member is rejected with 403 (owner/admin only)', async () => {
    stubPool({ orgRole: 'member' });
    const res = await request(buildApp())
      .patch('/api/plugins/100/run-mode')
      .set('Cookie', authCookie())
      .send({ run_mode: 'autonomous' });
    expect(res.status).toBe(403);
    expect(audit.fromReq.mock.calls.some(([, a]) => a && a.event === audit.EVENTS.PLUGIN_RUN_MODE_CHANGED)).toBe(false);
  });

  test('rejects an invalid run_mode value', async () => {
    stubPool({ orgRole: 'admin' });
    const res = await request(buildApp())
      .patch('/api/plugins/100/run-mode')
      .set('Cookie', authCookie())
      .send({ run_mode: 'yolo' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RUN_MODE');
  });

  test('admin flips preview → autonomous; change is audited with old/new meta', async () => {
    let updated = null;
    stubPool({
      orgRole: 'admin',
      handlers: [
        [/SELECT id, name, run_mode FROM plugins/i, [{ id: 100, name: 'digest', run_mode: 'preview' }]],
        [/UPDATE plugins\s+SET run_mode/i, (s, params) => {
          updated = params;
          return [{ id: 100, name: 'digest', status: 'active', run_mode: params[0], trigger_event: 'schedule.daily' }];
        }],
      ],
    });
    const res = await request(buildApp())
      .patch('/api/plugins/100/run-mode')
      .set('Cookie', authCookie())
      .send({ run_mode: 'autonomous' });
    expect(res.status).toBe(200);
    expect(res.body.data.run_mode).toBe('autonomous');
    expect(updated[0]).toBe('autonomous');
    const call = audit.fromReq.mock.calls.find(([, a]) => a && a.event === audit.EVENTS.PLUGIN_RUN_MODE_CHANGED);
    expect(call).toBeTruthy();
    expect(call[1].meta).toEqual(expect.objectContaining({ old: 'preview', new: 'autonomous' }));
  });

  test('same-mode PATCH is a no-op (no audit row)', async () => {
    stubPool({
      orgRole: 'owner',
      handlers: [
        [/SELECT id, name, run_mode FROM plugins/i, [{ id: 100, name: 'digest', run_mode: 'preview' }]],
      ],
    });
    const res = await request(buildApp())
      .patch('/api/plugins/100/run-mode')
      .set('Cookie', authCookie())
      .send({ run_mode: 'preview' });
    expect(res.status).toBe(200);
    expect(res.body.unchanged).toBe(true);
    expect(audit.fromReq.mock.calls.some(([, a]) => a && a.event === audit.EVENTS.PLUGIN_RUN_MODE_CHANGED)).toBe(false);
  });
});

describe('install with runMode', () => {
  const KNOWN_SLUG = pluginLibrary.list()[0].slug;

  test('installLibraryTemplate({ runMode: "autonomous" }) inserts the clone autonomous', async () => {
    let insertParams = null;
    stubPool({
      handlers: [
        [/INSERT INTO plugins/i, (s, params) => {
          insertParams = params;
          return [{ id: 9, name: 'x', public_id: 'p', status: 'active', source_kind: 'library', description: null, trigger_event: 'schedule.daily', library_slug: KNOWN_SLUG, run_mode: params[10] }];
        }],
      ],
    });
    const out = await extensionInstall.installLibraryTemplate({
      orgId: ORG_ID, userId: USER_ID, slug: KNOWN_SLUG, activate: true, runMode: 'autonomous',
    });
    expect(out.http).toBe(201);
    expect(out.body.plugin.run_mode).toBe('autonomous');
    expect(insertParams[10]).toBe('autonomous');
  });

  test('installLibraryTemplate rejects a bogus runMode', async () => {
    stubPool({});
    const out = await extensionInstall.installLibraryTemplate({
      orgId: ORG_ID, userId: USER_ID, slug: KNOWN_SLUG, activate: true, runMode: 'yolo',
    });
    expect(out.http).toBe(400);
    expect(out.body.code).toBe('INVALID_RUN_MODE');
  });

  test('POST /from-template with run_mode=autonomous is 403 for a member', async () => {
    stubPool({ orgRole: 'member' });
    const res = await request(buildApp())
      .post('/api/plugins/from-template')
      .set('Cookie', authCookie())
      .send({ template_id: KNOWN_SLUG, activate: true, run_mode: 'autonomous' });
    expect(res.status).toBe(403);
  });

  test('POST /from-template with run_mode=autonomous installs autonomous for an admin', async () => {
    let insertParams = null;
    stubPool({
      orgRole: 'admin',
      handlers: [
        [/INSERT INTO plugins/i, (s, params) => {
          insertParams = params;
          return [{ id: 9, name: 'x', public_id: 'p', status: 'active', source_kind: 'library', description: null, trigger_event: 'schedule.daily', library_slug: KNOWN_SLUG, run_mode: params[10] }];
        }],
      ],
    });
    const res = await request(buildApp())
      .post('/api/plugins/from-template')
      .set('Cookie', authCookie())
      .send({ template_id: KNOWN_SLUG, activate: true, run_mode: 'autonomous' });
    expect(res.status).toBe(201);
    expect(res.body.plugin.run_mode).toBe('autonomous');
    expect(insertParams[10]).toBe('autonomous');
    // The install-time autonomous grant carries its own run_mode_changed audit.
    const call = audit.fromReq.mock.calls.find(([, a]) => a && a.event === audit.EVENTS.PLUGIN_RUN_MODE_CHANGED);
    expect(call).toBeTruthy();
    expect(call[1].meta).toEqual(expect.objectContaining({ old: 'preview', new: 'autonomous', via: 'install' }));
  });
});
