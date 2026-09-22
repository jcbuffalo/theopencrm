// Platform AI budget guardrails (migration 174): trial slots, per-trial cap,
// monthly unbilled budget, once-per-month alerts through the dispatcher,
// auto-pause at 100%, and the provisioning gate.
process.env.AI_TRIAL_MAX_ACTIVE = '10';
process.env.AI_TRIAL_ORG_HARD_CAP_USD = '25';
process.env.AI_UNBILLED_MONTHLY_BUDGET_USD = '300';
process.env.PLATFORM_BUDGET_GATE_IN_TESTS = 'true'; // selfServeOrg skips the gate under NODE_ENV=test otherwise

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

const platformSettings = require('../services/platformSettings');
const platformBudget = require('../services/platformBudget');
const { createSelfServeOrg } = require('../services/selfServeOrg');
const emailActions = require('../services/emailActions');

// One configurable fake DB: trials count, spend micro-dollars, setting row,
// and an alert ledger that honours ON CONFLICT DO NOTHING.
function wire({ active = 0, trialMicro = 0, unbilledMicro = 0, allMicro = 0, enabled = true, superAdmin = true } = {}) {
  const state = { enabled, ledger: new Set(), settingsWrites: [], inserts: [] };
  platformSettings._clearCache(); // each wire() is a fresh world; the 30s read cache must not leak across
  mockPool.query.mockImplementation(async (sql, params) => {
    const s = String(sql);
    if (/COUNT\(\*\)::int AS active/i.test(s)) return { rows: [{ active }] };
    if (/AS unbilled_micro/i.test(s)) return { rows: [{ trial_micro: String(trialMicro), unbilled_micro: String(unbilledMicro), all_micro: String(allMicro) }] };
    if (/SELECT value FROM platform_settings/i.test(s)) return { rows: [{ value: state.enabled }] };
    if (/INSERT INTO platform_settings/i.test(s)) { state.enabled = JSON.parse(params[1]); state.settingsWrites.push([params[0], state.enabled, params[2]]); return { rows: [] }; }
    if (/INSERT INTO platform_budget_alerts/i.test(s)) {
      if (state.ledger.has(params[0])) return { rows: [] };
      state.ledger.add(params[0]);
      return { rows: [{ key: params[0] }] };
    }
    if (/INSERT INTO organizations/i.test(s)) { state.inserts.push([s, params]); return { rows: [{ id: 42 }] }; }
    if (/FROM admin_users WHERE user_id = \$1 AND role = 'super_admin'/i.test(s)) return { rows: superAdmin ? [{ '?column?': 1 }] : [] };
    if (/INSERT INTO email_action_tokens/i.test(s)) { state.token = { hash: params[2], user_id: params[1], action: params[3], entity_id: params[5], expires_at: new Date(Date.now() + params[7]) }; return { rows: [] }; }
    if (/FROM email_action_tokens t/i.test(s)) {
      return state.token && state.token.hash === params[0]
        ? { rows: [{ id: 1, org_id: null, user_id: state.token.user_id, action: state.token.action, entity_type: 'platform', entity_id: 1, params: {}, expires_at: state.token.expires_at, used_at: state.token.used_at || null, user_status: 'active' }] }
        : { rows: [] };
    }
    if (/UPDATE email_action_tokens SET used_at = NOW\(\)/i.test(s)) { if (state.token && !state.token.used_at) { state.token.used_at = new Date(); return { rows: [{ id: 1 }] }; } return { rows: [] }; }
    return { rows: [] };
  });
  return state;
}

beforeEach(() => { mockPool.query.mockReset(); platformSettings._clearCache(); });

describe('platformBudget.status', () => {
  test('reports slots, unbilled cost, percentages and the accepting verdict', async () => {
    wire({ active: 4, trialMicro: 12_500_000, unbilledMicro: 90_000_000, allMicro: 400_000_000 });
    const st = await platformBudget.status({ now: new Date('2026-09-22T12:00:00Z') });
    expect(st).toMatchObject({
      period: '2026-09', trials_enabled: true, accepting_trials: true, reason: null,
      active_trials: 4, trial_max_active: 10, trial_pct: 40, trial_org_hard_cap_usd: 25,
      mtd_trial_cost_usd: 12.5, mtd_unbilled_cost_usd: 90, mtd_all_cost_usd: 400, unbilled_budget_usd: 300, budget_pct: 30,
    });
  });

  test('verdict reasons: paused beats max_active beats budget', async () => {
    wire({ active: 10, unbilledMicro: 400_000_000, enabled: false });
    expect((await platformBudget.status()).reason).toBe('paused');
    wire({ active: 10, unbilledMicro: 400_000_000 });
    expect((await platformBudget.status()).reason).toBe('max_active');
    wire({ active: 2, unbilledMicro: 300_000_000 });
    expect((await platformBudget.status()).reason).toBe('budget');
  });

  test('effectiveHardCap caps trials at the trial cap and leaves paying orgs alone', () => {
    expect(platformBudget.effectiveHardCap({ ai_billing_status: 'trial', orgCapUsd: null, defaultCapUsd: 200 })).toBe(25);
    expect(platformBudget.effectiveHardCap({ ai_billing_status: 'trial', orgCapUsd: 10, defaultCapUsd: 200 })).toBe(10);
    expect(platformBudget.effectiveHardCap({ ai_billing_status: 'active', orgCapUsd: null, defaultCapUsd: 200 })).toBe(200);
    expect(platformBudget.effectiveHardCap({ ai_billing_status: 'active', orgCapUsd: 500, defaultCapUsd: 200 })).toBe(500);
  });
});

