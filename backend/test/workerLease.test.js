// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// workerLease — cross-instance run-claim primitive (migration 098).
// Locks in the contract the aiBilling and weeklySummary workers now depend on:
// the first caller to claim a (worker, period) gets true, everyone else false.

// describe / test / expect / vi are global (vitest, globals: true).

// Let the real db.js load, then overwrite its query method on the live pool
// (every service does `const pool = require('../db')`, so they share it).
const realPool = require('../db');
realPool.query = vi.fn();

const workerLease = require('../services/workerLease');

beforeEach(() => {
  realPool.query.mockReset();
});

describe('workerLease.claim', () => {
  test('returns true when the INSERT wins (row returned)', async () => {
    realPool.query.mockResolvedValueOnce({ rows: [{ claimed_at: new Date() }] });
    const won = await workerLease.claim('ai_billing', '2026-07');
    expect(won).toBe(true);
  });

  test('returns false when the row already exists (ON CONFLICT DO NOTHING → no row)', async () => {
    realPool.query.mockResolvedValueOnce({ rows: [] });
    const won = await workerLease.claim('ai_billing', '2026-07');
    expect(won).toBe(false);
  });

  test('claims with an atomic INSERT ... ON CONFLICT DO NOTHING RETURNING and the right params', async () => {
    realPool.query.mockResolvedValueOnce({ rows: [{ claimed_at: new Date() }] });
    await workerLease.claim('weekly_summary', '2026-W27');

    expect(realPool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = realPool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO worker_runs/i);
    expect(sql).toMatch(/ON CONFLICT \(worker, period_key\) DO NOTHING/i);
    expect(sql).toMatch(/RETURNING/i);
    expect(params).toEqual(['weekly_summary', '2026-W27']);
  });
});

describe('workerLease.release', () => {
  test('deletes exactly the claimed (worker, period) row', async () => {
    realPool.query.mockResolvedValueOnce({ rowCount: 1 });
    await workerLease.release('ai_billing', '2026-07');

    const [sql, params] = realPool.query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM worker_runs/i);
    expect(sql).toMatch(/worker = \$1 AND period_key = \$2/i);
    expect(params).toEqual(['ai_billing', '2026-07']);
  });
});
