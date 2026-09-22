// Spec 206 — API keys as a first-class credential on the CRM surface.
//   * auth.js authMiddleware falls back to a tocrm_ key when no cookie;
//   * read keys may only GET; write keys may mutate;
//   * account/billing/admin/OAuth routes are denied to every key;
//   * CSRF is exempt for key-authenticated requests (no cookie to forge);
//   * the key acts as its creator (org, org_role) and dies with them.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret';

const express = require('express');
const request = require('supertest');
const cookieParser = require('cookie-parser');

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

const apiKeys = require('../services/apiKeys');
const { authMiddleware } = require('../auth');
const { isDeniedPath, hasApiKey } = require('../middleware/apiKeyAuth');

const { fullKey: WRITE_KEY, keyHash: WRITE_HASH } = apiKeys.generateKey();
const { fullKey: READ_KEY, keyHash: READ_HASH } = apiKeys.generateKey();

function keyRow(hash, scopes, extra = {}) {
  return { id: 1, org_id: 77, name: 'cli', key_prefix: 'tocrm_x', scopes, created_by: 9, revoked_at: null,
    creator_org_role: 'admin', creator_status: 'active', creator_org_id: 77, ...extra };
}

// The lookup joins users; route the two hashes to their rows.
function wire({ write = keyRow(WRITE_HASH, ['read', 'write']), read = keyRow(READ_HASH, ['read']) } = {}) {
  mockPool.query.mockImplementation(async (sql, params) => {
    const s = String(sql);
    if (/FROM api_keys k/i.test(s)) {
      if (params[0] === WRITE_HASH) return { rows: write ? [write] : [] };
      if (params[0] === READ_HASH) return { rows: read ? [read] : [] };
      return { rows: [] };
    }
    if (/UPDATE api_keys SET last_used_at/i.test(s)) return { rows: [] };
    return { rows: [] };
  });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  const r = express.Router();
  r.use(authMiddleware);
  r.get('/deals', (req, res) => res.json({ ok: true, orgId: req.orgId, userId: req.userId, role: req.orgRole, via: req.authSource || 'cookie' }));
  r.post('/deals', (req, res) => res.status(201).json({ ok: true, orgId: req.orgId, userId: req.userId }));
  app.use('/api', r);
  return app;
}

beforeEach(() => { mockPool.query.mockReset(); });

describe('authMiddleware + API key', () => {
  test('no cookie, no key → 401 (unchanged)', async () => {
    wire();
    const res = await request(buildApp()).get('/api/deals');
    expect(res.status).toBe(401);
  });

  test('a write key reads AND writes, scoped to the key org, attributed to its creator, with the creator role', async () => {
    wire();
    const app = buildApp();
    const g = await request(app).get('/api/deals').set('Authorization', `Bearer ${WRITE_KEY}`);
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ orgId: 77, userId: 9, role: 'admin', via: 'api_key' });
    const p = await request(app).post('/api/deals').set('X-API-Key', WRITE_KEY).send({ title: 'x' });
    expect(p.status).toBe(201);
    expect(p.body).toMatchObject({ orgId: 77, userId: 9 });
  });

  test('a read-only key reads but a POST is 403 API_KEY_SCOPE', async () => {
    wire();
    const app = buildApp();
    expect((await request(app).get('/api/deals').set('Authorization', `Bearer ${READ_KEY}`)).status).toBe(200);
    const p = await request(app).post('/api/deals').set('Authorization', `Bearer ${READ_KEY}`).send({});
    expect(p.status).toBe(403);
    expect(p.body.code).toBe('API_KEY_SCOPE');
  });

  test('revoked key, unknown key, suspended creator → 401; DB error fails closed', async () => {
    wire({ write: keyRow(WRITE_HASH, ['read', 'write'], { revoked_at: new Date() }) });
    expect((await request(buildApp()).get('/api/deals').set('Authorization', `Bearer ${WRITE_KEY}`)).status).toBe(401);
    wire({ write: null });
    expect((await request(buildApp()).get('/api/deals').set('Authorization', `Bearer ${WRITE_KEY}`)).status).toBe(401);
    wire({ write: keyRow(WRITE_HASH, ['read', 'write'], { creator_status: 'suspended' }) });
    const s = await request(buildApp()).get('/api/deals').set('Authorization', `Bearer ${WRITE_KEY}`);
    expect(s.status).toBe(401);
    expect(s.body.code).toBe('API_KEY_CREATOR_INACTIVE');
    mockPool.query.mockImplementation(async () => { throw new Error('db down'); });
    expect((await request(buildApp()).get('/api/deals').set('Authorization', `Bearer ${WRITE_KEY}`)).status).toBe(401);
  });

  test('a non-tocrm Bearer token is ignored by the key path (JWT path untouched → 401)', async () => {
    wire();
    const res = await request(buildApp()).get('/api/deals').set('Authorization', 'Bearer eyJhbGciOi.notakey');
    expect(res.status).toBe(401);
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});

describe('denylist + CSRF exemption', () => {
  test('account / billing / admin / OAuth / inbound-webhook surfaces are denied to keys, CRM surfaces are not', () => {
    for (const p of ['/api/me', '/api/me/change-password', '/api/security/2fa/setup', '/api/admin/users', '/api/billing/checkout',
      '/api/keys', '/api/org/invites', '/api/auth/login', '/api/gateway/keys', '/api/drive/oauth/start', '/api/webhooks/teams',
      '/api/v1/admin/users', '/api/v1/billing/ai/admin/list']) {
      expect(isDeniedPath(p), p).toBe(true);
    }
    for (const p of ['/api/deals', '/api/v1/deals/12', '/api/contacts', '/api/import/deals', '/api/ai/chat', '/api/ai/actions/apply',
      '/api/plugins/3/run', '/api/webhooks-out', '/api/v1/webhooks-out/5/test', '/api/my-day', '/api/pipelines', '/api/v1/me']) {
      expect(isDeniedPath(p), p).toBe(false);
    }
  });

  test('a denied path with a valid write key is 403 API_KEY_FORBIDDEN_ROUTE, not 404', async () => {
    wire();
    const app = express();
    app.use(express.json());
    app.use(cookieParser(process.env.COOKIE_SECRET));
    const r = express.Router();
    r.use(authMiddleware);
    r.post('/me/change-password', (req, res) => res.json({ changed: true }));
    app.use('/api', r);
    const res = await request(app).post('/api/me/change-password').set('Authorization', `Bearer ${WRITE_KEY}`).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('API_KEY_FORBIDDEN_ROUTE');
  });

  test('hasApiKey is the CSRF-exemption signal: true only for a tocrm_ header', () => {
    const mk = (headers) => ({ headers, get: (h) => headers[h.toLowerCase()] });
    expect(hasApiKey(mk({ authorization: `Bearer ${WRITE_KEY}` }))).toBe(true);
    expect(hasApiKey(mk({ 'x-api-key': READ_KEY }))).toBe(true);
    expect(hasApiKey(mk({ authorization: 'Bearer eyJhbGci.jwt' }))).toBe(false);
    expect(hasApiKey(mk({}))).toBe(false);
  });
});
