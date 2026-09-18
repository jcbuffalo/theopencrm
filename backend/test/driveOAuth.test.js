// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Drive Intel — Phase 1 backend tests.
//
// COVERAGE
//   1. driveTokens.encrypt / decrypt round-trip (AES-256-GCM)
//   2. driveTokens — tamper detection (auth tag mismatch → decrypt throws)
//   3. driveTokens — graceful "not configured" when env key missing
//   4. driveOAuth.signStateToken → verifyStateToken round-trip
//   5. driveOAuth — replay defence (second verify of same token rejected)
//   6. driveOAuth — expired state token rejected
//   7. driveOAuth.exchangeCodeForTokens — mocked fetch returns access+refresh
//   8. driveOAuth.refreshAccessToken — mocked fetch returns new access token
//   9. driveOAuth.exchangeCodeForTokens — rejects when scope missing
//  10. driveOAuth.getCreds — DB-source path (PLATFORM_INTEGRATIONS_SPEC.md)
//  11. driveOAuth.getCreds — DB-first precedence over env vars
//  12. driveOAuth.getCreds — env fallback when DB row absent
//
// We mock global fetch for the Google network calls — never hit Google in
// the test suite (per the agent brief). The pg pool is mocked too so the
// PLATFORM_INTEGRATIONS-aware getCreds() doesn't try a real DB query.

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const crypto = require('crypto');

// A fixed 32-byte (base64-encoded) test key so encrypt/decrypt is
// deterministic between runs. Has to be set BEFORE the first require of
// driveTokens, since loadKey() caches the decoded buffer.
process.env.DRIVE_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

// Drive OAuth env. Use loopback-style values so any accidental network call
// fails fast rather than landing somewhere real.
process.env.GOOGLE_DRIVE_CLIENT_ID = 'test-drive-client-id';
process.env.GOOGLE_DRIVE_CLIENT_SECRET = 'test-drive-client-secret';
process.env.GOOGLE_DRIVE_REDIRECT_URI = 'http://localhost/api/drive/auth/callback';

// Patch the live pool exports so platformIntegrations.getConfig (called
// inside driveOAuth.getCreds) doesn't issue a real DB query. The default
// "no row" response keeps existing env-var tests behaving exactly as
// before — getCreds falls through to env. DB-source tests below override
// the per-call response.
const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn().mockResolvedValue({ rows: [] });
mockPool.connect = vi.fn();

const driveTokens = require('../services/driveTokens');
const driveOAuth = require('../services/driveOAuth');
const platformIntegrations = require('../services/platformIntegrations');

beforeEach(() => {
  driveTokens._resetForTests();
  driveOAuth._resetForTests();
  platformIntegrations._resetCacheForTests();
  mockPool.query.mockReset();
  // Default empty-row response so any getCreds() call without a per-test
  // override falls cleanly through to env vars (the legacy path).
  mockPool.query.mockResolvedValue({ rows: [] });
  // Each test re-sets fetch as needed; clear any prior mock between tests.
  if (global.fetch && global.fetch.mockReset) global.fetch.mockReset();
});

// ---------------------------------------------------------------------------
// driveTokens
// ---------------------------------------------------------------------------

