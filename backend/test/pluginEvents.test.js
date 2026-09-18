// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Tests for services/pluginEvents.js — the plugin trigger engine
// (migration 164).
//
// Strategy: live-module stubs (same pattern as plugin-runner.test.js).
// pluginRunner.run is stubbed so no isolate spins; pool.query is routed by
// SQL shape; featureFlags.hasFeature and notifications.create are stubbed on
// the live modules.

// Opt back in past the NODE_ENV=test dispatch bypass (see pluginEvents.js).
process.env.PLUGIN_EVENTS_IN_TESTS = 'true';

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/logger', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), notice: vi.fn(), debug: vi.fn(),
}));

const featureFlags = require('../services/featureFlags');
featureFlags.hasFeature = vi.fn().mockResolvedValue(true);

const notifications = require('../services/notifications');
notifications.create = vi.fn().mockResolvedValue({ id: 1 });

const pluginRunner = require('../services/pluginRunner');
pluginRunner.run = vi.fn().mockResolvedValue({ ok: true, status: 'success', runId: 1 });

const pluginEvents = require('../services/pluginEvents');
const { PLUGIN_EVENTS, matchesTriggerFilter } = pluginEvents;
const { TRIGGER_EVENTS } = require('../services/pluginSpecValidator');

const ORG = 7;

// ---------------------------------------------------------------------------
// pool.query router. State knobs let each test vary the listener rows and
// the dedupe-claim behavior.
// ---------------------------------------------------------------------------
let listenerRows = [];
let claimedKeys; // Set emulating the plugin_trigger_dedupe PK (ON CONFLICT)
let failureStreakAfterIncrement = 1;
let pausedRows = [{ id: 1, name: 'My Plugin' }];
let adminRows = [{ id: 100 }, { id: 101 }];
let updates; // captured UPDATE plugins calls

function routePoolQuery(sql, params) {
  const text = String(sql).trim();
  if (/FROM plugins/i.test(text) && /trigger_event = \$2/i.test(text)) {
    return Promise.resolve({ rows: listenerRows });
  }
  if (/INSERT INTO plugin_trigger_dedupe/i.test(text)) {
    const key = `${params[0]}:${params[1]}`;
    if (claimedKeys.has(key)) return Promise.resolve({ rows: [] }); // conflict
    claimedKeys.add(key);
    return Promise.resolve({ rows: [{ plugin_id: params[0] }] });
  }
  if (/UPDATE plugins/i.test(text)) {
    updates.push({ text, params });
    if (/consecutive_trigger_failures \+ 1/i.test(text)) {
      return Promise.resolve({ rows: [{ consecutive_trigger_failures: failureStreakAfterIncrement, name: 'My Plugin' }] });
    }
    if (/SET status = \$3/i.test(text)) {
      return Promise.resolve({ rows: pausedRows });
    }
    return Promise.resolve({ rows: [] });
  }
  if (/FROM users/i.test(text)) {
    return Promise.resolve({ rows: adminRows });
  }
  return Promise.resolve({ rows: [] });
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.query.mockImplementation(routePoolQuery);
  featureFlags.hasFeature.mockReset();
  featureFlags.hasFeature.mockResolvedValue(true);
  notifications.create.mockClear();
  pluginRunner.run.mockReset();
  pluginRunner.run.mockResolvedValue({ ok: true, status: 'success', runId: 1 });
  listenerRows = [{ id: 1, name: 'My Plugin', trigger_filter_json: null }];
  claimedKeys = new Set();
  failureStreakAfterIncrement = 1;
  pausedRows = [{ id: 1, name: 'My Plugin' }];
  adminRows = [{ id: 100 }, { id: 101 }];
  updates = [];
  delete process.env.PLUGIN_RUNTIME_DISABLED;
});

