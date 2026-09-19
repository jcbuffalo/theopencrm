// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// My Day work-queue — GET /api/my-day smoke tests.
//
// Mounts myDayRoutes against a tiny Express app (mirrors accountsList.test.js).
// The pg pool is fully mocked: each pool.query call resolves the next queued
// response, in the order the route issues them.
//
// Query order for GET / :
//   1. authMiddleware — SELECT org_id, org_role, status FROM users
//   2. tasksDue       — my open tasks due today/overdue
//   3. renewals       — active service contracts ending within 30 days
//   4. atRiskAccounts — customer companies with lifecycle_stage='at_risk'
//   5. quietAccounts  — customer companies with no touch in > 30 days
//   6. dealsNeedingAttention — open deals past close date / gone cold
//   7. has_data       — deals / contacts / companies row counts (one query)
//   8. nextSteps      — open deals whose next_step_date is today/overdue
//                       (migration 172; runs last so 1–7 keep their order)
//
// Asserts: 200 shape + counts, org-scoping (scope value threaded into every
// query), user-scoping of tasksDue, and section-level resilience (a missing
// customer-success table degrades that section to [] instead of a 500).

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const myDayRoutes = require('../routes/myDayRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/my-day', myDayRoutes);
  return app;
}

const USER_ID = 4242;
const ORG_ID = 7;
const DAY_MS = 86400000;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function daysAgoISO(n) {
  return new Date(Date.now() - n * DAY_MS).toISOString();
}
function daysAgoDate(n) {
  return new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
}
function daysAheadDate(n) {
  return new Date(Date.now() + n * DAY_MS).toISOString().slice(0, 10);
}

function mockAuth() {
  mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
}

beforeEach(() => {
  mockPool.query.mockReset();
});

