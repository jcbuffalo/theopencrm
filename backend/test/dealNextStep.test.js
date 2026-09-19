// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Deal next-step commitment (migration 172): deals.next_step + next_step_date.
//
//   1. PUT /deals/:id with both keys writes them (present-key flags true).
//   2. PUT with explicit nulls CLEARS them — the one thing the COALESCE
//      pattern on every other column can't express.
//   3. PUT without the keys leaves the columns alone (flags false).
//   4. The CSV export carries the two columns.
//   5. The chat `deal.update` proposal spec accepts + summarizes them
//      (services/chatActions.js) without a new tool.
//
// Pool is a SQL-shape router so the UPDATE's positional params can be
// asserted directly.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/v2DualWrite', () => ({
  onDealCreated: vi.fn().mockResolvedValue(null),
  onDealStageChanged: vi.fn().mockResolvedValue(null),
}));
vi.mock('../services/webhookDispatcher', () => ({ dispatch: vi.fn().mockResolvedValue(null) }));
vi.mock('../services/notificationDispatcher', () => ({ notifyDealActivity: vi.fn().mockResolvedValue(null) }));

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const dealRoutes = require('../routes/dealRoutes');
const chatActions = require('../services/chatActions');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 7201;
const ORG_ID = 72;
function authCookie() { return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`]; }

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/deals', dealRoutes);
  return app;
}

// Captures every UPDATE deals call; everything else gets a benign answer.
function primePool(captured) {
  mockPool.query.mockImplementation(async (sql, params) => {
    const s = String(sql);
    if (/FROM admin_users/i.test(s)) return { rows: [] };
    if (/FROM users WHERE id/i.test(s)) return { rows: [{ org_id: ORG_ID, org_role: 'owner', status: 'active' }] };
    if (/^\s*UPDATE deals SET/i.test(s)) {
      captured.push({ sql: s, params });
      return { rows: [{ id: 10, title: 'Acme Q3', next_step: params[34], next_step_date: params[36] }], rowCount: 1 };
    }
    if (/FROM deals d/i.test(s) && /export|li\.revenue_cents/i.test(s)) {
      return { rows: [{ id: 10, title: 'Acme Q3', stage: 'PROPOSAL', next_step: 'Send quote', next_step_date: '2026-09-21', revenue_cents: null, cost_cents: null }] };
    }
    return { rows: [] };
  });
}

// Positional indices in routes/dealRoutes.js PUT /:id (1-based in SQL):
//   $34 hasNextStep · $35 next_step · $36 hasNextStepDate · $37 next_step_date
const IDX = { HAS_STEP: 33, STEP: 34, HAS_DATE: 35, DATE: 36 };

beforeEach(() => { mockPool.query.mockReset(); });

describe('deals.next_step (migration 172)', () => {
  test('PUT writes next_step + next_step_date when both keys are present', async () => {
    const captured = [];
    primePool(captured);
    const res = await request(buildApp())
      .put('/deals/10')
      .set('Cookie', authCookie())
      .send({ next_step: '  Send revised quote to Dana ', next_step_date: '2026-09-21' });
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    const p = captured[0].params;
    expect(p[IDX.HAS_STEP]).toBe(true);
    expect(p[IDX.STEP]).toBe('Send revised quote to Dana'); // zod trims
    expect(p[IDX.HAS_DATE]).toBe(true);
    expect(p[IDX.DATE]).toBe('2026-09-21');
    expect(captured[0].sql).toMatch(/next_step = CASE WHEN \$34::boolean THEN \$35 ELSE next_step END/);
    // Org scope threaded as ever.
    expect(p[29]).toBe(ORG_ID);
  });

  test('PUT with explicit nulls clears both (the "Done" action on My Day)', async () => {
    const captured = [];
    primePool(captured);
    const res = await request(buildApp())
      .put('/deals/10')
      .set('Cookie', authCookie())
      .send({ next_step: null, next_step_date: null });
    expect(res.status).toBe(200);
    const p = captured[0].params;
    expect(p[IDX.HAS_STEP]).toBe(true);
    expect(p[IDX.STEP]).toBeNull();
    expect(p[IDX.HAS_DATE]).toBe(true);
    expect(p[IDX.DATE]).toBeNull();
  });

  test('PUT without the keys leaves the columns untouched', async () => {
    const captured = [];
    primePool(captured);
    const res = await request(buildApp())
      .put('/deals/10')
      .set('Cookie', authCookie())
      .send({ title: 'Renamed' });
    expect(res.status).toBe(200);
    const p = captured[0].params;
    expect(p[IDX.HAS_STEP]).toBe(false);
    expect(p[IDX.HAS_DATE]).toBe(false);
  });

  test('PUT rejects a malformed next_step_date', async () => {
    primePool([]);
    const res = await request(buildApp())
      .put('/deals/10')
      .set('Cookie', authCookie())
      .send({ next_step_date: 'next tuesday' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/next_step_date/);
  });

  test('CSV export includes Next Step / Next Step Date columns', async () => {
    primePool([]);
    const res = await request(buildApp())
      .get('/deals/export.csv')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    const [header, row] = res.text.split(/\r?\n/);
    expect(header).toMatch(/Next Step,Next Step Date/);
    expect(row).toMatch(/Send quote/);
    expect(row).toMatch(/2026-09-21/);
  });

  test('chat deal.update proposal accepts next_step + next_step_date and summarizes them', () => {
    const action = { entity: 'deal', op: 'update', target_id: 10, fields: { next_step: 'Call Dana', next_step_date: '2026-09-21' } };
    const result = chatActions.validateAction(action);
    expect(result.ok).toBe(true);
    expect(result.action.summary).toMatch(/next step → "Call Dana"/);
    expect(result.action.summary).toMatch(/next step due → 2026-09-21/);
  });
});
