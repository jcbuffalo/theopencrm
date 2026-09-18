// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Relationship Pulse — service math + /api/pulse route tests.
//
// Part 1 (pure): normalizeScore / pulseHealthSignal / buildPulseSummary are
// DB-free, so the banding + NPS math is asserted directly.
//
// Part 2 (routes): pulseRoutes mounted against a tiny Express app (no feature
// gate — the gate is exercised at the index.js mount, mirroring
// accountsList.test.js). The pg pool is fully mocked; each pool.query call
// resolves the next queued response in the order the route issues them.
//
// Query order:
//   POST /pulse          → 1. authMiddleware  2. company org-check
//                          (3. contact org-check when contact_id given)
//                          then INSERT
//   GET  /pulse?company_id= → 1. authMiddleware  2. history select
//   GET  /pulse/summary  → 1. authMiddleware  2. latest-per-company select
//
// The org-scoping tests assert BOTH directions: the scope value is threaded
// into every query, and an out-of-org company_id 404s without ever inserting.

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const pulseRoutes = require('../routes/pulseRoutes');
const {
  normalizeScore,
  pulseHealthSignal,
  buildPulseSummary,
  PulseError,
} = require('../services/relationshipPulse');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/pulse', pulseRoutes);
  return app;
}

const USER_ID = 4242;
const ORG_ID = 7;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

// authMiddleware's user lookup — first queued query on every request.
function queueAuth() {
  mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
}

beforeEach(() => {
  mockPool.query.mockReset();
});

// ---------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------

describe('pulseHealthSignal', () => {
  test('maps the stored 0–10 scale to promoter/passive/detractor bands', () => {
    expect(pulseHealthSignal(10)).toEqual({ band: 'green', label: 'Promoter' });
    expect(pulseHealthSignal(9)).toEqual({ band: 'green', label: 'Promoter' });
    expect(pulseHealthSignal(8)).toEqual({ band: 'amber', label: 'Passive' });
    expect(pulseHealthSignal(7)).toEqual({ band: 'amber', label: 'Passive' });
    expect(pulseHealthSignal(6)).toEqual({ band: 'red', label: 'Detractor' });
    expect(pulseHealthSignal(0)).toEqual({ band: 'red', label: 'Detractor' });
  });

  test('returns null (not a fake band) for missing/invalid scores', () => {
    expect(pulseHealthSignal(null)).toBe(null);
    expect(pulseHealthSignal(undefined)).toBe(null);
    expect(pulseHealthSignal('not-a-number')).toBe(null);
  });
});

describe('normalizeScore', () => {
  test('nps passes 0–10 integers through', () => {
    expect(normalizeScore(0, 'nps')).toEqual({ kind: 'nps', stored: 0 });
    expect(normalizeScore(10, undefined)).toEqual({ kind: 'nps', stored: 10 }); // kind defaults to nps
  });

  test('csat 1–5 normalizes onto the stored 0–10 scale', () => {
    expect(normalizeScore(1, 'csat').stored).toBe(0);
    expect(normalizeScore(2, 'csat').stored).toBe(3);
    expect(normalizeScore(3, 'csat').stored).toBe(5);
    expect(normalizeScore(4, 'csat').stored).toBe(8);  // passive
    expect(normalizeScore(5, 'csat').stored).toBe(10); // promoter
  });

  test('rejects out-of-range / non-integer / unknown-kind input', () => {
    expect(() => normalizeScore(11, 'nps')).toThrow(PulseError);
    expect(() => normalizeScore(-1, 'nps')).toThrow(PulseError);
    expect(() => normalizeScore(6, 'csat')).toThrow(PulseError);
    expect(() => normalizeScore(0, 'csat')).toThrow(PulseError);
    expect(() => normalizeScore(7.5, 'nps')).toThrow(PulseError);
    expect(() => normalizeScore(9, 'ces')).toThrow(PulseError);
  });
});

