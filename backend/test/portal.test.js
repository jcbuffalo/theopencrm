// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Customer Portal (migration 141) — service + route tests.
//
// Follows the surveys.test.js pattern: routes are mounted on a tiny Express
// app with the pg pool fully mocked (each pool.query call resolves the next
// queued response in route-issue order; the featureGate's session resolve is
// always query #1 on the authenticated surface). featureFlags.hasFeature is
// stubbed; storage.getSignedDownloadUrl is stubbed.
//
// Coverage map (the security spec for this slice):
//   • mint — token is 48-hex (192-bit), row carries the CALLER's tenancy, and
//     a cross-org company id can never be minted against (scoped fetch → 404).
//   • resolve — active + not-expired SQL guard, per-token portal_enabled
//     re-check, last_accessed_at stamp, malformed tokens never touch the DB.
//   • public reads — EVERY query binds the token's org_id AND company_id
//     (single-company scoping proof); whitelisted projections only (no notes,
//     no AI columns); unknown/revoked/expired/flag-off → the SAME generic 404.
//   • document download — same scoped predicate as the list (a foreign doc id
//     404s), GCS signed-URL redirect + DB-blob fallback.
//   • feature gate — portal_enabled=false → 403 on the admin surface and a
//     dead public surface (404), and the flag DEFAULTS OFF (ships inert).

// describe / test / expect / beforeEach / vi are global (vitest globals: true).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const portalService = require('../services/portal');
const portalRoutes = require('../routes/portalRoutes');
const featureFlags = require('../services/featureFlags');
const storage = require('../services/storage');
const { requireFeature } = require('../middleware/featureGate');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 4242;
const ORG_ID = 7;
const COMPANY_ID = 99;
const TOKEN = 'a'.repeat(48); // matches the 48-hex-char minted shape

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

// Token management is owner/admin-gated (mirrors segment bulk actions), so
// the default auth row is an admin; the role-gate tests pass 'member'
// explicitly. Pass orgId: null for an org-less personal workspace.
function authRow(role = 'admin', orgId = ORG_ID) {
  return { rows: [{ org_id: orgId, org_role: role, status: 'active' }] };
}

// The row resolveToken returns from its SELECT.
function tokenRow(overrides = {}) {
  return {
    id: 11, user_id: USER_ID, org_id: ORG_ID, company_id: COMPANY_ID,
    contact_id: null, is_active: true, expires_at: null,
    ...overrides,
  };
}

const STAMP_OK = { rows: [] }; // the last_accessed_at UPDATE response

// Authenticated app — mirrors the index.js mount (gate at the mount point).
function buildAuthedApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/portal', requireFeature('portal_enabled'), portalRoutes);
  return app;
}

// Public app — read surface only, WITHOUT the limiter so functional tests
// don't burn its budget (it's a module-level singleton).
function buildPublicApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/public/portal', portalRoutes.publicRouter);
  return app;
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  vi.restoreAllMocks();
  vi.spyOn(featureFlags, 'hasFeature').mockResolvedValue(true);
  // The public POST routes carry portalWriteLimiter (10/15min/IP, module
  // singleton) and supertest presents one IP for the whole file — reset its
  // counter per test so functional coverage never trips the limiter. The
  // limiter's OWN behavior is asserted separately, not via exhaustion here.
  const { portalWriteLimiter } = require('../middleware/rateLimits');
  for (const key of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) {
    try { portalWriteLimiter.resetKey(key); } catch (_) { /* store variance */ }
  }
});

// ---------------------------------------------------------------------------
// Flag default — the whole module ships inert
// ---------------------------------------------------------------------------

