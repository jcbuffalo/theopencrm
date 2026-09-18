// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Platform Integrations — Phase 1 service tests.
//
// COVERAGE
//   1. encrypt/decrypt round-trip via real driveTokens (no mocks)
//   2. set + getConfig: read back the public-shape row after a save
//   3. set + getSecret: decrypt the stored secret with the master key
//   4. clear: removes the row entirely
//   5. cache TTL: getConfig short-circuits to cache; set() and clear() bust it
//   6. validation: drive's client_id must end in .apps.googleusercontent.com
//   7. validation: drive's redirect_uri must be https URL
//   8. master-key gate: set() with a real secret throws when DRIVE_TOKEN_ENCRYPTION_KEY
//      is unset
//   9. unknown integration slug → throws (Phase 1 only registers `drive`)
//
// Like the other vitest suites, we mock the DB pool by patching the live
// pool instance (vi.mock for CJS module.exports = pool is unreliable).
// driveTokens is NOT mocked — encrypt/decrypt run for real.

const crypto = require('crypto');

// Set the master key BEFORE the first require of driveTokens — see
// driveTokens.loadKey().
process.env.DRIVE_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const driveTokens = require('../services/driveTokens');
const platformIntegrations = require('../services/platformIntegrations');

beforeEach(() => {
  mockPool.query.mockReset();
  driveTokens._resetForTests();
  platformIntegrations._resetCacheForTests();
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('platformIntegrations.set — drive config validation', () => {
  test('rejects when client_id does not end in .apps.googleusercontent.com', async () => {
    await expect(platformIntegrations.set('drive', {
      config: { client_id: 'not-a-google-client', redirect_uri: 'https://example.com/cb' },
      secret: 'shh',
      userId: 1,
    })).rejects.toThrow(/apps\.googleusercontent\.com/);
  });

  test('rejects when client_id is missing', async () => {
    await expect(platformIntegrations.set('drive', {
      config: { redirect_uri: 'https://example.com/cb' },
      secret: 'shh',
      userId: 1,
    })).rejects.toThrow(/client_id/);
  });

  test('rejects when redirect_uri is not https', async () => {
    await expect(platformIntegrations.set('drive', {
      config: {
        client_id: '1234.apps.googleusercontent.com',
        redirect_uri: 'http://example.com/cb',
      },
      secret: 'shh',
      userId: 1,
    })).rejects.toThrow(/https/);
  });

  test('rejects when redirect_uri is malformed', async () => {
    await expect(platformIntegrations.set('drive', {
      config: {
        client_id: '1234.apps.googleusercontent.com',
        redirect_uri: 'not-a-url',
      },
      secret: 'shh',
      userId: 1,
    })).rejects.toThrow(/redirect_uri/);
  });

  test('rejects unknown integration slug', async () => {
    await expect(platformIntegrations.set('not-a-real-integration', {
      config: {},
      secret: 'shh',
      userId: 1,
    })).rejects.toThrow(/unknown integration/);
  });

  test('getConfig throws on unknown slug', async () => {
    await expect(platformIntegrations.getConfig('mystery'))
      .rejects.toThrow(/unknown integration/);
  });
});

// ---------------------------------------------------------------------------
// Master-key gate
// ---------------------------------------------------------------------------

describe('platformIntegrations.set — master key gate', () => {
  test('refuses to encrypt a new secret when DRIVE_TOKEN_ENCRYPTION_KEY is missing', async () => {
    const saved = process.env.DRIVE_TOKEN_ENCRYPTION_KEY;
    delete process.env.DRIVE_TOKEN_ENCRYPTION_KEY;
    driveTokens._resetForTests();
    try {
      await expect(platformIntegrations.set('drive', {
        config: {
          client_id: '1234.apps.googleusercontent.com',
          redirect_uri: 'https://example.com/cb',
        },
        secret: 'real-secret',
        userId: 1,
      })).rejects.toThrow(/Master encryption key not configured/);
    } finally {
      process.env.DRIVE_TOKEN_ENCRYPTION_KEY = saved;
      driveTokens._resetForTests();
    }
  });

  test('allows a config-only update (no secret) when master key is missing', async () => {
    const saved = process.env.DRIVE_TOKEN_ENCRYPTION_KEY;
    delete process.env.DRIVE_TOKEN_ENCRYPTION_KEY;
    driveTokens._resetForTests();
    try {
      // The DB write for the config-preserve branch — no secret columns
      // touched, so no master key needed.
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          integration: 'drive',
          config: { client_id: '1234.apps.googleusercontent.com', redirect_uri: 'https://example.com/cb' },
          has_secret: false,
          updated_at: new Date('2026-06-01T00:00:00Z'),
          updated_by_user_id: 1,
        }],
      });
      const out = await platformIntegrations.set('drive', {
        config: {
          client_id: '1234.apps.googleusercontent.com',
          redirect_uri: 'https://example.com/cb',
        },
        // secret omitted entirely — preserve branch
        userId: 1,
      });
      expect(out.hasSecret).toBe(false);
      expect(out.config.client_id).toBe('1234.apps.googleusercontent.com');
    } finally {
      process.env.DRIVE_TOKEN_ENCRYPTION_KEY = saved;
      driveTokens._resetForTests();
    }
  });
});