describe('createSelfServeOrg gate', () => {
  test('provisions a trial when accepting, no trial when slots are full, budget spent, or paused; fails CLOSED on a read error', async () => {
    let state = wire({ active: 1 });
    await createSelfServeOrg(mockPool, { name: 'A', ownerUserId: 1 });
    expect(state.inserts[0][0]).toMatch(/ai_billing_status, ai_billing_trial_ends_at/);

    state = wire({ active: 10 });
    await createSelfServeOrg(mockPool, { name: 'B', ownerUserId: 1 });
    expect(state.inserts[0][0]).not.toMatch(/ai_billing_status/);

    state = wire({ unbilledMicro: 300_000_000 });
    await createSelfServeOrg(mockPool, { name: 'C', ownerUserId: 1 });
    expect(state.inserts[0][0]).not.toMatch(/ai_billing_status/);

    state = wire({ enabled: false });
    await createSelfServeOrg(mockPool, { name: 'D', ownerUserId: 1 });
    expect(state.inserts[0][0]).not.toMatch(/ai_billing_status/);

    mockPool.query.mockImplementation(async (sql, params) => {
      if (/COUNT\(\*\)::int AS active/i.test(String(sql))) throw new Error('relation "organizations" does not exist');
      if (/INSERT INTO organizations/i.test(String(sql))) return { rows: [{ id: 1, sql: String(sql) }] };
      return { rows: [] };
    });
    const r = await createSelfServeOrg(mockPool, { name: 'E', ownerUserId: 1 });
    expect(r.sql).not.toMatch(/ai_billing_status/);
  });
});

describe('checkAndAlert', () => {
  test('fires each crossed threshold once per month, auto-pauses at 100% of budget, and never re-fires', async () => {
    const notify = vi.fn(async () => []);
    const state = wire({ active: 8, unbilledMicro: 250_000_000 }); // 83% budget, 80% slots
    let out = await platformBudget.checkAndAlert({ now: new Date('2026-09-22T12:00:00Z'), notify });
    expect(out.fired.sort()).toEqual(['trials:2026-09:80', 'unbilled:2026-09:50', 'unbilled:2026-09:80']);
    expect(out.paused).toBe(false);
    expect(notify).toHaveBeenCalledTimes(3);
    expect(notify.mock.calls.map((c) => `${c[0].kind}:${c[0].step}`).sort()).toEqual(['budget:50', 'budget:80', 'trials:80']);

    // Same tick again → nothing new.
    notify.mockClear();
    out = await platformBudget.checkAndAlert({ now: new Date('2026-09-22T13:00:00Z'), notify });
    expect(out.fired).toEqual([]);
    expect(notify).not.toHaveBeenCalled();

    // Budget blows past 100% → one more alert, trials auto-paused, ledger keeps earlier keys.
    mockPool.query.mockImplementation((mockPool.query.getMockImplementation()));
    const impl = mockPool.query.getMockImplementation();
    mockPool.query.mockImplementation(async (sql, params) => {
      if (/AS unbilled_micro/i.test(String(sql))) return { rows: [{ trial_micro: '0', unbilled_micro: '310000000', all_micro: '0' }] };
      return impl(sql, params);
    });
    out = await platformBudget.checkAndAlert({ now: new Date('2026-09-22T14:00:00Z'), notify });
    expect(out.fired).toEqual(['unbilled:2026-09:100']);
    expect(out.paused).toBe(true);
    expect(state.enabled).toBe(false);
    expect(notify.mock.calls[0][0]).toMatchObject({ kind: 'budget', step: 100, autoPaused: true });
    expect(notify.mock.calls[0][0].status.trials_enabled).toBe(false);
  });
});

describe('one-click pause/resume from the alert email', () => {
  test('a super-admin token flips the platform setting; a non-super-admin token is refused', async () => {
    let state = wire({ superAdmin: true });
    const { token } = await emailActions.mint({ orgId: null, userId: 1, action: 'platform.trials.pause', entityId: 1 });
    const out = await emailActions.apply(token);
    expect(out.ok).toBe(true);
    expect(state.settingsWrites).toEqual([['ai_trials_enabled', false, 1]]);

    state = wire({ superAdmin: false });
    const t2 = await emailActions.mint({ orgId: null, userId: 7, action: 'platform.trials.resume', entityId: 1 });
    const denied = await emailActions.apply(t2.token);
    expect(denied.ok).toBe(false);
    expect(denied.status).toBe(403);
    expect(state.settingsWrites).toEqual([]);
  });
});
