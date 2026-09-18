// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Unit tests for the new `run_plugin` chat tool plus the friendly_status
// formatter. Strategy mirrors plugin-from-prompt.test.js: mock the pg pool by
// overwriting query() on the live instance, mock services/pluginRunner.run, and
// invoke the tool handler directly through the test-only `_buildChatToolRunner`
// export.
//
// Coverage:
//   • resolves by plugin_id (happy path)
//   • resolves by plugin_name substring (happy path)
//   • ambiguous name → AMBIGUOUS_NAME with candidate list
//   • plugin_id miss / cross-tenant → PLUGIN_NOT_FOUND
//   • plugin found but status != 'active' → PLUGIN_DISABLED
//   • neither id nor name given → PLUGIN_REF_REQUIRED
//   • friendlyStatus covers the documented buckets

// vitest globals.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

// Mock pluginRunner BEFORE requiring the route — the route caches
// `require('../services/pluginRunner')` in a top-level const.
const pluginRunner = require('../services/pluginRunner');
const runnerSpy = vi.fn();
pluginRunner.run = runnerSpy;

// Audit + logger noise — same shape as plugin-from-prompt.test.js.
const audit = require('../services/audit');
audit.record  = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

const logger = require('../services/logger');
logger.info  = vi.fn();
logger.warn  = vi.fn();
logger.error = vi.fn();

const aiRoutes = require('../routes/aiRoutes');
const { friendlyStatus, statusTone } = require('../services/pluginRunFormatter');

const ORG_ID = 99;
const USER_ID = 4242;

// Synthetic Express req shape. Mirrors the fields the chat-tool handlers read:
//   orgId, userId, adminRole, log. The qs(req) helper picks orgId first, so
//   tests set both to keep the closure-captured [sf, sv] stable across calls.
function buildReq(overrides = {}) {
  return {
    orgId: ORG_ID,
    userId: USER_ID,
    adminRole: null,
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    headers: {},
    ip: '127.0.0.1',
    ...overrides,
  };
}

beforeEach(() => {
  mockPool.query.mockReset();
  runnerSpy.mockReset();
  audit.fromReq.mockClear();
});

describe('run_plugin chat tool — happy paths', () => {
  test('resolves by plugin_id and returns the persisted run row', async () => {
    const req = buildReq();
    const runTool = aiRoutes._buildChatToolRunner(req);

    // 1) plugins lookup by id
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 7, name: 'follow-up', status: 'active' }],
    });
    // 2) runner returns a runId
    runnerSpy.mockResolvedValueOnce({
      ok: true,
      status: 'success',
      runId: 901,
      cpu_ms: 42,
      db_queries: 3,
      logs: ['ran ok'],
    });
    // 3) plugin_runs SELECT for the persisted row
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 901,
        plugin_id: 7,
        status: 'success',
        error_message: null,
        result_summary: null,
        cpu_ms: 42,
        db_queries: 3,
        log_lines: ['ran ok'],
        started_at: new Date(),
        ended_at: new Date(),
        trigger_kind: 'chat',
        trigger_source: 'copilot',
        triggered_by: USER_ID,
      }],
    });

    const result = await runTool('run_plugin', { plugin_id: 7 });

    expect(result.run).toBeDefined();
    expect(result.run.id).toBe(901);
    expect(result.run.friendly_status).toBe('Worked');
    expect(result.plugin_id).toBe(7);
    expect(result.plugin_name).toBe('follow-up');
    // pluginRunner was called with trigger_kind=chat and trigger_source=copilot
    expect(runnerSpy).toHaveBeenCalledTimes(1);
    const runnerArgs = runnerSpy.mock.calls[0][0];
    expect(runnerArgs.triggerKind).toBe('chat');
    expect(runnerArgs.triggerSource).toBe('copilot');
    expect(runnerArgs.pluginId).toBe(7);
    expect(runnerArgs.orgId).toBe(ORG_ID);
    expect(runnerArgs.userId).toBe(USER_ID);
  });

  test('resolves by plugin_name substring (single match)', async () => {
    const req = buildReq();
    const runTool = aiRoutes._buildChatToolRunner(req);

    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 12, name: 'stalled-deal-digest', status: 'active' }],
    });
    runnerSpy.mockResolvedValueOnce({
      ok: true, status: 'success', runId: 902, cpu_ms: 10, db_queries: 1, logs: [],
    });
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 902,
        plugin_id: 12,
        status: 'success',
        error_message: null,
        result_summary: 'digest sent',
        cpu_ms: 10,
        db_queries: 1,
        log_lines: null,
      }],
    });

    const result = await runTool('run_plugin', { plugin_name: 'stalled' });
    expect(result.run.id).toBe(902);
    expect(result.plugin_id).toBe(12);
    expect(result.run.friendly_status).toBe('Worked');
  });
});

