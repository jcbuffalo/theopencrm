// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// AI billing gate middleware — backend/middleware/requireAiBilling.js.
//
// COVERAGE (per spec):
//   - unconfigured → 402 AI_BILLING_REQUIRED, action: start_billing
//   - active       → next() (gate passes)
//   - comped       → next()
//   - trial w/ ai_billing_trial_ends_at in future → next();
//     past expiry → 402 AI_BILLING_TRIAL_EXPIRED
//   - past_due within 7-day grace → next();
//     past 7 days → 402 AI_BILLING_PAST_DUE
//   - halted w/ ai_halted_reason='payment_failed' → 402, payment-specific msg
//     'auto_threshold' → threshold-specific msg
//     otherwise (admin) → admin-specific msg
//   - super-admin user → next() regardless
//   - no req.orgId (personal workspace) → next()
//   - ai_billing_required feature flag explicitly false → next()
//   - DB error in readOrgBilling → fails open, next() called
//
// BYPASS GATE
//   The middleware has a hardcoded NODE_ENV=test bypass (lines 111-113). We
//   set AI_BILLING_REQUIRED_IN_TESTS=true in beforeEach so the gate runs
//   under vitest. We also reset the in-process caches between every test via
//   _resetCachesForTests().
//
// MOCKING STRATEGY
//   The middleware queries:
//     • admin_users   — via isSuperAdminCached (direct pool.query)
//     • organizations — via readOrgBilling   (direct pool.query)
//     • organizations.features — via featureFlags.hasFeature/getFeatures
//   We mock the pool for the first two and replace the featureFlags exports
//   in-place so we can drive both branches (enabled / disabled flag) without
//   queueing matched query responses for the JSONB column.

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

// Patch featureFlags so we don't have to queue per-test JSONB query rows.
// The middleware calls BOTH hasFeature() and getFeatures(); we drive them
// from the same stub object so a single helper toggles the gate.
const featureFlags = require('../services/featureFlags');
featureFlags.hasFeature  = vi.fn();
featureFlags.getFeatures = vi.fn();

// Bring-your-own key lookup (migration 153). The middleware calls
// orgAiKeys.getOrgKey through the module object; default it to "no key" so
// every pre-existing case below is unchanged, and flip it per-test in §10.
const orgAiKeys = require('../services/orgAiKeys');
orgAiKeys.getOrgKey = vi.fn().mockResolvedValue(null);

const requireAiBillingMod = require('../middleware/requireAiBilling');
const { requireAiBilling, _resetCachesForTests, PAST_DUE_GRACE_DAYS } = requireAiBillingMod;

// Helper — build a minimal Express-shaped (req, res, next) trio so each
// middleware case is just one function call. Supertest is overkill here.
function makeCtx({ orgId = 100, userId = 7 } = {}) {
  const req = { orgId, userId, log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } };
  const res = {
    status: vi.fn(function (code) { this.statusCode = code; return this; }),
    json:   vi.fn(function (body) { this.body = body; return this; }),
  };
  const next = vi.fn();
  return { req, res, next };
}

// Drive featureFlags: the flag is effective-on when it's explicitly true OR
// unset (because its registry defaultValue is true). Force it via the stub.
function flagOn() {
  featureFlags.hasFeature.mockResolvedValue(true);
  featureFlags.getFeatures.mockResolvedValue({ ai_billing_required: true });
}
function flagExplicitlyOff() {
  featureFlags.hasFeature.mockResolvedValue(false);
  featureFlags.getFeatures.mockResolvedValue({ ai_billing_required: false });
}

// Stub the admin_users SELECT used by isSuperAdminCached. The middleware
// queries by the user's id; we surface a row when the test wants the user
// elevated, otherwise empty.
function queueNotSuperAdmin() {
  mockPool.query.mockResolvedValueOnce({ rows: [] });
}
function queueSuperAdmin() {
  mockPool.query.mockResolvedValueOnce({ rows: [{ role: 'super_admin' }] });
}

// Stub the readOrgBilling SELECT.
function queueOrgRow(row) {
  mockPool.query.mockResolvedValueOnce({ rows: [row] });
}