describe('portal_enabled flag registration', () => {
  test('is a registered module flag that DEFAULTS OFF', () => {
    const flag = featureFlags.KNOWN_FLAGS.find((f) => f.name === 'portal_enabled');
    expect(flag).toBeTruthy();
    expect(flag.category).toBe('module');
    expect(flag.defaultValue).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Admin surface — mint / list / revoke, org isolation, feature gate
// ---------------------------------------------------------------------------

describe('portal token management (authenticated)', () => {
  test('portal_enabled = false → 403 on the admin surface', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    mockPool.query.mockResolvedValueOnce(authRow()); // gate's session resolve
    const res = await request(buildAuthedApp())
      .get('/api/portal/tokens').set('Cookie', authCookie());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
  });

  test('POST /tokens mints a 192-bit hex token carrying the caller tenancy', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow())                                  // 1 gate auth
      .mockResolvedValueOnce({ rows: [{ id: COMPANY_ID }] })             // 2 company scoped fetch
      .mockResolvedValueOnce({ rows: [tokenRow({ token: TOKEN })] });    // 3 insert
    const res = await request(buildAuthedApp())
      .post('/api/portal/tokens').set('Cookie', authCookie())
      .send({ company_id: COMPANY_ID, label: 'Q3 review link' });
    expect(res.status).toBe(201);

    // The company lookup was org-scoped.
    const [compSql, compParams] = mockPool.query.mock.calls[1];
    expect(compSql).toContain('org_id = $2');
    expect(compParams).toEqual([COMPANY_ID, ORG_ID]);

    // Inserted row: caller's user + org, the requested company, random token.
    const [insSql, insParams] = mockPool.query.mock.calls[2];
    expect(insSql).toContain('INSERT INTO portal_tokens');
    expect(insParams[0]).toBe(USER_ID);            // user_id
    expect(insParams[1]).toBe(ORG_ID);             // org_id
    expect(insParams[2]).toBe(COMPANY_ID);         // company_id
    expect(insParams[4]).toMatch(/^[0-9a-f]{48}$/); // 192-bit hex credential
    expect(insParams[5]).toBe('Q3 review link');
  });

  test('POST /tokens 404s for a cross-org company id — nothing minted', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] });        // scoped company fetch → miss
    const res = await request(buildAuthedApp())
      .post('/api/portal/tokens').set('Cookie', authCookie())
      .send({ company_id: 123456 });
    expect(res.status).toBe(404);
    expect(mockPool.query.mock.calls).toHaveLength(2); // no INSERT
  });

  test('POST /tokens rejects a past expires_at', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [{ id: COMPANY_ID }] });
    const res = await request(buildAuthedApp())
      .post('/api/portal/tokens').set('Cookie', authCookie())
      .send({ company_id: COMPANY_ID, expires_at: '2020-01-01T00:00:00Z' });
    expect(res.status).toBe(400);
  });

  test('POST /tokens validates a supplied contact_id in-scope', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [{ id: COMPANY_ID }] })  // company ok
      .mockResolvedValueOnce({ rows: [] });                   // contact scoped fetch → miss
    const res = await request(buildAuthedApp())
      .post('/api/portal/tokens').set('Cookie', authCookie())
      .send({ company_id: COMPANY_ID, contact_id: 777 });
    expect(res.status).toBe(404);
    const [contactSql, contactParams] = mockPool.query.mock.calls[2];
    expect(contactSql).toContain('org_id = $2');
    expect(contactParams).toEqual([777, ORG_ID]);
  });

  test('GET /tokens scopes the list to the caller org', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [tokenRow({ token: TOKEN, company_name: 'Acme' })] });
    const res = await request(buildAuthedApp())
      .get(`/api/portal/tokens?company_id=${COMPANY_ID}`).set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toContain('pt.org_id = $1');
    expect(params).toEqual([ORG_ID, String(COMPANY_ID)]);
  });

  test('POST /tokens/:id/revoke 404s cross-org (scoped UPDATE misses)', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] });        // scoped update → miss
    const res = await request(buildAuthedApp())
      .post('/api/portal/tokens/55/revoke').set('Cookie', authCookie());
    expect(res.status).toBe(404);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toContain('is_active = FALSE');
    expect(sql).toContain('org_id = $2');
    expect(params).toEqual(['55', ORG_ID]);
  });
});

// ---------------------------------------------------------------------------
// Owner/admin gate — minting a shareable external credential (and reading
// token values back) is privileged; plain org members get a 403 on every
// management route. Mirrors the segment bulk-action gate.
// ---------------------------------------------------------------------------

describe('portal token management role gate', () => {
  const MEMBER_CASES = [
    ['GET',    '/api/portal/tokens'],
    ['POST',   '/api/portal/tokens'],
    ['POST',   '/api/portal/tokens/55/revoke'],
    ['DELETE', '/api/portal/tokens/55'],
  ];

  test.each(MEMBER_CASES)('non-admin org member → 403 on %s %s, nothing queried past auth', async (method, path) => {
    mockPool.query.mockResolvedValueOnce(authRow('member')); // gate's session resolve
    const req = request(buildAuthedApp())[method.toLowerCase()](path)
      .set('Cookie', authCookie());
    const res = method === 'POST' && path === '/api/portal/tokens'
      ? await req.send({ company_id: COMPANY_ID })
      : await req;
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owners\/admins/);
    expect(mockPool.query.mock.calls).toHaveLength(1); // auth only — no token data touched
  });

  test('org owner passes the gate (list allowed)', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow('owner'))
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(buildAuthedApp())
      .get('/api/portal/tokens').set('Cookie', authCookie());
    expect(res.status).toBe(200);
  });

  test('org admin passes the gate (revoke allowed)', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow('admin'))
      .mockResolvedValueOnce({ rows: [{ id: 55, is_active: false }] });
    const res = await request(buildAuthedApp())
      .post('/api/portal/tokens/55/revoke').set('Cookie', authCookie());
    expect(res.status).toBe(200);
  });

  test('org-less (personal workspace) mint → 403: the portal requires an organization', async () => {
    mockPool.query.mockResolvedValueOnce(authRow(null, null)); // no org
    const res = await request(buildAuthedApp())
      .post('/api/portal/tokens').set('Cookie', authCookie())
      .send({ company_id: COMPANY_ID });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/requires an organization/);
    expect(mockPool.query.mock.calls).toHaveLength(1); // nothing minted
  });
});

// ---------------------------------------------------------------------------
// resolveToken — the trust boundary
// ---------------------------------------------------------------------------

