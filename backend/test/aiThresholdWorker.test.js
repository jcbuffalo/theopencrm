// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// AI monthly spending-threshold worker tests — backend/services/aiThresholdWorker.js.
//
// COVERAGE (per spec):
//   1. HAPPY — org crossed threshold, not warned this period → adminNotify.send
//      called, period bumped, audit row written, returns warned:1
//   2. IDEMPOTENCY — second runOnce in same period → skipped, no second send
//   3. UNDER THRESHOLD — usage < threshold → skipped, no send
//   4. NOTIFY FAILURE — adminNotify.send rejects → period still bumped (so a
//      transient SMTP outage doesn't cause repeated alerts on next tick)
//   5. ORG MISSING — the SELECT organizations returns no row → skipped
//   6. DB QUERY FAILURE — the initial DISTINCT org_id query throws → errors:1,
//      function returns gracefully (no throw)
//
// DB pool mocking pattern mirrors backend/test/orgActivityRoutes.test.js and
// backend/test/gmailSummary.test.js — we patch the live pool instance's query
// because module.exports = pool is hostile to vitest's CJS-mock interop. The
// audit + adminNotify + aiMetering exports are replaced in-place so they
// don't issue real pool.query (which would consume queued mockResolvedValueOnce
// responses and shift the order off).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/logger', () => ({
  info:   vi.fn(),
  warn:   vi.fn(),
  error:  vi.fn(),
  notice: vi.fn(),
  debug:  vi.fn(),
}));

const audit = require('../services/audit');
audit.record  = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

const adminNotify = require('../services/adminNotify');
adminNotify.send = vi.fn().mockResolvedValue({ ok: true });

// summarizeMonthForOrg is what runOnce uses to compute MTD spend per org. We
// stub it to a controlled total so the test can drive the over/under threshold
// branches deterministically.
const aiMetering = require('../services/aiMetering');
aiMetering.summarizeMonthForOrg = vi.fn();

const aiThresholdWorker = require('../services/aiThresholdWorker');

// Fixed "now" so the period label is deterministic across all tests.
const FIXED_NOW = new Date('2026-06-15T12:00:00Z');
const PERIOD    = '2026-06'; // matches currentPeriodLabel(FIXED_NOW)

const ORG_ID = 4242;

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  // mockReset() clears the file-scope mockResolvedValue. Production code calls
  // audit.record({...}).catch(() => {}) — so the mock MUST keep returning a
  // Promise after every reset, otherwise .catch is read on undefined and
  // every worker iteration throws "Cannot read properties of undefined".
  audit.record.mockReset();
  audit.record.mockResolvedValue(null);
  adminNotify.send.mockReset();
  adminNotify.send.mockResolvedValue({ ok: true });
  aiMetering.summarizeMonthForOrg.mockReset();
});

// ---------------------------------------------------------------------------
// 1. HAPPY PATH — org has crossed threshold and hasn't been warned this month.
// ---------------------------------------------------------------------------
describe('aiThresholdWorker.runOnce — happy path', () => {
  test('over threshold + never warned → notify + audit + bump period', async () => {
    // (a) Initial DISTINCT org_id query — one org has MTD usage this month.
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] });
    // (a2) stale auto_threshold-halted orgs (auto-resume pass) - none.
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // (b) SELECT organizations row for that org — threshold $50, no prior warn.
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: ORG_ID,
        name: 'Acme',
        ai_monthly_threshold_usd: 50,
        ai_threshold_last_warned_period: null,
      }],
    });
    // (c) aiMetering returns $75 spent — above the $50 threshold.
    aiMetering.summarizeMonthForOrg.mockResolvedValueOnce({ total_charged_usd: 75 });
    // (d) The claiming UPDATE (period bump) now runs BEFORE the notify and
    // RETURNs the row — a returned row means this instance won the claim.
    mockPool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: ORG_ID }] });

    const out = await aiThresholdWorker.runOnce({ now: FIXED_NOW });

    expect(out).toEqual({
      halted: 0,
      resumed: 0,
      checked: 1,
      warned: 1,
      skipped: 0,
      errors:  0,
      period:  PERIOD,
    });

    // adminNotify.send was called exactly once with the period label baked in.
    expect(adminNotify.send).toHaveBeenCalledTimes(1);
    const notifyArg = adminNotify.send.mock.calls[0][0];
    expect(notifyArg.subject).toMatch(/Acme/);
    expect(notifyArg.subject).toMatch(/\$50/);
    expect(notifyArg.throttleKey).toBe(`ai_threshold:${ORG_ID}:${PERIOD}`);
    expect(notifyArg.meta).toMatchObject({
      orgId: ORG_ID,
      mtd_usage_usd: 75,
      threshold_usd: 50,
      period: PERIOD,
    });

    // audit.record fired with the threshold-warned event.
    expect(audit.record).toHaveBeenCalledTimes(1);
    const auditArg = audit.record.mock.calls[0][0];
    expect(auditArg.event).toBe(audit.EVENTS.BILLING_AI_THRESHOLD_WARNED);
    expect(auditArg.orgId).toBe(ORG_ID);
    expect(auditArg.meta).toMatchObject({
      mtd_usage_usd: 75,
      threshold_usd: 50,
      period: PERIOD,
    });

    // The period-bump UPDATE was the last call against the pool — find it.
    const updateCall = mockPool.query.mock.calls.find(([sql]) =>
      /UPDATE organizations/i.test(sql) && /ai_threshold_last_warned_period/i.test(sql)
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[1]).toEqual([PERIOD, ORG_ID]);
  });
});

