// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// QuickBooks OAuth token encryption at rest (migration 099 / P1-3).
// Verifies tokens are AES-256-GCM encrypted with the shared DRIVE_TOKEN_
// ENCRYPTION_KEY helper, decrypt back correctly, and that saveConnection never
// persists plaintext.

const crypto = require('crypto');
// A valid 32-byte key must exist before driveTokens caches it.
process.env.DRIVE_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const driveTokens = require('../services/driveTokens');
driveTokens._resetForTests();

// Overwrite the live pool's query (every service shares the require('../db') instance).
const realPool = require('../db');
realPool.query = vi.fn();

const qb = require('../services/quickbooks');

beforeEach(() => realPool.query.mockReset());

describe('quickbooks.decryptTokens', () => {
  test('round-trips ciphertext produced by the shared crypto helper', () => {
    const at = driveTokens.encrypt('access-abc');
    const rt = driveTokens.encrypt('refresh-xyz');
    const conn = {
      access_token_ct: at.ciphertext, access_token_iv: at.iv, access_token_tag: at.tag,
      refresh_token_ct: rt.ciphertext, refresh_token_iv: rt.iv, refresh_token_tag: rt.tag,
    };
    expect(qb.decryptTokens(conn)).toEqual({ accessToken: 'access-abc', refreshToken: 'refresh-xyz' });
  });

  test('falls back to legacy plaintext columns when ciphertext is absent', () => {
    const conn = { access_token: 'legacy-a', refresh_token: 'legacy-r' };
    expect(qb.decryptTokens(conn)).toEqual({ accessToken: 'legacy-a', refreshToken: 'legacy-r' });
  });
});

describe('quickbooks.saveConnection', () => {
  test('writes ciphertext buffers, NULLs plaintext columns, and never stores the raw token', async () => {
    realPool.query.mockResolvedValueOnce({ rows: [] });
    await qb.saveConnection({
      orgId: 7, userId: 3, realmId: 'realm1',
      tokens: { access_token: 'AAA', refresh_token: 'RRR', expires_in: 3600 },
    });

    expect(realPool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = realPool.query.mock.calls[0];
    expect(sql).toMatch(/access_token_ct/);
    expect(sql).toMatch(/access_token = NULL/);
    expect(sql).toMatch(/refresh_token = NULL/);

    // params order: orgId, realmId, at.ct, at.iv, at.tag, rt.ct, rt.iv, rt.tag, expiresAt, env, userId
    expect(Buffer.isBuffer(params[2])).toBe(true); // access_token ciphertext
    expect(Buffer.isBuffer(params[5])).toBe(true); // refresh_token ciphertext
    // No parameter carries the raw plaintext token.
    expect(params).not.toContain('AAA');
    expect(params).not.toContain('RRR');
    // ...but the stored ciphertext decrypts back to the originals.
    expect(driveTokens.decrypt({ ciphertext: params[2], iv: params[3], tag: params[4] })).toBe('AAA');
    expect(driveTokens.decrypt({ ciphertext: params[5], iv: params[6], tag: params[7] })).toBe('RRR');
  });
});
