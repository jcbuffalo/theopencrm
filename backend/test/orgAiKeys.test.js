// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Bring-your-own Anthropic key — backend/services/orgAiKeys.js (migration 153).
//
// COVERAGE
//   1. setOrgKey: format validation (must look like sk-ant-…)
//   2. setOrgKey: encrypts with the real driveTokens helper; the ciphertext
//      written to the pool decrypts back to the key; last4 is the tail
//   3. setOrgKey: a 401 from the Anthropic probe → KEY_REJECTED, nothing stored
//   4. setOrgKey: a transient probe failure → stored with last_error
//   5. getOrgKey: decrypts the stored tuple; 30s cache; bustCache re-reads
//   6. getOrgKey: NODE_ENV=test bypass returns null unless opted in
//   7. clearOrgKey: DELETE + cache bust
//   8. getStatus: public shape never carries the key
//   9. setOrgKey refuses when DRIVE_TOKEN_ENCRYPTION_KEY is unset
//
// driveTokens is NOT mocked — encrypt/decrypt run for real (same as
// platformIntegrations.test.js). pool.query is patched on the live instance.

const crypto = require('crypto');
process.env.DRIVE_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/logger', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), notice: vi.fn(), debug: vi.fn(),
}));

const aiModel = require('../services/aiModel');
aiModel.getOrgAiSettings = vi.fn().mockResolvedValue({ model: 'claude-sonnet-4-6', effort: 'low' });

const driveTokens = require('../services/driveTokens');
const orgAiKeys = require('../services/orgAiKeys');

const ORG = 42;
const GOOD_KEY = 'sk-ant-api03-' + 'A'.repeat(40) + 'wxyz';

function okProbe() {
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
}

beforeEach(() => {
  mockPool.query.mockReset();
  driveTokens._resetForTests();
  orgAiKeys._resetForTests();
  process.env.ORG_AI_KEYS_IN_TESTS = 'true';
  okProbe();
});

afterEach(() => {
  delete process.env.ORG_AI_KEYS_IN_TESTS;
});

describe('isValidKeyFormat', () => {
  test('accepts an sk-ant- key and rejects junk', () => {
    expect(orgAiKeys.isValidKeyFormat(GOOD_KEY)).toBe(true);
    expect(orgAiKeys.isValidKeyFormat(`  ${GOOD_KEY}  `)).toBe(true);
    expect(orgAiKeys.isValidKeyFormat('sk-ant-short')).toBe(false);
    expect(orgAiKeys.isValidKeyFormat('sk-live-' + 'A'.repeat(40))).toBe(false);
    expect(orgAiKeys.isValidKeyFormat('sk-ant-' + 'A'.repeat(20) + ' with space')).toBe(false);
    expect(orgAiKeys.isValidKeyFormat('')).toBe(false);
    expect(orgAiKeys.isValidKeyFormat(null)).toBe(false);
  });
});

describe('setOrgKey', () => {
  test('rejects a malformed key before touching the DB or Anthropic', async () => {
    await expect(orgAiKeys.setOrgKey(ORG, 'not-a-key', 1)).rejects.toMatchObject({ code: 'INVALID_KEY_FORMAT', status: 400 });
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('encrypts with driveTokens, stores last4 + last_validated_at, never the plaintext', async () => {
    mockPool.query.mockImplementation(async (sql, params) => {
      if (/INSERT INTO org_ai_keys/i.test(sql)) {
        return { rows: [{ key_last4: params[5], last_validated_at: params[7], last_error: params[8], updated_at: new Date() }] };
      }
      return { rows: [] };
    });
    const status = await orgAiKeys.setOrgKey(ORG, GOOD_KEY, 7);

    expect(status).toMatchObject({ configured: true, last4: 'wxyz', billing_mode: 'byo_key', last_error: null });
    expect(status.last_validated_at).toBeInstanceOf(Date);
    expect(JSON.stringify(status)).not.toContain(GOOD_KEY);

    // Probe went out under the candidate key with a 1-token budget.
    const [, init] = globalThis.fetch.mock.calls[0];
    expect(init.headers['x-api-key']).toBe(GOOD_KEY);
    expect(JSON.parse(init.body).max_tokens).toBe(1);

    // The row carries ciphertext that round-trips through the real helper.
    const insert = mockPool.query.mock.calls.find(([sql]) => /INSERT INTO org_ai_keys/i.test(sql));
    const [orgId, provider, ciphertext, iv, tag, last4, userId] = insert[1];
    expect(orgId).toBe(ORG);
    expect(provider).toBe('anthropic');
    expect(userId).toBe(7);
    expect(last4).toBe('wxyz');
    expect(Buffer.isBuffer(ciphertext)).toBe(true);
    expect(ciphertext.toString('utf8')).not.toContain('sk-ant');
    expect(driveTokens.decrypt({ ciphertext, iv, tag })).toBe(GOOD_KEY);
  });

  test('Anthropic 401 → KEY_REJECTED and nothing is stored', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 401, json: async () => ({ error: { message: 'invalid x-api-key' } }),
    });
    await expect(orgAiKeys.setOrgKey(ORG, GOOD_KEY, 7)).rejects.toMatchObject({ code: 'KEY_REJECTED', status: 422 });
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('transient probe failure (529 / network) → stored with last_error, not validated', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    mockPool.query.mockImplementation(async (sql, params) => {
      if (/INSERT INTO org_ai_keys/i.test(sql)) {
        return { rows: [{ key_last4: params[5], last_validated_at: params[7], last_error: params[8], updated_at: new Date() }] };
      }
      return { rows: [] };
    });
    const status = await orgAiKeys.setOrgKey(ORG, GOOD_KEY, 7);
    expect(status.configured).toBe(true);
    expect(status.last_validated_at).toBeNull();
    expect(status.last_error).toMatch(/Could not reach Anthropic/);
  });

  test('refuses to store when the master encryption key is unset', async () => {
    const saved = process.env.DRIVE_TOKEN_ENCRYPTION_KEY;
    delete process.env.DRIVE_TOKEN_ENCRYPTION_KEY;
    driveTokens._resetForTests();
    try {
      await expect(orgAiKeys.setOrgKey(ORG, GOOD_KEY, 7)).rejects.toMatchObject({ code: 'ENCRYPTION_UNAVAILABLE', status: 503 });
      expect(mockPool.query).not.toHaveBeenCalled();
    } finally {
      process.env.DRIVE_TOKEN_ENCRYPTION_KEY = saved;
      driveTokens._resetForTests();
    }
  });
});

