// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// NPS/CSAT Surveys (CS-7, migration 138) — service + route tests.
//
// Follows the leads.test.js pattern: routes are mounted on a tiny Express app
// with the pg pool fully mocked (each pool.query call resolves the next queued
// response in route-issue order; authMiddleware's user lookup is always query
// #1 on authenticated surfaces). featureFlags.hasFeature is stubbed.
//
// Coverage map (per the slice spec):
//   • CRUD org-isolation — every query carries the caller's org scope;
//     cross-org ids 404.
//   • generate-links — mints pending token rows, validates contacts in-scope,
//     and NEVER sends anything.
//   • public respond — happy path stamps responded_at exactly once; unknown /
//     inactive token → generic 404 with no write; respond-once idempotency
//     (already-responded token → no UPDATE); score-range validation per kind.
//   • summary math — pure buildSurveySummary NPS rollup consistent with
//     relationshipPulse banding.
//   • 360 feed — the account-360 survey query is org-scoped and completed
//     responses land on the timeline.
//   • feature gate — customer_success_enabled=false → 403 on the
//     authenticated surface.

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const surveysService = require('../services/surveys');
const surveyRoutes = require('../routes/surveyRoutes');
const accountRoutes = require('../routes/accountRoutes');
const featureFlags = require('../services/featureFlags');
const { requireFeature } = require('../middleware/featureGate');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 4242;
const ORG_ID = 7;
const SURVEY_ID = 31;
const RESPONSE_TOKEN = 'a'.repeat(48); // matches the 48-hex-char minted shape

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function authRow(role = 'member') {
  return { rows: [{ org_id: ORG_ID, org_role: role, status: 'active' }] };
}

function surveyRow(overrides = {}) {
  return {
    id: SURVEY_ID, org_id: ORG_ID, user_id: USER_ID,
    name: 'Q3 relationship check', kind: 'nps',
    question: 'How likely are you to recommend us?',
    is_active: true, created_by: USER_ID, created_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

// The row shape resolveByToken returns (response joined to its survey).
function tokenRow(overrides = {}) {
  return {
    response_id: 555, responded_at: null, org_id: ORG_ID, user_id: USER_ID,
    survey_id: SURVEY_ID, name: 'Q3 relationship check', kind: 'nps',
    question: 'How likely are you to recommend us?', is_active: true,
    ...overrides,
  };
}

// Authenticated app — mirrors the index.js mount (gate at the mount point).
function buildAuthedApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/surveys', requireFeature('customer_success_enabled'), surveyRoutes);
  return app;
}

// Public app — response surface only, WITHOUT the limiter so functional tests
// don't burn its budget (it's a module-level singleton).
function buildPublicApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/public/surveys', surveyRoutes.publicRouter);
  return app;
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  vi.spyOn(featureFlags, 'hasFeature').mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// CRUD org-isolation
// ---------------------------------------------------------------------------

describe('surveys CRUD — org isolation', () => {
  test('GET /api/surveys scopes the list query to the caller org', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow())                                        // auth (gate)
      .mockResolvedValueOnce({ rows: [{ ...surveyRow(), sent_count: 4, responded_count: 2 }] }); // list
    const res = await request(buildAuthedApp())
      .get('/api/surveys').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toContain('org_id = $1');
    expect(params[0]).toBe(ORG_ID);
  });

  test('POST /api/surveys stamps user_id + org_id and defaults kind to nps', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow())                    // auth
      .mockResolvedValueOnce({ rows: [surveyRow()] });     // insert
    const res = await request(buildAuthedApp())
      .post('/api/surveys').set('Cookie', authCookie())
      .send({ name: 'Q3 relationship check' });
    expect(res.status).toBe(201);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toContain('INSERT INTO surveys');
    expect(params[0]).toBe(USER_ID);   // user_id
    expect(params[1]).toBe(ORG_ID);    // org_id
    expect(params[3]).toBe('nps');     // kind default
  });

  test('POST /api/surveys rejects an unknown kind', async () => {
    mockPool.query.mockResolvedValueOnce(authRow());
    const res = await request(buildAuthedApp())
      .post('/api/surveys').set('Cookie', authCookie())
      .send({ name: 'Bad', kind: 'stars' });
    expect(res.status).toBe(400);
    expect(mockPool.query.mock.calls).toHaveLength(1); // nothing written
  });

  test('GET /api/surveys/:id 404s for a cross-org (invisible) id', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] });                // scoped fetch → miss
    const res = await request(buildAuthedApp())
      .get(`/api/surveys/${SURVEY_ID}`).set('Cookie', authCookie());
    expect(res.status).toBe(404);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toContain('org_id = $2');
    expect(params).toEqual([String(SURVEY_ID), ORG_ID]);
  });

  test('PUT /api/surveys/:id 404s cross-org and never leaks the row', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] });                // scoped update → miss
    const res = await request(buildAuthedApp())
      .put(`/api/surveys/${SURVEY_ID}`).set('Cookie', authCookie())
      .send({ is_active: false });
    expect(res.status).toBe(404);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toContain('org_id = $5');
    expect(params[4]).toBe(ORG_ID);
  });
});

