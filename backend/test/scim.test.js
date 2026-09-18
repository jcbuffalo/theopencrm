// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// SCIM 2.0 provisioning tests.
//
// COVERAGE
//   1. scimTokens crypto — scim_ prefix, hash = sha256(fullToken), header parse
//   2. findActiveByPlaintext — active row returned; revoked → null; missing → null
//   3. scimAuth middleware — 401 on missing/bad/revoked; sets req.orgId on valid;
//      fails CLOSED on a DB error
//   4. Provisioning through the mounted router — POST /Users creates the user
//      in the TOKEN's org with org_role='member'; a cross-scheme JWT is rejected
//
// Same harness as apiKeys.test.js / auth.test.js: patch the live pool export so
// no real DB is touched. Real crypto runs.

const crypto = require('crypto');

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();

// featureFlags.hasFeature is hit by requireFeature('sso_enabled') inside the
// router. Force it true so the gate opens; the auth/provisioning logic is what
// we're testing here (a separate assertion covers the gate being present).
const featureFlags = require('../services/featureFlags');
featureFlags.hasFeature = vi.fn().mockResolvedValue(true);

const audit = require('../services/audit');
audit.record = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

const express = require('express');
const request = require('supertest');
const scimTokens = require('../services/scimTokens');
const { scimAuth } = require('../middleware/scimAuth');
const scimRoutes = require('../routes/scimRoutes');

beforeEach(() => {
  mockPool.query.mockReset();
  featureFlags.hasFeature.mockClear();
});

// ---------------------------------------------------------------------------
// 1. crypto
// ---------------------------------------------------------------------------
describe('scimTokens.generateToken', () => {
  test('mints a scim_-prefixed token whose hash is sha256 of the plaintext', () => {
    const { fullToken, tokenPrefix, tokenHash } = scimTokens.generateToken();
    expect(fullToken.startsWith('scim_')).toBe(true);
    expect(tokenPrefix.startsWith('scim_')).toBe(true);
    expect(fullToken.startsWith(tokenPrefix)).toBe(true);
    expect(tokenHash).toBe(crypto.createHash('sha256').update(fullToken, 'utf8').digest('hex'));
    expect(tokenHash).not.toContain(fullToken);
  });

  test('extractTokenFromRequest reads only a scim_ Bearer (ignores JWTs)', () => {
    expect(scimTokens.extractTokenFromRequest({ headers: { authorization: 'Bearer scim_abc' } })).toBe('scim_abc');
    expect(scimTokens.extractTokenFromRequest({ headers: { authorization: 'Bearer eyJ.some.jwt' } })).toBeNull();
    expect(scimTokens.extractTokenFromRequest({ headers: {} })).toBeNull();
  });
});

describe('scimTokens.findActiveByPlaintext', () => {
  const valid = 'scim_' + 'a'.repeat(48);

  test('returns the row for a valid, non-revoked token (looked up by hash)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 3, org_id: 9, revoked_at: null }] });
    const row = await scimTokens.findActiveByPlaintext(valid);
    expect(row.org_id).toBe(9);
    const [, params] = mockPool.query.mock.calls[0];
    expect(params[0]).toBe(scimTokens.sha256Hex(valid));
  });

  test('returns null for a revoked token even though the row exists', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 3, org_id: 9, revoked_at: new Date() }] });
    expect(await scimTokens.findActiveByPlaintext(valid)).toBeNull();
  });

  test('returns null when no row matches, and short-circuits non-scim tokens', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    expect(await scimTokens.findActiveByPlaintext(valid)).toBeNull();
    expect(await scimTokens.findActiveByPlaintext('not-a-scim-token')).toBeNull();
    expect(mockPool.query).toHaveBeenCalledTimes(1); // the non-scim call never hit the DB
  });
});