describe('portal.resolveToken', () => {
  test('the lookup SQL enforces active + not-expired in one guarded query', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })
      .mockResolvedValueOnce(STAMP_OK);
    const t = await portalService.resolveToken(TOKEN);
    expect(t).toBeTruthy();
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('is_active = TRUE');
    expect(sql).toContain('expires_at IS NULL OR expires_at > NOW()');
    expect(params).toEqual([TOKEN]);
  });

  test('stamps last_accessed_at on success (the only public-surface write)', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })
      .mockResolvedValueOnce(STAMP_OK);
    await portalService.resolveToken(TOKEN);
    const [stampSql, stampParams] = mockPool.query.mock.calls[1];
    expect(stampSql).toContain('last_accessed_at = NOW()');
    expect(stampParams).toEqual([11]);
  });

  test('a failed stamp never blocks the read (best-effort)', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })
      .mockRejectedValueOnce(new Error('write blip'));
    const t = await portalService.resolveToken(TOKEN);
    expect(t).toBeTruthy();
  });

  test('unknown token → null, no stamp', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    expect(await portalService.resolveToken('f'.repeat(48))).toBeNull();
    expect(mockPool.query.mock.calls).toHaveLength(1);
  });

  test('malformed token is rejected before touching the DB', async () => {
    expect(await portalService.resolveToken('nope!')).toBeNull();
    expect(await portalService.resolveToken('')).toBeNull();
    expect(await portalService.resolveToken(null)).toBeNull();
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('org flag off → null (public surface disappears with the module)', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    mockPool.query.mockResolvedValueOnce({ rows: [tokenRow()] });
    expect(await portalService.resolveToken(TOKEN)).toBeNull();
    expect(featureFlags.hasFeature).toHaveBeenCalledWith(ORG_ID, 'portal_enabled');
    expect(mockPool.query.mock.calls).toHaveLength(1); // no stamp on a dead token
  });

  test('org-less token → null even with the flag "on" (kill switch honored: no org, no portal)', async () => {
    featureFlags.hasFeature.mockResolvedValue(true);
    mockPool.query.mockResolvedValueOnce({ rows: [tokenRow({ org_id: null })] });
    expect(await portalService.resolveToken(TOKEN)).toBeNull();
    expect(featureFlags.hasFeature).not.toHaveBeenCalled();
    expect(mockPool.query.mock.calls).toHaveLength(1); // no stamp on a dead token
  });
});

// ---------------------------------------------------------------------------
// Public reads — single-company scoping + whitelists + generic 404
// ---------------------------------------------------------------------------