describe('buildPulseSummary', () => {
  test('computes promoter/passive/detractor counts and NPS = %promoters − %detractors', () => {
    // 4 accounts: 2 promoters, 1 passive, 1 detractor → 50% − 25% = 25.
    const rows = [
      { company_id: 1, score: 10, created_at: '2026-07-01T00:00:00Z' },
      { company_id: 2, score: 9,  created_at: '2026-07-02T00:00:00Z' },
      { company_id: 3, score: 7,  created_at: '2026-07-03T00:00:00Z' },
      { company_id: 4, score: 2,  created_at: '2026-06-01T00:00:00Z' },
    ];
    const s = buildPulseSummary(rows);
    expect(s.total_accounts).toBe(4);
    expect(s.promoters).toBe(2);
    expect(s.passives).toBe(1);
    expect(s.detractors).toBe(1);
    expect(s.nps).toBe(25);
    expect(s.latest_at).toBe('2026-07-03T00:00:00.000Z');
  });

  test('all detractors → negative NPS; zero rows → null NPS (no fake zero)', () => {
    expect(buildPulseSummary([{ company_id: 1, score: 1 }]).nps).toBe(-100);
    const empty = buildPulseSummary([]);
    expect(empty.total_accounts).toBe(0);
    expect(empty.nps).toBe(null);
    expect(empty.latest_at).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// POST /pulse
// ---------------------------------------------------------------------------

describe('POST /pulse', () => {
  test('records an nps pulse: org-checks the company, inserts, returns 201 + band', async () => {
    queueAuth();
    // 2. company org-check — company 55 exists in ORG_ID.
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 55 }] });
    // 3. insert.
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 900, org_id: ORG_ID, company_id: 55, contact_id: null, score: 9, kind: 'nps', comment: 'Great QBR', recorded_by: USER_ID, created_at: '2026-07-13T00:00:00Z' }],
    });

    const res = await request(buildApp())
      .post('/pulse')
      .set('Cookie', authCookie())
      .send({ company_id: 55, score: 9, comment: 'Great QBR' });

    expect(res.status).toBe(201);
    expect(res.body.score).toBe(9);
    expect(res.body.band).toBe('green');
    expect(res.body.band_label).toBe('Promoter');

    // Company check is org-scoped.
    const companyCheck = mockPool.query.mock.calls[1];
    expect(companyCheck[0]).toMatch(/FROM companies/);
    expect(companyCheck[0]).toMatch(/org_id = \$2/);
    expect(companyCheck[1]).toEqual([55, ORG_ID]);

    // Insert carries the org id, the user as recorder, and the raw nps score.
    const insert = mockPool.query.mock.calls[2];
    expect(insert[0]).toMatch(/INSERT INTO relationship_pulses/);
    expect(insert[1]).toEqual([USER_ID, ORG_ID, 55, null, 9, 'nps', 'Great QBR', USER_ID]);
  });

  test('normalizes a csat 5/5 to a stored 10', async () => {
    queueAuth();
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 55 }] });
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 901, org_id: ORG_ID, company_id: 55, contact_id: null, score: 10, kind: 'csat', comment: null, recorded_by: USER_ID, created_at: '2026-07-13T00:00:00Z' }],
    });

    const res = await request(buildApp())
      .post('/pulse')
      .set('Cookie', authCookie())
      .send({ company_id: 55, score: 5, kind: 'csat' });

    expect(res.status).toBe(201);
    const insert = mockPool.query.mock.calls[2];
    expect(insert[1][4]).toBe(10);     // stored score
    expect(insert[1][5]).toBe('csat'); // kind preserved for honest labeling
  });

  test('404s (and never inserts) when the company belongs to another org', async () => {
    queueAuth();
    // Company org-check misses — id exists in some other org, not ours.
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .post('/pulse')
      .set('Cookie', authCookie())
      .send({ company_id: 9999, score: 9 });

    expect(res.status).toBe(404);
    // auth + company check only — the INSERT never ran.
    expect(mockPool.query.mock.calls).toHaveLength(2);
    expect(mockPool.query.mock.calls.some(([sql]) => /INSERT/i.test(sql || ''))).toBe(false);
  });

  test('400s on an out-of-range score without touching the DB beyond auth', async () => {
    queueAuth();

    const res = await request(buildApp())
      .post('/pulse')
      .set('Cookie', authCookie())
      .send({ company_id: 55, score: 42 });

    expect(res.status).toBe(400);
    expect(mockPool.query.mock.calls).toHaveLength(1); // auth only
  });
});

// ---------------------------------------------------------------------------
// GET /pulse?company_id=
// ---------------------------------------------------------------------------

describe('GET /pulse', () => {
  test('returns the org-scoped history with derived bands, newest first', async () => {
    queueAuth();
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 2, company_id: 55, contact_id: null, score: 9, kind: 'nps', comment: null, recorded_by: USER_ID, created_at: '2026-07-10T00:00:00Z' },
        { id: 1, company_id: 55, contact_id: 3, score: 4, kind: 'nps', comment: 'rough patch', recorded_by: USER_ID, created_at: '2026-05-01T00:00:00Z' },
      ],
    });

    const res = await request(buildApp())
      .get('/pulse?company_id=55')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.pulses).toHaveLength(2);
    expect(res.body.pulses[0].band).toBe('green');
    expect(res.body.pulses[1].band).toBe('red');

    // Org scope + company id are both bound parameters on the history query.
    const historyCall = mockPool.query.mock.calls[1];
    expect(historyCall[0]).toMatch(/FROM relationship_pulses/);
    expect(historyCall[0]).toMatch(/org_id = \$1/);
    expect(historyCall[1]).toEqual([ORG_ID, 55]);
  });

  test('400s when company_id is missing', async () => {
    queueAuth();
    const res = await request(buildApp())
      .get('/pulse')
      .set('Cookie', authCookie());
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /pulse/summary
// ---------------------------------------------------------------------------

describe('GET /pulse/summary', () => {
  test('rolls the latest pulse per company into an org NPS', async () => {
    queueAuth();
    // DISTINCT ON already collapsed to one row per company by the SQL.
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { company_id: 1, score: 10, created_at: '2026-07-01T00:00:00Z' },
        { company_id: 2, score: 8,  created_at: '2026-07-02T00:00:00Z' },
        { company_id: 3, score: 3,  created_at: '2026-07-03T00:00:00Z' },
      ],
    });

    const res = await request(buildApp())
      .get('/pulse/summary')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.total_accounts).toBe(3);
    expect(res.body.promoters).toBe(1);
    expect(res.body.passives).toBe(1);
    expect(res.body.detractors).toBe(1);
    expect(res.body.nps).toBe(0); // 33% − 33%, rounded

    const summaryCall = mockPool.query.mock.calls[1];
    expect(summaryCall[0]).toMatch(/DISTINCT ON \(company_id\)/);
    expect(summaryCall[0]).toMatch(/org_id = \$1/);
    expect(summaryCall[1]).toEqual([ORG_ID]);
  });

  test('degrades to a null NPS when the org has no pulses yet', async () => {
    queueAuth();
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .get('/pulse/summary')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.total_accounts).toBe(0);
    expect(res.body.nps).toBe(null);
  });
});
