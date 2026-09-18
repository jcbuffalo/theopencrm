// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Microsoft (Outlook / M365) integration — OAuth + token-encryption tests.
// Mirrors test/driveOAuth.test.js.
//
// COVERAGE
//   1. msgraphTokens.encrypt / decrypt round-trip (AES-256-GCM, via the
//      driveTokens seam)
//   2. msgraphTokens — tamper detection (auth tag mismatch → decrypt throws)
//   3. msgraphOAuth.signStateToken → verifyStateToken round-trip
//   4. msgraphOAuth — replay defence (second verify of same token rejected)
//   5. msgraphOAuth.buildAuthUrl — Microsoft v2.0 authorize endpoint, scopes,
//      state param round-trip, tenant selection
//   6. msgraphOAuth.exchangeCodeForTokens — mocked fetch; success, missing
//      refresh_token, missing scopes (short + fully-qualified forms), error
//      surface
//   7. msgraphOAuth.refreshAccessToken — returns the ROTATED refresh token
//      when Microsoft supplies one (the load-bearing divergence from Google)
//   8. msgraphOAuth.revokeToken — documented no-op resolves ok
//   9. msgraphOAuth.getCreds — DB-first / env-fallback / neither (mirrors the
//      driveOAuth getCreds suite)
//  10. Graceful degradation — isConfigured false + operator-facing configError
//
// We mock global fetch for the Microsoft network calls — never hit
// login.microsoftonline.com or graph.microsoft.com in the suite. The pg pool
// is mocked too so the platform_integrations-aware getCreds() doesn't try a
// real DB query.

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const crypto = require('crypto');

// A fixed 32-byte (base64) test key so encrypt/decrypt is deterministic.
// Must be set BEFORE the first require of driveTokens (loadKey caches).
process.env.DRIVE_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

// Microsoft OAuth env fallback. Loopback-style values so any accidental
// network call fails fast rather than landing somewhere real.
process.env.MICROSOFT_CLIENT_ID = '11111111-2222-3333-4444-555555555555';
process.env.MICROSOFT_CLIENT_SECRET = 'test-ms-client-secret';
process.env.MICROSOFT_REDIRECT_URI = 'http://localhost/api/msgraph/auth/callback';
delete process.env.MICROSOFT_TENANT_ID;

// Patch the live pool exports so platformIntegrations.getConfig (called
// inside msgraphOAuth.getCreds) doesn't issue a real DB query.
const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn().mockResolvedValue({ rows: [] });
mockPool.connect = vi.fn();

const msgraphTokens = require('../services/msgraphTokens');
const msgraphOAuth = require('../services/msgraphOAuth');
const platformIntegrations = require('../services/platformIntegrations');

const GRAPH_SCOPE_STRING = 'Mail.Read Calendars.ReadWrite User.Read';

beforeEach(() => {
  msgraphTokens._resetForTests();
  msgraphOAuth._resetForTests();
  platformIntegrations._resetCacheForTests();
  mockPool.query.mockReset();
  mockPool.query.mockResolvedValue({ rows: [] });
  if (global.fetch && global.fetch.mockReset) global.fetch.mockReset();
});

// ---------------------------------------------------------------------------
// msgraphTokens (AES-256-GCM via the driveTokens seam)
// ---------------------------------------------------------------------------

