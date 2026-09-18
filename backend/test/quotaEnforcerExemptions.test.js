// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// AI-quota exemptions (sell-readiness P0).
//
// The free-tier AI cap (50 calls/user/mo) must NOT 429 orgs that are
// already paying for their AI usage another way:
//   • ai_billing_status = 'active'  — metered Stripe plan, billed per call
//   • ai_billing_status = 'comped'  — operator explicitly waived billing
//   • a stored BYO Anthropic key    — org pays Anthropic directly
// Everyone else keeps the historical tier-based behavior.

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();

const orgAiKeys = require('../services/orgAiKeys');
const quotaEnforcer = require('../services/quotaEnforcer');

const ORG_ID = 42;

// Queue: 1. org billing row (tier + ai_billing_status).
function queueOrgRow({ tier = 'free', ai_billing_status = 'unconfigured' } = {}) {
  mockPool.query.mockResolvedValueOnce({ rows: [{ tier, ai_billing_status }] });
}
// Queue: 2. ai_usage_events monthly count.
function queueUsageCount(calls) {
  mockPool.query.mockResolvedValueOnce({ rows: [{ calls }] });
}

function usageCountWasQueried() {
  return mockPool.query.mock.calls.some(
    ([sql]) => typeof sql === 'string' && /ai_usage_events/.test(sql)
  );
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.query.mockResolvedValue({ rows: [] });
  vi.restoreAllMocks();
});

describe('checkAiQuota — free-tier enforcement still fires', () => {
  test('free org at/over its cap throws QuotaExceeded (429)', async () => {
    queueOrgRow({ tier: 'free', ai_billing_status: 'unconfigured' });
    queueUsageCount(50); // cap = 50 × 1 seat

    await expect(
      quotaEnforcer.checkAiQuota({ orgId: ORG_ID, userCount: 1 })
    ).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      statusCode: 429,
      details: { orgId: ORG_ID, tier: 'free', metric: 'ai_requests', limit: 50, current: 50 },
    });
  });

  test('free org under its cap passes', async () => {
    queueOrgRow({ tier: 'free', ai_billing_status: 'unconfigured' });
    queueUsageCount(49);
    await expect(
      quotaEnforcer.checkAiQuota({ orgId: ORG_ID, userCount: 1 })
    ).resolves.toBeUndefined();
  });

  test('legacy mock shape (tier only, no ai_billing_status) still enforces', async () => {
    // Back-compat: a row without ai_billing_status is NOT exempt.
    mockPool.query.mockResolvedValueOnce({ rows: [{ tier: 'free' }] });
    queueUsageCount(50);
    await expect(
      quotaEnforcer.checkAiQuota({ orgId: ORG_ID, userCount: 1 })
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });
});

describe('checkAiQuota — paying/comped/BYO-key exemptions', () => {
  test("ai_billing_status='active' (paying) org is never capped", async () => {
    queueOrgRow({ tier: 'free', ai_billing_status: 'active' });
    // No usage count queued: the exemption must short-circuit before counting.
    await expect(
      quotaEnforcer.checkAiQuota({ orgId: ORG_ID, userCount: 1 })
    ).resolves.toBeUndefined();
    expect(usageCountWasQueried()).toBe(false);
  });

  test("ai_billing_status='comped' org is never capped", async () => {
    queueOrgRow({ tier: 'free', ai_billing_status: 'comped' });
    await expect(
      quotaEnforcer.checkAiQuota({ orgId: ORG_ID, userCount: 1 })
    ).resolves.toBeUndefined();
    expect(usageCountWasQueried()).toBe(false);
  });

  test('org with a BYO Anthropic key is never capped', async () => {
    queueOrgRow({ tier: 'free', ai_billing_status: 'unconfigured' });
    vi.spyOn(orgAiKeys, 'getOrgKey').mockResolvedValue('sk-ant-test-byo-key-1234567890');
    await expect(
      quotaEnforcer.checkAiQuota({ orgId: ORG_ID, userCount: 1 })
    ).resolves.toBeUndefined();
    expect(usageCountWasQueried()).toBe(false);
  });

  test("'past_due' billing status is NOT exempt", async () => {
    queueOrgRow({ tier: 'free', ai_billing_status: 'past_due' });
    queueUsageCount(50);
    await expect(
      quotaEnforcer.checkAiQuota({ orgId: ORG_ID, userCount: 1 })
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  // Org-less (personal-workspace) users bypass the AI billing gate entirely
  // (`allow('personal')`), so the free per-user cap here is their ONLY meter.
  describe('org-less users', () => {
    test('under the free per-user cap → allowed (counted by user_id)', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ n: 10 }] }); // user month count
      await expect(
        quotaEnforcer.checkAiQuota({ orgId: null, userId: 777 })
      ).resolves.toBeUndefined();
      const [sql, params] = mockPool.query.mock.calls[0];
      expect(sql).toMatch(/ai_usage_events/);
      expect(sql).toMatch(/user_id = \$1/);
      expect(params).toEqual([777]);
    });

    test('at the free per-user cap → QUOTA_EXCEEDED', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ n: 50 }] });
      await expect(
        quotaEnforcer.checkAiQuota({ orgId: null, userId: 777 })
      ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    });

    test('no orgId AND no userId → unmetered no-op (nothing to key on)', async () => {
      await expect(quotaEnforcer.checkAiQuota({ orgId: null })).resolves.toBeUndefined();
      expect(mockPool.query).not.toHaveBeenCalled();
    });
  });
});
