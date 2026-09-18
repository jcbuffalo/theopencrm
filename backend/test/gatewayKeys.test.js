// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// AI Gateway key service — services/gatewayKeys.js (spec 202).
//
// COVERAGE: key format (ocrm_gw_ + 32 bytes base64url), hash + display
// prefix derivation, header extraction (Bearer + x-api-key), active-key
// lookup with 30s cache, revoked/missing rejection, bustCache.

const crypto = require('crypto');

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

const gatewayKeys = require('../services/gatewayKeys');

beforeEach(() => {
  mockPool.query.mockReset();
  gatewayKeys._resetCachesForTests();
});

describe('generateKey', () => {
  it('mints ocrm_gw_ + 43 base64url chars (32 bytes) with matching hash + prefix', () => {
    const { fullKey, keyPrefix, keyHash } = gatewayKeys.generateKey();
    expect(fullKey).toMatch(/^ocrm_gw_[A-Za-z0-9_-]{43}$/);
    expect(keyPrefix).toBe(fullKey.slice(0, 'ocrm_gw_'.length + 8));
    expect(keyHash).toBe(crypto.createHash('sha256').update(fullKey, 'utf8').digest('hex'));
  });

  it('mints unique keys', () => {
    const a = gatewayKeys.generateKey();
    const b = gatewayKeys.generateKey();
    expect(a.fullKey).not.toBe(b.fullKey);
  });
});

describe('extractKeyFromRequest', () => {
  it('accepts Authorization: Bearer ocrm_gw_...', () => {
    const req = { headers: { authorization: 'Bearer ocrm_gw_abc123' } };
    expect(gatewayKeys.extractKeyFromRequest(req)).toBe('ocrm_gw_abc123');
  });

  it('accepts x-api-key: ocrm_gw_... (Anthropic-SDK header shape)', () => {
    const req = { headers: { 'x-api-key': 'ocrm_gw_xyz' } };
    expect(gatewayKeys.extractKeyFromRequest(req)).toBe('ocrm_gw_xyz');
  });

  it('ignores non-gateway bearer tokens (JWTs, tocrm_ PATs) and empty requests', () => {
    expect(gatewayKeys.extractKeyFromRequest({ headers: { authorization: 'Bearer tocrm_abc' } })).toBeNull();
    expect(gatewayKeys.extractKeyFromRequest({ headers: { authorization: 'Bearer eyJhbGciOi' } })).toBeNull();
    expect(gatewayKeys.extractKeyFromRequest({ headers: {} })).toBeNull();
  });
});

describe('findActiveByPlaintext', () => {
  const KEY = 'ocrm_gw_' + 'A'.repeat(43);
  const ROW = { id: 7, org_id: 42, label: 'test', key_prefix: 'ocrm_gw_AAAAAAAA', status: 'active' };

  it('returns the row for an active key and caches the lookup for 30s', async () => {
    mockPool.query.mockResolvedValue({ rows: [ROW] });
    const first = await gatewayKeys.findActiveByPlaintext(KEY);
    expect(first).toEqual(ROW);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    // Cache hit — no second query.
    const second = await gatewayKeys.findActiveByPlaintext(KEY);
    expect(second).toEqual(ROW);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  it('returns null for a revoked key and does NOT cache the miss', async () => {
    mockPool.query.mockResolvedValue({ rows: [{ ...ROW, status: 'revoked' }] });
    expect(await gatewayKeys.findActiveByPlaintext(KEY)).toBeNull();
    expect(await gatewayKeys.findActiveByPlaintext(KEY)).toBeNull();
    expect(mockPool.query).toHaveBeenCalledTimes(2); // re-checked each time
  });

  it('returns null for an unknown key and a malformed token without querying', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });
    expect(await gatewayKeys.findActiveByPlaintext(KEY)).toBeNull();
    expect(await gatewayKeys.findActiveByPlaintext('not-a-gateway-key')).toBeNull();
    expect(mockPool.query).toHaveBeenCalledTimes(1); // only the well-formed one hit the DB
  });

  it('bustCache forces the next lookup back to the DB (revocation propagates)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [ROW] });
    await gatewayKeys.findActiveByPlaintext(KEY); // cached now
    // Row flips to revoked in the DB; cache would still serve it...
    mockPool.query.mockResolvedValueOnce({ rows: [{ ...ROW, status: 'revoked' }] });
    gatewayKeys.bustCache(gatewayKeys.sha256Hex(KEY));
    expect(await gatewayKeys.findActiveByPlaintext(KEY)).toBeNull();
    expect(mockPool.query).toHaveBeenCalledTimes(2);
  });
});
