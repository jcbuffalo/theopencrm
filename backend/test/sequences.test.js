// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Email sequences (migrations 132/133) — route + service + worker tests.
//
// Route tests mount sequenceRoutes in the exact index.js pattern (the
// campaigns_enabled gate at the mount, auth inside the router) with a
// SQL-shape pool mock for the two gate queries (users lookup +
// organizations.features) and a FIFO queue for route/service SQL — the
// hybrid of featureGate.test.js and recurringTasks.test.js. featureFlags
// caches features per-org for 30s in module state, so every route test gets
// a UNIQUE org id.
//
// Covered: feature-gate off → 403 / missing key → passes (the flipped
// campaigns_enabled default); org-scoped CRUD; enroll skips duplicates +
// sets next_send_at from the first step's delay; the send tick's
// suppression-first skip (unsubscribed contact → enrollment flips
// 'unsubscribed', transport never called); atomic-claim no-double-send;
// send → advance → complete; unconfigured-email degradation; and the
// worker's lease claim/skip/release.

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { requireFeature } = require('../middleware/featureGate');
const sequenceRoutes = require('../routes/sequenceRoutes');
const sequences = require('../services/sequences');
const sequenceWorker = require('../services/sequenceWorker');
const email = require('../services/email');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 6001;

// Unique org id per test — dodges featureFlags' 30s in-process cache.
let orgSeq = 80_000;
let ORG_ID = null;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  // Exact index.js mount shape: gate first, auth inside the router.
  app.use('/api/sequences', requireFeature('campaigns_enabled'), sequenceRoutes);
  return app;
}

// SQL-shape + FIFO hybrid mock. Auth (`FROM users`) and the feature lookup
// (`FROM organizations`) are shape-routed so they're stable no matter how
// often the gate/auth run; BEGIN/COMMIT/ROLLBACK are pass-through; everything
// else consumes the queue (default empty rows) and is recorded in `calls`
// for assertions.
let queue = [];
let calls = [];