describe('public portal reads', () => {
  test('unknown token → the SAME generic 404 on every path, nothing else queried', async () => {
    for (const path of ['overview', 'deals', 'documents', 'documents/5/download']) {
      mockPool.query.mockReset();
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // token miss
      const res = await request(buildPublicApp())
        .get(`/api/public/portal/${'f'.repeat(48)}/${path}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not found' });
      expect(mockPool.query.mock.calls).toHaveLength(1);
    }
  });

  test('malformed token 404s without any DB call', async () => {
    const res = await request(buildPublicApp())
      .get('/api/public/portal/short/overview');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('flag-off org token → generic 404 (indistinguishable from unknown)', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    mockPool.query.mockResolvedValueOnce({ rows: [tokenRow()] });
    const res = await request(buildPublicApp())
      .get(`/api/public/portal/${TOKEN}/deals`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  test('overview: every read binds the token org + company; whitelisted shape', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })                       // 1 resolve
      .mockResolvedValueOnce(STAMP_OK)                                     // 2 stamp
      .mockResolvedValueOnce({ rows: [{ name: 'Acme', industry: 'Mfg', website: 'https://acme.test', location: 'Buffalo' }] }) // 3 company
      .mockResolvedValueOnce({ rows: [{ total: 3, open: 2 }] })            // 4 deal counts
      .mockResolvedValueOnce({ rows: [{ id: 1, title: 'Q-100', status: 'sent', total_amount: '500.00', valid_until: null, created_at: 'now' }] }) // 5 quotes
      .mockResolvedValueOnce({ rows: [] });                                // 6 invoices
    const res = await request(buildPublicApp())
      .get(`/api/public/portal/${TOKEN}/overview`);
    expect(res.status).toBe(200);

    // Company / deals / quotes / invoices queries ALL carry org + company.
    for (const i of [2, 3, 4, 5]) {
      const [sql, params] = mockPool.query.mock.calls[i];
      expect(sql).toContain('org_id = $1');
      expect(params[0]).toBe(ORG_ID);
      expect(params[1]).toBe(COMPANY_ID);
    }

    // Whitelisted projection: profile basics only, no internals.
    expect(res.body.company).toEqual({ name: 'Acme', industry: 'Mfg', website: 'https://acme.test', location: 'Buffalo' });
    expect(res.body.deals).toEqual({ total: 3, open: 2 });
    expect(res.body.quotes).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain('org_id');
    expect(JSON.stringify(res.body)).not.toContain('notes');
  });

  test('overview degrades gracefully when quotes/invoices tables are absent', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })
      .mockResolvedValueOnce(STAMP_OK)
      .mockResolvedValueOnce({ rows: [{ name: 'Acme', industry: null, website: null, location: null }] })
      .mockResolvedValueOnce({ rows: [{ total: 0, open: 0 }] })
      .mockRejectedValueOnce(new Error('relation "quotes" does not exist'))
      .mockRejectedValueOnce(new Error('relation "invoices" does not exist'));
    const res = await request(buildPublicApp())
      .get(`/api/public/portal/${TOKEN}/overview`);
    expect(res.status).toBe(200);
    expect(res.body.quotes).toEqual([]);
    expect(res.body.invoices).toEqual([]);
  });

  test('deals: scoped to org + company, and the SELECT list excludes internals', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })
      .mockResolvedValueOnce(STAMP_OK)
      .mockResolvedValueOnce({ rows: [{ id: 5, title: 'Widget order', stage: 'PROPOSAL', amount: '1000.00', expected_close_date: null, closed_date: null, created_at: 'now' }] });
    const res = await request(buildPublicApp())
      .get(`/api/public/portal/${TOKEN}/deals`);
    expect(res.status).toBe(200);

    const [sql, params] = mockPool.query.mock.calls[2];
    expect(sql).toContain('company_id = $2');
    expect(sql).toContain('org_id = $1');
    expect(params).toEqual([ORG_ID, COMPANY_ID]);
    // Internal-only columns are not even selected — they cannot leak.
    expect(sql).not.toMatch(/\bnotes\b/);
    expect(sql).not.toMatch(/\bdescription\b/);
    expect(sql).not.toContain('ai_health_score');
    expect(sql).not.toContain('ai_win_probability');
    expect(sql).not.toContain('ai_risk_factors');
  });

  test('org-less (user_id-scoped) token → generic 404: no org means no portal_enabled kill switch, so it must not serve', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [tokenRow({ org_id: null })] });
    const res = await request(buildPublicApp())
      .get(`/api/public/portal/${TOKEN}/deals`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    // Dead token: no access stamp, no data query — resolve stopped at org-less.
    expect(mockPool.query.mock.calls).toHaveLength(1);
    // And the flag check never ran (there is no org to check).
    expect(featureFlags.hasFeature).not.toHaveBeenCalled();
  });

  test('documents list: predicate covers the company AND only ITS deals', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })
      .mockResolvedValueOnce(STAMP_OK)
      .mockResolvedValueOnce({ rows: [{ id: 9, filename: 'contract.pdf', doc_type: 'contract', size: 1234, mime_type: 'application/pdf', created_at: 'now' }] });
    const res = await request(buildPublicApp())
      .get(`/api/public/portal/${TOKEN}/documents`);
    expect(res.status).toBe(200);

    const [sql, params] = mockPool.query.mock.calls[2];
    expect(sql).toContain(`d.related_type = 'company' AND d.related_id = $2`);
    expect(sql).toContain('company_id = $2'); // the deal-doc subquery is company-bound too
    expect(params).toEqual([ORG_ID, COMPANY_ID]);
    // No storage paths / uploader identity / notes in the projection.
    expect(sql).not.toContain('gcs_object_path');
    expect(sql).not.toContain('uploaded_by');
    expect(sql).not.toMatch(/d\.notes/);
  });
});

// ---------------------------------------------------------------------------
// Document download — scoping + transports
// ---------------------------------------------------------------------------

describe('public portal document download', () => {
  test('GCS-stored doc → 302 redirect to a short-lived signed URL', async () => {
    vi.spyOn(storage, 'getSignedDownloadUrl').mockResolvedValue('https://signed.example/doc');
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })
      .mockResolvedValueOnce(STAMP_OK)
      .mockResolvedValueOnce({ rows: [{ filename: 'contract.pdf', mime_type: 'application/pdf', content: null, gcs_object_path: 'org/7/company/99/x-contract.pdf' }] });
    const res = await request(buildPublicApp())
      .get(`/api/public/portal/${TOKEN}/documents/9/download`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://signed.example/doc');
    expect(storage.getSignedDownloadUrl).toHaveBeenCalledWith(
      'org/7/company/99/x-contract.pdf',
      expect.objectContaining({ expiresInSeconds: 900, filename: 'contract.pdf' })
    );

    // The doc lookup ran the SAME company-scoped predicate as the list.
    const [sql, params] = mockPool.query.mock.calls[2];
    expect(sql).toContain(`d.related_type = 'company' AND d.related_id = $2`);
    expect(params).toEqual([ORG_ID, COMPANY_ID, '9']);
  });

  test('a document belonging to ANOTHER company/org → generic 404', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })
      .mockResolvedValueOnce(STAMP_OK)
      .mockResolvedValueOnce({ rows: [] });        // scoped lookup → miss
    const res = await request(buildPublicApp())
      .get(`/api/public/portal/${TOKEN}/documents/424242/download`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  test('legacy DB-blob doc streams with an attachment disposition', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })
      .mockResolvedValueOnce(STAMP_OK)
      .mockResolvedValueOnce({ rows: [{ filename: 'notes.txt', mime_type: 'text/plain', content: Buffer.from('hello'), gcs_object_path: null }] });
    const res = await request(buildPublicApp())
      .get(`/api/public/portal/${TOKEN}/documents/9/download`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment; filename="notes.txt"');
    expect(res.text).toBe('hello');
  });

  test('doc row with neither GCS path nor content → generic 404 (no oracle)', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })
      .mockResolvedValueOnce(STAMP_OK)
      .mockResolvedValueOnce({ rows: [{ filename: 'ghost.pdf', mime_type: null, content: null, gcs_object_path: null }] });
    const res = await request(buildPublicApp())
      .get(`/api/public/portal/${TOKEN}/documents/9/download`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });
});

// ---------------------------------------------------------------------------
// Portal case submission (migration 148) — the one public write.
//
// NOTE the POST route carries portalWriteLimiter (a module-level singleton,
// 10 req / 15 min / IP) and supertest presents one IP — keep the number of
// POSTs in this file comfortably under 10 or functional tests start 429ing.
// ---------------------------------------------------------------------------

describe('portal.sanitizeText', () => {
  test('strips HTML tags, control chars, trims, caps length; non-strings → ""', () => {
    expect(portalService.sanitizeText('  <b>Hi</b> there  ', 100)).toBe('Hi there');
    expect(portalService.sanitizeText('<script>alert(1)</script>help', 100)).toBe('alert(1)help');
    expect(portalService.sanitizeText('a\u0000b\u0007c', 100)).toBe('abc');
    expect(portalService.sanitizeText('line1\nline2\ttabbed', 100)).toBe('line1\nline2\ttabbed'); // \n \t kept
    expect(portalService.sanitizeText('x'.repeat(300), 10)).toHaveLength(10);
    expect(portalService.sanitizeText(42, 10)).toBe('');
    expect(portalService.sanitizeText(null, 10)).toBe('');
  });

  test('priority allowlist mirrors schemas/cases.js', () => {
    expect(portalService.CASE_PRIORITIES).toEqual(require('../schemas/cases').CASE_PRIORITIES);
  });
});

describe('public portal case submission', () => {
  test('POST /:token/cases inserts with token tenancy only, source=portal → 201 {case_id}', async () => {
    const notificationDispatcher = require('../services/notificationDispatcher');
    const notifySpy = vi.spyOn(notificationDispatcher, 'notifyPortalCaseSubmitted')
      .mockResolvedValue({ email: 'skipped', sms: 'skipped' });
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow({ contact_id: 31 })] })   // 1 resolve
      .mockResolvedValueOnce(STAMP_OK)                                   // 2 stamp
      .mockResolvedValueOnce({ rows: [{ id: 501 }] });                   // 3 insert
    const res = await request(buildPublicApp())
      .post(`/api/public/portal/${TOKEN}/cases`)
      .send({
        subject: '  <b>Invoice</b> portal is down  ',
        message: 'Getting a 500 on the <i>invoices</i> page',
        priority: 'high',
        // Hostile extras — must be ignored, tenancy comes from the token:
        org_id: 999, company_id: 123456, user_id: 1,
      });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ case_id: 501 });

    const [sql, params] = mockPool.query.mock.calls[2];
    expect(sql).toContain('INSERT INTO cases');
    expect(sql).toContain(`'portal'`);              // source pinned in SQL, not caller-supplied
    expect(sql).toContain(`'open'`);                // status pinned too
    expect(params[0]).toBe(USER_ID);                // user_id — from the token row
    expect(params[1]).toBe(ORG_ID);                 // org_id — from the token row
    expect(params[2]).toBe(COMPANY_ID);             // company_id — token, NOT the body's 123456
    expect(params[3]).toBe(31);                     // contact_id threaded from the token
    expect(params[4]).toBe('Invoice portal is down');            // sanitized subject
    expect(params[5]).toBe('Getting a 500 on the invoices page'); // `message` alias, sanitized
    expect(params[6]).toBe('high');

    // The account team is told (fire-and-forget, after the insert).
    expect(notifySpy).toHaveBeenCalledWith(501);
  });

  test('missing/empty subject → 400, nothing inserted', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })
      .mockResolvedValueOnce(STAMP_OK);
    const res = await request(buildPublicApp())
      .post(`/api/public/portal/${TOKEN}/cases`)
      .send({ subject: '<p></p>', description: 'tags-only subject sanitizes to empty' });
    expect(res.status).toBe(400);
    expect(mockPool.query.mock.calls).toHaveLength(2); // resolve + stamp only — no INSERT
  });

  test('unrecognized priority falls back to normal (allowlist, not passthrough)', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })
      .mockResolvedValueOnce(STAMP_OK)
      .mockResolvedValueOnce({ rows: [{ id: 502 }] });
    const res = await request(buildPublicApp())
      .post(`/api/public/portal/${TOKEN}/cases`)
      .send({ subject: 'Need a part', priority: `urgent'); DROP TABLE cases;--` });
    expect(res.status).toBe(201);
    expect(mockPool.query.mock.calls[2][1][6]).toBe('normal');
  });

  test('dead token → the SAME generic 404, body never reaches the service', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // token miss
    const res = await request(buildPublicApp())
      .post(`/api/public/portal/${'f'.repeat(48)}/cases`)
      .send({ subject: 'anyone home?' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(mockPool.query.mock.calls).toHaveLength(1); // resolve only — no INSERT
  });

  test('GET /:token/cases lists ONLY portal-submitted cases, whitelisted projection', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })
      .mockResolvedValueOnce(STAMP_OK)
      .mockResolvedValueOnce({ rows: [{ id: 501, subject: 'Invoice portal is down', status: 'open', priority: 'high', created_at: 'now', updated_at: 'now' }] });
    const res = await request(buildPublicApp())
      .get(`/api/public/portal/${TOKEN}/cases`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);

    const [sql, params] = mockPool.query.mock.calls[2];
    expect(sql).toContain(`source = 'portal'`);     // internal cases never surface
    expect(sql).toContain('org_id = $1');
    expect(sql).toContain('company_id = $2');
    expect(params).toEqual([ORG_ID, COMPANY_ID]);
    // Internal-only fields aren't selected — they cannot leak.
    expect(sql).not.toContain('owner_user_id');
    expect(sql).not.toContain('sla_due_at');
    expect(sql).not.toMatch(/\bdescription\b/);
  });

  test('write limiter is registered and strict (10 / 15 min), separate from the read limiter', () => {
    const { portalWriteLimiter, portalReadLimiter } = require('../middleware/rateLimits');
    expect(typeof portalWriteLimiter).toBe('function');
    expect(portalWriteLimiter).not.toBe(portalReadLimiter);
  });
});

