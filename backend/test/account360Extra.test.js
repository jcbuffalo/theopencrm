// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// CS-1 — Account 360 edge-case coverage (complements account-360.test.js).
//
// Beyond the existing happy/404 cases, this file exercises:
//   (1) a populated timeline merging deals + activities + tasks + issues +
//       gmail summaries, asserted in correct reverse-chronological order;
//   (2) the open_task / open_issue / open_deal rollup counts;
//   (3) auth required — no cookie yields 401.
//
// The pg pool is fully mocked; each pool.query call resolves the next queued
// response in the exact order the route issues them. Route query order for
// GET /:companyId/360 :
//   1. authMiddleware — SELECT org_id, org_role, status FROM users
//   2. company header — SELECT ... FROM companies
//   3. deals          — SELECT ... FROM deals
//   4. activities     — SELECT ... FROM activities
//   5. tasks          — SELECT ... FROM tasks
//   6. issues         — SELECT ... FROM issues
//   7. summaries      — SELECT ... FROM deal_gmail_summaries
//   8. email messages — SELECT ... FROM email_thread_messages (org-scoped only)
//   9. calendar events — SELECT ... FROM calendar_events (org-scoped only)
//
// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const accountRoutes = require('../routes/accountRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/accounts', accountRoutes);
  return app;
}

const USER_ID = 4242;
const ORG_ID = 7;
const COMPANY_ID = 99;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

beforeEach(() => {
  mockPool.query.mockReset();
});

// Mocks authMiddleware (query 1) + company header (query 2) as a happy account
// belonging to ORG_ID. Caller queues queries 3..7 afterward.
function seedAuthAndCompany() {
  mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
  mockPool.query.mockResolvedValueOnce({
    rows: [{
      id: COMPANY_ID, name: 'Acme Co', industry: 'Manufacturing', website: null,
      location: null, employee_count: null, annual_revenue: null, status: 'active',
      type: 'customer', owner_id: null, first_deal_at: null, last_deal_at: null,
      notes: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    }],
  });
}