describe('msgraphTokens (AES-256-GCM seam)', () => {
  test('encrypt/decrypt round-trip recovers the exact plaintext', () => {
    const plaintext = '0.AXcAmsft-refresh-token-shape-AAAAAAAAAAAAAAAAAAAAAA';
    const enc = msgraphTokens.encrypt(plaintext);

    expect(Buffer.isBuffer(enc.ciphertext)).toBe(true);
    expect(enc.iv.length).toBe(12);
    expect(enc.tag.length).toBe(16);
    expect(msgraphTokens.decrypt(enc)).toBe(plaintext);
  });

  test('tampered auth tag → decrypt throws (GCM integrity check)', () => {
    const enc = msgraphTokens.encrypt('secret-refresh-token');
    const tamperedTag = Buffer.from(enc.tag);
    tamperedTag[0] = tamperedTag[0] ^ 0x01;
    expect(() => msgraphTokens.decrypt({ ...enc, tag: tamperedTag })).toThrow();
  });

  test('isConfigured false when the master key is missing', () => {
    const saved = process.env.DRIVE_TOKEN_ENCRYPTION_KEY;
    delete process.env.DRIVE_TOKEN_ENCRYPTION_KEY;
    try {
      msgraphTokens._resetForTests();
      expect(msgraphTokens.isConfigured()).toBe(false);
      expect(msgraphTokens.configError()).toMatch(/DRIVE_TOKEN_ENCRYPTION_KEY/);
    } finally {
      process.env.DRIVE_TOKEN_ENCRYPTION_KEY = saved;
      msgraphTokens._resetForTests();
    }
  });
});

// ---------------------------------------------------------------------------
// State token round-trip + replay defence
// ---------------------------------------------------------------------------