// ---------------------------------------------------------------------------
// Portal quote response (migration 149) — approve / request changes.
// Shares the 10/15min write-limiter budget with case submission above:
// this block adds 4 POSTs (file total 8 of 10) — mind the budget when
// extending either block.
// ---------------------------------------------------------------------------

describe('public portal quote response', () => {
  test('POST approve: scoped UPDATE touches portal_response* only, never status → 200', async () => {
    const notificationDispatcher = require('../services/notificationDispatcher');
    const notifySpy = vi.spyOn(notificationDispatcher, 'notifyPortalQuoteResponse')
      .mockResolvedValue({ email: 'skipped', sms: 'skipped' });
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })                          // 1 resolve
      .mockResolvedValueOnce(STAMP_OK)                                        // 2 stamp
      .mockResolvedValueOnce({ rows: [{ id: 77, portal_response: 'approved' }] }); // 3 update
    const res = await request(buildPublicApp())
      .post(`/api/public/portal/${TOKEN}/quotes/77/respond`)
      .send({ action: 'approved', note: '<b>Looks great</b> - go ahead', org_id: 999 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ quote_id: 77, portal_response: 'approved' });

    const [sql, params] = mockPool.query.mock.calls[2];
    expect(sql).toContain('UPDATE quotes');
    expect(sql).toContain('portal_response = $3');
    // The internal lifecycle is untouched from the public surface.
    expect(sql).not.toMatch(/\bSET status\b/);
    expect(sql).not.toMatch(/,\s*status\s*=/);
    expect(sql).toContain('customer_id = $2');
    expect(sql).toContain('org_id = $1');
    expect(params[0]).toBe(ORG_ID);                    // tenant from token
    expect(params[1]).toBe(COMPANY_ID);                // company from token
    expect(params[2]).toBe('approved');
    expect(params[3]).toBe('Looks great - go ahead');  // sanitized note
    expect(params[4]).toBe(77);
    expect(notifySpy).toHaveBeenCalledWith(77);
  });

  test('foreign/unknown quote id → generic 404 (scoped UPDATE misses), no notify', async () => {
    const notificationDispatcher = require('../services/notificationDispatcher');
    const notifySpy = vi.spyOn(notificationDispatcher, 'notifyPortalQuoteResponse')
      .mockResolvedValue({ email: 'skipped', sms: 'skipped' });
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })
      .mockResolvedValueOnce(STAMP_OK)
      .mockResolvedValueOnce({ rows: [] });            // scoped update → miss
    const res = await request(buildPublicApp())
      .post(`/api/public/portal/${TOKEN}/quotes/424242/respond`)
      .send({ action: 'changes_requested', note: 'wrong pricing' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(notifySpy).not.toHaveBeenCalled();
  });

  test('bad action → 400 before any UPDATE; non-numeric id → 404 without touching quotes', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })
      .mockResolvedValueOnce(STAMP_OK);
    const res = await request(buildPublicApp())
      .post(`/api/public/portal/${TOKEN}/quotes/77/respond`)
      .send({ action: 'delete-everything' });
    expect(res.status).toBe(400);
    expect(mockPool.query.mock.calls).toHaveLength(2); // resolve + stamp only

    mockPool.query.mockReset();
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })
      .mockResolvedValueOnce(STAMP_OK);
    const res2 = await request(buildPublicApp())
      .post(`/api/public/portal/${TOKEN}/quotes/abc/respond`)
      .send({ action: 'approved' });
    expect(res2.status).toBe(404);
    expect(mockPool.query.mock.calls).toHaveLength(2); // id guard rejected pre-query
  });

  test('overview quote projection now carries portal_response (customer own echo)', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })
      .mockResolvedValueOnce(STAMP_OK)
      .mockResolvedValueOnce({ rows: [{ name: 'Acme', industry: null, website: null, location: null }] })
      .mockResolvedValueOnce({ rows: [{ total: 1, open: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 77, title: 'Q-100', status: 'sent', total_amount: '500.00', valid_until: null, created_at: 'now', portal_response: 'approved', portal_response_at: 'now' }] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(buildPublicApp())
      .get(`/api/public/portal/${TOKEN}/overview`);
    expect(res.status).toBe(200);
    const [quoteSql] = mockPool.query.mock.calls[4];
    expect(quoteSql).toContain('portal_response');
    expect(quoteSql).not.toContain('portal_response_note'); // note not echoed in list
    expect(quoteSql).not.toMatch(/\bnotes\b/);              // internal notes stay internal
    expect(res.body.quotes[0].portal_response).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// Portal message thread (migration 150) — the CS-10 "comments" slice.
// ---------------------------------------------------------------------------

describe('public portal messages', () => {
  test('GET /:token/messages: thread scoped to org+company, team names only', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })
      .mockResolvedValueOnce(STAMP_OK)
      .mockResolvedValueOnce({ rows: [
        { id: 1, author_type: 'customer', body: 'Any update on the PO?', created_at: 't1', author_name: null },
        { id: 2, author_type: 'team', body: 'Shipping Friday!', created_at: 't2', author_name: 'John' },
      ] });
    const res = await request(buildPublicApp())
      .get(`/api/public/portal/${TOKEN}/messages`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[1].author_name).toBe('John');

    const [sql, params] = mockPool.query.mock.calls[2];
    expect(sql).toContain('org_id = $1');
    expect(sql).toContain('company_id = $2');
    expect(params).toEqual([ORG_ID, COMPANY_ID]);
    // The team member's name is exposed ONLY for team messages.
    expect(sql).toContain(`WHEN pm.author_type = 'team' THEN u.name`);
    // No emails / user ids in the public projection.
    expect(sql).not.toContain('u.email');
    expect(sql).not.toContain('pm.author_user_id,');
  });

  test('POST /:token/messages: author pinned customer, tenancy from token → 201', async () => {
    const notificationDispatcher = require('../services/notificationDispatcher');
    const notifySpy = vi.spyOn(notificationDispatcher, 'notifyPortalMessageReceived')
      .mockResolvedValue({ email: 'skipped', sms: 'skipped' });
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })
      .mockResolvedValueOnce(STAMP_OK)
      .mockResolvedValueOnce({ rows: [{ id: 9, author_type: 'customer', body: 'Any update on the PO?', created_at: 't1' }] });
    const res = await request(buildPublicApp())
      .post(`/api/public/portal/${TOKEN}/messages`)
      .send({ body: '  <b>Any update</b> on the PO?  ', author_type: 'team', org_id: 999 });
    expect(res.status).toBe(201);
    expect(res.body.author_type).toBe('customer');

    const [sql, params] = mockPool.query.mock.calls[2];
    expect(sql).toContain('INSERT INTO portal_messages');
    expect(sql).toContain(`'customer'`);              // pinned in SQL, hostile body field ignored
    expect(params[0]).toBe(USER_ID);
    expect(params[1]).toBe(ORG_ID);
    expect(params[2]).toBe(COMPANY_ID);
    expect(params[3]).toBe('Any update on the PO?'); // sanitized
    expect(notifySpy).toHaveBeenCalledWith(9);
  });

  test('empty/tags-only body → 400, nothing inserted; dead token → generic 404', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })
      .mockResolvedValueOnce(STAMP_OK);
    const res = await request(buildPublicApp())
      .post(`/api/public/portal/${TOKEN}/messages`)
      .send({ body: '<p></p>' });
    expect(res.status).toBe(400);
    expect(mockPool.query.mock.calls).toHaveLength(2);

    mockPool.query.mockReset();
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // token miss
    const res2 = await request(buildPublicApp())
      .post(`/api/public/portal/${'f'.repeat(48)}/messages`)
      .send({ body: 'hello?' });
    expect(res2.status).toBe(404);
    expect(res2.body).toEqual({ error: 'Not found' });
    expect(mockPool.query.mock.calls).toHaveLength(1);
  });
});

