// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// User-defined automation rules — evaluator unit tests.
//
// The evaluator lives in services/automation.js (evaluateUserRule / runUserRules)
// and runs each org's enabled `automation_rules` on the same tick as the
// built-in RULES[]. These tests exercise a couple of trigger/action combos, the
// automation_runs dedupe, and the org-scoping of every scan — against a fully
// mocked pg pool with a SQL-routing implementation, mirroring the pattern in
// automationRenewalAtRisk.test.js.
//
// describe / test / expect / beforeEach / vi are vitest globals.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/logger', () => ({
  info:   vi.fn(),
  warn:   vi.fn(),
  error:  vi.fn(),
  notice: vi.fn(),
  debug:  vi.fn(),
}));

const automation = require('../services/automation');

const ORG_ID = 7;
const OTHER_ORG = 99;

// --- SQL-routing mock -------------------------------------------------------
// Captures every SQL string + params, routes each known query to a canned
// result, and records the side-effect writes (task inserts, hot-flag updates,
// automation_runs inserts) so the assertions can inspect them.
function installRoutingMock({ enabledRules = null, dealScanRows = [], taskScanRows = [] } = {}) {
  const captured = {
    sql: [],
    params: [],
    taskInserts: [],
    hotFlagUpdates: [],
    recordedRuns: [],
  };

  mockPool.query.mockImplementation((text, params) => {
    captured.sql.push(text);
    captured.params.push(params);

    // runUserRules() — load enabled rules.
    if (/FROM automation_rules/i.test(text) && /enabled\s*=\s*TRUE/i.test(text)) {
      return Promise.resolve({ rows: enabledRules || [], rowCount: (enabledRules || []).length });
    }

    // recordRun() — INSERT INTO automation_runs.
    if (/INSERT INTO automation_runs/i.test(text)) {
      captured.recordedRuns.push({ text, params });
      return Promise.resolve({ rows: [], rowCount: 1 });
    }

    // createTaskForOrg() — INSERT INTO tasks ... RETURNING id.
    if (/INSERT INTO tasks/i.test(text)) {
      captured.taskInserts.push({ text, params });
      return Promise.resolve({ rows: [{ id: 5000 }], rowCount: 1 });
    }

    // set_hot_flag action.
    if (/UPDATE deals SET hot_flag = TRUE/i.test(text)) {
      captured.hotFlagUpdates.push({ text, params });
      return Promise.resolve({ rows: [], rowCount: 1 });
    }

    // deal trigger scans (deal_stage_is / deal_idle_days).
    if (/FROM deals d/i.test(text) && /NOT EXISTS/i.test(text)) {
      return Promise.resolve({ rows: dealScanRows, rowCount: dealScanRows.length });
    }

    // task_overdue trigger scan.
    if (/FROM tasks t/i.test(text) && /NOT EXISTS/i.test(text)) {
      return Promise.resolve({ rows: taskScanRows, rowCount: taskScanRows.length });
    }

    return Promise.resolve({ rows: [], rowCount: 0 });
  });

  return captured;
}

beforeEach(() => {
  mockPool.query.mockReset();
});

describe('evaluateUserRule — deal_stage_is + set_hot_flag', () => {
  test('flips hot_flag on matched deals and dedup-records the run org-scoped', async () => {
    const captured = installRoutingMock({
      dealScanRows: [{ id: 900, org_id: ORG_ID, user_id: 1, title: 'Acme', stage: 'CLOSED_WON' }],
    });

    const rule = {
      id: 42, org_id: ORG_ID, created_by: 1,
      name: 'Hot on close', trigger: 'deal_stage_is',
      conditions: { stage: 'CLOSED_WON' }, action: { type: 'set_hot_flag' }, enabled: true,
    };

    const res = await automation.evaluateUserRule(rule);

    expect(res.ok).toBe(true);
    expect(res.fired).toBe(1);
    expect(res.scanned).toBe(1);

    // The scan is org-scoped ($1 = org_id) and carries the per-rule dedupe key.
    const scanIdx = captured.sql.findIndex(s => /FROM deals d/i.test(s) && /NOT EXISTS/i.test(s));
    expect(scanIdx).toBeGreaterThan(-1);
    expect(captured.params[scanIdx][0]).toBe(ORG_ID);
    expect(captured.sql[scanIdx]).toMatch(/d\.org_id\s*=\s*\$1/i);
    expect(captured.params[scanIdx]).toContain('user_rule:42');

    // The hot-flag UPDATE ran org-scoped against the matched deal.
    expect(captured.hotFlagUpdates.length).toBe(1);
    expect(captured.hotFlagUpdates[0].params).toEqual([900, ORG_ID]);

    // The dedupe ledger recorded the firing keyed user_rule:<id>.
    expect(captured.recordedRuns.length).toBe(1);
    // recordRun params: [orgId, rule, targetType, targetId, status, meta]
    expect(captured.recordedRuns[0].params[0]).toBe(ORG_ID);
    expect(captured.recordedRuns[0].params[1]).toBe('user_rule:42');
    expect(captured.recordedRuns[0].params[2]).toBe('deal');
    expect(captured.recordedRuns[0].params[3]).toBe(900);
  });
});