beforeEach(() => {
  mockPool.query.mockReset();
  featureFlags.hasFeature.mockReset();
  featureFlags.getFeatures.mockReset();
  orgAiKeys.getOrgKey.mockReset();
  orgAiKeys.getOrgKey.mockResolvedValue(null);
  _resetCachesForTests();
  // Force the gate to run under vitest (default test env is bypassed). Lines
  // 111-113 of requireAiBilling.js gate on this env var.
  process.env.AI_BILLING_REQUIRED_IN_TESTS = 'true';
  // Default the flag to ON — most tests want the gate active.
  flagOn();
  // Default: caller is not super-admin.
  queueNotSuperAdmin();
});

afterEach(() => {
  delete process.env.AI_BILLING_REQUIRED_IN_TESTS;
});

// ---------------------------------------------------------------------------
// 1. No org context — personal workspace short-circuits before any DB query.
// ---------------------------------------------------------------------------
describe('requireAiBilling — no orgId', () => {
  test('personal workspace (no req.orgId) passes through', async () => {
    mockPool.query.mockReset(); // No DB calls expected at all
    const mw = requireAiBilling();
    const { req, res, next } = makeCtx({ orgId: null });
    await mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Feature flag explicitly off — gate disabled per-org.
// ---------------------------------------------------------------------------
describe('requireAiBilling — feature flag off', () => {
  test('ai_billing_required: false → next() without org-billing lookup', async () => {
    flagExplicitlyOff();
    const mw = requireAiBilling();
    const { req, res, next } = makeCtx();
    await mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Super-admin bypass — regardless of org status.
// ---------------------------------------------------------------------------
describe('requireAiBilling — super-admin bypass', () => {
  test('super_admin user → next() even when org is unconfigured', async () => {
    // Override the default not-super-admin row queued in beforeEach.
    mockPool.query.mockReset();
    queueSuperAdmin();
    const mw = requireAiBilling();
    const { req, res, next } = makeCtx();
    await mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Status: unconfigured → 402.
// ---------------------------------------------------------------------------
describe('requireAiBilling — unconfigured', () => {
  test('returns 402 AI_BILLING_REQUIRED + action start_billing', async () => {
    queueOrgRow({ ai_billing_status: 'unconfigured' });
    const mw = requireAiBilling();
    const { req, res, next } = makeCtx();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.body.code).toBe('AI_BILLING_REQUIRED');
    expect(res.body.action).toBe('start_billing');
    expect(res.body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Status: active and comped — both allowed.
// ---------------------------------------------------------------------------
describe('requireAiBilling — active / comped', () => {
  test('active → next()', async () => {
    queueOrgRow({ ai_billing_status: 'active' });
    const mw = requireAiBilling();
    const { req, res, next } = makeCtx();
    await mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('comped → next()', async () => {
    queueOrgRow({ ai_billing_status: 'comped' });
    const mw = requireAiBilling();
    const { req, res, next } = makeCtx();
    await mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Status: trial — future expiry passes, past expiry fails.
// ---------------------------------------------------------------------------
describe('requireAiBilling — trial', () => {
  test('trial w/ ai_billing_trial_ends_at in future → next()', async () => {
    const futureIso = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    queueOrgRow({ ai_billing_status: 'trial', ai_billing_trial_ends_at: futureIso });
    const mw = requireAiBilling();
    const { req, res, next } = makeCtx();
    await mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('trial past expiry → 402 AI_BILLING_TRIAL_EXPIRED', async () => {
    const pastIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    queueOrgRow({ ai_billing_status: 'trial', ai_billing_trial_ends_at: pastIso });
    const mw = requireAiBilling();
    const { req, res, next } = makeCtx();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.body.code).toBe('AI_BILLING_TRIAL_EXPIRED');
    expect(res.body.action).toBe('start_billing');
  });
});

// ---------------------------------------------------------------------------
// 7. Status: past_due — 7-day grace from updated_at.
// ---------------------------------------------------------------------------
describe('requireAiBilling — past_due', () => {
  test('within 7-day grace → next()', async () => {
    const recent = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    queueOrgRow({ ai_billing_status: 'past_due', updated_at: recent });
    const mw = requireAiBilling();
    const { req, res, next } = makeCtx();
    await mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('past 7 days → 402 AI_BILLING_PAST_DUE', async () => {
    const stale = new Date(
      Date.now() - (PAST_DUE_GRACE_DAYS + 1) * 24 * 60 * 60 * 1000
    ).toISOString();
    queueOrgRow({ ai_billing_status: 'past_due', updated_at: stale });
    const mw = requireAiBilling();
    const { req, res, next } = makeCtx();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.body.code).toBe('AI_BILLING_PAST_DUE');
    expect(res.body.action).toBe('update_payment');
  });
});

// ---------------------------------------------------------------------------
// 8. Status: halted — reason drives the message.
// ---------------------------------------------------------------------------
describe('requireAiBilling — halted (reason-specific messages)', () => {
  test('payment_failed reason → payment-specific message', async () => {
    queueOrgRow({ ai_billing_status: 'halted', ai_halted_reason: 'payment_failed' });
    const mw = requireAiBilling();
    const { req, res, next } = makeCtx();
    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.body.code).toBe('AI_BILLING_HALTED');
    expect(res.body.action).toBe('contact_admin');
    expect(res.body.error).toMatch(/payment failure/i);
  });

  test('auto_threshold reason → threshold-specific message', async () => {
    queueOrgRow({ ai_billing_status: 'halted', ai_halted_reason: 'auto_threshold' });
    const mw = requireAiBilling();
    const { req, res, next } = makeCtx();
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.body.code).toBe('AI_BILLING_HALTED');
    expect(res.body.error).toMatch(/threshold/i);
  });

  test('admin reason (default) → admin-specific message', async () => {
    queueOrgRow({ ai_billing_status: 'halted', ai_halted_reason: 'admin' });
    const mw = requireAiBilling();
    const { req, res, next } = makeCtx();
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.body.code).toBe('AI_BILLING_HALTED');
    expect(res.body.error).toMatch(/organization admin/i);
  });
});

// ---------------------------------------------------------------------------
// 10. Bring-your-own key (migration 153) — the org pays Anthropic directly,
//     so the gate lets it through BEFORE any status check and the verdict
//     says so. Nothing else is queried (the super-admin / org-billing rows
//     queued by beforeEach stay unconsumed).
// ---------------------------------------------------------------------------
describe('requireAiBilling — bring-your-own key', () => {
  test('unconfigured org WITH a BYO key → next(), no 402', async () => {
    orgAiKeys.getOrgKey.mockResolvedValue('sk-ant-org-key');
    queueOrgRow({ ai_billing_status: 'unconfigured' });
    const mw = requireAiBilling();
    const { req, res, next } = makeCtx();
    await mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(orgAiKeys.getOrgKey).toHaveBeenCalledWith(100);
    // Short-circuited before the admin_users / organizations lookups.
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('halted org WITH a BYO key → still allowed (their key, their bill)', async () => {
    orgAiKeys.getOrgKey.mockResolvedValue('sk-ant-org-key');
    queueOrgRow({ ai_billing_status: 'halted', ai_halted_reason: 'payment_failed' });
    const mw = requireAiBilling();
    const { req, res, next } = makeCtx();
    await mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('evaluateAiBilling reports status byo_key / reason byo_key', async () => {
    orgAiKeys.getOrgKey.mockResolvedValue('sk-ant-org-key');
    const verdict = await requireAiBillingMod.evaluateAiBilling({ orgId: 100, userId: 7 });
    expect(verdict).toMatchObject({ allowed: true, status: 'byo_key', reason: 'byo_key', code: null, action: null });
  });

  test('no BYO key → falls through to the normal status machine (unconfigured → 402)', async () => {
    queueOrgRow({ ai_billing_status: 'unconfigured' });
    const mw = requireAiBilling();
    const { req, res, next } = makeCtx();
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.body.code).toBe('AI_BILLING_REQUIRED');
  });
});

// ---------------------------------------------------------------------------
// 9. DB error in readOrgBilling → fails open, next() called.
// ---------------------------------------------------------------------------
describe('requireAiBilling — DB error', () => {
  test('readOrgBilling pool.query throws → next() (fail open)', async () => {
    // After the not-super-admin row queued in beforeEach, the next pool.query
    // is readOrgBilling. Make it reject.
    mockPool.query.mockRejectedValueOnce(new Error('connection refused'));
    const mw = requireAiBilling();
    const { req, res, next } = makeCtx();
    await mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.log.warn).toHaveBeenCalled();
  });
});