// ---------------------------------------------------------------------------
// set + getConfig round-trip
// ---------------------------------------------------------------------------

describe('platformIntegrations — set + getConfig round-trip', () => {
  test('set returns the new public-shape row', async () => {
    // The insert/upsert returning clause:
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        integration: 'drive',
        config: {
          client_id: '1234.apps.googleusercontent.com',
          redirect_uri: 'https://example.com/cb',
        },
        has_secret: true,
        updated_at: new Date('2026-06-01T00:00:00Z'),
        updated_by_user_id: 42,
      }],
    });

    const out = await platformIntegrations.set('drive', {
      config: {
        client_id: '1234.apps.googleusercontent.com',
        redirect_uri: 'https://example.com/cb',
        ignored_extra_field: 'should-be-stripped',
      },
      secret: 'actual-client-secret',
      userId: 42,
    });

    expect(out.hasSecret).toBe(true);
    expect(out.configured).toBe(true);
    expect(out.config.client_id).toBe('1234.apps.googleusercontent.com');
    expect(out.updatedByUserId).toBe(42);

    // The query SQL string contains ciphertext + iv + tag bind params (we
    // wrote them as $3 / $4 / $5). Spot-check that the call shape included
    // Buffer ciphertext.
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toMatch(/secret_ciphertext/);
    expect(Buffer.isBuffer(params[2])).toBe(true); // ciphertext
    expect(Buffer.isBuffer(params[3])).toBe(true); // iv
    expect(Buffer.isBuffer(params[4])).toBe(true); // tag

    // Config was stripped to whitelisted fields. params[1] is the JSON.stringified
    // config JSONB bind.
    const stored = JSON.parse(params[1]);
    expect(stored).toEqual({
      client_id: '1234.apps.googleusercontent.com',
      redirect_uri: 'https://example.com/cb',
    });
    expect(stored.ignored_extra_field).toBeUndefined();
  });

  test('getConfig returns the row in public shape (no secret bytes)', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        integration: 'drive',
        config: {
          client_id: '1234.apps.googleusercontent.com',
          redirect_uri: 'https://example.com/cb',
        },
        has_secret: true,
        updated_at: new Date('2026-06-01T00:00:00Z'),
        updated_by_user_id: 7,
      }],
    });

    const out = await platformIntegrations.getConfig('drive');
    expect(out.integration).toBe('drive');
    expect(out.hasSecret).toBe(true);
    expect(out.configured).toBe(true);
    expect(out.config.client_id).toBe('1234.apps.googleusercontent.com');

    // No ciphertext bytes leaked into the public-shape view.
    expect(out.secret_ciphertext).toBeUndefined();
    expect(out.secret).toBeUndefined();
  });

  test('getConfig returns null for a slug with no row', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const out = await platformIntegrations.getConfig('drive');
    expect(out).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getSecret — decrypt round-trip via real driveTokens
// ---------------------------------------------------------------------------

describe('platformIntegrations.getSecret — encrypt/decrypt round-trip', () => {
  test('encrypts via driveTokens and decrypts back to the exact plaintext', async () => {
    const plaintextSecret = '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ape-1234567890';
    // Encrypt with the real helper so the test verifies the same code path
    // the service uses.
    const enc = driveTokens.encrypt(plaintextSecret);

    mockPool.query.mockResolvedValueOnce({
      rows: [{
        secret_ciphertext: enc.ciphertext,
        secret_iv:         enc.iv,
        secret_tag:        enc.tag,
      }],
    });

    const recovered = await platformIntegrations.getSecret('drive');
    expect(recovered).toBe(plaintextSecret);
  });

  test('returns null when the row exists but ciphertext columns are null', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        secret_ciphertext: null,
        secret_iv:         null,
        secret_tag:        null,
      }],
    });
    const out = await platformIntegrations.getSecret('drive');
    expect(out).toBeNull();
  });

  test('returns null when no row at all', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const out = await platformIntegrations.getSecret('drive');
    expect(out).toBeNull();
  });

  test('throws an operator-facing error when master key is missing and a row exists', async () => {
    const plaintext = 'still-encrypted';
    const enc = driveTokens.encrypt(plaintext);

    const saved = process.env.DRIVE_TOKEN_ENCRYPTION_KEY;
    delete process.env.DRIVE_TOKEN_ENCRYPTION_KEY;
    driveTokens._resetForTests();
    try {
      mockPool.query.mockResolvedValueOnce({
        rows: [{
          secret_ciphertext: enc.ciphertext,
          secret_iv:         enc.iv,
          secret_tag:        enc.tag,
        }],
      });
      await expect(platformIntegrations.getSecret('drive'))
        .rejects.toThrow(/master encryption key not configured/i);
    } finally {
      process.env.DRIVE_TOKEN_ENCRYPTION_KEY = saved;
      driveTokens._resetForTests();
    }
  });
});

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