describe('msgraphOAuth state token', () => {
  test('sign → verify round-trip recovers org_id + user_id', () => {
    const token = msgraphOAuth.signStateToken({ orgId: 42, userId: 7 });
    expect(token.split('.').length).toBe(3); // standard JWT shape

    const decoded = msgraphOAuth.verifyStateToken(token);
    expect(decoded.org_id).toBe(42);
    expect(decoded.user_id).toBe(7);
    expect(typeof decoded.nonce).toBe('string');
  });

  test('replay defence — verifying the same token twice rejects the second call', () => {
    const token = msgraphOAuth.signStateToken({ orgId: 1, userId: 2 });
    expect(() => msgraphOAuth.verifyStateToken(token)).not.toThrow();
    expect(() => msgraphOAuth.verifyStateToken(token)).toThrow(/nonce/);
  });

  test('tampered token (wrong signature) is rejected', () => {
    const token = msgraphOAuth.signStateToken({ orgId: 1, userId: 2 });
    const parts = token.split('.');
    parts[2] = parts[2].slice(0, -1) + (parts[2].slice(-1) === 'a' ? 'b' : 'a');
    expect(() => msgraphOAuth.verifyStateToken(parts.join('.'))).toThrow();
  });

  test('wholly fabricated token is rejected', () => {
    expect(() => msgraphOAuth.verifyStateToken('not.a.jwt')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildAuthUrl — Microsoft identity platform v2.0
// ---------------------------------------------------------------------------

describe('msgraphOAuth.buildAuthUrl', () => {
  test('targets the v2.0 authorize endpoint with the Graph scopes + a verifiable state', async () => {
    const url = await msgraphOAuth.buildAuthUrl({ orgId: 5, userId: 9 });
    expect(url).toContain('login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(url).toContain('Mail.Read');
    expect(url).toContain('Calendars.ReadWrite');
    expect(url).toContain('offline_access');
    const u = new URL(url);
    const state = u.searchParams.get('state');
    expect(state).toBeTruthy();
    const decoded = msgraphOAuth.verifyStateToken(state);
    expect(decoded.org_id).toBe(5);
    expect(decoded.user_id).toBe(9);
  });

  test('uses the configured tenant when MICROSOFT_TENANT_ID is set', async () => {
    process.env.MICROSOFT_TENANT_ID = 'contoso.onmicrosoft.com';
    try {
      const url = await msgraphOAuth.buildAuthUrl({ orgId: 5, userId: 9 });
      expect(url).toContain('login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize');
    } finally {
      delete process.env.MICROSOFT_TENANT_ID;
    }
  });
});

// ---------------------------------------------------------------------------
// Scope normalization (Microsoft echoes short-form scope names)
// ---------------------------------------------------------------------------

describe('msgraphOAuth scope validation helpers', () => {
  test('accepts short-form granted scopes', () => {
    expect(msgraphOAuth.grantedScopesInclude('Mail.Read Calendars.ReadWrite User.Read')).toBe(true);
  });
  test('accepts fully-qualified granted scopes', () => {
    expect(msgraphOAuth.grantedScopesInclude(
      'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Calendars.ReadWrite'
    )).toBe(true);
  });
  test('rejects when a required scope is missing', () => {
    expect(msgraphOAuth.grantedScopesInclude('Mail.Read User.Read')).toBe(false);
    expect(msgraphOAuth.grantedScopesInclude('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Token endpoint calls (mocked fetch)
// ---------------------------------------------------------------------------

describe('msgraphOAuth Microsoft token calls', () => {
  test('exchangeCodeForTokens returns the parsed tokens on success', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'eyJ.fake-access',
        refresh_token: '0.fake-refresh',
        expires_in: 3599,
        scope: GRAPH_SCOPE_STRING,
        token_type: 'Bearer',
      }),
    });

    const out = await msgraphOAuth.exchangeCodeForTokens('auth-code-from-microsoft');
    expect(out.access_token).toBe('eyJ.fake-access');
    expect(out.refresh_token).toBe('0.fake-refresh');
    expect(out.expires_in).toBe(3599);
    expect(out.scopes).toContain('Mail.Read');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = global.fetch.mock.calls[0];
    expect(calledUrl).toMatch(/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/token/);
    expect(calledInit.method).toBe('POST');
    expect(calledInit.body).toContain('grant_type=authorization_code');
    expect(calledInit.body).toContain('code=auth-code-from-microsoft');
  });

  test('exchangeCodeForTokens throws when Microsoft returns no refresh_token', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'eyJ.fake',
        expires_in: 3599,
        scope: GRAPH_SCOPE_STRING,
      }),
    });
    await expect(msgraphOAuth.exchangeCodeForTokens('code')).rejects.toThrow(/refresh_token/);
  });

  test('exchangeCodeForTokens throws when a required Graph scope was not granted', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'eyJ.fake',
        refresh_token: '0.fake-refresh',
        expires_in: 3599,
        scope: 'Mail.Read User.Read', // Calendars.ReadWrite withheld
      }),
    });
    await expect(msgraphOAuth.exchangeCodeForTokens('code')).rejects.toThrow(/Calendars\.ReadWrite/);
  });

  test('exchangeCodeForTokens surfaces error_description on HTTP failure', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant', error_description: 'AADSTS70008: expired code' }),
    });
    await expect(msgraphOAuth.exchangeCodeForTokens('code')).rejects.toThrow(/AADSTS70008/);
  });

  test('refreshAccessToken returns the ROTATED refresh token when supplied', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'eyJ.refreshed',
        refresh_token: '0.rotated-refresh', // Microsoft rotates on use
        expires_in: 3599,
        scope: GRAPH_SCOPE_STRING,
      }),
    });

    const out = await msgraphOAuth.refreshAccessToken('0.old-refresh');
    expect(out.access_token).toBe('eyJ.refreshed');
    expect(out.refresh_token).toBe('0.rotated-refresh');

    const [, calledInit] = global.fetch.mock.calls[0];
    expect(calledInit.body).toContain('grant_type=refresh_token');
  });

  test('refreshAccessToken returns refresh_token:null when Microsoft does not rotate', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'eyJ.refreshed',
        expires_in: 3599,
      }),
    });
    const out = await msgraphOAuth.refreshAccessToken('0.old-refresh');
    expect(out.refresh_token).toBeNull();
  });

  test('revokeToken is a documented no-op that resolves ok', async () => {
    global.fetch = vi.fn(); // must NOT be called
    const out = await msgraphOAuth.revokeToken('0.anything');
    expect(out.ok).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Graceful "not configured"
// ---------------------------------------------------------------------------

describe('msgraphOAuth graceful degradation', () => {
  test('isConfigured is true with the env fallback present', async () => {
    expect(await msgraphOAuth.isConfigured()).toBe(true);
    expect(await msgraphOAuth.configError()).toBe(null);
  });

  test('isConfigured flips false when env client id removed AND no DB row', async () => {
    const saved = process.env.MICROSOFT_CLIENT_ID;
    delete process.env.MICROSOFT_CLIENT_ID;
    try {
      expect(await msgraphOAuth.isConfigured()).toBe(false);
      expect(await msgraphOAuth.configError()).toMatch(/platform-integrations/);
    } finally {
      process.env.MICROSOFT_CLIENT_ID = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// getCreds — DB-first sourcing (PLATFORM_INTEGRATIONS_SPEC.md)
// ---------------------------------------------------------------------------

describe('msgraphOAuth.getCreds — DB-first sourcing', () => {
  const dbRow = {
    integration: 'msgraph',
    config: {
      client_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      redirect_uri: 'https://app.example.com/api/msgraph/auth/callback',
      tenant: 'contoso.onmicrosoft.com',
    },
    hasSecret: true,
    configured: true,
    updatedAt: new Date(),
    updatedByUserId: 1,
  };

  test('returns DB creds (incl. tenant) when a configured row exists', async () => {
    const origGetConfig = platformIntegrations.getConfig;
    const origGetSecret = platformIntegrations.getSecret;
    platformIntegrations.getConfig = vi.fn().mockResolvedValue(dbRow);
    platformIntegrations.getSecret = vi.fn().mockResolvedValue('db-supplied-secret');
    try {
      const creds = await msgraphOAuth.getCreds();
      expect(creds.source).toBe('db');
      expect(creds.clientId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      expect(creds.clientSecret).toBe('db-supplied-secret');
      expect(creds.tenant).toBe('contoso.onmicrosoft.com');
    } finally {
      platformIntegrations.getConfig = origGetConfig;
      platformIntegrations.getSecret = origGetSecret;
    }
  });

  test('DB creds win over env creds (DB-first precedence)', async () => {
    const origGetConfig = platformIntegrations.getConfig;
    const origGetSecret = platformIntegrations.getSecret;
    platformIntegrations.getConfig = vi.fn().mockResolvedValue(dbRow);
    platformIntegrations.getSecret = vi.fn().mockResolvedValue('db-secret');
    try {
      const creds = await msgraphOAuth.getCreds();
      expect(creds.source).toBe('db');
      expect(creds.clientId).not.toBe(process.env.MICROSOFT_CLIENT_ID);
    } finally {
      platformIntegrations.getConfig = origGetConfig;
      platformIntegrations.getSecret = origGetSecret;
    }
  });

  test('falls back to env when DB row absent (default tenant "common")', async () => {
    const creds = await msgraphOAuth.getCreds();
    expect(creds.source).toBe('env');
    expect(creds.clientId).toBe('11111111-2222-3333-4444-555555555555');
    expect(creds.tenant).toBe('common');
  });

  test('returns null when neither DB nor env is configured', async () => {
    const saved = {
      id: process.env.MICROSOFT_CLIENT_ID,
      sec: process.env.MICROSOFT_CLIENT_SECRET,
      uri: process.env.MICROSOFT_REDIRECT_URI,
    };
    delete process.env.MICROSOFT_CLIENT_ID;
    delete process.env.MICROSOFT_CLIENT_SECRET;
    delete process.env.MICROSOFT_REDIRECT_URI;
    try {
      expect(await msgraphOAuth.getCreds()).toBeNull();
    } finally {
      process.env.MICROSOFT_CLIENT_ID     = saved.id;
      process.env.MICROSOFT_CLIENT_SECRET = saved.sec;
      process.env.MICROSOFT_REDIRECT_URI  = saved.uri;
    }
  });

  test('platformIntegrations registry knows the msgraph slug + validates its config shape', () => {
    expect(platformIntegrations.isKnownIntegration('msgraph')).toBe(true);
    const def = platformIntegrations.INTEGRATIONS.msgraph;
    expect(def.validateConfig({
      client_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      redirect_uri: 'https://x.example.com/cb',
      tenant: 'common',
    })).toBe(null);
    expect(def.validateConfig({
      client_id: 'not-a-guid',
      redirect_uri: 'https://x.example.com/cb',
    })).toMatch(/GUID/);
    expect(def.validateConfig({
      client_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      redirect_uri: 'http://insecure.example.com/cb',
    })).toMatch(/https/);
  });
});