// ---------------------------------------------------------------------------
// 3. scimAuth middleware — isolated
// ---------------------------------------------------------------------------
describe('scimAuth middleware', () => {
  function run(headers, poolImpl) {
    if (poolImpl) mockPool.query.mockImplementation(poolImpl);
    const app = express();
    app.use('/scim/v2', scimAuth, (req, res) => res.json({ orgId: req.orgId, scimTokenId: req.scimTokenId }));
    return request(app).get('/scim/v2/ping').set(headers || {});
  }

  test('401 when no bearer token present', async () => {
    const res = await run({});
    expect(res.status).toBe(401);
    expect(res.body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:Error');
  });

  test('401 for an unknown token', async () => {
    const res = await run({ authorization: 'Bearer scim_' + 'b'.repeat(48) }, async () => ({ rows: [] }));
    expect(res.status).toBe(401);
  });

  test('401 for a revoked token (findActive returns null)', async () => {
    const res = await run(
      { authorization: 'Bearer scim_' + 'c'.repeat(48) },
      async (sql) => (sql.includes('FROM scim_tokens') ? { rows: [{ id: 1, org_id: 4, revoked_at: new Date() }] } : { rows: [] })
    );
    expect(res.status).toBe(401);
  });

  test('fails CLOSED (401) when the token lookup throws', async () => {
    const res = await run(
      { authorization: 'Bearer scim_' + 'd'.repeat(48) },
      async () => { throw new Error('db down'); }
    );
    expect(res.status).toBe(401);
  });

  test('passes and sets req.orgId from the token row on a valid token', async () => {
    const res = await run(
      { authorization: 'Bearer scim_' + 'e'.repeat(48) },
      async (sql) => (sql.includes('FROM scim_tokens') ? { rows: [{ id: 7, org_id: 42, revoked_at: null }] } : { rows: [] })
    );
    expect(res.status).toBe(200);
    expect(res.body.orgId).toBe(42);
    expect(res.body.scimTokenId).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 4. Provisioning through the full router
// ---------------------------------------------------------------------------
describe('POST /scim/v2/Users — provisioning', () => {
  const TOKEN = 'scim_' + 'f'.repeat(48);
  const ORG_ID = 55;

  function buildApp() {
    const app = express();
    app.use('/scim/v2', scimRoutes);
    return app;
  }

  // Route the mocked pool by inspecting SQL so unawaited touchLastUsed doesn't
  // desync a strict call sequence.
  function poolRouter({ existingUser = [], insertRow } = {}) {
    return async (sql) => {
      if (sql.includes('FROM scim_tokens WHERE token_hash')) {
        return { rows: [{ id: 1, org_id: ORG_ID, revoked_at: null }] };
      }
      if (sql.startsWith('UPDATE scim_tokens SET last_used_at')) return { rows: [] };
      if (sql.includes('FROM users WHERE LOWER(email)')) return { rows: existingUser };
      if (sql.startsWith('INSERT INTO users')) return { rows: [insertRow] };
      return { rows: [] };
    };
  }

  test('creates the user in the TOKEN\'s org with org_role=member', async () => {
    const insertRow = {
      id: 900, email: 'newhire@acme.com', name: 'New Hire', status: 'active',
      created_at: new Date(), updated_at: new Date(),
    };
    mockPool.query.mockImplementation(poolRouter({ existingUser: [], insertRow }));

    const res = await request(buildApp())
      .post('/scim/v2/Users')
      .set('authorization', `Bearer ${TOKEN}`)
      .set('content-type', 'application/scim+json')
      .send({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'newhire@acme.com',
        name: { givenName: 'New', familyName: 'Hire' },
        active: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.userName).toBe('newhire@acme.com');
    expect(res.body.id).toBe('900');

    // Assert the INSERT bound org_id = the token's org and the 'member' role.
    const insertCall = mockPool.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO users'));
    expect(insertCall).toBeTruthy();
    expect(insertCall[0]).toMatch(/'member'/);
    // params: [email, name, status, org_id]
    expect(insertCall[1][3]).toBe(ORG_ID);
    expect(insertCall[1][0]).toBe('newhire@acme.com');
  });

  test('409 when the email already exists (no duplicate / cross-org hijack)', async () => {
    mockPool.query.mockImplementation(poolRouter({ existingUser: [{ id: 5, org_id: 999 }] }));
    const res = await request(buildApp())
      .post('/scim/v2/Users')
      .set('authorization', `Bearer ${TOKEN}`)
      .send({ userName: 'exists@acme.com', active: true });
    expect(res.status).toBe(409);
  });

  test('401 when a normal session JWT (not a scim_ token) is presented', async () => {
    mockPool.query.mockImplementation(poolRouter({}));
    const res = await request(buildApp())
      .post('/scim/v2/Users')
      .set('authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.fake.jwt')
      .send({ userName: 'x@acme.com' });
    expect(res.status).toBe(401);
  });
});