describe('GET /accounts/:companyId/360 — edge cases', () => {
  test('merges deals + activities + tasks + issues + gmail summaries into a reverse-chronological timeline', async () => {
    // Distinct, deliberately out-of-order timestamps so we can verify the
    // route's own DESC sort (not the per-query ORDER BY) is what wins.
    const tsDeal     = '2026-06-22T10:00:00.000Z'; // newest overall (deal.updated_at)
    const tsActivity = '2026-06-21T09:00:00.000Z';
    const tsSummary  = '2026-06-20T08:00:00.000Z';
    const tsTask     = '2026-06-19T07:00:00.000Z';
    const tsIssue    = '2026-06-18T06:00:00.000Z'; // oldest overall

    seedAuthAndCompany();

    // 3. deals — one deal, timestamped via updated_at.
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 301, title: 'Renewal 2026', stage: 'NEGOTIATION', phase: null, amount: 50000,
        expected_close_date: null, closed_date: null,
        created_at: '2026-01-05T00:00:00.000Z', updated_at: tsDeal,
      }],
    });
    // 4. activities — one activity (uses activity_date).
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 401, type: 'call', title: 'Quarterly check-in', description: 'Reviewed usage',
        activity_date: tsActivity, outcome: 'positive', deal_id: 301, contact_id: 12,
        created_at: '2026-06-21T08:30:00.000Z',
      }],
    });
    // 5. tasks — one open task (uses due_date).
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 501, title: 'Send renewal quote', description: 'Draft and send',
        due_date: tsTask, status: 'pending', priority: 'high',
        deal_id: 301, contact_id: null,
        created_at: '2026-06-15T00:00:00.000Z', updated_at: '2026-06-15T00:00:00.000Z',
      }],
    });
    // 6. issues — one open issue (uses created_at).
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 601, title: 'Billing discrepancy', description: 'Invoice mismatch',
        category: 'billing', urgency: 'high', status: 'open', deal_id: 301,
        resolved_at: null, created_at: tsIssue, updated_at: tsIssue,
      }],
    });
    // 7. gmail summaries — one summary (uses generated_at).
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 701, deal_id: 301, thread_link_id: 9001,
        summary_md: 'Customer asked about pricing tiers.', next_step: 'Follow up Monday',
        generated_at: tsSummary,
      }],
    });
    // 8. inbound email messages — none.
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // 9. calendar meetings — none.
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .get(`/accounts/${COMPANY_ID}/360`)
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);

    const timeline = res.body.timeline;
    expect(Array.isArray(timeline)).toBe(true);
    // All five signal types are present.
    expect(timeline.length).toBe(5);

    // Reverse-chronological order: deal (newest) → activity → summary → task → issue (oldest).
    expect(timeline.map((e) => e.type)).toEqual([
      'deal', 'activity', 'gmail_summary', 'task', 'issue',
    ]);
    expect(timeline.map((e) => e.timestamp)).toEqual([
      tsDeal, tsActivity, tsSummary, tsTask, tsIssue,
    ]);

    // Timestamps are strictly non-increasing.
    for (let i = 1; i < timeline.length; i++) {
      const prev = new Date(timeline[i - 1].timestamp).getTime();
      const cur = new Date(timeline[i].timestamp).getTime();
      expect(prev).toBeGreaterThanOrEqual(cur);
    }

    // Spot-check that each entry carries its identifying payload.
    const byType = Object.fromEntries(timeline.map((e) => [e.type, e]));
    expect(byType.deal.id).toBe(301);
    expect(byType.deal.title).toBe('Renewal 2026');
    expect(byType.activity.id).toBe(401);
    expect(byType.activity.meta.activity_type).toBe('call');
    expect(byType.task.id).toBe(501);
    expect(byType.task.meta.priority).toBe('high');
    expect(byType.issue.id).toBe(601);
    expect(byType.issue.meta.category).toBe('billing');
    expect(byType.gmail_summary.id).toBe(701);
    expect(byType.gmail_summary.detail).toBe('Customer asked about pricing tiers.');

    // last_touch is the newest timestamp across the whole timeline (the deal).
    expect(res.body.header.last_touch).toBe(tsDeal);
  });

  test('computes open_* rollup counts, excluding terminal states', async () => {
    seedAuthAndCompany();

    // 3. deals — 2 open (LEAD, NEGOTIATION) + 2 terminal (closed_won, CLOSED_LOST) → open_deal_count = 2.
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 311, title: 'Open lower', stage: 'LEAD', phase: null, amount: 100, expected_close_date: null, closed_date: null, created_at: '2026-02-01T00:00:00.000Z', updated_at: '2026-02-01T00:00:00.000Z' },
        { id: 312, title: 'Open upper', stage: 'NEGOTIATION', phase: null, amount: 200, expected_close_date: null, closed_date: null, created_at: '2026-02-02T00:00:00.000Z', updated_at: '2026-02-02T00:00:00.000Z' },
        { id: 313, title: 'Won', stage: 'closed_won', phase: null, amount: 300, expected_close_date: null, closed_date: null, created_at: '2026-02-03T00:00:00.000Z', updated_at: '2026-02-03T00:00:00.000Z' },
        { id: 314, title: 'Lost', stage: 'CLOSED_LOST', phase: null, amount: 400, expected_close_date: null, closed_date: null, created_at: '2026-02-04T00:00:00.000Z', updated_at: '2026-02-04T00:00:00.000Z' },
      ],
    });
    // 4. activities — none.
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // 5. tasks — 2 open (pending, in_progress) + 2 terminal (done, cancelled) → open_task_count = 2.
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 511, title: 'Pending task', description: null, due_date: null, status: 'pending', priority: 'low', deal_id: 311, contact_id: null, created_at: '2026-03-01T00:00:00.000Z', updated_at: '2026-03-01T00:00:00.000Z' },
        { id: 512, title: 'In progress task', description: null, due_date: null, status: 'in_progress', priority: 'low', deal_id: 311, contact_id: null, created_at: '2026-03-02T00:00:00.000Z', updated_at: '2026-03-02T00:00:00.000Z' },
        { id: 513, title: 'Done task', description: null, due_date: null, status: 'done', priority: 'low', deal_id: 311, contact_id: null, created_at: '2026-03-03T00:00:00.000Z', updated_at: '2026-03-03T00:00:00.000Z' },
        { id: 514, title: 'Cancelled task', description: null, due_date: null, status: 'cancelled', priority: 'low', deal_id: 311, contact_id: null, created_at: '2026-03-04T00:00:00.000Z', updated_at: '2026-03-04T00:00:00.000Z' },
      ],
    });
    // 6. issues — 1 open + 2 terminal (resolved, closed) → open_issue_count = 1.
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 611, title: 'Open issue', description: null, category: 'support', urgency: 'low', status: 'open', deal_id: 311, resolved_at: null, created_at: '2026-04-01T00:00:00.000Z', updated_at: '2026-04-01T00:00:00.000Z' },
        { id: 612, title: 'Resolved issue', description: null, category: 'support', urgency: 'low', status: 'resolved', deal_id: 311, resolved_at: '2026-04-02T00:00:00.000Z', created_at: '2026-04-02T00:00:00.000Z', updated_at: '2026-04-02T00:00:00.000Z' },
        { id: 613, title: 'Closed issue', description: null, category: 'support', urgency: 'low', status: 'closed', deal_id: 311, resolved_at: '2026-04-03T00:00:00.000Z', created_at: '2026-04-03T00:00:00.000Z', updated_at: '2026-04-03T00:00:00.000Z' },
      ],
    });
    // 7. gmail summaries — none.
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // 8. inbound email messages — none.
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // 9. calendar meetings — none.
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .get(`/accounts/${COMPANY_ID}/360`)
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.header.open_deal_count).toBe(2);
    expect(res.body.header.open_task_count).toBe(2);
    expect(res.body.header.open_issue_count).toBe(1);
  });

  test('requires auth — no cookie yields 401', async () => {
    const res = await request(buildApp())
      .get(`/accounts/${COMPANY_ID}/360`);

    expect(res.status).toBe(401);
    // authMiddleware should reject before any data query runs.
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});
