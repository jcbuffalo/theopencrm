// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// CS-2 — account-health snapshot worker + pure scoring tests.
//
// Two concerns covered here:
//   • services/accountHealthWorker.js tick() — recomputes + INSERTs a snapshot
//     row per active account, is org-scoped, and is idempotent (skips an org
//     already snapshotted today).
//   • services/accountHealth.js scoreAccount() — pure boundary tests:
//     clearly-green, clearly-red, and a middle yellow signal set.
//
// Postgres is fully mocked (no real DB): we patch the live pool's .query and
// queue responses in the exact order the worker issues them. featureFlags is
// stubbed via vi.spyOn rather than the pool.
//
// Query order inside tick() for ONE active, feature-on org that is NOT yet
// snapshotted today and has ONE account:
//   1. activeOrgIds()            — SELECT DISTINCT org_id FROM deals ...
//   2. hasFeature(org, flag)     — STUBBED (not a pool query)
//   3. alreadySnapshottedToday() — SELECT 1 FROM account_health_snapshots ...
//   4. computeForOrg()           — WITH accounts ... (one big rollup query)
//   5. per account: INSERT INTO account_health_snapshots ...

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const featureFlags  = require('../services/featureFlags');
const accountHealth = require('../services/accountHealth');
const workerLease   = require('../services/workerLease');
const worker        = require('../services/accountHealthWorker');

const ORG_ID  = 7;
const OTHER_ORG = 99;

beforeEach(() => {
  mockPool.query.mockReset();
  // Default: feature on for any org. Individual tests override.
  vi.spyOn(featureFlags, 'hasFeature').mockResolvedValue(true);
  // The cross-instance claim (migration 098 lease) is exercised in
  // workerLease.test.js; here we spy it to won so the pool.query sequence the
  // per-test mocks queue stays exactly as before (claim won't hit the pool).
  vi.spyOn(workerLease, 'claim').mockResolvedValue(true);
  vi.spyOn(workerLease, 'release').mockResolvedValue(undefined);
});

// A single account rollup row as computeForOrg's big query would return it.
// last_touch ~5 days ago, no issues / renewals / at-risk deals => clearly green.
function greenAccountRow(companyId, now) {
  const fiveDaysAgo = new Date(now.getTime() - 5 * 86400000);
  return {
    company_id: companyId,
    last_touch: fiveDaysAgo.toISOString(),
    open_blocking_issues: 0,
    open_red_issues: 0,
    next_renewal_date: null,
    at_risk_open_deals: 0,
    open_deals: 1,
    emails_sent_30d: 0,
    emails_opened_30d: 0,
  };
}