describe('evaluateUserRule — task_overdue + create_task', () => {
  test('creates a task for each overdue task target and records the run', async () => {
    const captured = installRoutingMock({
      taskScanRows: [{ id: 300, org_id: ORG_ID, user_id: 2, assigned_to: 3, deal_id: 88, title: 'Call back' }],
    });

    const rule = {
      id: 7, org_id: ORG_ID, created_by: 2,
      name: 'Escalate overdue', trigger: 'task_overdue',
      conditions: {}, action: { type: 'create_task', title: 'Follow up on overdue task', priority: 'high' }, enabled: true,
    };

    const res = await automation.evaluateUserRule(rule);

    expect(res.ok).toBe(true);
    expect(res.fired).toBe(1);
    expect(res.scanned).toBe(1);

    // The task scan is org-scoped.
    const scanIdx = captured.sql.findIndex(s => /FROM tasks t/i.test(s) && /NOT EXISTS/i.test(s));
    expect(captured.params[scanIdx][0]).toBe(ORG_ID);

    // A task was inserted (createTaskForOrg) with the rule's title/priority.
    expect(captured.taskInserts.length).toBe(1);
    const p = captured.taskInserts[0].params;
    // INSERT params: [ownerUserId, orgId, contact_id, deal_id, title, description, due_date, priority]
    expect(p[1]).toBe(ORG_ID);
    expect(p).toContain('Follow up on overdue task');
    expect(p).toContain('high');

    // Run recorded keyed user_rule:7 for the task target.
    expect(captured.recordedRuns.length).toBe(1);
    expect(captured.recordedRuns[0].params[1]).toBe('user_rule:7');
    expect(captured.recordedRuns[0].params[2]).toBe('task');
    expect(captured.recordedRuns[0].params[3]).toBe(300);
  });
});

describe('evaluateUserRule — dedupe + safety', () => {
  test('an empty scan (already-fired targets excluded by the NOT EXISTS anti-join) fires nothing', async () => {
    const captured = installRoutingMock({ dealScanRows: [] });

    const rule = {
      id: 5, org_id: ORG_ID, created_by: 1,
      name: 'Idle nudge', trigger: 'deal_idle_days',
      conditions: { days: 14 }, action: { type: 'set_hot_flag' }, enabled: true,
    };

    const res = await automation.evaluateUserRule(rule);

    expect(res.ok).toBe(true);
    expect(res.scanned).toBe(0);
    expect(res.fired).toBe(0);
    expect(captured.hotFlagUpdates.length).toBe(0);
    expect(captured.recordedRuns.length).toBe(0);

    // The scan carries the automation_runs NOT EXISTS anti-join keyed on the
    // per-rule dedupe key — this is what keeps a target from re-firing.
    const scan = captured.sql.find(s => /FROM deals d/i.test(s) && /NOT EXISTS/i.test(s));
    expect(scan).toMatch(/FROM automation_runs ar/i);
    expect(scan).toMatch(/ar\.rule\s*=\s*\$3/i);
  });

  test('a rule with invalid conditions is skipped, not fatal, and touches no tables', async () => {
    const captured = installRoutingMock({ dealScanRows: [{ id: 1, org_id: ORG_ID }] });

    const rule = {
      id: 9, org_id: ORG_ID, created_by: 1,
      name: 'Broken', trigger: 'deal_stage_is',
      conditions: {}, /* missing required `stage` */ action: { type: 'set_hot_flag' }, enabled: true,
    };

    const res = await automation.evaluateUserRule(rule);

    expect(res.ok).toBe(false);
    expect(res.skipped).toBe('invalid');
    expect(res.fired).toBe(0);
    // No scan / update / record issued for an invalid rule.
    expect(captured.hotFlagUpdates.length).toBe(0);
    expect(captured.recordedRuns.length).toBe(0);
  });

  test('org-scoping: the scan cannot target another org (org_id is the rule owner)', async () => {
    const captured = installRoutingMock({
      dealScanRows: [{ id: 900, org_id: OTHER_ORG, user_id: 1, title: 'X', stage: 'CLOSED_WON' }],
    });

    const rule = {
      id: 1, org_id: ORG_ID, created_by: 1,
      name: 'Scoped', trigger: 'deal_stage_is',
      conditions: { stage: 'CLOSED_WON' }, action: { type: 'set_hot_flag' }, enabled: true,
    };

    await automation.evaluateUserRule(rule);

    // Every scan issued is bound to the rule's own org_id, never a target row's.
    const scanIdx = captured.sql.findIndex(s => /FROM deals d/i.test(s) && /NOT EXISTS/i.test(s));
    expect(captured.params[scanIdx][0]).toBe(ORG_ID);
    // recordRun is also scoped to the rule's org, not the (spoofed) row org.
    expect(captured.recordedRuns[0].params[0]).toBe(ORG_ID);
  });
});

describe('runUserRules — loads and evaluates each org\'s enabled rules', () => {
  test('loads enabled automation_rules and evaluates them', async () => {
    const captured = installRoutingMock({
      enabledRules: [{
        id: 11, org_id: ORG_ID, created_by: 1, name: 'R', trigger: 'deal_stage_is',
        conditions: { stage: 'CLOSED_WON' }, action: { type: 'set_hot_flag' }, enabled: true,
      }],
      dealScanRows: [{ id: 900, org_id: ORG_ID, user_id: 1, title: 'Acme', stage: 'CLOSED_WON' }],
    });

    const results = await automation.runUserRules();

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(11);
    expect(results[0].fired).toBe(1);

    // It went through the enabled-rules loader.
    expect(captured.sql.some(s => /FROM automation_rules/i.test(s) && /enabled\s*=\s*TRUE/i.test(s))).toBe(true);
  });

  test('a missing automation_rules table degrades to no rules (pre-migration safety)', async () => {
    mockPool.query.mockImplementation((text) => {
      if (/FROM automation_rules/i.test(text)) {
        return Promise.reject(new Error('relation "automation_rules" does not exist'));
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const results = await automation.runUserRules();
    expect(results).toEqual([]);
  });
});
