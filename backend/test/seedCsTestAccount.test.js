// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Unit tests for the CS e2e test-account seeder (services/seedCsTestAccount.js).
// The pg pool is fully mocked; bcryptjs.hash is stubbed so the test is fast and
// deterministic. We drive the new-user happy path by queuing pool responses in
// the order the seeder issues them, then assert the key writes.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

const bcrypt = require('bcryptjs');
const { ensureCsTestAccount } = require('../services/seedCsTestAccount');

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  mockPool.query.mockReset();
  vi.spyOn(bcrypt, 'hash').mockResolvedValue('$2a$12$stubbedhashvalueforunittttt');
  process.env = { ...ORIG_ENV };
  delete process.env.CS_E2E_SEED;
  delete process.env.CS_E2E_EMAIL;
  delete process.env.CS_E2E_PASSWORD;
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
});

describe('ensureCsTestAccount', () => {
  test('skips entirely when CS_E2E_SEED is not "true"', async () => {
    const res = await ensureCsTestAccount();
    expect(res.skipped).toMatch(/CS_E2E_SEED/);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('skips when password is missing or too short', async () => {
    process.env.CS_E2E_SEED = 'true';
    process.env.CS_E2E_PASSWORD = 'short';
    const res = await ensureCsTestAccount();
    expect(res.skipped).toMatch(/PASSWORD/);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('provisions a new password user + zang/CS org + seed data', async () => {
    process.env.CS_E2E_SEED = 'true';
    process.env.CS_E2E_EMAIL = 'CS-E2E@TheOpenCRM.com'; // mixed case -> lowercased
    process.env.CS_E2E_PASSWORD = 'aStrongTestPassword1';

    mockPool.query
      .mockResolvedValueOnce({ rows: [] })                 // 1 SELECT user by email -> none
      .mockResolvedValueOnce({ rows: [{ id: 4242 }] })     // 2 INSERT user RETURNING id
      .mockResolvedValueOnce({ rows: [{ id: 77 }] })       // 3 INSERT organizations RETURNING id
      .mockResolvedValueOnce({ rows: [] })                 // 4 UPDATE users set org_id
      .mockResolvedValueOnce({ rows: [] })                 // 5 SELECT company [cs-e2e] -> none
      .mockResolvedValueOnce({ rows: [{ id: 900 }] })      // 6 INSERT company RETURNING id
      .mockResolvedValueOnce({ rows: [] })                 // 7 SELECT deal [cs-e2e] -> none
      .mockResolvedValueOnce({ rows: [{ id: 500 }] })      // 8 INSERT deal RETURNING id
      .mockResolvedValueOnce({ rows: [] })                 // 9 INSERT activity
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })         // 10 COUNT service_contracts -> 0
      .mockResolvedValueOnce({ rows: [] })                 // 11 INSERT contract (upcoming)
      .mockResolvedValueOnce({ rows: [] });                // 12 INSERT contract (at_risk)

    const res = await ensureCsTestAccount();

    expect(res).toEqual({ email: 'cs-e2e@theopencrm.com', orgId: 77, companyId: 900 });

    const sqlOf = (i) => mockPool.query.mock.calls[i][0];
    const argsOf = (i) => mockPool.query.mock.calls[i][1];

    // User lookup is lowercased.
    expect(argsOf(0)[0]).toBe('cs-e2e@theopencrm.com');
    // New user inserted active + email-verified with the bcrypt hash.
    expect(sqlOf(1)).toMatch(/INSERT INTO users/);
    expect(sqlOf(1)).toMatch(/'active'/);
    expect(sqlOf(1)).toMatch(/TRUE/);
    expect(argsOf(1)[1]).toMatch(/^\$2[aby]\$/); // bcrypt hash shape
    // Org created on the zang profile with customer_success_enabled.
    expect(sqlOf(2)).toMatch(/INSERT INTO organizations/);
    expect(sqlOf(2)).toMatch(/'zang'/);
    expect(sqlOf(2)).toMatch(/customer_success_enabled/);
    // User linked to the new org as owner.
    expect(sqlOf(3)).toMatch(/UPDATE users SET org_id/);
    expect(argsOf(3)).toEqual([77, 4242]);
    // Two service contracts seeded in distinct renewal stages.
    expect(sqlOf(10)).toMatch(/INSERT INTO service_contracts/);
    expect(sqlOf(10)).toMatch(/'upcoming'/);
    expect(sqlOf(11)).toMatch(/'at_risk'/);
  });

  test('idempotent path: existing user refreshes password + ensures org flags', async () => {
    process.env.CS_E2E_SEED = 'true';
    process.env.CS_E2E_PASSWORD = 'aStrongTestPassword1';

    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 11, org_id: 77 }] }) // 1 SELECT user -> exists w/ org
      .mockResolvedValueOnce({ rows: [] })                       // 2 UPDATE users password/status
      .mockResolvedValueOnce({ rows: [] })                       // 3 UPDATE organizations features
      .mockResolvedValueOnce({ rows: [] })                       // 4 UPDATE users org_role
      .mockResolvedValueOnce({ rows: [{ id: 900 }] })            // 5 SELECT company -> exists
      .mockResolvedValueOnce({ rows: [{ id: 500 }] })            // 6 SELECT deal -> exists
      .mockResolvedValueOnce({ rows: [{ n: 2 }] });              // 7 COUNT contracts -> already 2

    const res = await ensureCsTestAccount();
    expect(res).toEqual({ email: 'cs-e2e@theopencrm.com', orgId: 77, companyId: 900 });
    // No new user/org/company/contract INSERTs on the idempotent path.
    const allSql = mockPool.query.mock.calls.map((c) => c[0]).join('\n');
    expect(allSql).not.toMatch(/INSERT INTO users/);
    expect(allSql).not.toMatch(/INSERT INTO organizations/);
    expect(allSql).toMatch(/UPDATE organizations[\s\S]*customer_success_enabled/);
  });
});