describe('run_plugin chat tool — error paths', () => {
  test('multiple name matches → AMBIGUOUS_NAME with candidates', async () => {
    const req = buildReq();
    const runTool = aiRoutes._buildChatToolRunner(req);

    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 1, name: 'digest-daily', status: 'active' },
        { id: 2, name: 'digest-weekly', status: 'active' },
      ],
    });

    const result = await runTool('run_plugin', { plugin_name: 'digest' });
    expect(result.code).toBe('AMBIGUOUS_NAME');
    expect(result.candidates).toEqual([
      { id: 1, name: 'digest-daily' },
      { id: 2, name: 'digest-weekly' },
    ]);
    // Runner must NOT have been invoked for an ambiguous match.
    expect(runnerSpy).not.toHaveBeenCalled();
  });

  test('not found (cross-tenant or bad id) → PLUGIN_NOT_FOUND', async () => {
    const req = buildReq();
    const runTool = aiRoutes._buildChatToolRunner(req);
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const result = await runTool('run_plugin', { plugin_id: 999999 });
    expect(result.code).toBe('PLUGIN_NOT_FOUND');
    expect(runnerSpy).not.toHaveBeenCalled();
  });

  test('plugin found but status != active → PLUGIN_DISABLED', async () => {
    const req = buildReq();
    const runTool = aiRoutes._buildChatToolRunner(req);
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 7, name: 'follow-up', status: 'draft' }],
    });
    const result = await runTool('run_plugin', { plugin_id: 7 });
    expect(result.code).toBe('PLUGIN_DISABLED');
    expect(result.status).toBe('draft');
    expect(result.hint).toContain('toggle it on');
    expect(runnerSpy).not.toHaveBeenCalled();
  });

  test('neither plugin_id nor plugin_name → PLUGIN_REF_REQUIRED', async () => {
    const req = buildReq();
    const runTool = aiRoutes._buildChatToolRunner(req);
    const result = await runTool('run_plugin', {});
    expect(result.code).toBe('PLUGIN_REF_REQUIRED');
    expect(runnerSpy).not.toHaveBeenCalled();
  });

  test('runner returns failure → row is still returned with friendly_status', async () => {
    // The chat tool fetches the persisted row even on runner failure so the
    // user can be told what went wrong without a follow-up tool call.
    const req = buildReq();
    const runTool = aiRoutes._buildChatToolRunner(req);
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 7, name: 'follow-up', status: 'active' }],
    });
    runnerSpy.mockResolvedValueOnce({
      ok: false,
      status: 'failed',
      runId: 950,
      error: 'something broke',
      cpu_ms: 12, db_queries: 0, logs: ['boom'],
    });
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 950, plugin_id: 7, status: 'failed',
        error_message: 'something broke', result_summary: null,
        cpu_ms: 12, db_queries: 0, log_lines: ['boom'],
      }],
    });

    const result = await runTool('run_plugin', { plugin_id: 7 });
    expect(result.run.status).toBe('failed');
    expect(result.run.friendly_status).toBe("Didn't finish — there was an error");
  });
});