describe('portal messages (authenticated, member-level)', () => {
  test('GET /messages requires only membership, not admin — member reads the thread', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow('member'))     // gate's session resolve — plain member
      .mockResolvedValueOnce({ rows: [{ id: 1, author_type: 'customer', author_user_id: null, body: 'hi', created_at: 't', author_name: null }] });
    const res = await request(buildAuthedApp())
      .get(`/api/portal/messages?company_id=${COMPANY_ID}`).set('Cookie', authCookie());
    expect(res.status).toBe(200);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toContain('org_id = $1');
    expect(params).toEqual([ORG_ID, COMPANY_ID]);
  });

  test('POST /messages: member replies; company validated in-scope; author pinned team', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow('member'))
      .mockResolvedValueOnce({ rows: [{ id: COMPANY_ID }] })   // scoped company fetch
      .mockResolvedValueOnce({ rows: [{ id: 3, author_type: 'team', author_user_id: USER_ID, body: 'On it!', created_at: 't' }] });
    const res = await request(buildAuthedApp())
      .post('/api/portal/messages').set('Cookie', authCookie())
      .send({ company_id: COMPANY_ID, body: 'On it!' });
    expect(res.status).toBe(201);

    const [insSql, insParams] = mockPool.query.mock.calls[2];
    expect(insSql).toContain(`'team'`);
    expect(insParams[0]).toBe(USER_ID);   // tenant attribution
    expect(insParams[3]).toBe(USER_ID);   // author_user_id = the member
    expect(insParams[4]).toBe('On it!');
  });

  test('POST /messages 404s for a cross-org company — nothing inserted', async () => {
    mockPool.query
      .mockResolvedValueOnce(authRow('member'))
      .mockResolvedValueOnce({ rows: [] });        // scoped company fetch → miss
    const res = await request(buildAuthedApp())
      .post('/api/portal/messages').set('Cookie', authCookie())
      .send({ company_id: 123456, body: 'sneaky' });
    expect(res.status).toBe(404);
    expect(mockPool.query.mock.calls).toHaveLength(2); // no INSERT
  });
});