// ---------------------------------------------------------------------------
// Taxonomy contract
// ---------------------------------------------------------------------------
describe('PLUGIN_EVENTS taxonomy', () => {
  test('every dispatched event name is accepted by the authoring allowlist', () => {
    for (const name of Object.values(PLUGIN_EVENTS)) {
      expect(TRIGGER_EVENTS).toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// matchesTriggerFilter
// ---------------------------------------------------------------------------
describe('matchesTriggerFilter', () => {
  test('null / empty / malformed filters match everything', () => {
    expect(matchesTriggerFilter(null, { a: 1 })).toBe(true);
    expect(matchesTriggerFilter(undefined, {})).toBe(true);
    expect(matchesTriggerFilter({}, { a: 1 })).toBe(true);
    expect(matchesTriggerFilter('garbage', { a: 1 })).toBe(true);
  });

  test('simple field equality — loose string comparison, AND semantics', () => {
    expect(matchesTriggerFilter({ stage: 'closed_won' }, { stage: 'closed_won' })).toBe(true);
    expect(matchesTriggerFilter({ stage: 'closed_won' }, { stage: 'lead' })).toBe(false);
    expect(matchesTriggerFilter({ company_id: 5 }, { company_id: '5' })).toBe(true);
    expect(matchesTriggerFilter({ stage: 'x', priority: 'high' }, { stage: 'x', priority: 'low' })).toBe(false);
  });

  test('null filter values match only null/missing payload fields', () => {
    expect(matchesTriggerFilter({ company_id: null }, { company_id: null })).toBe(true);
    expect(matchesTriggerFilter({ company_id: null }, {})).toBe(true);
    expect(matchesTriggerFilter({ company_id: null }, { company_id: 3 })).toBe(false);
  });

  test('non-primitive filter values fail closed', () => {
    expect(matchesTriggerFilter({ tags: ['a'] }, { tags: ['a'] })).toBe(false);
    expect(matchesTriggerFilter({ nested: { a: 1 } }, { nested: { a: 1 } })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// emit dispatch behavior
// ---------------------------------------------------------------------------
describe('emit', () => {
  test('runs active listeners for the org with a trigger-shaped input', async () => {
    const r = await pluginEvents.emit(ORG, 'deal.created', { id: 42, title: 'Big deal', stage: 'lead' });
    expect(r.dispatched).toBe(1);
    expect(pluginRunner.run).toHaveBeenCalledTimes(1);
    const args = pluginRunner.run.mock.calls[0][0];
    expect(args).toMatchObject({
      pluginId: 1,
      orgId: ORG,
      triggerKind: 'event',
      triggerSource: 'deal.created',
    });
    expect(args.input.trigger).toMatchObject({ event: 'deal.created', id: 42, title: 'Big deal' });
    // listener lookup was scoped to (org, event, status='active')
    const sel = mockPool.query.mock.calls.find(([sql]) => /FROM plugins/i.test(sql) && /trigger_event/i.test(sql));
    expect(sel[0]).toMatch(/status = 'active'/);
    expect(sel[1]).toEqual([ORG, 'deal.created']);
  });

  test('skips dispatch entirely when plugins_enabled is off for the org', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    const r = await pluginEvents.emit(ORG, 'deal.created', { id: 42 });
    expect(r.skipped).toBe('plugins_disabled');
    expect(pluginRunner.run).not.toHaveBeenCalled();
    // never even queried the plugins table
    expect(mockPool.query.mock.calls.some(([sql]) => /FROM plugins/i.test(sql))).toBe(false);
  });

  test('platform kill switch short-circuits before any DB work', async () => {
    process.env.PLUGIN_RUNTIME_DISABLED = '1';
    const r = await pluginEvents.emit(ORG, 'deal.created', { id: 42 });
    expect(r.skipped).toBe('runtime_disabled');
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('trigger_filter_json gates dispatch per plugin', async () => {
    listenerRows = [
      { id: 1, name: 'won-only', trigger_filter_json: { stage: 'closed_won' } },
      { id: 2, name: 'all-deals', trigger_filter_json: null },
    ];
    const r = await pluginEvents.emit(ORG, 'deal.stage_changed', { id: 9, stage: 'lead', prev_stage: 'x' },
      { dedupeKey: 'deal.stage_changed:9:x->lead' });
    expect(r.dispatched).toBe(1);
    expect(pluginRunner.run).toHaveBeenCalledTimes(1);
    expect(pluginRunner.run.mock.calls[0][0].pluginId).toBe(2);
  });

  test('dedupe: the same logical event never runs the same plugin twice', async () => {
    const first = await pluginEvents.emit(ORG, 'deal.created', { id: 42 });
    const second = await pluginEvents.emit(ORG, 'deal.created', { id: 42 });
    expect(first.dispatched).toBe(1);
    expect(second.dispatched).toBe(0);
    expect(pluginRunner.run).toHaveBeenCalledTimes(1);
    // a different entity still fires
    await pluginEvents.emit(ORG, 'deal.created', { id: 43 });
    expect(pluginRunner.run).toHaveBeenCalledTimes(2);
  });

  test('a dedupe-claim DB error fails closed (skips the run, never throws)', async () => {
    mockPool.query.mockImplementation((sql, params) => {
      if (/INSERT INTO plugin_trigger_dedupe/i.test(String(sql))) {
        return Promise.reject(new Error('dedupe table on fire'));
      }
      return routePoolQuery(sql, params);
    });
    const r = await pluginEvents.emit(ORG, 'deal.created', { id: 42 });
    expect(r.dispatched).toBe(0);
    expect(pluginRunner.run).not.toHaveBeenCalled();
  });

  test('NEVER fails the calling write: a throwing dispatch resolves quietly', async () => {
    mockPool.query.mockRejectedValue(new Error('database exploded'));
    featureFlags.hasFeature.mockRejectedValue(new Error('flags exploded'));
    await expect(pluginEvents.emit(ORG, 'deal.created', { id: 42 }))
      .resolves.toMatchObject({ dispatched: 0 });
  });

  test('a throwing pluginRunner.run is contained per plugin', async () => {
    listenerRows = [
      { id: 1, name: 'boom', trigger_filter_json: null },
      { id: 2, name: 'fine', trigger_filter_json: null },
    ];
    pluginRunner.run
      .mockRejectedValueOnce(new Error('isolate exploded'))
      .mockResolvedValueOnce({ ok: true, status: 'success' });
    const r = await pluginEvents.emit(ORG, 'deal.created', { id: 42 });
    // plugin 1's failure didn't stop plugin 2
    expect(pluginRunner.run).toHaveBeenCalledTimes(2);
    expect(r.results.find((x) => x.pluginId === 2).ok).toBe(true);
  });

  test('NODE_ENV=test bypass: emit no-ops unless the suite opts in', async () => {
    delete process.env.PLUGIN_EVENTS_IN_TESTS;
    try {
      const r = await pluginEvents.emit(ORG, 'deal.created', { id: 42 });
      expect(r.skipped).toBe('test_env');
      expect(mockPool.query).not.toHaveBeenCalled();
      expect(pluginRunner.run).not.toHaveBeenCalled();
    } finally {
      process.env.PLUGIN_EVENTS_IN_TESTS = 'true';
    }
  });

  test('bad args are a no-op', async () => {
    expect((await pluginEvents.emit(null, 'deal.created', { id: 1 })).skipped).toBe('bad_args');
    expect((await pluginEvents.emit(ORG, '', { id: 1 })).skipped).toBe('bad_args');
    expect(pluginRunner.run).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Trigger outcome bookkeeping: liveness, streak, auto-pause
// ---------------------------------------------------------------------------
describe('trigger outcome bookkeeping', () => {
  test('a successful triggered run stamps last_triggered_at and resets the streak', async () => {
    await pluginEvents.emit(ORG, 'deal.created', { id: 42 });
    const reset = updates.find((u) => /consecutive_trigger_failures = 0/i.test(u.text));
    expect(reset).toBeTruthy();
    expect(reset.text).toMatch(/last_triggered_at = NOW\(\)/i);
    expect(reset.params).toEqual([1, ORG]);
  });

  test('an execution failure increments the streak but does not pause below the threshold', async () => {
    pluginRunner.run.mockResolvedValue({ ok: false, status: 'timeout' });
    failureStreakAfterIncrement = 3;
    await pluginEvents.emit(ORG, 'deal.created', { id: 42 });
    expect(updates.some((u) => /consecutive_trigger_failures \+ 1/i.test(u.text))).toBe(true);
    expect(updates.some((u) => /SET status = \$3/i.test(u.text))).toBe(false);
    expect(notifications.create).not.toHaveBeenCalled();
  });

  test('the 5th consecutive failure auto-pauses the plugin and notifies every org admin', async () => {
    pluginRunner.run.mockResolvedValue({ ok: false, status: 'error', error: 'boom' });
    failureStreakAfterIncrement = 5;
    await pluginEvents.emit(ORG, 'deal.created', { id: 42 });
    const pause = updates.find((u) => /SET status = \$3/i.test(u.text));
    expect(pause).toBeTruthy();
    expect(pause.params).toEqual([1, ORG, 'errored']);
    // only pauses a still-active plugin (idempotent vs concurrent pause)
    expect(pause.text).toMatch(/status = 'active'/);
    expect(notifications.create).toHaveBeenCalledTimes(2);
    expect(notifications.create.mock.calls[0][0]).toMatchObject({
      orgScope: ['org_id', ORG],
      userId: 100,
      type: 'plugin_auto_paused',
      link: '/plugins/1',
    });
  });

  test('environmental outcomes (quota / concurrency) are streak-neutral', async () => {
    pluginRunner.run.mockResolvedValue({ ok: false, status: 'quota_exceeded' });
    await pluginEvents.emit(ORG, 'deal.created', { id: 42 });
    expect(updates.some((u) => /consecutive_trigger_failures \+ 1/i.test(u.text))).toBe(false);
    expect(updates.some((u) => /consecutive_trigger_failures = 0/i.test(u.text))).toBe(false);
    // liveness still stamped
    expect(updates.some((u) => /last_triggered_at = NOW\(\)/i.test(u.text))).toBe(true);
  });
});