function prime({ features = {} } = {}) {
  ORG_ID = ++orgSeq;
  queue = [];
  calls = [];
  mockPool.query.mockImplementation(async (sql, params) => {
    const text = String(sql);
    if (/FROM users/i.test(text)) {
      return { rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] };
    }
    if (/SELECT features(, profile)? FROM organizations/i.test(text)) {
      return { rows: [{ features }] };
    }
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(text)) {
      return { rows: [] };
    }
    calls.push([text, params]);
    return queue.length > 0 ? queue.shift() : { rows: [] };
  });
  mockPool.connect.mockImplementation(async () => ({
    query: mockPool.query,
    release: () => {},
  }));
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  mockPool.query.mockResolvedValue({ rows: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Feature gate — campaigns_enabled
// ---------------------------------------------------------------------------
describe('campaigns_enabled gate', () => {
  test('explicit false → 403 FEATURE_DISABLED, route SQL never runs', async () => {
    prime({ features: { campaigns_enabled: false } });

    const res = await request(buildApp())
      .get('/api/sequences')
      .set('Cookie', authCookie());

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
    expect(res.body.feature).toBe('campaigns_enabled');
    expect(calls.length).toBe(0);
  });

  test('missing key falls back to the flipped default (true) and passes', async () => {
    prime({ features: {} });
    queue.push({ rows: [] }); // list SELECT

    const res = await request(buildApp())
      .get('/api/sequences')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    expect(res.body.sequences).toEqual([]);
    // Test env has no transport — the UI banner flag rides along.
    expect(res.body.email_configured).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CRUD — org isolation
// ---------------------------------------------------------------------------
describe('sequence CRUD org scoping', () => {
  test('create stamps org_id + user_id and persists ordered steps', async () => {
    prime();
    queue.push({ rows: [{ id: 5, name: 'Onboarding', is_active: true }] }); // INSERT sequences

    const res = await request(buildApp())
      .post('/api/sequences')
      .set('Cookie', authCookie())
      .send({
        name: 'Onboarding',
        steps: [
          { delay_days: 0, subject: 'Welcome {{contact.name}}', body_template: 'Hi {{contact.name}}!' },
          { delay_days: 3, subject: 'Checking in', body_template: 'Still with us?' },
        ],
      });

    expect(res.status).toBe(201);
    const [seqSql, seqParams] = calls[0];
    expect(seqSql).toMatch(/INSERT INTO sequences/);
    expect(seqParams[0]).toBe(ORG_ID);
    expect(seqParams[1]).toBe(USER_ID);

    // Two step inserts, ordered 0 then 1, org denormalized onto each.
    const stepCalls = calls.filter(([sql]) => /INSERT INTO sequence_steps/.test(sql));
    expect(stepCalls.length).toBe(2);
    expect(stepCalls[0][1][2]).toBe(0);
    expect(stepCalls[1][1][2]).toBe(1);
    expect(stepCalls[1][1][3]).toBe(3); // delay_days
    expect(stepCalls[0][1][1]).toBe(ORG_ID);
  });

  test('create rejects a step missing a subject before any SQL', async () => {
    prime();

    const res = await request(buildApp())
      .post('/api/sequences')
      .set('Cookie', authCookie())
      .send({ name: 'Bad', steps: [{ delay_days: 1, body_template: 'no subject' }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/subject/);
    expect(calls.length).toBe(0);
  });

  test("GET /:id is tenant-scoped — another org's sequence 404s", async () => {
    prime();
    queue.push({ rows: [] }); // scoped SELECT misses

    const res = await request(buildApp())
      .get('/api/sequences/42')
      .set('Cookie', authCookie());

    expect(res.status).toBe(404);
    const [sql, params] = calls[0];
    expect(sql).toMatch(/WHERE id = \$1 AND org_id = \$2/);
    expect(params).toEqual(['42', ORG_ID]);
  });
});

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------
describe('POST /api/sequences/:id/enroll', () => {
  test('enrolls scoped contacts, skips duplicates, sets next_send_at from the first delay', async () => {
    prime();
    queue.push({ rows: [{ id: 9, first_delay_days: 2, step_count: 3 }] }); // sequence lookup
    queue.push({ rows: [{ id: 1, contact_id: 11 }, { id: 2, contact_id: 12 }] }); // INSERT (one conflict)

    const res = await request(buildApp())
      .post('/api/sequences/9/enroll')
      .set('Cookie', authCookie())
      .send({ contact_ids: [11, 12, 13] });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ enrolled: 2, skipped: 1 });

    const [insSql, insParams] = calls[1];
    // Double-enroll guard rides inside the INSERT itself.
    expect(insSql).toMatch(/ON CONFLICT \(sequence_id, contact_id\) DO NOTHING/);
    // First-step delay drives the initial due time.
    expect(insSql).toMatch(/NOW\(\) \+ \(\$4 \|\| ' days'\)::interval/);
    expect(insParams[3]).toBe('2');
    // Only contacts inside the caller's org can be enrolled.
    expect(insSql).toMatch(/c\.org_id = \$6/);
    expect(insParams[5]).toBe(ORG_ID);
    expect(insParams[0]).toBe(ORG_ID);
  });

  test('a sequence with no steps refuses enrollment with 400', async () => {
    prime();
    queue.push({ rows: [{ id: 9, first_delay_days: null, step_count: 0 }] });

    const res = await request(buildApp())
      .post('/api/sequences/9/enroll')
      .set('Cookie', authCookie())
      .send({ contact_ids: [11] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one step/);
    expect(calls.length).toBe(1); // no INSERT attempted
  });

  test("another org's sequence 404s without touching enrollments", async () => {
    prime();
    queue.push({ rows: [] }); // scoped sequence lookup misses

    const res = await request(buildApp())
      .post('/api/sequences/9/enroll')
      .set('Cookie', authCookie())
      .send({ contact_ids: [11] });

    expect(res.status).toBe(404);
    expect(calls.length).toBe(1);
  });

  test('stop only flips an ACTIVE enrollment, org-scoped', async () => {
    prime();
    queue.push({ rows: [{ id: 77, status: 'stopped' }] });

    const res = await request(buildApp())
      .post('/api/sequences/enrollments/77/stop')
      .set('Cookie', authCookie());

    expect(res.status).toBe(200);
    const [sql, params] = calls[0];
    expect(sql).toMatch(/SET status = 'stopped'/);
    expect(sql).toMatch(/AND status = 'active'/);
    expect(sql).toMatch(/org_id = \$2/);
    expect(params).toEqual(['77', ORG_ID]);
  });
});

// ---------------------------------------------------------------------------
// processDueEnrollments — the send tick
// ---------------------------------------------------------------------------

// A due enrollment row as the tick's scan query returns it.
function dueRow(overrides = {}) {
  return {
    id: 100,
    org_id: 7,
    user_id: 4,
    sequence_id: 9,
    contact_id: 3,
    current_step: 0,
    first_name: 'Ada',
    last_name: 'Lovelace',
    contact_email: 'ada@example.com',
    sequence_created_by: 4,
    sequence_name: 'Onboarding',
    ...overrides,
  };
}

const TWO_STEPS = [
  { id: 1, step_order: 0, delay_days: 0, subject: 'Hi {{contact.name}}', body_template: 'Hello {{contact.name}}, welcome!' },
  { id: 2, step_order: 1, delay_days: 3, subject: 'Step two', body_template: 'Body two' },
];

describe('sequences.processDueEnrollments', () => {
  test('does nothing (no claim, no send) when email is not configured', async () => {
    vi.spyOn(email, 'isConfigured').mockReturnValue(false);
    const sendSpy = vi.spyOn(email, 'sendMail');

    const out = await sequences.processDueEnrollments();

    expect(out.skipped).toBe('email_not_configured');
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  test('sends the due step, records it in email_sends, advances atomically, schedules the next delay', async () => {
    vi.spyOn(email, 'isConfigured').mockReturnValue(true);
    const sendSpy = vi.spyOn(email, 'sendMail').mockResolvedValue({ ok: true, kind: 'gmail', messageId: 'mid-1' });

    mockPool.query.mockReset();
    mockPool.query.mockResolvedValueOnce({ rows: [dueRow()] });      // 0 due scan
    mockPool.query.mockResolvedValueOnce({ rows: TWO_STEPS });       // 1 steps
    mockPool.query.mockResolvedValueOnce({ rows: [] });              // 2 suppression (clean)
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 100 }] });   // 3 atomic claim WON
    mockPool.query.mockResolvedValueOnce({ rows: [] });              // 4 unsub token INSERT
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 555 }] });   // 5 email_sends INSERT
    mockPool.query.mockResolvedValueOnce({ rows: [] });              // 6 provider_message_id UPDATE

    const out = await sequences.processDueEnrollments();

    expect(out).toMatchObject({ sent: 1, completed: 0, unsubscribed: 0, failed: 0 });

    // Suppression is checked BEFORE the claim/send.
    expect(mockPool.query.mock.calls[2][0]).toMatch(/FROM email_unsubscribes/);
    expect(mockPool.query.mock.calls[2][0]).toMatch(/unsubscribed_at IS NOT NULL/);
    expect(mockPool.query.mock.calls[2][1]).toEqual([7, 'ada@example.com']);

    // Atomic claim: advance is fenced on status + the exact expected step.
    const [claimSql, claimParams] = mockPool.query.mock.calls[3];
    expect(claimSql).toMatch(/SET current_step = current_step \+ 1/);
    expect(claimSql).toMatch(/WHERE id = \$1 AND status = 'active' AND current_step = \$2/);
    expect(claimParams[0]).toBe(100);
    expect(claimParams[1]).toBe(0);
    expect(claimParams[3]).toBe('3'); // next step's delay_days drives next_send_at

    // Dispatch recorded like every other CRM send.
    const [sendsSql, sendsParams] = mockPool.query.mock.calls[5];
    expect(sendsSql).toMatch(/INSERT INTO email_sends/);
    expect(sendsParams[0]).toBe(7);            // org
    expect(sendsParams[2]).toBe(3);            // contact
    expect(sendsParams[3]).toBe('ada@example.com');
    expect(sendsParams[4]).toBe('Hi Ada Lovelace'); // merge field resolved

    // Transport got the rendered content + an unsubscribe footer.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const mail = sendSpy.mock.calls[0][0];
    expect(mail.to).toBe('ada@example.com');
    expect(mail.subject).toBe('Hi Ada Lovelace');
    // The unsubscribe link is REQUIRED on drip mail: HTML footer, plain-text
    // footer (text-only clients) and the List-Unsubscribe header (one-click
    // in Gmail/Outlook) all point at the same public token URL.
    expect(mail.text).toMatch(/^Hello Ada Lovelace, welcome!\n\n--\nUnsubscribe from these messages: .*\/api\/emails\/unsubscribe\/[a-f0-9]{48}$/);
    expect(mail.html).toMatch(/\/api\/emails\/unsubscribe\//);
    expect(mail.html).toMatch(/\/api\/emails\/track\/555\.gif/);
    expect(mail.listUnsubscribe).toMatch(/\/api\/emails\/unsubscribe\/[a-f0-9]{48}$/);
    // No org sender identity on the row → platform default ("<Org> via …"),
    // no Reply-To.
    expect(mail.fromNameVerbatim).toBe(false);
    expect(mail.replyTo).toBeUndefined();
  });

  test('the last step completes the enrollment (status → completed, next_send_at NULL)', async () => {
    vi.spyOn(email, 'isConfigured').mockReturnValue(true);
    vi.spyOn(email, 'sendMail').mockResolvedValue({ ok: true, kind: 'gmail', messageId: 'mid-2' });

    mockPool.query.mockReset();
    mockPool.query.mockResolvedValueOnce({ rows: [dueRow({ current_step: 1 })] });
    mockPool.query.mockResolvedValueOnce({ rows: TWO_STEPS });
    mockPool.query.mockResolvedValueOnce({ rows: [] });              // suppression clean
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 100 }] });   // claim won
    mockPool.query.mockResolvedValueOnce({ rows: [] });              // token
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 556 }] });   // email_sends
    mockPool.query.mockResolvedValueOnce({ rows: [] });              // provider update

    const out = await sequences.processDueEnrollments();

    expect(out).toMatchObject({ sent: 1, completed: 1 });
    const claimSql = mockPool.query.mock.calls[3][0];
    expect(claimSql).toMatch(/status\s+= 'completed'/);
    expect(claimSql).toMatch(/next_send_at = NULL/);
  });

  test('an unsubscribed contact is NEVER emailed — enrollment flips to unsubscribed', async () => {
    vi.spyOn(email, 'isConfigured').mockReturnValue(true);
    const sendSpy = vi.spyOn(email, 'sendMail');

    mockPool.query.mockReset();
    mockPool.query.mockResolvedValueOnce({ rows: [dueRow()] });
    mockPool.query.mockResolvedValueOnce({ rows: TWO_STEPS });
    mockPool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }); // suppression HIT
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 100 }] });       // status UPDATE

    const out = await sequences.processDueEnrollments();

    expect(out).toMatchObject({ sent: 0, unsubscribed: 1 });
    expect(sendSpy).not.toHaveBeenCalled();
    const [flipSql] = mockPool.query.mock.calls[3];
    expect(flipSql).toMatch(/SET status = 'unsubscribed'/);
    // Exactly 4 queries — no token, no email_sends row, no claim.
    expect(mockPool.query).toHaveBeenCalledTimes(4);
  });

  test('a lost atomic claim (concurrent tick already advanced) sends nothing', async () => {
    vi.spyOn(email, 'isConfigured').mockReturnValue(true);
    const sendSpy = vi.spyOn(email, 'sendMail');

    mockPool.query.mockReset();
    mockPool.query.mockResolvedValueOnce({ rows: [dueRow()] });
    mockPool.query.mockResolvedValueOnce({ rows: TWO_STEPS });
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // suppression clean
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // claim LOST

    const out = await sequences.processDueEnrollments();

    expect(out).toMatchObject({ sent: 0, failed: 0 });
    expect(sendSpy).not.toHaveBeenCalled();
    expect(mockPool.query).toHaveBeenCalledTimes(4); // nothing after the lost claim
  });

  test('a transport failure after the claim is logged, never re-sent, never fails the tick', async () => {
    vi.spyOn(email, 'isConfigured').mockReturnValue(true);
    vi.spyOn(email, 'sendMail').mockRejectedValue(new Error('smtp 421'));

    mockPool.query.mockReset();
    mockPool.query.mockResolvedValueOnce({ rows: [dueRow()] });
    mockPool.query.mockResolvedValueOnce({ rows: TWO_STEPS });
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 100 }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 557 }] });

    const out = await sequences.processDueEnrollments();

    // Step counts as consumed (claim-before-send: skip beats double-send).
    expect(out).toMatchObject({ sent: 1, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
// sequenceWorker — leased tick
// ---------------------------------------------------------------------------
describe('sequenceWorker.tick', () => {
  test('skips without a lease when email is unconfigured', async () => {
    vi.spyOn(email, 'isConfigured').mockReturnValue(false);
    mockPool.query.mockReset();

    const out = await sequenceWorker.tick();

    expect(out.skipped).toBe('email_not_configured');
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('skips the period when another instance holds the lease', async () => {
    vi.spyOn(email, 'isConfigured').mockReturnValue(true);
    mockPool.query.mockReset();
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // claim lost

    const out = await sequenceWorker.tick();

    expect(out.skipped).toBe(true);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(mockPool.query.mock.calls[0][0]).toMatch(/INSERT INTO worker_runs/);
    expect(mockPool.query.mock.calls[0][1][0]).toBe('sequence_send');
  });

  test('winning the lease runs the send tick; a thrown tick releases the lease', async () => {
    vi.spyOn(email, 'isConfigured').mockReturnValue(true);

    // Won lease + idle scan.
    mockPool.query.mockReset();
    mockPool.query.mockResolvedValueOnce({ rows: [{ claimed_at: new Date().toISOString() }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // due scan idle
    let out = await sequenceWorker.tick();
    expect(out).toMatchObject({ sent: 0 });

    // Won lease + scan explodes → lease released for retry.
    mockPool.query.mockReset();
    mockPool.query.mockResolvedValueOnce({ rows: [{ claimed_at: new Date().toISOString() }] });
    mockPool.query.mockRejectedValueOnce(new Error('db went away'));
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // release
    out = await sequenceWorker.tick();
    expect(out.error).toBe('db went away');
    expect(mockPool.query.mock.calls[2][0]).toMatch(/DELETE FROM worker_runs/);
    expect(mockPool.query.mock.calls[2][1][0]).toBe('sequence_send');
  });

  test('period keys bucket by the interval so exactly one lease exists per window', () => {
    const t = new Date('2026-07-13T14:22:31.000Z');
    expect(sequenceWorker.periodKey(t, 15)).toBe('2026-07-13T14:15');
    expect(sequenceWorker.periodKey(new Date('2026-07-13T14:29:59.000Z'), 15)).toBe('2026-07-13T14:15');
    expect(sequenceWorker.periodKey(new Date('2026-07-13T14:30:00.000Z'), 15)).toBe('2026-07-13T14:30');
  });
});
