// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Self-host gateway client side (spec 202):
//   • services/ai.js resolveApiKey fallback order (BYO → platform → gateway)
//   • the gateway URL join — the resolved endpoint MUST be exactly
//     <base>/v1/messages, the same join the Anthropic Node SDK performs on a
//     custom baseURL (client.messages.create → POST `${baseURL}/v1/messages`),
//     so it hits the platform mount /api/gateway/v1/messages verbatim
//   • quotaEnforcer gateway exemption (a configured gateway key skips the
//     local free-tier quota, like BYO — the gateway enforces billing-side)
//   • requireAiBilling.evaluateAiBilling reports mode 'gateway' where BYO
//     reports 'byo_key'
//
// All the gateway/platform env reads are per-call (no module-load capture),
// so env is staged per test and restored in afterEach — no module juggling.
// The pool is patched at the live instance (module.exports = pool is hostile
// to vitest's CJS-mock interop — same note as every other suite).

const realPool = require('../db');
const mockQuery = vi.fn();
realPool.query = mockQuery;
realPool.connect = vi.fn();

const ai = require('../services/ai');
const quotaEnforcer = require('../services/quotaEnforcer');
const requireAiBilling = require('../middleware/requireAiBilling');
const featureFlags = require('../services/featureFlags');

const GATEWAY_KEY = 'ocrm_gw_' + 'C'.repeat(43);

const savedEnv = {};
function stageEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k];
  }
  mockQuery.mockReset();
});

describe('gateway URL join (the SDK-baseURL contract)', () => {
  it('default base joins to https://app.theopencrm.com/api/gateway/v1/messages', () => {
    stageEnv({ OPENCRM_AI_GATEWAY_URL: undefined });
    expect(ai.gatewayMessagesUrl()).toBe('https://app.theopencrm.com/api/gateway/v1/messages');
  });

  it('a custom base with a trailing slash still joins to exactly <base>/v1/messages', () => {
    stageEnv({ OPENCRM_AI_GATEWAY_URL: 'https://crm.example.com/api/gateway/' });
    expect(ai.gatewayMessagesUrl()).toBe('https://crm.example.com/api/gateway/v1/messages');
  });
});

describe('resolveApiKey fallback order', () => {
  it('gateway key is used when no platform key exists (billingMode gateway + endpoint set)', async () => {
    stageEnv({ ANTHROPIC_API_KEY: undefined, OPENCRM_AI_GATEWAY_KEY: GATEWAY_KEY, OPENCRM_AI_GATEWAY_URL: undefined });
    const creds = await ai.resolveApiKey(null);
    expect(creds).toEqual({
      key: GATEWAY_KEY,
      billingMode: 'gateway',
      endpoint: 'https://app.theopencrm.com/api/gateway/v1/messages',
    });
    // Configured probes must report true in gateway mode.
    expect(ai.isConfigured()).toBe(true);
    expect(await ai.isConfiguredForOrg(null)).toBe(true);
  });

  it('the platform ANTHROPIC_API_KEY wins over a configured gateway key', async () => {
    stageEnv({ ANTHROPIC_API_KEY: 'sk-ant-platform', OPENCRM_AI_GATEWAY_KEY: GATEWAY_KEY });
    const creds = await ai.resolveApiKey(null);
    expect(creds.billingMode).toBe('platform');
    expect(creds.key).toBe('sk-ant-platform');
    expect(creds.endpoint).toBeUndefined(); // direct Anthropic endpoint
  });

  it('returns null (AI not configured) when neither key exists', async () => {
    stageEnv({ ANTHROPIC_API_KEY: undefined, OPENCRM_AI_GATEWAY_KEY: undefined });
    expect(await ai.resolveApiKey(null)).toBeNull();
    expect(ai.isConfigured()).toBe(false);
  });
});

describe('quotaEnforcer gateway exemption', () => {
  it('a configured gateway key skips the local free-tier quota entirely (no DB reads)', async () => {
    stageEnv({ ANTHROPIC_API_KEY: undefined, OPENCRM_AI_GATEWAY_KEY: GATEWAY_KEY });
    expect(quotaEnforcer.isGatewayMode()).toBe(true);
    await expect(quotaEnforcer.checkAiQuota({ orgId: 1, userId: 2, userCount: 1 })).resolves.toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('is NOT gateway mode when a platform key exists (normal quota path applies)', () => {
    stageEnv({ ANTHROPIC_API_KEY: 'sk-ant-platform', OPENCRM_AI_GATEWAY_KEY: GATEWAY_KEY });
    expect(quotaEnforcer.isGatewayMode()).toBe(false);
  });
});

describe('evaluateAiBilling reports gateway mode', () => {
  beforeEach(() => requireAiBilling._resetCachesForTests());

  it("allows with status 'gateway' on a gateway-mode instance (mirror of byo_key)", async () => {
    stageEnv({ ANTHROPIC_API_KEY: undefined, OPENCRM_AI_GATEWAY_KEY: GATEWAY_KEY });
    const verdict = await requireAiBilling.evaluateAiBilling({ orgId: 1, userId: 2 });
    expect(verdict.allowed).toBe(true);
    expect(verdict.status).toBe('gateway');
    expect(mockQuery).not.toHaveBeenCalled(); // shortcuts before any DB read
  });

  it('does not shortcut the hosted platform (platform key present, no gateway key)', async () => {
    stageEnv({ ANTHROPIC_API_KEY: 'sk-ant-platform', OPENCRM_AI_GATEWAY_KEY: undefined });
    const origHasFeature = featureFlags.hasFeature;
    const origGetFeatures = featureFlags.getFeatures;
    featureFlags.hasFeature = vi.fn().mockResolvedValue(true);
    featureFlags.getFeatures = vi.fn().mockResolvedValue({ ai_billing_required: true });
    try {
      // org row: unconfigured → the normal 402-shaped block, not 'gateway'.
      mockQuery.mockResolvedValue({ rows: [{ id: 1, ai_billing_status: 'unconfigured' }] });
      const verdict = await requireAiBilling.evaluateAiBilling({ orgId: 1 });
      expect(verdict.allowed).toBe(false);
      expect(verdict.code).toBe('AI_BILLING_REQUIRED');
    } finally {
      featureFlags.hasFeature = origHasFeature;
      featureFlags.getFeatures = origGetFeatures;
    }
  });
});
