// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Tests for services/pluginScheduleWorker.js (migration 164) — the leased
// tick that fires 'schedule.hourly' / 'schedule.daily' plugin triggers.
//
// pluginRunner.run is stubbed; the dedupe table is emulated by a Set so the
// once-per-day / once-per-hour guarantees run through the REAL
// pluginEvents.runTriggeredPlugin claim path.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/logger', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), notice: vi.fn(), debug: vi.fn(),
}));

const workerLease = require('../services/workerLease');
workerLease.claim = vi.fn().mockResolvedValue(true);
workerLease.release = vi.fn().mockResolvedValue(undefined);

const featureFlags = require('../services/featureFlags');
featureFlags.hasFeature = vi.fn().mockResolvedValue(true);

const pluginRunner = require('../services/pluginRunner');
pluginRunner.run = vi.fn().mockResolvedValue({ ok: true, status: 'success', runId: 1 });

const worker = require('../services/pluginScheduleWorker');

let scheduledRows = [];
let claimedKeys;

function routePoolQuery(sql, params) {
  const text = String(sql).trim();
  if (/FROM plugins/i.test(text) && /schedule\.hourly/i.test(text)) {
    return Promise.resolve({ rows: scheduledRows });
  }
  if (/INSERT INTO plugin_trigger_dedupe/i.test(text)) {
    const key = `${params[0]}:${params[1]}`;
    if (claimedKeys.has(key)) return Promise.resolve({ rows: [] });
    claimedKeys.add(key);
    return Promise.resolve({ rows: [{ plugin_id: params[0] }] });
  }
  if (/DELETE FROM plugin_trigger_dedupe/i.test(text)) {
    return Promise.resolve({ rows: [] });
  }
  // outcome bookkeeping UPDATEs on plugins
  return Promise.resolve({ rows: [] });
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.query.mockImplementation(routePoolQuery);
  workerLease.claim.mockReset();
  workerLease.claim.mockResolvedValue(true);
  workerLease.release.mockClear();
  featureFlags.hasFeature.mockReset();
  featureFlags.hasFeature.mockResolvedValue(true);
  pluginRunner.run.mockReset();
  pluginRunner.run.mockResolvedValue({ ok: true, status: 'success', runId: 1 });
  scheduledRows = [];
  claimedKeys = new Set();
});

const NOON = new Date('2026-09-17T12:10:00Z');
const ONE_PM = new Date('2026-09-17T13:10:00Z');

describe('pluginScheduleWorker.tick', () => {
  test('lease not won → skip without dispatching', async () => {
    workerLease.claim.mockResolvedValue(false);
    scheduledRows = [{ id: 1, name: 'daily', org_id: 7, trigger_event: 'schedule.daily' }];
    const r = await worker.tick({ now: NOON });
    expect(r.skipped).toBe(true);
    expect(pluginRunner.run).not.toHaveBeenCalled();
  });

  test('daily plugin fires with a { trigger: { event, date } } input and trigger_kind schedule', async () => {
    scheduledRows = [{ id: 1, name: 'daily', org_id: 7, trigger_event: 'schedule.daily' }];
    const r = await worker.tick({ now: NOON });
    expect(r.dispatched).toBe(1);
    const args = pluginRunner.run.mock.calls[0][0];
    expect(args).toMatchObject({
      pluginId: 1,
      orgId: 7,
      triggerKind: 'schedule',
      triggerSource: 'schedule.daily',
    });
    expect(args.input.trigger).toEqual({ event: 'schedule.daily', date: '2026-09-17' });
  });

  test('schedule.daily fires ONCE per day even across multiple hourly ticks', async () => {
    scheduledRows = [{ id: 1, name: 'daily', org_id: 7, trigger_event: 'schedule.daily' }];
    workerLease.claim.mockResolvedValue(true);
    await worker.tick({ now: NOON });
    await worker.tick({ now: ONE_PM }); // later hour, same UTC day
    expect(pluginRunner.run).toHaveBeenCalledTimes(1);
    // next day it fires again
    await worker.tick({ now: new Date('2026-09-18T00:10:00Z') });
    expect(pluginRunner.run).toHaveBeenCalledTimes(2);
  });

  test('schedule.hourly fires once per hour bucket', async () => {
    scheduledRows = [{ id: 2, name: 'hourly', org_id: 7, trigger_event: 'schedule.hourly' }];
    await worker.tick({ now: NOON });
    await worker.tick({ now: new Date('2026-09-17T12:40:00Z') }); // same hour
    expect(pluginRunner.run).toHaveBeenCalledTimes(1);
    await worker.tick({ now: ONE_PM }); // next hour
    expect(pluginRunner.run).toHaveBeenCalledTimes(2);
    expect(pluginRunner.run.mock.calls[1][0].input.trigger).toEqual({
      event: 'schedule.hourly', date: '2026-09-17', hour: '2026-09-17T13',
    });
  });

  test('orgs with plugins_enabled off are skipped', async () => {
    scheduledRows = [
      { id: 1, name: 'a', org_id: 7, trigger_event: 'schedule.daily' },
      { id: 2, name: 'b', org_id: 8, trigger_event: 'schedule.daily' },
    ];
    featureFlags.hasFeature.mockImplementation(async (orgId) => orgId === 8);
    const r = await worker.tick({ now: NOON });
    expect(r.dispatched).toBe(1);
    expect(pluginRunner.run).toHaveBeenCalledTimes(1);
    expect(pluginRunner.run.mock.calls[0][0].orgId).toBe(8);
  });

  test('a thrown tick releases the lease so the period can retry', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (/FROM plugins/i.test(String(sql))) return Promise.reject(new Error('db down'));
      return Promise.resolve({ rows: [] });
    });
    const r = await worker.tick({ now: NOON });
    expect(r.error).toBe('db down');
    expect(workerLease.release).toHaveBeenCalledWith(worker.WORKER_NAME, '2026-09-17T12');
  });
});
