// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// CS-3 — automation rule 'service_contract_renewal_at_risk' unit tests.
//
// This rule lives in services/automation.js and had ZERO coverage. It flips a
// service_contract's renewal_stage from 'upcoming' -> 'at_risk' when the
// contract is inside its renewal-notice window AND there has been no recent
// activity on its linked deal / customer. The activity check is org-scoped
// (a.org_id = sc.org_id, and the customer-deals subquery is d.org_id =
// sc.org_id) — this test locks in that security fix.
//
// RULES[] is not exported, so we exercise the rule through runAll(). The pg
// pool is fully mocked with a SQL-routing implementation: every other rule's
// scan SELECT resolves empty (so only the at_risk rule does any work), and the
// QuickBooks / email integrations are stubbed "not configured" so their rules
// early-return. We capture every SQL string issued so we can assert on the
// org-scoping predicates the rule generates.

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

// Patch the live pool instance (see auth.test.js / notification-dispatcher.test.js).
const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

// Quiet the logger so a rule warn() doesn't spam the test output.
vi.mock('../services/logger', () => ({
  info:   vi.fn(),
  warn:   vi.fn(),
  error:  vi.fn(),
  notice: vi.fn(),
  debug:  vi.fn(),
}));

// Force the QB + email rules to early-return ("not configured") so they issue
// no queries — keeps our SQL-routing mock focused on the rule under test.
const qbModule    = require('../services/quickbooks');
const emailModule = require('../services/email');
qbModule.isConfigured    = vi.fn(() => false);
emailModule.isConfigured = vi.fn(() => false);

const automation = require('../services/automation');

const ORG_ID = 7;

// --- SQL-routing mock -------------------------------------------------------
// Tracks every SQL string issued, the rows returned for the at_risk scan, the
// id list updated, and the rows inserted into automation_runs (the dedup
// ledger). `firedTargets` simulates a pre-existing automation_runs row so we
// can test the alreadyFired dedup path.

function installRoutingMock({ atRiskScanRows = [], firedTargets = new Set() } = {}) {
  const captured = {
    sql: [],
    updatedIds: [],
    recordedRuns: [],
  };

  mockPool.query.mockImplementation((text, params) => {
    captured.sql.push(text);

    // alreadyFired() — SELECT 1 FROM automation_runs WHERE rule=$1 ...
    if (/FROM automation_runs/i.test(text) && /SELECT 1/i.test(text)) {
      const [rule, targetType, targetId] = params;
      const key = `${rule}:${targetType}:${targetId}`;
      return Promise.resolve({ rows: firedTargets.has(key) ? [{ '?column?': 1 }] : [], rowCount: firedTargets.has(key) ? 1 : 0 });
    }

    // recordRun() — INSERT INTO automation_runs (...)
    if (/INSERT INTO automation_runs/i.test(text)) {
      captured.recordedRuns.push({ text, params });
      return Promise.resolve({ rows: [], rowCount: 1 });
    }

    // The at_risk rule's UPDATE.
    if (/UPDATE service_contracts SET renewal_stage = 'at_risk'/i.test(text)) {
      captured.updatedIds.push(params[0]);
      return Promise.resolve({ rows: [], rowCount: 1 });
    }

    // The at_risk rule's scan SELECT — identified by selecting renewal_notice_days
    // out of service_contracts AND filtering on renewal_stage='upcoming'.
    if (/FROM service_contracts sc/i.test(text) && /renewal_stage/i.test(text) && /NOT EXISTS/i.test(text)) {
      return Promise.resolve({ rows: atRiskScanRows, rowCount: atRiskScanRows.length });
    }

    // Every other rule's scan SELECT -> empty.
    return Promise.resolve({ rows: [], rowCount: 0 });
  });

  return captured;
}

// Pull the at_risk rule's result out of the runAll() summary.
function atRiskResult(summary) {
  return summary.rules.find(r => r.id === 'service_contract_renewal_at_risk');
}