describe('pluginRunFormatter#friendlyStatus', () => {
  test('covers all documented buckets', () => {
    expect(friendlyStatus('success')).toBe('Worked');
    expect(friendlyStatus('ok')).toBe('Worked');
    expect(friendlyStatus('failed')).toBe("Didn't finish — there was an error");
    expect(friendlyStatus('error')).toBe("Didn't finish — there was an error");
    expect(friendlyStatus('budget_exceeded')).toMatch(/safety limit/);
    expect(friendlyStatus('query_budget_exceeded')).toMatch(/safety limit/);
    expect(friendlyStatus('timed_out')).toMatch(/Took too long/);
    expect(friendlyStatus('timeout')).toMatch(/Took too long/);
    expect(friendlyStatus('sandbox_unavailable')).toMatch(/sandbox isn't available/);
    expect(friendlyStatus('running')).toBe('Still running');
    expect(friendlyStatus('memory_exceeded')).toMatch(/too much memory/);
    expect(friendlyStatus('concurrent_limit_exceeded')).toMatch(/at once/);
    expect(friendlyStatus('quota_exceeded')).toMatch(/quota/);
  });

  test('falls through with raw status for unknown values', () => {
    expect(friendlyStatus('weird_new_status')).toBe('Status: weird_new_status');
  });

  test('handles null / undefined', () => {
    expect(friendlyStatus(null)).toBe('Status: unknown');
    expect(friendlyStatus(undefined)).toBe('Status: unknown');
  });

  test('statusTone groups statuses into good/warn/bad/neutral', () => {
    expect(statusTone('success')).toBe('good');
    expect(statusTone('failed')).toBe('bad');
    expect(statusTone('budget_exceeded')).toBe('warn');
    expect(statusTone('running')).toBe('neutral');
    expect(statusTone('weird_new_status')).toBe('neutral');
  });
});

describe('buildActionsFromToolCalls — run_plugin chip', () => {
  test('emits a "View run" navigate chip on successful run_plugin', () => {
    const actions = aiRoutes._buildActionsFromToolCalls([
      {
        name: 'run_plugin',
        input: { plugin_id: 7 },
        result: {
          plugin_id: 7,
          plugin_name: 'follow-up',
          run: { id: 901, status: 'success' },
        },
      },
    ]);
    expect(actions).toContainEqual({
      kind: 'navigate',
      path: '/plugins/7/runs#run-901',
      label: 'View run',
    });
  });

  test('emits an "apply_plugin_run" chip when a preview run staged proposals', () => {
    const actions = aiRoutes._buildActionsFromToolCalls([
      {
        name: 'run_plugin',
        input: { plugin_id: 7 },
        result: {
          plugin_id: 7,
          plugin_name: 'follow-up',
          run: { id: 901, status: 'success' },
          proposed_change_count: 3,
          writes_applied: false,
        },
      },
    ]);
    const applyChip = actions.find((a) => a.kind === 'apply_plugin_run');
    expect(applyChip).toBeDefined();
    expect(applyChip.pluginId).toBe(7);
    expect(applyChip.runId).toBe(901);
    expect(applyChip.proposalCount).toBe(3);
    expect(typeof applyChip.summary).toBe('string');
    expect(applyChip.label).toBe('Apply 3 changes');
    // The "View run" navigate chip is still emitted alongside the apply card.
    expect(actions).toContainEqual({
      kind: 'navigate',
      path: '/plugins/7/runs#run-901',
      label: 'View run',
    });
  });

  test('singularizes the apply label for exactly one staged change', () => {
    const actions = aiRoutes._buildActionsFromToolCalls([
      {
        name: 'run_plugin',
        input: { plugin_id: 7 },
        result: {
          plugin_id: 7,
          run: { id: 902, status: 'success' },
          proposed_change_count: 1,
        },
      },
    ]);
    const applyChip = actions.find((a) => a.kind === 'apply_plugin_run');
    expect(applyChip).toBeDefined();
    expect(applyChip.label).toBe('Apply 1 change');
  });

  test('does NOT emit an apply_plugin_run chip when the run staged no changes', () => {
    const actions = aiRoutes._buildActionsFromToolCalls([
      {
        name: 'run_plugin',
        input: { plugin_id: 7 },
        result: {
          plugin_id: 7,
          run: { id: 903, status: 'success' },
          proposed_change_count: 0,
        },
      },
    ]);
    expect(actions.some((a) => a.kind === 'apply_plugin_run')).toBe(false);
    // Still get the View run chip.
    expect(actions).toContainEqual({
      kind: 'navigate',
      path: '/plugins/7/runs#run-903',
      label: 'View run',
    });
  });

  test('does NOT emit a chip when run_plugin returned an error', () => {
    const actions = aiRoutes._buildActionsFromToolCalls([
      {
        name: 'run_plugin',
        input: { plugin_id: 7 },
        result: { code: 'PLUGIN_NOT_FOUND', error: 'PLUGIN_NOT_FOUND' },
      },
    ]);
    expect(actions).toEqual([]);
  });

  test('emits an "Open plugin" chip for describe_plugin', () => {
    const actions = aiRoutes._buildActionsFromToolCalls([
      {
        name: 'describe_plugin',
        input: { plugin_id: 11 },
        result: { plugin: { id: 11, name: 'X' } },
      },
    ]);
    expect(actions).toContainEqual({
      kind: 'navigate',
      path: '/plugins/11',
      label: 'Open plugin',
    });
  });
});