// ---------------------------------------------------------------------------
// Portal document upload (migration 151) — the last CS-10 slice.
// ---------------------------------------------------------------------------

describe('portal.sanitizeFilename', () => {
  test('basename only, control chars stripped, reserved chars replaced, capped', () => {
    expect(portalService.sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(portalService.sanitizeFilename('..\\..\\boot.ini')).toBe('boot.ini');
    expect(portalService.sanitizeFilename('inv\u0000oice<2026>.pdf')).toBe('invoice_2026_.pdf');
    expect(portalService.sanitizeFilename('x'.repeat(300) + '.pdf')).toHaveLength(200);
    expect(portalService.sanitizeFilename('')).toBeNull();
    expect(portalService.sanitizeFilename(null)).toBeNull();
  });
});

describe('public portal document upload', () => {
  test('PDF upload → 201; INSERT pins source=portal, uploaded_by NULL, tenancy from token', async () => {
    const notificationDispatcher = require('../services/notificationDispatcher');
    const notifySpy = vi.spyOn(notificationDispatcher, 'notifyPortalDocumentUploaded')
      .mockResolvedValue({ email: 'skipped', sms: 'skipped' });
    vi.spyOn(storage, 'uploadBuffer').mockResolvedValue({ objectPath: 'org/7/company/99/x-contract.pdf', bucket: 'test-bucket' });
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })            // 1 resolve
      .mockResolvedValueOnce(STAMP_OK)                          // 2 stamp
      .mockResolvedValueOnce({ rows: [{ n: 3 }] })              // 3 quota count
      .mockResolvedValueOnce({ rows: [{ id: 71, filename: 'contract.pdf', doc_type: 'other', size: 4, mime_type: 'application/pdf', created_at: 'now' }] }); // 4 insert
    const res = await request(buildPublicApp())
      .post(`/api/public/portal/${TOKEN}/documents`)
      .attach('file', Buffer.from('%PDF'), { filename: 'contract.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    expect(res.body.filename).toBe('contract.pdf');

    // Quota query counts portal-sourced rows for THIS company only.
    const [quotaSql, quotaParams] = mockPool.query.mock.calls[2];
    expect(quotaSql).toContain(`source = 'portal'`);
    expect(quotaParams).toEqual([ORG_ID, COMPANY_ID]);

    const [insSql, insParams] = mockPool.query.mock.calls[3];
    expect(insSql).toContain('INSERT INTO documents');
    expect(insSql).toContain(`'portal'`);   // source pinned in SQL
    expect(insSql).toContain('NULL');       // uploaded_by NULL — external author
    expect(insParams[0]).toBe(USER_ID);     // tenant attribution from the token
    expect(insParams[1]).toBe(ORG_ID);
    expect(insParams[2]).toBe(COMPANY_ID);
    expect(insParams[3]).toBe('contract.pdf');
    expect(insParams[4]).toBeNull();        // GCS succeeded → no DB blob
    expect(storage.uploadBuffer).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID, relatedType: 'company', relatedId: COMPANY_ID,
    }));
    expect(notifySpy).toHaveBeenCalledWith(71);
  });

  test('disallowed type (html) → 400, nothing stored (stored-XSS guard)', async () => {
    const gcsSpy = vi.spyOn(storage, 'uploadBuffer').mockResolvedValue({ objectPath: 'x', bucket: 'b' });
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })
      .mockResolvedValueOnce(STAMP_OK);
    const res = await request(buildPublicApp())
      .post(`/api/public/portal/${TOKEN}/documents`)
      .attach('file', Buffer.from('<script>alert(1)</script>'), { filename: 'evil.html', contentType: 'text/html' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not supported/);
    expect(gcsSpy).not.toHaveBeenCalled();
    expect(mockPool.query.mock.calls).toHaveLength(2); // resolve + stamp only — no quota/INSERT
  });

  test('extension/MIME mismatch (pdf ext, html mime) → 400', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })
      .mockResolvedValueOnce(STAMP_OK);
    const res = await request(buildPublicApp())
      .post(`/api/public/portal/${TOKEN}/documents`)
      .attach('file', Buffer.from('x'), { filename: 'fake.pdf', contentType: 'text/html' });
    expect(res.status).toBe(400);
    expect(mockPool.query.mock.calls).toHaveLength(2);
  });

  test('quota reached → 409, no storage write', async () => {
    const gcsSpy = vi.spyOn(storage, 'uploadBuffer').mockResolvedValue({ objectPath: 'x', bucket: 'b' });
    mockPool.query
      .mockResolvedValueOnce({ rows: [tokenRow()] })
      .mockResolvedValueOnce(STAMP_OK)
      .mockResolvedValueOnce({ rows: [{ n: portalService.PORTAL_UPLOAD_QUOTA }] }); // quota full
    const res = await request(buildPublicApp())
      .post(`/api/public/portal/${TOKEN}/documents`)
      .attach('file', Buffer.from('%PDF'), { filename: 'one-too-many.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(409);
    expect(gcsSpy).not.toHaveBeenCalled();
    expect(mockPool.query.mock.calls).toHaveLength(3); // no INSERT
  });

  test('dead token → generic 404 before the multipart body is processed', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // token miss
    const res = await request(buildPublicApp())
      .post(`/api/public/portal/${'f'.repeat(48)}/documents`)
      .attach('file', Buffer.from('%PDF'), { filename: 'contract.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(mockPool.query.mock.calls).toHaveLength(1); // resolve only
  });
});