describe('driveTokens (AES-256-GCM)', () => {
  test('encrypt/decrypt round-trip recovers the exact plaintext', () => {
    const plaintext = '1//0abcDEFghijklmnopqrstuvwxyz-google-refresh-token-shape';
    const enc = driveTokens.encrypt(plaintext);

    expect(Buffer.isBuffer(enc.ciphertext)).toBe(true);
    expect(Buffer.isBuffer(enc.iv)).toBe(true);
    expect(Buffer.isBuffer(enc.tag)).toBe(true);
    expect(enc.iv.length).toBe(12);
    expect(enc.tag.length).toBe(16);

    const recovered = driveTokens.decrypt(enc);
    expect(recovered).toBe(plaintext);
  });

  test('every encryption uses a fresh IV (non-deterministic ciphertext)', () => {
    const plaintext = 'same-input-twice';
    const a = driveTokens.encrypt(plaintext);
    const b = driveTokens.encrypt(plaintext);

    // GCM nonces are random per call → IV and ciphertext should differ.
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);

    // Both still decrypt to the same plaintext.
    expect(driveTokens.decrypt(a)).toBe(plaintext);
    expect(driveTokens.decrypt(b)).toBe(plaintext);
  });

  test('tampered auth tag → decrypt throws (GCM integrity check)', () => {
    const enc = driveTokens.encrypt('secret-payload');
    // Flip a bit in the auth tag.
    const tamperedTag = Buffer.from(enc.tag);
    tamperedTag[0] = tamperedTag[0] ^ 0x01;
    expect(() => driveTokens.decrypt({ ...enc, tag: tamperedTag })).toThrow();
  });

  test('tampered ciphertext → decrypt throws', () => {
    const enc = driveTokens.encrypt('secret-payload-2');
    const tampered = Buffer.from(enc.ciphertext);
    tampered[0] = tampered[0] ^ 0x01;
    expect(() => driveTokens.decrypt({ ...enc, ciphertext: tampered })).toThrow();
  });

  test('isConfigured returns false when env key is missing', () => {
    const saved = process.env.DRIVE_TOKEN_ENCRYPTION_KEY;
    delete process.env.DRIVE_TOKEN_ENCRYPTION_KEY;
    try {
      driveTokens._resetForTests();
      expect(driveTokens.isConfigured()).toBe(false);
      expect(driveTokens.configError()).toMatch(/DRIVE_TOKEN_ENCRYPTION_KEY/);
    } finally {
      process.env.DRIVE_TOKEN_ENCRYPTION_KEY = saved;
      driveTokens._resetForTests();
    }
  });

  test('isConfigured returns false when env key is wrong length', () => {
    const saved = process.env.DRIVE_TOKEN_ENCRYPTION_KEY;
    process.env.DRIVE_TOKEN_ENCRYPTION_KEY = Buffer.from('too-short').toString('base64');
    try {
      driveTokens._resetForTests();
      expect(driveTokens.isConfigured()).toBe(false);
      expect(driveTokens.configError()).toMatch(/32 bytes/);
    } finally {
      process.env.DRIVE_TOKEN_ENCRYPTION_KEY = saved;
      driveTokens._resetForTests();
    }
  });
});

// ---------------------------------------------------------------------------
// driveOAuth — state token round-trip
// ---------------------------------------------------------------------------

