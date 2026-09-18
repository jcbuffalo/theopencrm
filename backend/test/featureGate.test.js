// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Feature-gate enforcement — regression tests for the mount-level no-op bug.
//
// THE BUG: index.js mounts many routers as
//     app.use('/api/documents', requireFeature('documents_enabled'), documentRoutes)
// but authMiddleware runs INSIDE each router (router.use(authMiddleware)),
// so the mount-level gate executed before req.orgId existed and always fell
// through — /admin/feature-flags toggles never actually disabled anything.
//
// THE FIX (middleware/featureGate.js): when the gate runs pre-auth it resolves
// the session itself via the same (idempotent) authMiddleware the routers use,
// then evaluates the org's effective flag value (explicit setting wins; a
// missing key means the flag's registered default from services/featureFlags).
//
// These tests mount REAL route files in the exact index.js pattern (gate at
// the mount, auth inside the router) and prove:
//   1. explicit false → 403 FEATURE_DISABLED   (documents, reports, retention)
//   2. explicit true / default-true missing key → passes the gate
//   3. default-false missing key → 403          (quickbooks-style)
//   4. org-less user (user_id only) → NOT blocked (fail-open preserved)
//   5. unauthenticated → 401 from auth, not a gate 403/pass
//   6. token-auth surfaces that set req.orgId without req.userId (scimAuth
//      pattern) are still enforced
//
// Pool is fully mocked with a SQL-shape router (not queue order) so the two
// gate queries (users lookup + organizations.features) are stable regardless
// of route internals. NOTE: featureFlags caches features per-org for 30s in
// module state, so every test uses a UNIQUE org id.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { requireFeature } = require('../middleware/featureGate');
const { authMiddleware, generateToken, AUTH_COOKIE_NAME } = require('../auth');

const documentRoutes = require('../routes/documentRoutes');
const reportBuilderRoutes = require('../routes/reportBuilderRoutes');
const retentionRoutes = require('../routes/retentionRoutes');

const USER_ID = 9001;

// Unique org id per test — dodges featureFlags' 30s in-process cache.
let orgSeq = 50_000;
function nextOrgId() { return ++orgSeq; }

// SQL-shape pool mock. `user` drives authMiddleware's users lookup; `features`
// drives featureFlags.getFeatures' organizations lookup. Everything else gets
// empty rows (route handlers that survive the gate tolerate empty data or are
// never reached in these tests).
function primePool({ user, features }) {
  mockPool.query.mockImplementation(async (sql) => {
    const text = String(sql);
    if (/FROM users/i.test(text)) return { rows: user ? [user] : [] };
    if (/FROM organizations/i.test(text)) return { rows: [{ features }] };
    return { rows: [] };
  });
}

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

// Mirrors the index.js mount pattern exactly: gate at the mount point,
// authMiddleware inside the router.
function buildApp(mountPath, flag, router) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use(mountPath, requireFeature(flag), router);
  return app;
}

// A faithful stand-in for a route file: auth inside the router, then a probe
// endpoint. Used where we assert the ALLOW path (real route handlers would
// need bespoke data fixtures; the composition under test is identical).
function probeRouter() {
  const router = express.Router();
  router.use(authMiddleware);
  router.get('/ping', (req, res) => res.json({ ok: true, orgId: req.orgId ?? null }));
  return router;
}

beforeEach(() => {
  mockPool.query.mockReset();
});

describe('mount-level gate — explicit false blocks (the previously no-op mounts)', () => {
  test('documents: documents_enabled explicitly false → 403 FEATURE_DISABLED', async () => {
    const orgId = nextOrgId();
    primePool({
      user: { org_id: orgId, org_role: 'member', status: 'active' },
      features: { documents_enabled: false },
    });
    const app = buildApp('/api/documents', 'documents_enabled', documentRoutes);

    const res = await request(app).get('/api/documents').set('Cookie', authCookie());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
    expect(res.body.feature).toBe('documents_enabled');
  });

  test('reports: reports_enabled explicitly false → 403 on the report builder', async () => {
    const orgId = nextOrgId();
    primePool({
      user: { org_id: orgId, org_role: 'member', status: 'active' },
      features: { reports_enabled: false },
    });
    const app = buildApp('/api/reports', 'reports_enabled', reportBuilderRoutes);

    const res = await request(app).get('/api/reports').set('Cookie', authCookie());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
    expect(res.body.feature).toBe('reports_enabled');
  });

  test('retention: customer_success_enabled explicitly false → 403', async () => {
    const orgId = nextOrgId();
    primePool({
      user: { org_id: orgId, org_role: 'member', status: 'active' },
      features: { customer_success_enabled: false },
    });
    const app = buildApp('/api/retention', 'customer_success_enabled', retentionRoutes);

    const res = await request(app).get('/api/retention/summary').set('Cookie', authCookie());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
    expect(res.body.feature).toBe('customer_success_enabled');
  });
});