describe('accountHealthWorker.tick()', () => {
  test('writes a snapshot row (score+band) per active account, org-scoped', async () => {
    const now = new Date('2026-06-23T12:00:00.000Z');

    // 1. activeOrgIds — one active org.
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] });
    // 3. alreadySnapshottedToday — not yet today.
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // 4. computeForOrg — one account.
    mockPool.query.mockResolvedValueOnce({ rows: [greenAccountRow(101, now)] });
    // 5. INSERT account_health_snapshots.
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const out = await worker.tick({ now });

    expect(out).toEqual({ orgs: 1, snapshots: 1 });

    // Find the INSERT call.
    const insertCall = mockPool.query.mock.calls.find((c) =>
      /INSERT INTO account_health_snapshots/i.test(c[0])
    );
    expect(insertCall).toBeDefined();

    // It is org-scoped: org_id is the first bound param.
    const params = insertCall[1];
    expect(params[0]).toBe(ORG_ID);          // org_id
    expect(params[1]).toBe(101);             // company_id
    // score is a number in [0,100]; green band for this row.
    expect(typeof params[2]).toBe('number');
    expect(params[2]).toBeGreaterThanOrEqual(0);
    expect(params[2]).toBeLessThanOrEqual(100);
    expect(params[3]).toBe('green');
    // signals serialized as JSON.
    expect(typeof params[4]).toBe('string');
    expect(JSON.parse(params[4])).toHaveProperty('inputs');

    // The activeOrgIds query and the computeForOrg query both scope by org_id.
    const orgIdsCall = mockPool.query.mock.calls[0];
    expect(orgIdsCall[0]).toMatch(/SELECT DISTINCT org_id FROM deals/i);
    const computeCall = mockPool.query.mock.calls.find((c) => /WITH accounts AS/i.test(c[0]));
    expect(computeCall).toBeDefined();
    expect(computeCall[0]).toMatch(/org_id = \$1/);   // org-scoped, not user-scoped
    expect(computeCall[1][0]).toBe(ORG_ID);           // scope value is the org id
  });

  test('is idempotent — skips an org already snapshotted today (no INSERT)', async () => {
    const now = new Date('2026-06-23T12:00:00.000Z');

    // 1. activeOrgIds — one active org.
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] });
    // 3. alreadySnapshottedToday — ALREADY snapshotted today (row present).
    mockPool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

    const out = await worker.tick({ now });

    expect(out).toEqual({ orgs: 0, snapshots: 0 });

    // No INSERT, and computeForOrg never ran.
    const insertCall = mockPool.query.mock.calls.find((c) =>
      /INSERT INTO account_health_snapshots/i.test(c[0])
    );
    expect(insertCall).toBeUndefined();
    const computeCall = mockPool.query.mock.calls.find((c) => /WITH accounts AS/i.test(c[0]));
    expect(computeCall).toBeUndefined();
  });

  test('skips an org without the customer_success_enabled feature', async () => {
    const now = new Date('2026-06-23T12:00:00.000Z');
    featureFlags.hasFeature.mockResolvedValue(false);

    // 1. activeOrgIds — one active org (feature off).
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: OTHER_ORG }] });

    const out = await worker.tick({ now });

    expect(out).toEqual({ orgs: 0, snapshots: 0 });
    // hasFeature short-circuits before any further pool query.
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });
});

describe('accountHealth.scoreAccount() boundaries', () => {
  test('clearly-green: recent touch, no negative signals => high score, green', () => {
    const { score, band } = accountHealth.scoreAccount({
      daysSinceLastTouch: 3,
      openBlockingIssues: 0,
      openRedIssues: 0,
      daysToNextRenewal: 365,
      atRiskOpenDeals: 0,
      openDeals: 2,
      emailsSent30d: 4,
      emailsOpened30d: 3,
    });
    expect(score).toBe(100);
    expect(band).toBe('green');
    expect(score).toBeGreaterThanOrEqual(accountHealth.GREEN_MIN);
  });

  test('clearly-red: stale, blocking + red issues, near renewal, at-risk deals, cold email', () => {
    const { score, band } = accountHealth.scoreAccount({
      daysSinceLastTouch: 120,   // -30
      openBlockingIssues: 3,     // -30 (capped)
      openRedIssues: 3,          // -20 (capped)
      daysToNextRenewal: 10,     // -15
      atRiskOpenDeals: 3,        // -24 (capped)
      openDeals: 5,
      emailsSent30d: 6,          // -10 (0 opens)
      emailsOpened30d: 0,
    });
    // Penalties far exceed 100; clamps to 0.
    expect(score).toBe(0);
    expect(band).toBe('red');
    expect(score).toBeLessThan(accountHealth.YELLOW_MIN);
  });

  test('middle yellow: a moderate set of signals lands in [40,70)', () => {
    // 100 - 20 (touch >60d) - 15 (1 blocking) - 5 (renewal <90d) = 60 => yellow.
    const { score, band } = accountHealth.scoreAccount({
      daysSinceLastTouch: 75,    // -20
      openBlockingIssues: 1,     // -15
      openRedIssues: 0,
      daysToNextRenewal: 60,     // -5
      atRiskOpenDeals: 0,
      openDeals: 1,
      emailsSent30d: 0,
      emailsOpened30d: 0,
    });
    expect(score).toBe(60);
    expect(band).toBe('yellow');
    expect(score).toBeGreaterThanOrEqual(accountHealth.YELLOW_MIN);
    expect(score).toBeLessThan(accountHealth.GREEN_MIN);
  });
});