describe('driveOAuth state token', () => {
  test('sign → verify round-trip recovers org_id + user_id', () => {
    const token = driveOAuth.signStateToken({ orgId: 42, userId: 7 });
    expect(typeof token).toBe('string');
    expect(token.split('.').length).toBe(3); // standard JWT shape

    const decoded = driveOAuth.verifyStateToken(token);
    expect(decoded.org_id).toBe(42);
    expect(decoded.user_id).toBe(7);
    expect(typeof decoded.nonce).toBe('string');
    expect(decoded.nonce.length).toBeGreaterThan(0);
  });

  test('replay defence — verifying the same token twice rejects the second call', () => {
    const token = driveOAuth.signStateToken({ orgId: 1, userId: 2 });
    expect(() => driveOAuth.verifyStateToken(token)).not.toThrow();
    expect(() => driveOAuth.verifyStateToken(token)).toThrow(/nonce/);
  });

  test('tampered token (wrong signature) is rejected', () => {
    const token = driveOAuth.signStateToken({ orgId: 1, userId: 2 });
    // Mangle the signature portion.
    const parts = token.split('.');
    parts[2] = parts[2].slice(0, -1) + (parts[2].slice(-1) === 'a' ? 'b' : 'a');
    expect(() => driveOAuth.verifyStateToken(parts.join('.'))).toThrow();
  });

  test('verify with a wholly fabricated token is rejected', () => {
    expect(() => driveOAuth.verifyStateToken('not.a.jwt')).toThrow();
  });

  test('buildAuthUrl includes the required scope and a state param', async () => {
    const url = await driveOAuth.buildAuthUrl({ orgId: 5, userId: 9 });
    expect(url).toContain('drive.readonly');
    expect(url).toContain('access_type=offline');
    expect(url).toContain('prompt=consent');
    const u = new URL(url);
    const state = u.searchParams.get('state');
    expect(state).toBeTruthy();
    // The minted state should verify back to the same org/user.
    const decoded = driveOAuth.verifyStateToken(state);
    expect(decoded.org_id).toBe(5);
    expect(decoded.user_id).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// driveOAuth — Google token endpoint (mocked fetch)
// ---------------------------------------------------------------------------

describe('driveOAuth Google token calls', () => {
  test('exchangeCodeForTokens returns the parsed tokens on success', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'ya29.fake-access',
        refresh_token: '1//fake-refresh',
        expires_in: 3599,
        scope: 'https://www.googleapis.com/auth/drive.readonly openid',
        token_type: 'Bearer',
        id_token: 'eyJ.fake.id',
      }),
    });

    const out = await driveOAuth.exchangeCodeForTokens('auth-code-from-google');
    expect(out.access_token).toBe('ya29.fake-access');
    expect(out.refresh_token).toBe('1//fake-refresh');
    expect(out.expires_in).toBe(3599);
    expect(out.scopes).toContain('https://www.googleapis.com/auth/drive.readonly');

    // Verify the request shape — the body should be form-encoded with the
    // expected grant_type + redirect_uri.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = global.fetch.mock.calls[0];
    expect(calledUrl).toMatch(/oauth2\.googleapis\.com\/token/);
    expect(calledInit.method).toBe('POST');
    expect(calledInit.body).toContain('grant_type=authorization_code');
    expect(calledInit.body).toContain('code=auth-code-from-google');
  });

  test('exchangeCodeForTokens throws when Google returns no refresh_token', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'ya29.fake',
        // missing refresh_token
        expires_in: 3599,
        scope: 'https://www.googleapis.com/auth/drive.readonly',
      }),
    });
    await expect(driveOAuth.exchangeCodeForTokens('code')).rejects.toThrow(/refresh_token/);
  });

  test('exchangeCodeForTokens throws when drive.readonly is not in the granted scope', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'ya29.fake',
        refresh_token: '1//fake-refresh',
        expires_in: 3599,
        scope: 'openid email', // user de-selected the drive scope on the consent screen
      }),
    });
    await expect(driveOAuth.exchangeCodeForTokens('code')).rejects.toThrow(/drive\.readonly/);
  });

  test('exchangeCodeForTokens surfaces Google error_description on HTTP failure', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant', error_description: 'Bad code' }),
    });
    await expect(driveOAuth.exchangeCodeForTokens('code')).rejects.toThrow(/Bad code/);
  });

  test('refreshAccessToken returns a fresh access token', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'ya29.refreshed',
        expires_in: 3599,
        scope: 'https://www.googleapis.com/auth/drive.readonly',
        token_type: 'Bearer',
      }),
    });

    const out = await driveOAuth.refreshAccessToken('1//fake-refresh');
    expect(out.access_token).toBe('ya29.refreshed');
    expect(out.expires_in).toBe(3599);

    const [, calledInit] = global.fetch.mock.calls[0];
    expect(calledInit.body).toContain('grant_type=refresh_token');
    expect(calledInit.body).toContain('refresh_token=1');
  });

  test('revokeToken treats Google "invalid_token" 400 as success (already revoked)', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_token' }),
    });
    const out = await driveOAuth.revokeToken('1//already-revoked');
    expect(out.ok).toBe(true);
    expect(out.alreadyRevoked).toBe(true);
  });

  test('revokeToken propagates other failures', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'server error',
    });
    await expect(driveOAuth.revokeToken('1//token')).rejects.toThrow(/500/);
  });
});