// ---------------------------------------------------------------------------
// Feature gate
// ---------------------------------------------------------------------------

describe('surveys feature gate', () => {
  test('customer_success_enabled = false → 403 on the authenticated surface', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    mockPool.query.mockResolvedValueOnce(authRow());       // gate's auth resolve
    const res = await request(buildAuthedApp())
      .get('/api/surveys').set('Cookie', authCookie());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
  });

  test('public respond disappears too when the org turned the module off', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    mockPool.query.mockResolvedValueOnce({ rows: [tokenRow()] }); // token resolves…
    const res = await request(buildPublicApp())
      .post(`/api/public/surveys/${RESPONSE_TOKEN}/respond`)
      .send({ score: 10 });
    expect(res.status).toBe(404);                          // …but flag-off → same generic 404
    expect(mockPool.query.mock.calls).toHaveLength(1);     // no write
  });
});

// ---------------------------------------------------------------------------
// Generate links (never sends)
// ---------------------------------------------------------------------------

describe('POST /api/surveys/:id/links', () => {
  test('mints pending rows for in-scope contacts + anonymous count', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow())                                            // auth
      .mockResolvedValueOnce({ rows: [surveyRow()] })                              // survey scoped fetch
      .mockResolvedValueOnce({ rows: [{ id: 11, company_id: 99 }] })               // contacts in scope (1 of 2 found)
      .mockResolvedValueOnce({ rows: [{ id: 1, contact_id: 11, company_id: 99, response_token: 't1', created_at: 'now' }] })
      .mockResolvedValueOnce({ rows: [{ id: 2, contact_id: null, company_id: null, response_token: 't2', created_at: 'now' }] });
    const res = await request(buildAuthedApp())
      .post(`/api/surveys/${SURVEY_ID}/links`).set('Cookie', authCookie())
      .send({ contact_ids: [11, 999999], count: 1 });
    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(2);              // out-of-scope contact silently skipped
    expect(res.body.created[0].path).toBe('/s/t1');

    // Contact resolution was org-scoped.
    const [contactSql, contactParams] = mockPool.query.mock.calls[2];
    expect(contactSql).toContain('org_id = $2');
    expect(contactParams[1]).toBe(ORG_ID);

    // Inserted rows carry the caller's tenancy and a generated token.
    const [insSql, insParams] = mockPool.query.mock.calls[3];
    expect(insSql).toContain('INSERT INTO survey_responses');
    expect(insParams[1]).toBe(ORG_ID);
    expect(insParams[5]).toMatch(/^[0-9a-f]{48}$/);
  });

  test('400s when neither contact_ids nor count is given (no silent bulk enroll)', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [surveyRow()] });
    const res = await request(buildAuthedApp())
      .post(`/api/surveys/${SURVEY_ID}/links`).set('Cookie', authCookie())
      .send({});
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Public respond — happy / 404 / idempotency / validation
// ---------------------------------------------------------------------------

