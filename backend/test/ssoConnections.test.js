// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// SSO connection storage — the OAuth client secret must be encrypted at rest
// (AES-256-GCM via services/driveTokens) and round-trip back only through the
// server-side getClientSecret() path. Never persisted or returned in plaintext.

const crypto = require('crypto');

// A valid 32-byte base64 master key, installed BEFORE requiring driveTokens so
// isConfigured() sees it. setup.js doesn't set this, so we own it here.
process.env.DRIVE_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();

const driveTokens = require('../services/driveTokens');
driveTokens._resetForTests();

const ssoConnections = require('../services/ssoConnections');

beforeEach(() => {
  mockPool.query.mockReset();
});

describe('ssoConnections client-secret encryption at rest', () => {
  const SECRET = 'super-secret-oauth-client-value';

  test('upsert stores the client secret as ciphertext (never plaintext) and round-trips', async () => {
    let stored = null; // captured ct/iv/tag buffers

    mockPool.query.mockImplementation(async (sql, params) => {
      if (sql.includes('SELECT id FROM sso_connections')) return { rows: [] }; // no existing row → INSERT path
      if (sql.startsWith('INSERT INTO sso_connections')) {
        // params order per the INSERT: org_id, slug, issuer, client_id,
        // client_secret_ct, client_secret_iv, client_secret_tag, allowed_domain, enabled, created_by
        stored = { ct: params[4], iv: params[5], tag: params[6] };
        // Prove the plaintext is NOT among the bound params.
        for (const p of params) {
          if (typeof p === 'string') expect(p).not.toContain(SECRET);
        }
        return {
          rows: [{
            id: 1, org_id: params[0], slug: params[1], protocol: 'oidc',
            issuer: params[2], client_id: params[3], client_secret_ct: params[4],
            allowed_domain: params[7], enabled: params[8], created_by: params[9],
            created_at: new Date(), updated_at: new Date(),
          }],
        };
      }
      return { rows: [] };
    });

    const conn = await ssoConnections.upsert(77, {
      slug: 'acme', issuer: 'https://idp.example.com', clientId: 'client-abc',
      clientSecret: SECRET, allowedDomain: 'acme.com', enabled: true, userId: 3,
    });

    // Public shape exposes hasSecret but NOT the secret itself.
    expect(conn.hasSecret).toBe(true);
    expect(JSON.stringify(conn)).not.toContain(SECRET);

    // Ciphertext is real bytes, not the plaintext.
    expect(Buffer.isBuffer(stored.ct)).toBe(true);
    expect(stored.ct.toString('utf8')).not.toContain(SECRET);

    // getClientSecret decrypts the stored tuple back to the original.
    mockPool.query.mockResolvedValueOnce({
      rows: [{ client_secret_ct: stored.ct, client_secret_iv: stored.iv, client_secret_tag: stored.tag }],
    });
    const back = await ssoConnections.getClientSecret(77);
    expect(back).toBe(SECRET);
  });

  test('getClientSecret returns null when no secret is stored', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ client_secret_ct: null, client_secret_iv: null, client_secret_tag: null }] });
    expect(await ssoConnections.getClientSecret(77)).toBeNull();
  });
});