describe('GET /my-day', () => {
  test('returns the aggregated work-queue with counts, org- and user-scoped', async () => {
    mockAuth();
    // 2. tasksDue — one overdue task.
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 11, title: 'Call Acme about the PO', description: null,
        due_date: daysAgoDate(3), status: 'open', priority: 'high',
        deal_id: 5, contact_id: null, deal_title: 'Acme Q3', contact_name: null,
      }],
    });
    // 3. renewals — one contract ending in ~12 days.
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 21, name: 'Acme Support Plan', customer_id: 1, end_date: daysAheadDate(12),
        status: 'active', monthly_amount: '250.00', days_to_end: 12, customer_name: 'Acme Co',
      }],
    });
    // 4. atRiskAccounts.
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 3, name: 'Cirrus Inc', industry: 'SaaS', status: 'active', lifecycle_stage: 'at_risk' }],
    });
    // 5. quietAccounts — one touched 65 days ago, one never touched.
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 2, name: 'Bravo LLC', industry: null, lifecycle_stage: 'active', last_touch: null },
        { id: 3, name: 'Cirrus Inc', industry: 'SaaS', lifecycle_stage: 'at_risk', last_touch: daysAgoISO(65) },
      ],
    });
    // 6. dealsNeedingAttention — past close date + last activity 20 days ago.
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 5, title: 'Acme Q3', stage: 'NEGOTIATION', phase: 'pre_sale', amount: '15000.00',
        expected_close_date: daysAgoDate(4), company_name: 'Acme Co', customer_name: null,
        last_activity: daysAgoISO(20),
      }],
    });
    // 7. has_data — row counts.
    mockPool.query.mockResolvedValueOnce({ rows: [{ deals: 4, contacts: 9, companies: 2 }] });
    // 8. nextSteps (migration 172) — one overdue committed next step.
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 8, title: 'Bravo renewal', stage: 'PROPOSAL', deal_type: 'default', amount: '9000.00',
        next_step: 'Send revised quote to Dana', next_step_date: daysAgoDate(2),
        company_name: 'Bravo LLC', contact_name: 'Dana Reyes',
      }],
    });

    const res = await request(buildApp())
      .get('/my-day')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);

    // Org-scoping: every section query is parameterized on the org scope value.
    const calls = mockPool.query.mock.calls;
    expect(calls).toHaveLength(8);
    for (let i = 1; i < 8; i++) {
      expect(calls[i][1][0]).toBe(ORG_ID);
    }
    // nextSteps runs LAST (after has_data) and only pulls dated, open deals.
    expect(calls[7][0]).toMatch(/next_step_date <= CURRENT_DATE/);
    expect(calls[7][0]).toMatch(/d\.stage NOT IN/);
    expect(res.body.nextSteps).toHaveLength(1);
    expect(res.body.nextSteps[0].next_step).toBe('Send revised quote to Dana');
    expect(res.body.nextSteps[0].overdue_days).toBeGreaterThanOrEqual(1);
    // has_data is one round-trip, org-scoped on all three tables.
    expect(calls[6][0]).toMatch(/FROM deals\s+WHERE org_id = \$1/);
    expect(calls[6][0]).toMatch(/FROM contacts\s+WHERE org_id = \$1/);
    expect(calls[6][0]).toMatch(/FROM companies WHERE org_id = \$1/);
    expect(res.body.has_data).toEqual({ deals: 4, contacts: 9, companies: 2 });
    // User-scoping: the tasksDue query also threads the requesting user's id.
    expect(calls[1][1]).toEqual([ORG_ID, USER_ID]);
    expect(calls[1][0]).toMatch(/assigned_to = \$2/);

    // Sections + derived fields.
    expect(res.body.tasksDue).toHaveLength(1);
    expect(res.body.tasksDue[0].title).toBe('Call Acme about the PO');
    expect(res.body.tasksDue[0].overdue_days).toBeGreaterThanOrEqual(2);

    expect(res.body.renewals).toHaveLength(1);
    expect(res.body.renewals[0].customer_name).toBe('Acme Co');

    expect(res.body.atRiskAccounts).toHaveLength(1);
    expect(res.body.atRiskAccounts[0].lifecycle_stage).toBe('at_risk');

    expect(res.body.quietAccounts).toHaveLength(2);
    const bravo = res.body.quietAccounts.find((a) => a.id === 2);
    expect(bravo.days_since_last_touch).toBe(null);
    const cirrus = res.body.quietAccounts.find((a) => a.id === 3);
    expect(cirrus.days_since_last_touch).toBe(65);

    expect(res.body.dealsNeedingAttention).toHaveLength(1);
    expect(res.body.dealsNeedingAttention[0].past_close_date).toBe(true);
    expect(res.body.dealsNeedingAttention[0].days_since_last_activity).toBe(20);

    // Counts rollup.
    expect(res.body.counts).toEqual({
      tasksDue: 1,
      renewals: 1,
      atRiskAccounts: 1,
      quietAccounts: 2,
      dealsNeedingAttention: 1,
      nextSteps: 1,
      total: 7,
    });
  });

  test('a missing customer-success source degrades to [] instead of a 500', async () => {
    mockAuth();
    // 2. tasksDue — fine.
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // 3. renewals — service_contracts table missing (42P01 undefined_table).
    mockPool.query.mockRejectedValueOnce(Object.assign(new Error('relation "service_contracts" does not exist'), { code: '42P01' }));
    // 4. atRiskAccounts — lifecycle_stage column missing on an older DB.
    mockPool.query.mockRejectedValueOnce(Object.assign(new Error('column "lifecycle_stage" does not exist'), { code: '42703' }));
    // 5. quietAccounts — fine.
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // 6. dealsNeedingAttention — fine.
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // 7. has_data — count fails (e.g. companies table missing) → null, not a 500.
    mockPool.query.mockRejectedValueOnce(Object.assign(new Error('relation "companies" does not exist'), { code: '42P01' }));

    const res = await request(buildApp())
      .get('/my-day')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.renewals).toEqual([]);
    expect(res.body.atRiskAccounts).toEqual([]);
    expect(res.body.tasksDue).toEqual([]);
    expect(res.body.quietAccounts).toEqual([]);
    expect(res.body.dealsNeedingAttention).toEqual([]);
    expect(res.body.counts.total).toBe(0);
    expect(res.body.has_data).toBeNull();
  });

  test('an org-less user falls back to user_id scoping on every section', async () => {
    // authMiddleware — no org.
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: null, org_role: null, status: 'active' }] });
    for (let i = 0; i < 5; i++) mockPool.query.mockResolvedValueOnce({ rows: [] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ deals: 0, contacts: 0, companies: 0 }] });

    const res = await request(buildApp())
      .get('/my-day')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.has_data).toEqual({ deals: 0, contacts: 0, companies: 0 });
    const calls = mockPool.query.mock.calls;
    for (let i = 1; i < 7; i++) {
      // Scope value is the user id, and the SQL scopes on user_id.
      expect(calls[i][1][0]).toBe(USER_ID);
      expect(calls[i][0]).toMatch(/user_id = \$1/);
    }
  });
});