describe('public survey respond', () => {
  test('happy path records exactly one response and stamps responded_at', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })       // resolve token
      .mockResolvedValueOnce({ rows: [{ id: 555 }] });     // guarded UPDATE hits
    const res = await request(buildPublicApp())
      .post(`/api/public/surveys/${RESPONSE_TOKEN}/respond`)
      .send({ score: 9, comment: 'Great team' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, already_responded: false });

    const [updSql, updParams] = mockPool.query.mock.calls[1];
    expect(updSql).toContain('responded_at IS NULL');      // the respond-once guard
    expect(updParams).toEqual([9, 'Great team', 555]);
  });

  test('unknown token → generic 404 and NO write', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });    // token miss
    const res = await request(buildPublicApp())
      .post(`/api/public/surveys/${'f'.repeat(48)}/respond`)
      .send({ score: 9 });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(mockPool.query.mock.calls).toHaveLength(1);
  });

  test('malformed token is rejected before touching the DB', async () => {
    const res = await request(buildPublicApp())
      .post('/api/public/surveys/nope!/respond')
      .send({ score: 9 });
    expect(res.status).toBe(404);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('respond-once: an already-responded token is a no-op (idempotent)', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [tokenRow({ responded_at: '2026-07-01T00:00:00.000Z' })],
    });
    const res = await request(buildPublicApp())
      .post(`/api/public/surveys/${RESPONSE_TOKEN}/respond`)
      .send({ score: 2, comment: 'trying to overwrite' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, already_responded: true });
    expect(mockPool.query.mock.calls).toHaveLength(1);     // resolve only — no UPDATE
  });

  test('race-safe: UPDATE guarded by responded_at IS NULL missing → already_responded', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })       // looked pending…
      .mockResolvedValueOnce({ rows: [] });                // …but another request won the race
    const res = await request(buildPublicApp())
      .post(`/api/public/surveys/${RESPONSE_TOKEN}/respond`)
      .send({ score: 9 });
    expect(res.status).toBe(200);
    expect(res.body.already_responded).toBe(true);
  });

  test('nps score outside 0–10 → 400, nothing written', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [tokenRow()] });
    const res = await request(buildPublicApp())
      .post(`/api/public/surveys/${RESPONSE_TOKEN}/respond`)
      .send({ score: 11 });
    expect(res.status).toBe(400);
    expect(mockPool.query.mock.calls).toHaveLength(1);
  });

  test('csat score outside 1–5 → 400, nothing written', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [tokenRow({ kind: 'csat' })] });
    const res = await request(buildPublicApp())
      .post(`/api/public/surveys/${RESPONSE_TOKEN}/respond`)
      .send({ score: 9 });
    expect(res.status).toBe(400);
    expect(mockPool.query.mock.calls).toHaveLength(1);
  });

  test('non-integer score → 400', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [tokenRow()] });
    const res = await request(buildPublicApp())
      .post(`/api/public/surveys/${RESPONSE_TOKEN}/respond`)
      .send({ score: 'ten' });
    expect(res.status).toBe(400);
  });

  test('GET /:token renders question + scale without leaking org internals', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [tokenRow()] });
    const res = await request(buildPublicApp())
      .get(`/api/public/surveys/${RESPONSE_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: 'Q3 relationship check',
      question: 'How likely are you to recommend us?',
      kind: 'nps',
      scale: { min: 0, max: 10 },
      responded: false,
    });
    expect(res.body.org_id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Summary math (pure)
// ---------------------------------------------------------------------------

describe('buildSurveySummary — NPS/CSAT rollup math', () => {
  const row = (score, kind = 'nps', responded = true, sid = 1) => ({
    survey_id: sid, name: `S${sid}`, kind,
    score, responded_at: responded ? '2026-07-01T00:00:00.000Z' : null,
  });

  test('NPS = %promoters − %detractors over responded rows only', async () => {
    // 6 promoters (9–10), 1 passive (7–8), 3 detractors (0–6) → NPS 30.
    const rows = [
      row(10), row(10), row(9), row(9), row(9), row(10),
      row(7),
      row(6), row(0), row(3),
      row(null, 'nps', false), row(null, 'nps', false), // pending: count as sent only
    ];
    const s = surveysService.buildSurveySummary(rows);
    expect(s.overall.sent).toBe(12);
    expect(s.overall.responded).toBe(10);
    expect(s.overall.promoters).toBe(6);
    expect(s.overall.passives).toBe(1);
    expect(s.overall.detractors).toBe(3);
    expect(s.overall.nps).toBe(30);
    expect(s.overall.response_rate).toBeCloseTo(0.83, 2);
  });

  test('CSAT bands match relationshipPulse (5 promoter / 4 passive / ≤3 detractor)', () => {
    const rows = [row(5, 'csat'), row(4, 'csat'), row(3, 'csat'), row(1, 'csat')];
    const s = surveysService.buildSurveySummary(rows);
    expect(s.overall.promoters).toBe(1);
    expect(s.overall.passives).toBe(1);
    expect(s.overall.detractors).toBe(2);
    expect(s.overall.nps).toBe(Math.round(((1 - 2) / 4) * 100)); // -25
  });

  test('zero responses → nps null (there is no NPS, not an NPS of 0)', () => {
    const s = surveysService.buildSurveySummary([row(null, 'nps', false)]);
    expect(s.overall.nps).toBeNull();
    expect(s.overall.sent).toBe(1);
    expect(s.overall.responded).toBe(0);
    // …and an entirely empty org:
    expect(surveysService.buildSurveySummary([]).overall.nps).toBeNull();
  });

  test('per-survey rollup keeps surveys separate and averages raw scores', () => {
    const rows = [row(10, 'nps', true, 1), row(0, 'nps', true, 1), row(5, 'csat', true, 2)];
    const s = surveysService.buildSurveySummary(rows);
    const s1 = s.surveys.find((x) => x.id === 1);
    const s2 = s.surveys.find((x) => x.id === 2);
    expect(s1.nps).toBe(0);          // 1 promoter, 1 detractor
    expect(s1.avg_score).toBe(5);
    expect(s2.nps).toBe(100);        // CSAT 5 = promoter
    expect(s2.avg_score).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Account 360 feed
// ---------------------------------------------------------------------------

describe('Account 360 survey feed', () => {
  test('completed responses are org-scoped and land on the timeline', async () => {
    const COMPANY_ID = 99;
    const app = express();
    app.use(express.json());
    app.use(cookieParser(process.env.COOKIE_SECRET));
    app.use('/accounts', accountRoutes);

    const empty = { rows: [] };
    mockPool.query
      .mockResolvedValueOnce(authRow())                                        // 1 auth
      .mockResolvedValueOnce({ rows: [{ id: COMPANY_ID, name: 'Acme' }] })     // 2 company
      .mockResolvedValueOnce(empty)                                            // 3 deals
      .mockResolvedValueOnce(empty)                                            // 4 activities
      .mockResolvedValueOnce(empty)                                            // 5 tasks
      .mockResolvedValueOnce(empty)                                            // 6 issues
      .mockResolvedValueOnce(empty)                                            // 7 gmail summaries
      .mockResolvedValueOnce(empty)                                            // 8 email messages
      .mockResolvedValueOnce(empty)                                            // 9 calendar events
      .mockResolvedValueOnce(empty)                                            // 10 pulse
      .mockResolvedValueOnce(empty)                                            // 11 cases
      .mockResolvedValueOnce({                                                 // 12 survey responses
        rows: [{
          id: 71, survey_id: SURVEY_ID, score: 9, comment: 'Solid quarter',
          responded_at: '2026-07-02T12:00:00.000Z',
          survey_name: 'Q3 relationship check', survey_kind: 'nps',
        }],
      });

    const res = await request(app)
      .get(`/accounts/${COMPANY_ID}/360`).set('Cookie', authCookie());
    expect(res.status).toBe(200);

    // The survey query carries BOTH the company id and the caller's org scope.
    const surveyCall = mockPool.query.mock.calls.find(([sql]) => sql.includes('FROM survey_responses'));
    expect(surveyCall).toBeTruthy();
    expect(surveyCall[0]).toContain('org_id = $2');
    expect(surveyCall[0]).toContain('responded_at IS NOT NULL');
    expect(surveyCall[1]).toEqual([COMPANY_ID, ORG_ID]);

    const entry = res.body.timeline.find((e) => e.type === 'survey_response');
    expect(entry).toBeTruthy();
    expect(entry.meta.score).toBe(9);
    expect(entry.title).toContain('NPS response');
  });

  test('a failing survey read never 500s the 360 (try/catch-tolerant tail)', async () => {
    const COMPANY_ID = 99;
    const app = express();
    app.use(express.json());
    app.use(cookieParser(process.env.COOKIE_SECRET));
    app.use('/accounts', accountRoutes);

    const empty = { rows: [] };
    mockPool.query
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [{ id: COMPANY_ID, name: 'Acme' }] })
      .mockResolvedValueOnce(empty).mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty).mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty).mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty).mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty)                                            // cases
      .mockRejectedValueOnce(new Error('relation "survey_responses" does not exist'));

    const res = await request(app)
      .get(`/accounts/${COMPANY_ID}/360`).set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.timeline.some((e) => e.type === 'survey_response')).toBe(false);
  });
});