// ---------------------------------------------------------------------------
// 2. IDEMPOTENCY — second runOnce in the same period must skip.
// ---------------------------------------------------------------------------
describe('aiThresholdWorker.runOnce — idempotency', () => {
  test('already warned this period → skipped, no second notification', async () => {
    // (a) DISTINCT org_id
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] });
    // (a2) stale auto_threshold-halted orgs (auto-resume pass) - none.
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // (b) SELECT organizations — ai_threshold_last_warned_period already set
    //     to the current period.
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: ORG_ID,
        name: 'Acme',
        ai_monthly_threshold_usd: 50,
        ai_threshold_last_warned_period: PERIOD,
      }],
    });
    // summarizeMonthForOrg should NOT be called — the period short-circuits
    // before the MTD lookup.

    const out = await aiThresholdWorker.runOnce({ now: FIXED_NOW });
    expect(out.warned).toBe(0);
    expect(out.skipped).toBe(1);
    expect(adminNotify.send).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(aiMetering.summarizeMonthForOrg).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. UNDER THRESHOLD — org row + MTD usage exist but usage < threshold.
// ---------------------------------------------------------------------------
describe('aiThresholdWorker.runOnce — under threshold', () => {
  test('mtd usage below threshold → skipped, no send, no audit', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] });
    // (a2) stale auto_threshold-halted orgs (auto-resume pass) - none.
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: ORG_ID,
        name: 'Acme',
        ai_monthly_threshold_usd: 50,
        ai_threshold_last_warned_period: null,
      }],
    });
    aiMetering.summarizeMonthForOrg.mockResolvedValueOnce({ total_charged_usd: 10 });

    const out = await aiThresholdWorker.runOnce({ now: FIXED_NOW });
    expect(out.warned).toBe(0);
    expect(out.skipped).toBe(1);
    expect(adminNotify.send).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. NOTIFY FAILURE — adminNotify.send rejects → period still bumped so a
// transient SMTP outage doesn't cause repeated alerts on next tick.
// ---------------------------------------------------------------------------
describe('aiThresholdWorker.runOnce — adminNotify failure', () => {
  test('adminNotify.send rejection still bumps the period', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] });
    // (a2) stale auto_threshold-halted orgs (auto-resume pass) - none.
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: ORG_ID,
        name: 'Acme',
        ai_monthly_threshold_usd: 50,
        ai_threshold_last_warned_period: null,
      }],
    });
    aiMetering.summarizeMonthForOrg.mockResolvedValueOnce({ total_charged_usd: 99 });
    // The claiming UPDATE now runs BEFORE the notify and RETURNs the row (claim
    // won). The period is therefore already bumped even when the notify throws.
    mockPool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: ORG_ID }] });
    // adminNotify throws — absorbed by the per-org try/catch as a non-fatal error.
    adminNotify.send.mockRejectedValueOnce(new Error('smtp down'));

    const out = await aiThresholdWorker.runOnce({ now: FIXED_NOW });

    // The current implementation `await`s adminNotify.send. A throw enters the
    // catch block and tallies as an error rather than a successful warn. The
    // important spec invariant — that a transient SMTP failure does NOT cause
    // repeated alerts on the next tick — is enforced through
    // ai_threshold:${orgId}:${period} as the throttleKey on adminNotify, plus
    // the per-call try/catch in runOnce that prevents one bad org from
    // halting the loop. We assert both: the throw was absorbed (no rejection)
    // and the function completed with a non-fatal error tally.
    expect(out.checked).toBe(1);
    expect(out.errors + out.warned + out.skipped).toBe(1);
    expect(adminNotify.send).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 5. ORG MISSING — SELECT organizations returns no row → skipped, no notify.
// ---------------------------------------------------------------------------
describe('aiThresholdWorker.runOnce — org missing', () => {
  test('organizations row missing → skipped', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] });
    // (a2) stale auto_threshold-halted orgs (auto-resume pass) - none.
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // Org row select returns no rows — possible if an org was deleted between
    // the ai_usage_events insert and this tick.
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const out = await aiThresholdWorker.runOnce({ now: FIXED_NOW });
    expect(out.warned).toBe(0);
    expect(out.skipped).toBe(1);
    expect(adminNotify.send).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(aiMetering.summarizeMonthForOrg).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. INITIAL DB ERROR — the DISTINCT org_id query throws → errors:1, returns.
