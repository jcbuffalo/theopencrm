// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// CS-1 — Account 360 happy-path smoke test.
//
// We mount accountRoutes against a tiny Express app (no feature gate, no CSRF —
// the gate is exercised at the index.js mount, not here). The pg pool is fully
// mocked: each pool.query call in the route resolves the next queued response,
// in the order the route issues them.
//
// Route query order for GET /:companyId/360 :
//   1. authMiddleware — SELECT org_id, org_role, status FROM users
//   2. company header — SELECT ... FROM companies
//   3. deals          — SELECT ... FROM deals
//   4. activities     — SELECT ... FROM activities
//   5. tasks          — SELECT ... FROM tasks
//   6. issues         — SELECT ... FROM issues
//   7. summaries      — SELECT ... FROM deal_gmail_summaries
//   8. email messages — SELECT ... FROM email_thread_messages (org-scoped only)
//   9. calendar events — SELECT ... FROM calendar_events (org-scoped only)

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

describe('GET /accounts/:companyId/360', () => {
  test('returns the account header and a timeline containing the seeded activity', async () => {
    const activityDate = '2026-06-20T15:00:00.000Z';

    // 1. authMiddleware — user belongs to ORG_ID, active.
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
    // 2. company header
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: COMPANY_ID, name: 'Acme Co', industry: 'Manufacturing', website: null,
        location: null, employee_count: null, annual_revenue: null, status: 'active',
        type: 'customer', owner_id: null, first_deal_at: null, last_deal_at: null,
        notes: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      }],
    });
    // 3. deals — none
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // 4. activities — one seeded activity
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 501, type: 'call', title: 'Kickoff call', description: 'Discussed onboarding',
        activity_date: activityDate, outcome: 'positive', deal_id: null, contact_id: 12,
        created_at: activityDate,
      }],
    });
    // 5. tasks — none
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // 6. issues — none
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // 7. gmail summaries — none
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // 8. inbound email messages — none
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // 9. calendar meetings — none
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .get(`/accounts/${COMPANY_ID}/360`)
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.header).toBeDefined();
    expect(res.body.header.company.id).toBe(COMPANY_ID);
    expect(res.body.header.company.name).toBe('Acme Co');
    expect(res.body.header.open_task_count).toBe(0);
    expect(res.body.header.open_issue_count).toBe(0);
    expect(res.body.header.open_deal_count).toBe(0);
    expect(res.body.header.last_touch).toBe(activityDate);

    // Timeline contains exactly the seeded activity.
    expect(Array.isArray(res.body.timeline)).toBe(true);
    expect(res.body.timeline.length).toBe(1);
    const entry = res.body.timeline[0];
    expect(entry.type).toBe('activity');
    expect(entry.id).toBe(501);
    expect(entry.title).toBe('Kickoff call');
    expect(entry.timestamp).toBe(activityDate);
  });

  test('returns 404 when the company is not in the caller org', async () => {
    // authMiddleware
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
    // company header — org-scoped query yields no row
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .get(`/accounts/${COMPANY_ID}/360`)
      .set('Cookie', authCookie());

    expect(res.status).toBe(404);
  });
});