describe('platformIntegrations.clear', () => {
  test('removes the row and returns true', async () => {
    mockPool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ integration: 'drive' }] });
    const out = await platformIntegrations.clear('drive', { userId: 1 });
    expect(out).toBe(true);
    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM platform_integrations/);
  });

  test('returns false when no row to delete', async () => {
    mockPool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const out = await platformIntegrations.clear('drive', { userId: 1 });
    expect(out).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cache invalidation
// ---------------------------------------------------------------------------

describe('platformIntegrations — cache TTL + invalidation', () => {
  test('getConfig short-circuits to cache on second call (no extra DB hit)', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        integration: 'drive',
        config: { client_id: '1234.apps.googleusercontent.com', redirect_uri: 'https://example.com/cb' },
        has_secret: true,
        updated_at: new Date('2026-06-01T00:00:00Z'),
        updated_by_user_id: 1,
      }],
    });

    const first  = await platformIntegrations.getConfig('drive');
    const second = await platformIntegrations.getConfig('drive');
    expect(first.config.client_id).toBe('1234.apps.googleusercontent.com');
    expect(second.config.client_id).toBe('1234.apps.googleusercontent.com');
    // Exactly one pool.query call — the second was served from cache.
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  test('null result (no row) is cached too — avoids DB on every check', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const first  = await platformIntegrations.getConfig('drive');
    const second = await platformIntegrations.getConfig('drive');
    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  test('set() busts the cache so the next getConfig re-reads', async () => {
    // First getConfig: row1
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        integration: 'drive',
        config: { client_id: 'old.apps.googleusercontent.com', redirect_uri: 'https://example.com/old' },
        has_secret: true,
        updated_at: new Date('2026-06-01T00:00:00Z'),
        updated_by_user_id: 1,
      }],
    });
    // set() upsert (returns the new row)
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        integration: 'drive',
        config: { client_id: 'new.apps.googleusercontent.com', redirect_uri: 'https://example.com/new' },
        has_secret: true,
        updated_at: new Date('2026-06-01T01:00:00Z'),
        updated_by_user_id: 2,
      }],
    });
    // Second getConfig (post-set): fresh DB read should fire because cache was busted
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        integration: 'drive',
        config: { client_id: 'new.apps.googleusercontent.com', redirect_uri: 'https://example.com/new' },
        has_secret: true,
        updated_at: new Date('2026-06-01T01:00:00Z'),
        updated_by_user_id: 2,
      }],
    });

    const before = await platformIntegrations.getConfig('drive');
    expect(before.config.client_id).toBe('old.apps.googleusercontent.com');

    await platformIntegrations.set('drive', {
      config: {
        client_id: 'new.apps.googleusercontent.com',
        redirect_uri: 'https://example.com/new',
      },
      secret: 'new-secret',
      userId: 2,
    });

    const after = await platformIntegrations.getConfig('drive');
    expect(after.config.client_id).toBe('new.apps.googleusercontent.com');
    // Three DB calls total: first getConfig, the set upsert, the second getConfig.
    expect(mockPool.query).toHaveBeenCalledTimes(3);
  });

  test('clear() busts the cache too', async () => {
    // First getConfig: a row
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        integration: 'drive',
        config: { client_id: '1234.apps.googleusercontent.com', redirect_uri: 'https://example.com/cb' },
        has_secret: true,
        updated_at: new Date('2026-06-01T00:00:00Z'),
        updated_by_user_id: 1,
      }],
    });
    // clear() delete
    mockPool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ integration: 'drive' }] });
    // Second getConfig: now empty
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const before = await platformIntegrations.getConfig('drive');
    expect(before).not.toBeNull();
    await platformIntegrations.clear('drive', { userId: 1 });
    const after = await platformIntegrations.getConfig('drive');
    expect(after).toBeNull();
    expect(mockPool.query).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// set semantics: preserve / clear / replace on `secret`