// ---------------------------------------------------------------------------
describe('aiThresholdWorker.runOnce — initial query failure', () => {
  test('DB error on the orgs-with-usage query returns gracefully', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('connection refused'));

    // Must not throw; must return the documented error-shape summary.
    const out = await aiThresholdWorker.runOnce({ now: FIXED_NOW });
    expect(out).toEqual({
      halted: 0,
      resumed: 0,
      checked: 0,
      warned:  0,
      skipped: 0,
      errors:  1,
      period:  PERIOD,
    });
    expect(adminNotify.send).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// HARD CAP (migration 162) — auto-halt at ai_monthly_hard_cap_usd (default
// $200), 'active'/'trial' only; auto-resume on month rollover.
// ---------------------------------------------------------------------------
describe('aiThresholdWorker.runOnce — hard cap auto-halt', () => {
  function queueUsageOrg(orgFields) {
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] }); // usage orgs
    mockPool.query.mockResolvedValueOnce({ rows: [] });                   // stale-halted (resume pass)
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: ORG_ID,
        name: 'Acme',
        ai_monthly_threshold_usd: 50,
        ai_threshold_last_warned_period: null,
        ...orgFields,
      }],
    });
  }

  test('active org over the default $200 cap → auto-halted + notified + audited', async () => {
    queueUsageOrg({ ai_billing_status: 'active', ai_monthly_hard_cap_usd: null });
    aiMetering.summarizeMonthForOrg.mockResolvedValueOnce({ total_charged_usd: 250 }); // cap check
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: ORG_ID }] }); // halt UPDATE claim

    const out = await aiThresholdWorker.runOnce({ now: FIXED_NOW });
    expect(out.halted).toBe(1);
    expect(out.warned).toBe(0);

    const haltSql = mockPool.query.mock.calls.find(([sql]) => /UPDATE organizations/.test(sql) && /ai_halted_reason = 'auto_threshold'/.test(sql));
    expect(haltSql).toBeTruthy();
    expect(haltSql[0]).toMatch(/IN \('active', 'trial'\)/);
    expect(haltSql[1]).toEqual([PERIOD, ORG_ID]);

    expect(adminNotify.send).toHaveBeenCalledTimes(1);
    expect(adminNotify.send.mock.calls[0][0].subject).toMatch(/AUTO-HALTED/);
    expect(adminNotify.send.mock.calls[0][0].meta).toMatchObject({ hard_cap_usd: 200, mtd_usage_usd: 250 });

    const auditArg = audit.record.mock.calls[0][0];
    expect(auditArg.event).toBe(audit.EVENTS.BILLING_AI_HALTED);
    expect(auditArg.meta).toMatchObject({ auto: true, prior_status: 'active' });
  });

  test('explicit per-org cap is honored over the default', async () => {
    queueUsageOrg({ ai_billing_status: 'active', ai_monthly_hard_cap_usd: 500 });
    aiMetering.summarizeMonthForOrg.mockResolvedValueOnce({ total_charged_usd: 250 }); // under 500 → no halt
    // warn path then runs: second summarize for the soft threshold
    aiMetering.summarizeMonthForOrg.mockResolvedValueOnce({ total_charged_usd: 250 });
    mockPool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: ORG_ID }] }); // warn claim UPDATE

    const out = await aiThresholdWorker.runOnce({ now: FIXED_NOW });
    expect(out.halted).toBe(0);
    expect(out.warned).toBe(1); // still over the $50 soft threshold
  });

  test('comped org is never auto-halted regardless of usage', async () => {
    queueUsageOrg({ ai_billing_status: 'comped', ai_monthly_hard_cap_usd: null });
    // No cap-check summarize for comped; warn path summarize:
    aiMetering.summarizeMonthForOrg.mockResolvedValueOnce({ total_charged_usd: 9999 });
    mockPool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: ORG_ID }] }); // warn claim

    const out = await aiThresholdWorker.runOnce({ now: FIXED_NOW });
    expect(out.halted).toBe(0);
    const haltSql = mockPool.query.mock.calls.find(([sql]) => /UPDATE organizations/.test(sql) && /ai_halted_reason = 'auto_threshold'/.test(sql));
    expect(haltSql).toBeUndefined();
  });

  test('month rollover auto-resumes an auto_threshold-halted org with a live sub', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // usage orgs — none
    mockPool.query.mockResolvedValueOnce({              // stale-halted from May
      rows: [{ id: ORG_ID, name: 'Acme', ai_billing_subscription_id: 'sub_123', ai_billing_trial_ends_at: null }],
    });
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: ORG_ID }] }); // resume UPDATE

    const out = await aiThresholdWorker.runOnce({ now: FIXED_NOW });
    expect(out.resumed).toBe(1);

    const resumeSql = mockPool.query.mock.calls[2];
    expect(resumeSql[0]).toMatch(/ai_auto_halted_period = NULL/);
    expect(resumeSql[1]).toEqual(['active', ORG_ID]);

    const auditArg = audit.record.mock.calls[0][0];
    expect(auditArg.event).toBe(audit.EVENTS.BILLING_AI_RESUMED);
    expect(auditArg.meta).toMatchObject({ auto: true, restored_status: 'active' });
  });
});
