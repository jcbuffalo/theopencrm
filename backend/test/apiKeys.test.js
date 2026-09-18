// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Developer-platform API-key core tests.
//
// COVERAGE
//   1. generateKey — tocrm_ prefix, hash = sha256(fullKey), fresh each call
//   2. sha256Hex — deterministic
//   3. extractKeyFromRequest — X-API-Key, Bearer, and non-key rejection
//   4. findActiveByPlaintext — active row returned; revoked → null; missing → null
//   5. findActiveByPlaintext — a non-tocrm token short-circuits (no DB query)
//   6. touchLastUsed — issues the UPDATE, swallows DB errors
//
// Same pattern as the other suites: patch the live pool export so no real DB
// is touched. apiKeys crypto runs for real.

const crypto = require('crypto');

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();

const apiKeys = require('../services/apiKeys');

beforeEach(() => {
  mockPool.query.mockReset();
});

describe('apiKeys.generateKey', () => {
  test('mints a tocrm_-prefixed key whose hash is sha256 of the plaintext', () => {
    const { fullKey, keyPrefix, keyHash } = apiKeys.generateKey();
    expect(fullKey.startsWith('tocrm_')).toBe(true);
    expect(keyPrefix.startsWith('tocrm_')).toBe(true);
    // The display prefix is a strict prefix of the full key.
    expect(fullKey.startsWith(keyPrefix)).toBe(true);
    // Hash is sha256 hex of the full plaintext — never the plaintext itself.
    expect(keyHash).toBe(crypto.createHash('sha256').update(fullKey, 'utf8').digest('hex'));
    expect(keyHash).not.toContain(fullKey);
  });

  test('every call produces a distinct key + hash', () => {
    const a = apiKeys.generateKey();
    const b = apiKeys.generateKey();
    expect(a.fullKey).not.toBe(b.fullKey);
    expect(a.keyHash).not.toBe(b.keyHash);
  });
});

describe('apiKeys.sha256Hex', () => {
  test('is deterministic', () => {
    expect(apiKeys.sha256Hex('tocrm_abc')).toBe(apiKeys.sha256Hex('tocrm_abc'));
    expect(apiKeys.sha256Hex('tocrm_abc')).not.toBe(apiKeys.sha256Hex('tocrm_abd'));
  });
});

describe('apiKeys.extractKeyFromRequest', () => {
  test('reads X-API-Key header', () => {
    const req = { headers: { 'x-api-key': 'tocrm_deadbeef' } };
    expect(apiKeys.extractKeyFromRequest(req)).toBe('tocrm_deadbeef');
  });

  test('reads Authorization: Bearer tocrm_...', () => {
    const req = { headers: { authorization: 'Bearer tocrm_cafebabe' } };
    expect(apiKeys.extractKeyFromRequest(req)).toBe('tocrm_cafebabe');
  });

  test('ignores a Bearer token that is not a tocrm_ key (JWT path untouched)', () => {
    const req = { headers: { authorization: 'Bearer eyJhbGciOi.some.jwt' } };
    expect(apiKeys.extractKeyFromRequest(req)).toBeNull();
  });

  test('returns null when no key header present', () => {
    expect(apiKeys.extractKeyFromRequest({ headers: {} })).toBeNull();
  });
});

describe('apiKeys.findActiveByPlaintext', () => {
  const validKey = 'tocrm_' + 'a'.repeat(40);

  test('returns the row for a valid, non-revoked key', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 5, org_id: 7, name: 'CI key', key_prefix: 'tocrm_aaaaaaaa',
        scopes: ['read'], created_by: 3, last_used_at: null, revoked_at: null,
        created_at: new Date(),
      }],
    });
    const row = await apiKeys.findActiveByPlaintext(validKey);
    expect(row).not.toBeNull();
    expect(row.id).toBe(5);
    expect(row.org_id).toBe(7);
    // Looked up by hash, not plaintext.
    const [, params] = mockPool.query.mock.calls[0];
    expect(params[0]).toBe(apiKeys.sha256Hex(validKey));
  });

  test('returns null for a revoked key even though the row exists', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 5, org_id: 7, scopes: ['read'], created_by: 3, revoked_at: new Date() }],
    });
    const row = await apiKeys.findActiveByPlaintext(validKey);
    expect(row).toBeNull();
  });

  test('returns null when no row matches the hash', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    expect(await apiKeys.findActiveByPlaintext(validKey)).toBeNull();
  });

  test('short-circuits (no DB query) for a token without the tocrm_ prefix', async () => {
    const row = await apiKeys.findActiveByPlaintext('not-a-key');
    expect(row).toBeNull();
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});

describe('apiKeys.touchLastUsed', () => {
  test('issues an UPDATE against api_keys', async () => {
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });
    await apiKeys.touchLastUsed(9);
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE api_keys SET last_used_at/);
    expect(params).toEqual([9]);
  });

  test('swallows DB errors (never throws into the request path)', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('db down'));
    await expect(apiKeys.touchLastUsed(9)).resolves.toBeUndefined();
  });
});