beforeEach(() => {
  mockPool.query.mockReset();
});

describe("automation rule 'service_contract_renewal_at_risk'", () => {
  test('flips renewal_stage upcoming -> at_risk for a contract in the notice window with no recent activity', async () => {
    const captured = installRoutingMock({
      atRiskScanRows: [
        { id: 101, org_id: ORG_ID, user_id: 1, name: 'Acme MSA', end_date: '2026-07-10',
          renewal_notice_days: 30, customer_id: 55, deal_id: 900 },
      ],
    });

    const summary = await automation.runAll();
    const res = atRiskResult(summary);

    expect(res.ok).toBe(true);
    expect(res.fired).toBe(1);
    expect(res.scanned).toBe(1);

    // The UPDATE that performs the flip ran against the matched contract...
    expect(captured.updatedIds).toEqual([101]);
    // ...and it is guarded so it only flips a row still 'upcoming' (idempotent).
    const updateSql = captured.sql.find(s => /UPDATE service_contracts SET renewal_stage = 'at_risk'/i.test(s));
    expect(updateSql).toMatch(/COALESCE\(renewal_stage, 'upcoming'\) = 'upcoming'/i);

    // The dedup ledger recorded the firing for this contract.
    expect(captured.recordedRuns.length).toBe(1);
    const run = captured.recordedRuns[0];
    // INSERT params: [orgId, rule, targetType, targetId, status, meta]
    expect(run.params[0]).toBe(ORG_ID);
    expect(run.params[1]).toBe('service_contract_renewal_at_risk');
    expect(run.params[2]).toBe('service_contract');
    expect(run.params[3]).toBe(101);
  });

  test('the scan SELECT org-scopes the activity NOT EXISTS check and the customer-deals subquery', async () => {
    const captured = installRoutingMock({ atRiskScanRows: [] });

    await automation.runAll();

    const scanSql = captured.sql.find(s =>
      /FROM service_contracts sc/i.test(s) && /NOT EXISTS/i.test(s) && /renewal_stage/i.test(s));
    expect(scanSql).toBeDefined();

    // SECURITY: the recent-activity check must be org-scoped so an activity in a
    // different org cannot suppress a flip in this org.
    expect(scanSql).toMatch(/a\.org_id\s*=\s*sc\.org_id/i);

    // SECURITY: the customer's deals subquery must also be org-scoped so a deal
    // belonging to another org (even with a colliding customer_id) cannot be
    // treated as recent activity for this contract.
    expect(scanSql).toMatch(/d\.org_id\s*=\s*sc\.org_id/i);

    // And the activity recency join is on the contract's own deal / customer.
    expect(scanSql).toMatch(/a\.deal_id\s*=\s*sc\.deal_id/i);
    expect(scanSql).toMatch(/d\.customer_id\s*=\s*sc\.customer_id/i);
  });

  test('alreadyFired dedup prevents a second flip on a contract that already fired', async () => {
    // Pre-seed the dedup ledger so alreadyFired() returns a row for contract 101.
    const captured = installRoutingMock({
      atRiskScanRows: [
        { id: 101, org_id: ORG_ID, user_id: 1, name: 'Acme MSA', end_date: '2026-07-10',
          renewal_notice_days: 30, customer_id: 55, deal_id: 900 },
      ],
      firedTargets: new Set(['service_contract_renewal_at_risk:service_contract:101']),
    });

    const summary = await automation.runAll();
    const res = atRiskResult(summary);

    expect(res.ok).toBe(true);
    // The contract was scanned but the dedup guard suppressed the flip.
    expect(res.scanned).toBe(1);
    expect(res.fired).toBe(0);
    expect(captured.updatedIds).toEqual([]);     // no UPDATE issued
    expect(captured.recordedRuns.length).toBe(0); // nothing newly recorded
  });
});
