// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Tests for data enrichment — services/enrichment.js + the /:id/enrich routes
// on contactRoutes.js / companyRoutes.js.
//
// Strategy mirrors test/communications.test.js: mount the router on a bare
// Express app, mock the pg pool by overwriting query() on the live instance,
// and queue per-call mockResolvedValueOnce() responses in the order the handler
// issues them (authMiddleware SELECT first, then the route's own queries).
// global.fetch is stubbed so the "provider" never hits the network, and the
// enrichment_enabled feature gate is forced on via featureFlags.hasFeature.
//
// Coverage:
//   • isConfigured gating on ENRICHMENT_API_KEY
//   • normalization of a raw provider payload → the stable shape
//   • cache HIT skips the provider; cache MISS calls it and writes the cache
//   • unconfigured → { configured:false }, never throws, never calls fetch
//   • enrich endpoint is org-scoped (a cross-org id 404s, no provider call)

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const enrichment = require('../services/enrichment');
const featureFlags = require('../services/featureFlags');
const contactRoutes = require('../routes/contactRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 4242;
const ORG_ID = 77;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/contacts', contactRoutes);
  return app;
}

// authMiddleware issues SELECT org_id, org_role, status FROM users WHERE id=$1.
function queueAuthRow(role = 'member') {
  mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: role, status: 'active' }] });
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.query.mockResolvedValue({ rows: [] });
  // Force the feature gate on so the route reaches its handler.
  vi.spyOn(featureFlags, 'hasFeature').mockResolvedValue(true);
  delete process.env.ENRICHMENT_API_KEY;
  delete process.env.ENRICHMENT_PROVIDER_URL;
  delete process.env.ENRICHMENT_PROVIDER;
  global.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ENRICHMENT_API_KEY;
  delete process.env.ENRICHMENT_PROVIDER_URL;
  delete process.env.ENRICHMENT_PROVIDER;
});

// ---------------------------------------------------------------------------
// service: isConfigured + normalization
// ---------------------------------------------------------------------------
describe('enrichment.isConfigured', () => {
  test('false when no API key, true once ENRICHMENT_API_KEY is set', () => {
    expect(enrichment.isConfigured()).toBe(false);
    process.env.ENRICHMENT_API_KEY = 'k_live_abc';
    expect(enrichment.isConfigured()).toBe(true);
  });
});

describe('enrichment normalization', () => {
  test('contact payload maps vendor field names onto the stable shape', () => {
    const out = enrichment.normalizeContact({
      jobTitle: 'VP Sales', organization: 'Acme', linkedin_url: 'https://lnkd.in/x', city: 'Austin, TX', junk: 1,
    });
    expect(out).toEqual({ title: 'VP Sales', company: 'Acme', linkedin: 'https://lnkd.in/x', location: 'Austin, TX' });
  });

  test('company payload maps vendor field names onto the stable shape', () => {
    const out = enrichment.normalizeCompany({
      category: 'Software', employees: 250, domain: 'acme.com', summary: 'We make things.',
    });
    expect(out).toEqual({ industry: 'Software', employee_count: 250, website: 'acme.com', description: 'We make things.' });
  });

  test('missing fields normalize to null, never throw', () => {
    expect(enrichment.normalizeContact(null)).toEqual({ title: null, company: null, linkedin: null, location: null });
    expect(enrichment.normalizeCompany(undefined)).toEqual({ industry: null, employee_count: null, website: null, description: null });
  });
});