// ---------------------------------------------------------------------------

describe('platformIntegrations.set — secret handling semantics', () => {
  test('omitted secret → preserve branch (no ciphertext params in SQL)', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        integration: 'drive',
        config: { client_id: '1234.apps.googleusercontent.com', redirect_uri: 'https://example.com/cb' },
        has_secret: true, // unchanged because we didn't touch it
        updated_at: new Date('2026-06-01T00:00:00Z'),
        updated_by_user_id: 1,
      }],
    });
    await platformIntegrations.set('drive', {
      config: {
        client_id: '1234.apps.googleusercontent.com',
        redirect_uri: 'https://example.com/cb',
      },
      // secret omitted
      userId: 1,
    });
    const [sql] = mockPool.query.mock.calls[0];
    // Preserve-branch SQL does NOT touch secret columns.
    expect(sql).not.toMatch(/secret_ciphertext\s*=/);
    expect(sql).not.toMatch(/secret_iv\s*=/);
  });

  test('null secret → clear branch (sets secret columns to NULL)', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        integration: 'drive',
        config: { client_id: '1234.apps.googleusercontent.com', redirect_uri: 'https://example.com/cb' },
        has_secret: false,
        updated_at: new Date('2026-06-01T00:00:00Z'),
        updated_by_user_id: 1,
      }],
    });
    await platformIntegrations.set('drive', {
      config: {
        client_id: '1234.apps.googleusercontent.com',
        redirect_uri: 'https://example.com/cb',
      },
      secret: null,
      userId: 1,
    });
    const [sql] = mockPool.query.mock.calls[0];
    // Clear branch sets ciphertext = NULL.
    expect(sql).toMatch(/secret_ciphertext\s*=\s*NULL/);
  });

  test('empty-string secret is rejected (callers should send null to clear)', async () => {
    await expect(platformIntegrations.set('drive', {
      config: {
        client_id: '1234.apps.googleusercontent.com',
        redirect_uri: 'https://example.com/cb',
      },
      secret: '',
      userId: 1,
    })).rejects.toThrow(/non-empty string|null/);
  });
});

// ---------------------------------------------------------------------------
// isConfigured (synchronous cache check)
// ---------------------------------------------------------------------------

describe('platformIntegrations.isConfigured — sync cache check', () => {
  test('returns false before any getConfig call (cold cache)', () => {
    expect(platformIntegrations.isConfigured('drive')).toBe(false);
  });

  test('returns true after a getConfig warms the cache with a configured row', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        integration: 'drive',
        config: { client_id: '1234.apps.googleusercontent.com', redirect_uri: 'https://example.com/cb' },
        has_secret: true,
        updated_at: new Date('2026-06-01T00:00:00Z'),
        updated_by_user_id: 1,
      }],
    });
    await platformIntegrations.getConfig('drive');
    expect(platformIntegrations.isConfigured('drive')).toBe(true);
  });

  test('returns false after a getConfig warms the cache with a null row', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await platformIntegrations.getConfig('drive');
    expect(platformIntegrations.isConfigured('drive')).toBe(false);
  });
});