describe('getOrgKey / cache / clear', () => {
  function wireStoredKey(key) {
    const enc = driveTokens.encrypt(key);
    mockPool.query.mockImplementation(async (sql) => {
      if (/SELECT key_ciphertext/i.test(sql)) {
        return { rows: [{ key_ciphertext: enc.ciphertext, key_iv: enc.iv, key_tag: enc.tag }] };
      }
      if (/DELETE FROM org_ai_keys/i.test(sql)) return { rowCount: 1, rows: [] };
      return { rows: [] };
    });
  }

  test('decrypts the stored tuple and caches for subsequent reads', async () => {
    wireStoredKey(GOOD_KEY);
    expect(orgAiKeys.hasKeyCached(ORG)).toBe(false);
    expect(await orgAiKeys.getOrgKey(ORG)).toBe(GOOD_KEY);
    expect(orgAiKeys.hasKeyCached(ORG)).toBe(true);
    expect(await orgAiKeys.getOrgKey(ORG)).toBe(GOOD_KEY);
    expect(mockPool.query).toHaveBeenCalledTimes(1);

    orgAiKeys.bustCache(ORG);
    expect(await orgAiKeys.getOrgKey(ORG)).toBe(GOOD_KEY);
    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });

  test('no row → null (and the negative result is cached too)', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });
    expect(await orgAiKeys.getOrgKey(ORG)).toBeNull();
    expect(await orgAiKeys.getOrgKey(ORG)).toBeNull();
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(orgAiKeys.hasKeyCached(ORG)).toBe(false);
  });

  test('undecryptable row (wrong master key) → null, never throws', async () => {
    wireStoredKey(GOOD_KEY);
    process.env.DRIVE_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
    driveTokens._resetForTests();
    expect(await orgAiKeys.getOrgKey(ORG)).toBeNull();
  });

  test('NODE_ENV=test bypass: returns null without a query unless opted in', async () => {
    delete process.env.ORG_AI_KEYS_IN_TESTS;
    wireStoredKey(GOOD_KEY);
    expect(await orgAiKeys.getOrgKey(ORG)).toBeNull();
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('clearOrgKey deletes the row and busts the cache', async () => {
    wireStoredKey(GOOD_KEY);
    expect(await orgAiKeys.getOrgKey(ORG)).toBe(GOOD_KEY);
    expect(await orgAiKeys.clearOrgKey(ORG)).toBe(true);
    expect(orgAiKeys.hasKeyCached(ORG)).toBe(false);
    const del = mockPool.query.mock.calls.find(([sql]) => /DELETE FROM org_ai_keys/i.test(sql));
    expect(del[1]).toEqual([ORG, 'anthropic']);
  });
});

describe('getStatus', () => {
  test('returns the public shape without the key', async () => {
    const validated = new Date('2026-08-27T12:00:00Z');
    mockPool.query.mockResolvedValue({ rows: [{ key_last4: 'wxyz', last_validated_at: validated, last_error: null, updated_at: validated }] });
    const s = await orgAiKeys.getStatus(ORG);
    expect(s).toEqual({
      configured: true, provider: 'anthropic', last4: 'wxyz',
      last_validated_at: validated, last_error: null, updated_at: validated, billing_mode: 'byo_key',
    });
  });

  test('no row → configured false / billing_mode platform', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });
    const s = await orgAiKeys.getStatus(ORG);
    expect(s).toMatchObject({ configured: false, last4: null, billing_mode: 'platform' });
  });
});
