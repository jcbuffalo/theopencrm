// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Tests for first-party analytics: the path normalizer (the privacy rail for
// page_views, migration 165) and the POST /api/metrics/pageview beacon.
//
// Strategy mirrors passwordReset.test.js: patch the live pool, mount the
// router on a bare Express app with the REAL pageviewLimiter, drive with
// supertest under distinct X-Forwarded-For IPs.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();

const express = require('express');
const request = require('supertest');

const { normalizePath, normalizeReferrerHost } = require('../utils/pathNormalizer');
const { pageviewLimiter } = require('../middleware/rateLimits');
const pageviewRoutes = require('../routes/pageviewRoutes');

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/metrics/pageview', pageviewLimiter, pageviewRoutes);
  return app;
}

let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `10.88.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.query.mockResolvedValue({ rows: [] });
});

// ---------------------------------------------------------------------------
// Normalizer unit tests — the privacy contract, documented in the module.
// ---------------------------------------------------------------------------

describe('normalizePath', () => {
  test('strips numeric record ids', () => {
    expect(normalizePath('/deals/123')).toBe('/deals/:id');
    expect(normalizePath('/companies/9/contacts/42')).toBe('/companies/:id/contacts/:id');
  });

  test('drops query strings and fragments entirely', () => {
    expect(normalizePath('/deals?stage=LEAD&secret=abc')).toBe('/deals');
    expect(normalizePath('/reset-password?token=deadbeefdeadbeefdeadbeefdeadbeef')).toBe('/reset-password');
    expect(normalizePath('/settings#privacy')).toBe('/settings');
  });

  test('masks token-like segments (hex / uuid / base64url)', () => {
    expect(normalizePath('/x/deadbeefdeadbeefdeadbeef')).toBe('/x/:token');
    expect(normalizePath('/x/550e8400-e29b-41d4-a716-446655440000')).toBe('/x/:token');
    expect(normalizePath('/x/AbC123xyz_-9foobar0')).toBe('/x/:token');
  });

  test('always masks under the known token routes, even short tokens', () => {
    expect(normalizePath('/portal/shorttok')).toBe('/portal/:token');
    expect(normalizePath('/f/ab12')).toBe('/f/:token');
    expect(normalizePath('/s/x')).toBe('/s/:token');
    expect(normalizePath('/accept-invite/tok')).toBe('/accept-invite/:token');
  });

  test('keeps ordinary route slugs and the root path', () => {
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('/admin/feature-flags')).toBe('/admin/feature-flags');
    expect(normalizePath('/customer-success-overview')).toBe('/customer-success-overview');
  });

  test('rejects garbage', () => {
    expect(normalizePath('')).toBe(null);
    expect(normalizePath('no-leading-slash')).toBe(null);
    expect(normalizePath(12345)).toBe(null);
    expect(normalizePath(null)).toBe(null);
    expect(normalizePath('/a/'.repeat(50))).toBe(null); // too many segments
    expect(normalizePath('/x' + String.fromCharCode(0) + 'y')).toBe(null); // control chars
  });
});

describe('normalizeReferrerHost', () => {
  test('accepts plain hostnames, lowercased', () => {
    expect(normalizeReferrerHost('News.Ycombinator.com')).toBe('news.ycombinator.com');
    expect(normalizeReferrerHost('t.co')).toBe('t.co');
  });
  test('rejects URLs, paths, and garbage', () => {
    expect(normalizeReferrerHost('https://evil.com/path')).toBe(null);
    expect(normalizeReferrerHost('host/with/path')).toBe(null);
    expect(normalizeReferrerHost('')).toBe(null);
    expect(normalizeReferrerHost(42)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Endpoint tests
// ---------------------------------------------------------------------------

describe('POST /api/metrics/pageview', () => {
  test('anonymous view: 204, inserts normalized path with org NULL', async () => {
    const res = await request(buildApp())
      .post('/api/metrics/pageview')
      .set('X-Forwarded-For', nextIp())
      .send({ path: '/deals/123?tab=intel', referrer_host: 'news.ycombinator.com' });

    expect(res.status).toBe(204);
    const insert = mockPool.query.mock.calls.find(([sql]) => /INSERT INTO page_views/.test(sql));
    expect(insert).toBeTruthy();
    const [, params] = insert;
    expect(params).toEqual([null, '/deals/:id', 'news.ycombinator.com', false]);
  });

  test('implausible path: 204 but nothing stored', async () => {
    const res = await request(buildApp())
      .post('/api/metrics/pageview')
      .set('X-Forwarded-For', nextIp())
      .send({ path: 'javascript:alert(1)' });
    expect(res.status).toBe(204);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('DB failure: still 204 (silent by design)', async () => {
    mockPool.query.mockRejectedValue(new Error('db down'));
    const res = await request(buildApp())
      .post('/api/metrics/pageview')
      .set('X-Forwarded-For', nextIp())
      .send({ path: '/chat' });
    expect(res.status).toBe(204);
  });

  test('rate limit: 61st beacon from one IP → 429', async () => {
    const app = buildApp();
    const ip = nextIp();
    for (let i = 0; i < 60; i++) {
      const r = await request(app)
        .post('/api/metrics/pageview')
        .set('X-Forwarded-For', ip)
        .send({ path: '/chat' });
      expect(r.status).toBe(204);
    }
    const blocked = await request(app)
      .post('/api/metrics/pageview')
      .set('X-Forwarded-For', ip)
      .send({ path: '/chat' });
    expect(blocked.status).toBe(429);
  });
});