// ---------------------------------------------------------------------------
// service: unconfigured / cache miss / cache hit
// ---------------------------------------------------------------------------
describe('enrichment.enrichContact', () => {
  test('unconfigured: returns configured:false, never calls the provider or throws', async () => {
    const res = await enrichment.enrichContact({ email: 'a@b.com', orgId: ORG_ID });
    expect(res.configured).toBe(false);
    expect(res.fields).toEqual({});
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('cache MISS: calls the provider, normalizes, and writes the cache', async () => {
    process.env.ENRICHMENT_API_KEY = 'k_live_abc';
    process.env.ENRICHMENT_PROVIDER_URL = 'https://provider.example/lookup';
    process.env.ENRICHMENT_PROVIDER = 'testprov';

    // 1) cache read → miss (no rows)
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // 2) cache write → ignored
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jobTitle: 'CTO', company: 'Acme', linkedin: 'li/x', location: 'NYC' }),
    });

    const res = await enrichment.enrichContact({ email: 'Person@Acme.com ', orgId: ORG_ID });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    // Provider called with the normalized (lowercased/trimmed) email key.
    const calledUrl = global.fetch.mock.calls[0][0];
    expect(calledUrl).toContain('type=contact');
    expect(calledUrl).toContain('key=person%40acme.com');
    expect(res.configured).toBe(true);
    expect(res.cached).toBe(false);
    expect(res.fields).toEqual({ title: 'CTO', company: 'Acme', linkedin: 'li/x', location: 'NYC' });

    // A cache-write INSERT was issued.
    const wrote = mockPool.query.mock.calls.some(([sql]) => /INSERT INTO enrichment_cache/i.test(sql));
    expect(wrote).toBe(true);
  });

  test('cache HIT: returns cached data and never calls the provider', async () => {
    process.env.ENRICHMENT_API_KEY = 'k_live_abc';
    process.env.ENRICHMENT_PROVIDER_URL = 'https://provider.example/lookup';

    // cache read → hit
    mockPool.query.mockResolvedValueOnce({
      rows: [{ data: { title: 'Cached VP', company: 'CachedCo' }, provider: 'testprov', fetched_at: new Date() }],
    });

    const res = await enrichment.enrichContact({ email: 'x@y.com', orgId: ORG_ID });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(res.cached).toBe(true);
    expect(res.fields.title).toBe('Cached VP');
    expect(res.fields.company).toBe('CachedCo');
  });
});

// ---------------------------------------------------------------------------
// route: POST /api/contacts/:id/enrich — org-scoping
// ---------------------------------------------------------------------------
describe('POST /api/contacts/:id/enrich', () => {
  test('org-scoping: a contact outside the org 404s and never calls the provider', async () => {
    process.env.ENRICHMENT_API_KEY = 'k_live_abc';
    process.env.ENRICHMENT_PROVIDER_URL = 'https://provider.example/lookup';
    queueAuthRow();
    // lookup SELECT ... WHERE id=$1 AND org_id=$2 → miss
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .post('/api/contacts/999/enrich')
      .set('Cookie', authCookie())
      .send({});

    expect(res.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();

    // The lookup was org-scoped (bound both id and org_id).
    const lookup = mockPool.query.mock.calls.find(
      ([sql]) => /FROM contacts WHERE id = \$1 AND org_id = \$2/i.test(sql)
    );
    expect(lookup).toBeDefined();
    expect(lookup[1]).toEqual(['999', ORG_ID]);
  });

  test('unconfigured provider: returns 200 { configured:false } proposal', async () => {
    queueAuthRow();
    // contact lookup → found (no email)
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 5, email: null }] });

    const res = await request(buildApp())
      .post('/api/contacts/5/enrich')
      .set('Cookie', authCookie())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.fields).toEqual({});
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('apply merges accepted fields into custom_fields (org-scoped UPDATE)', async () => {
    queueAuthRow();
    // UPDATE ... RETURNING → the updated row
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 5, custom_fields: { enrichment_title: 'CTO' } }] });

    const res = await request(buildApp())
      .post('/api/contacts/5/enrich/apply')
      .set('Cookie', authCookie())
      .send({ fields: { title: 'CTO', company: '' } });

    expect(res.status).toBe(200);
    const update = mockPool.query.mock.calls.find(
      ([sql]) => /UPDATE contacts/i.test(sql) && /custom_fields/i.test(sql) && /org_id = \$3/i.test(sql)
    );
    expect(update).toBeDefined();
    // Only the non-empty field was namespaced + written; empty company dropped.
    const mergedJson = JSON.parse(update[1][0]);
    expect(mergedJson).toEqual({ enrichment_title: 'CTO' });
    expect(update[1][2]).toBe(ORG_ID);
  });
});