describe('mount-level gate — enabled orgs pass through', () => {
  test('flag explicitly true → request reaches the router', async () => {
    const orgId = nextOrgId();
    primePool({
      user: { org_id: orgId, org_role: 'member', status: 'active' },
      features: { documents_enabled: true },
    });
    const app = buildApp('/api/documents', 'documents_enabled', probeRouter());

    const res = await request(app).get('/api/documents/ping').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.orgId).toBe(orgId);
  });

  test('missing key + default-TRUE flag → passes (default respected, not treated as off)', async () => {
    const orgId = nextOrgId();
    primePool({
      user: { org_id: orgId, org_role: 'member', status: 'active' },
      features: {}, // documents_enabled defaults true in KNOWN_FLAGS
    });
    const app = buildApp('/api/documents', 'documents_enabled', probeRouter());

    const res = await request(app).get('/api/documents/ping').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('missing key + default-FALSE flag → 403 (quickbooks_enabled defaults off)', async () => {
    const orgId = nextOrgId();
    primePool({
      user: { org_id: orgId, org_role: 'member', status: 'active' },
      features: {}, // quickbooks_enabled defaults false in KNOWN_FLAGS
    });
    const app = buildApp('/api/quickbooks', 'quickbooks_enabled', probeRouter());

    const res = await request(app).get('/api/quickbooks/ping').set('Cookie', authCookie());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
  });
});

describe('fail-open + auth boundaries preserved', () => {
  test('org-less user (user_id only, org_id null) is NOT blocked', async () => {
    primePool({
      user: { org_id: null, org_role: null, status: 'active' },
      features: {}, // never consulted — gate falls open before the flag check
    });
    const app = buildApp('/api/documents', 'documents_enabled', probeRouter());

    const res = await request(app).get('/api/documents/ping').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.orgId).toBe(null);
    // The gate must not have consulted organizations.features at all.
    const orgQueries = mockPool.query.mock.calls.filter(([sql]) => /FROM organizations/i.test(String(sql)));
    expect(orgQueries.length).toBe(0);
  });

  test('unauthenticated request → 401 from the router auth, not a gate response', async () => {
    primePool({ user: null, features: {} });
    const app = buildApp('/api/documents', 'documents_enabled', probeRouter());

    const res = await request(app).get('/api/documents/ping'); // no cookie
    expect(res.status).toBe(401);
    // No token → gate does zero DB work; the 401 came from authMiddleware.
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('garbage token → 401 (gate resolves via the same authMiddleware)', async () => {
    primePool({ user: null, features: {} });
    const app = buildApp('/api/documents', 'documents_enabled', probeRouter());

    const res = await request(app)
      .get('/api/documents/ping')
      .set('Cookie', [`${AUTH_COOKIE_NAME}=not-a-jwt`]);
    expect(res.status).toBe(401);
  });

  test('token-auth surface that sets req.orgId without req.userId (scimAuth pattern) is enforced', async () => {
    const orgId = nextOrgId();
    primePool({ user: null, features: { sso_enabled: false } });

    const app = express();
    app.use(express.json());
    // Simulate scimAuth: org context from a bearer token, no session user.
    app.use((req, res, next) => { req.orgId = orgId; next(); });
    app.use('/scim', requireFeature('sso_enabled'), (req, res) => res.json({ ok: true }));

    const res = await request(app).get('/scim');
    expect(res.status).toBe(403);
    expect(res.body.feature).toBe('sso_enabled');
  });

  test('gate positioned AFTER auth (the /api/ai mount pattern) still works and does not re-auth', async () => {
    const orgId = nextOrgId();
    primePool({
      user: { org_id: orgId, org_role: 'member', status: 'active' },
      features: { ai_features_enabled: true },
    });

    const app = express();
    app.use(express.json());
    app.use(cookieParser(process.env.COOKIE_SECRET));
    // index.js /api/ai pattern: auth at the mount, then the gate, then router.
    app.use('/api/ai', authMiddleware, requireFeature('ai_features_enabled'), probeRouter());

    const res = await request(app).get('/api/ai/ping').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    // users lookup exactly once — both the gate and the in-router auth must
    // have skipped re-authentication (idempotent authMiddleware).
    const userQueries = mockPool.query.mock.calls.filter(([sql]) => /FROM users/i.test(String(sql)));
    expect(userQueries.length).toBe(1);
  });
});