// ---------------------------------------------------------------------------
// Graceful "not configured" — when OAuth env vars are missing, isConfigured
// returns false and configError gives a useful operator message.
// ---------------------------------------------------------------------------

describe('driveOAuth graceful degradation', () => {
  test('isConfigured is true with all env vars present', async () => {
    expect(await driveOAuth.isConfigured()).toBe(true);
    expect(await driveOAuth.configError()).toBe(null);
  });

  test('isConfigured flips false when env client id removed AND no DB row', async () => {
    const saved = process.env.GOOGLE_DRIVE_CLIENT_ID;
    delete process.env.GOOGLE_DRIVE_CLIENT_ID;
    try {
      expect(await driveOAuth.isConfigured()).toBe(false);
      expect(await driveOAuth.configError()).toMatch(/GOOGLE_DRIVE_CLIENT_ID/);
    } finally {
      process.env.GOOGLE_DRIVE_CLIENT_ID = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// driveOAuth.getCreds — DB-source path (PLATFORM_INTEGRATIONS_SPEC.md refactor)
// ---------------------------------------------------------------------------

describe('driveOAuth.getCreds — DB-first sourcing', () => {
  test('returns DB creds when platformIntegrations.getConfig has a configured row', async () => {
    // Mock platformIntegrations.getConfig + getSecret to return a configured
    // Drive row. We patch the live module exports — same pattern as the
    // me.test.js audit shim above.
    const origGetConfig = platformIntegrations.getConfig;
    const origGetSecret = platformIntegrations.getSecret;
    platformIntegrations.getConfig = vi.fn().mockResolvedValue({
      integration: 'drive',
      config: {
        client_id: 'db-client.apps.googleusercontent.com',
        redirect_uri: 'https://app.example.com/api/drive/auth/callback',
      },
      hasSecret: true,
      configured: true,
      updatedAt: new Date(),
      updatedByUserId: 1,
    });
    platformIntegrations.getSecret = vi.fn().mockResolvedValue('db-supplied-secret');

    try {
      const creds = await driveOAuth.getCreds();
      expect(creds).not.toBeNull();
      expect(creds.source).toBe('db');
      expect(creds.clientId).toBe('db-client.apps.googleusercontent.com');
      expect(creds.clientSecret).toBe('db-supplied-secret');
      expect(creds.redirectUri).toBe('https://app.example.com/api/drive/auth/callback');
    } finally {
      platformIntegrations.getConfig = origGetConfig;
      platformIntegrations.getSecret = origGetSecret;
    }
  });

  test('DB creds win over env creds (DB-first precedence)', async () => {
    const origGetConfig = platformIntegrations.getConfig;
    const origGetSecret = platformIntegrations.getSecret;
    platformIntegrations.getConfig = vi.fn().mockResolvedValue({
      integration: 'drive',
      config: {
        client_id: 'db-wins.apps.googleusercontent.com',
        redirect_uri: 'https://from-db.example.com/cb',
      },
      hasSecret: true,
      configured: true,
      updatedAt: new Date(),
      updatedByUserId: 1,
    });
    platformIntegrations.getSecret = vi.fn().mockResolvedValue('db-secret');

    try {
      const creds = await driveOAuth.getCreds();
      // Env had GOOGLE_DRIVE_CLIENT_ID='test-drive-client-id' from the top of
      // the file — DB value should win.
      expect(creds.source).toBe('db');
      expect(creds.clientId).toBe('db-wins.apps.googleusercontent.com');
      expect(creds.clientSecret).not.toBe(process.env.GOOGLE_DRIVE_CLIENT_SECRET);
      expect(creds.clientSecret).toBe('db-secret');
    } finally {
      platformIntegrations.getConfig = origGetConfig;
      platformIntegrations.getSecret = origGetSecret;
    }
  });

  test('falls back to env when DB row absent', async () => {
    // Default mockPool.query returns { rows: [] } — i.e. no DB row. getCreds
    // should fall through to env vars.
    const creds = await driveOAuth.getCreds();
    expect(creds).not.toBeNull();
    expect(creds.source).toBe('env');
    expect(creds.clientId).toBe('test-drive-client-id');
    expect(creds.clientSecret).toBe('test-drive-client-secret');
  });

  test('falls back to env when DB row exists but has no secret', async () => {
    const origGetConfig = platformIntegrations.getConfig;
    const origGetSecret = platformIntegrations.getSecret;
    platformIntegrations.getConfig = vi.fn().mockResolvedValue({
      integration: 'drive',
      config: {
        client_id: 'db-config-only.apps.googleusercontent.com',
        redirect_uri: 'https://from-db.example.com/cb',
      },
      hasSecret: false,
      configured: false, // hasSecret=false → configured=false
      updatedAt: new Date(),
      updatedByUserId: 1,
    });
    platformIntegrations.getSecret = vi.fn().mockResolvedValue(null);

    try {
      const creds = await driveOAuth.getCreds();
      // configured=false on the DB row → fall through to env
      expect(creds.source).toBe('env');
      expect(creds.clientId).toBe('test-drive-client-id');
    } finally {
      platformIntegrations.getConfig = origGetConfig;
      platformIntegrations.getSecret = origGetSecret;
    }
  });

  test('returns null when neither DB nor env is configured', async () => {
    const saved = {
      id: process.env.GOOGLE_DRIVE_CLIENT_ID,
      sec: process.env.GOOGLE_DRIVE_CLIENT_SECRET,
      uri: process.env.GOOGLE_DRIVE_REDIRECT_URI,
    };
    delete process.env.GOOGLE_DRIVE_CLIENT_ID;
    delete process.env.GOOGLE_DRIVE_CLIENT_SECRET;
    delete process.env.GOOGLE_DRIVE_REDIRECT_URI;
    try {
      const creds = await driveOAuth.getCreds();
      expect(creds).toBeNull();
    } finally {
      process.env.GOOGLE_DRIVE_CLIENT_ID     = saved.id;
      process.env.GOOGLE_DRIVE_CLIENT_SECRET = saved.sec;
      process.env.GOOGLE_DRIVE_REDIRECT_URI  = saved.uri;
    }
  });

  test('exchangeCodeForTokens uses DB creds when available', async () => {
    const origGetConfig = platformIntegrations.getConfig;
    const origGetSecret = platformIntegrations.getSecret;
    platformIntegrations.getConfig = vi.fn().mockResolvedValue({
      integration: 'drive',
      config: {
        client_id: 'db-client.apps.googleusercontent.com',
        redirect_uri: 'https://from-db.example.com/cb',
      },
      hasSecret: true,
      configured: true,
      updatedAt: new Date(),
      updatedByUserId: 1,
    });
    platformIntegrations.getSecret = vi.fn().mockResolvedValue('db-only-secret');

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'ya29.fake',
        refresh_token: '1//fake',
        expires_in: 3599,
        scope: 'https://www.googleapis.com/auth/drive.readonly',
        token_type: 'Bearer',
      }),
    });

    try {
      await driveOAuth.exchangeCodeForTokens('the-code');
      // Verify the body sent to Google used the DB-source client_id + secret,
      // not the env vars.
      const [, calledInit] = global.fetch.mock.calls[0];
      expect(calledInit.body).toContain('client_id=db-client.apps.googleusercontent.com');
      expect(calledInit.body).toContain('client_secret=db-only-secret');
    } finally {
      platformIntegrations.getConfig = origGetConfig;
      platformIntegrations.getSecret = origGetSecret;
    }
  });
});
