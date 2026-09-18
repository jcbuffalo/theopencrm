// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Self-service identity + lightweight defaults (workstream D, Aug 2026).
//
//   1. middleware/adminAuth.requireOrgAdmin — org owner/admin pass, members
//      are denied, platform super-admins pass regardless of org role.
//   2. routes/adminFeatureFlagRoutes — an org OWNER can read + toggle their
//      own org's `scope: 'org'` flags; platform-scope flags are hidden from
//      them and refuse their writes; super-admins keep cross-org access.
//   3. services/featureFlags — profile-aware defaults: the Zang modules are
//      OFF by default for generic orgs and ON for zang orgs; explicit keys
//      still win.
//   4. migrations/153 — exists and is idempotent (guarded UPDATEs only).
//   5. services/bootstrapAdmin.initialStatusFor — OPEN_SIGNUP=true opts a
//      deployment into instant self-serve; default stays pending_approval.
//
// Pool is fully mocked with a SQL-shape router. featureFlags caches per-org
// for 30s in module state, so every test uses a UNIQUE org id.

const fs = require('fs');
const path = require('path');

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');
const { requireOrgAdmin } = require('../middleware/adminAuth');
const featureFlags = require('../services/featureFlags');
const bootstrapAdmin = require('../services/bootstrapAdmin');
const flagRoutes = require('../routes/adminFeatureFlagRoutes');

const USER_ID = 7001;

let orgSeq = 70_000;
function nextOrgId() { return ++orgSeq; }

// `user` drives authMiddleware's users lookup; `admin` drives the admin_users
// lookup (null = not a platform admin); `org` drives organizations.
function primePool({ user, admin = null, org = {} }) {
  mockPool.query.mockImplementation(async (sql) => {
    const text = String(sql);
    if (/FROM admin_users/i.test(text)) return { rows: admin ? [admin] : [] };
    if (/FROM users/i.test(text)) return { rows: user ? [user] : [] };
    if (/FROM organizations/i.test(text)) return { rows: [org] };
    if (/UPDATE organizations/i.test(text)) return { rows: [], rowCount: 1 };
    return { rows: [] };
  });
}

function authCookie(userId = USER_ID) {
  return [`${AUTH_COOKIE_NAME}=${generateToken(userId)}`];
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/admin/feature-flags', flagRoutes);
  return app;
}

beforeEach(() => {
  mockPool.query.mockReset();
  featureFlags._clearCache();
});

// ---------------------------------------------------------------------------
// 1. requireOrgAdmin
// ---------------------------------------------------------------------------
describe('requireOrgAdmin', () => {
  function run(reqOverrides) {
    const req = { userId: USER_ID, orgId: 1, orgRole: 'member', ...reqOverrides };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    const next = vi.fn();
    return requireOrgAdmin(req, res, next).then(() => ({ req, res, next }));
  }

  test('org owner passes without touching admin_users beyond the super-admin probe', async () => {
    primePool({ user: null, admin: null });
    const { req, next } = await run({ orgRole: 'owner' });
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.isOrgAdmin).toBe(true);
    expect(req.isSuperAdmin).toBe(false);
  });

  test('org admin passes', async () => {
    primePool({ user: null, admin: null });
    const { next } = await run({ orgRole: 'admin' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('org member is denied with 403', async () => {
    primePool({ user: null, admin: null });
    const { res, next } = await run({ orgRole: 'member' });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('platform super-admin passes even as an org member', async () => {
    primePool({ user: null, admin: { id: 1, user_id: USER_ID, role: 'super_admin', permissions: [] } });
    const { req, next } = await run({ orgRole: 'member' });
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.isSuperAdmin).toBe(true);
  });

  test('a non-super platform admin row does not grant org-admin', async () => {
    primePool({ user: null, admin: { id: 1, user_id: USER_ID, role: 'moderator', permissions: [] } });
    const { res, next } = await run({ orgRole: 'member' });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('unauthenticated → 401', async () => {
    const { res, next } = await run({ userId: undefined, orgRole: 'owner' });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ---------------------------------------------------------------------------
// 2. feature-flag routes — org owner self-service
// ---------------------------------------------------------------------------
describe('GET /api/admin/feature-flags/flags', () => {
  test('org owner (not a platform admin) can list their org — platform-scope flags hidden', async () => {
    const orgId = nextOrgId();
    primePool({
      user: { org_id: orgId, org_role: 'owner', status: 'active' },
      org: { features: { plugins_enabled: true }, profile: 'generic' },
    });
    const res = await request(buildApp()).get('/api/admin/feature-flags/flags').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.data.orgId).toBe(orgId);
    expect(res.body.data.profile).toBe('generic');
    const names = res.body.data.flags.map((f) => f.name);
    expect(names).toContain('plugins_enabled');
    expect(names).toContain('quotes_enabled');
    expect(names).not.toContain('ai_billing_required');
    expect(names).not.toContain('phase2_entities');
    expect(names).not.toContain('v2_dual_write_enabled');
    expect(names).not.toContain('sso_enabled');
    // Plain-English metadata rides along.
    const plugins = res.body.data.flags.find((f) => f.name === 'plugins_enabled');
    expect(plugins.currentValue).toBe(true);
    expect(plugins.isOverride).toBe(true);
    expect(plugins.label).toBeTruthy();
    expect(plugins.oneLiner).toBeTruthy();
    expect(plugins.group).toBe('Insights');
    expect(plugins.scope).toBe('org');
  });

  test('org member is denied (403)', async () => {
    const orgId = nextOrgId();
    primePool({ user: { org_id: orgId, org_role: 'member', status: 'active' }, org: { features: {}, profile: 'generic' } });
    const res = await request(buildApp()).get('/api/admin/feature-flags/flags').set('Cookie', authCookie());
    expect(res.status).toBe(403);
  });

  test('super-admin sees platform-scope flags too', async () => {
    const orgId = nextOrgId();
    primePool({
      user: { org_id: orgId, org_role: 'member', status: 'active' },
      admin: { id: 1, user_id: USER_ID, role: 'super_admin', permissions: [] },
      org: { features: {}, profile: 'generic' },
    });
    const res = await request(buildApp()).get('/api/admin/feature-flags/flags').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    const names = res.body.data.flags.map((f) => f.name);
    expect(names).toContain('ai_billing_required');
    expect(names).toContain('sso_enabled');
    expect(names.length).toBe(featureFlags.KNOWN_FLAGS.length);
  });

  test('cross-org read: org owner denied, super-admin allowed', async () => {
    const orgId = nextOrgId();
    const other = nextOrgId();
    primePool({ user: { org_id: orgId, org_role: 'owner', status: 'active' }, org: { features: {}, profile: 'zang' } });
    let res = await request(buildApp()).get(`/api/admin/feature-flags/flags/${other}`).set('Cookie', authCookie());
    expect(res.status).toBe(403);

    primePool({
      user: { org_id: orgId, org_role: 'member', status: 'active' },
      admin: { id: 1, user_id: USER_ID, role: 'super_admin', permissions: [] },
      org: { features: {}, profile: 'zang' },
    });
    res = await request(buildApp()).get(`/api/admin/feature-flags/flags/${other}`).set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.data.orgId).toBe(other);
    expect(res.body.data.profile).toBe('zang');
  });
});

describe('PUT/DELETE /api/admin/feature-flags/flags/:orgId/:name', () => {
  test('org owner can toggle an org-scope flag on their own org', async () => {
    const orgId = nextOrgId();
    primePool({ user: { org_id: orgId, org_role: 'owner', status: 'active' }, org: { features: {}, profile: 'generic' } });
    const res = await request(buildApp())
      .put(`/api/admin/feature-flags/flags/${orgId}/plugins_enabled`)
      .set('Cookie', authCookie())
      .send({ value: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ orgId, flag: 'plugins_enabled', value: true });
    const update = mockPool.query.mock.calls.find(([sql]) => /UPDATE organizations/i.test(String(sql)));
    expect(update).toBeTruthy();
    expect(update[1]).toEqual([['plugins_enabled'], 'true', orgId]);
  });

  test('org owner cannot toggle a platform-scope flag (403, no write)', async () => {
    const orgId = nextOrgId();
    primePool({ user: { org_id: orgId, org_role: 'owner', status: 'active' }, org: { features: {}, profile: 'generic' } });
    const res = await request(buildApp())
      .put(`/api/admin/feature-flags/flags/${orgId}/ai_billing_required`)
      .set('Cookie', authCookie())
      .send({ value: false });
    expect(res.status).toBe(403);
    expect(mockPool.query.mock.calls.some(([sql]) => /UPDATE organizations/i.test(String(sql)))).toBe(false);
  });

  test('org owner cannot write to another org (403)', async () => {
    const orgId = nextOrgId();
    primePool({ user: { org_id: orgId, org_role: 'owner', status: 'active' }, org: { features: {}, profile: 'generic' } });
    const res = await request(buildApp())
      .put(`/api/admin/feature-flags/flags/${orgId + 1}/plugins_enabled`)
      .set('Cookie', authCookie())
      .send({ value: true });
    expect(res.status).toBe(403);
  });

  test('org admin (role admin) can unset a flag; unknown flags are 400', async () => {
    const orgId = nextOrgId();
    primePool({ user: { org_id: orgId, org_role: 'admin', status: 'active' }, org: { features: { plugins_enabled: true }, profile: 'generic' } });
    let res = await request(buildApp())
      .delete(`/api/admin/feature-flags/flags/${orgId}/plugins_enabled`)
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);

    res = await request(buildApp())
      .put(`/api/admin/feature-flags/flags/${orgId}/not_a_flag`)
      .set('Cookie', authCookie())
      .send({ value: true });
    expect(res.status).toBe(400);
  });

  test('member cannot write (403); super-admin can write platform-scope cross-org', async () => {
    const orgId = nextOrgId();
    primePool({ user: { org_id: orgId, org_role: 'member', status: 'active' }, org: { features: {}, profile: 'generic' } });
    let res = await request(buildApp())
      .put(`/api/admin/feature-flags/flags/${orgId}/plugins_enabled`)
      .set('Cookie', authCookie())
      .send({ value: true });
    expect(res.status).toBe(403);

    primePool({
      user: { org_id: orgId, org_role: 'member', status: 'active' },
      admin: { id: 1, user_id: USER_ID, role: 'super_admin', permissions: [] },
      org: { features: {}, profile: 'generic' },
    });
    res = await request(buildApp())
      .put(`/api/admin/feature-flags/flags/${orgId + 5}/ai_billing_required`)
      .set('Cookie', authCookie())
      .send({ value: false });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 3. profile-aware defaults
// ---------------------------------------------------------------------------
describe('featureFlags profile-aware defaults', () => {
  const ZANG_MODULES = ['quotes_enabled', 'vendor_quotes_enabled', 'submittals_enabled', 'change_orders_enabled'];

  test('defaultFor: Zang modules OFF for generic / jcp / rin / null, ON for zang', () => {
    for (const name of ZANG_MODULES) {
      expect(featureFlags.defaultFor(name, 'generic')).toBe(false);
      expect(featureFlags.defaultFor(name, 'jcp')).toBe(false);
      expect(featureFlags.defaultFor(name, 'rin')).toBe(false);
      expect(featureFlags.defaultFor(name, null)).toBe(false);
      expect(featureFlags.defaultFor(name, 'zang')).toBe(true);
    }
    // Core generic modules stay ON everywhere.
    expect(featureFlags.defaultFor('products_enabled', 'generic')).toBe(true);
    expect(featureFlags.defaultFor('customer_success_enabled', 'generic')).toBe(true);
    expect(featureFlags.defaultFor('leads_enabled', 'zang')).toBe(true);
    expect(featureFlags.defaultFor('does_not_exist', 'generic')).toBe(false);
  });

  test('hasFeature: generic org → quotes_enabled false by default; zang org → true', async () => {
    const generic = nextOrgId();
    primePool({ org: { features: {}, profile: 'generic' } });
    expect(await featureFlags.hasFeature(generic, 'quotes_enabled')).toBe(false);
    expect(await featureFlags.hasFeature(generic, 'products_enabled')).toBe(true);

    const zang = nextOrgId();
    primePool({ org: { features: {}, profile: 'zang' } });
    expect(await featureFlags.hasFeature(zang, 'quotes_enabled')).toBe(true);
  });

  test('hasFeature: an explicit key wins over the profile default (the migration-153 pin)', async () => {
    const pinned = nextOrgId();
    primePool({ org: { features: { quotes_enabled: true, submittals_enabled: true }, profile: 'jcp' } });
    expect(await featureFlags.hasFeature(pinned, 'quotes_enabled')).toBe(true);
    expect(await featureFlags.hasFeature(pinned, 'submittals_enabled')).toBe(true);
    expect(await featureFlags.hasFeature(pinned, 'vendor_quotes_enabled')).toBe(false);

    const zangOff = nextOrgId();
    primePool({ org: { features: { quotes_enabled: false }, profile: 'zang' } });
    expect(await featureFlags.hasFeature(zangOff, 'quotes_enabled')).toBe(false);
  });

  test('every KNOWN_FLAG carries scope / group / label / oneLiner', () => {
    for (const f of featureFlags.KNOWN_FLAGS) {
      expect(['org', 'platform']).toContain(f.scope);
      expect(featureFlags.FLAG_GROUPS).toContain(f.group);
      expect(typeof f.label).toBe('string');
      expect(typeof f.oneLiner).toBe('string');
      expect(typeof f.defaultValue).toBe('boolean');
    }
    for (const name of ['ai_billing_required', 'phase2_entities', 'v2_dual_write_enabled', 'sso_enabled']) {
      expect(featureFlags.isPlatformScoped(name)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. migration 153 exists and is idempotent
// ---------------------------------------------------------------------------
describe('migration 153_pin_zang_module_defaults', () => {
  const file = path.join(__dirname, '..', 'migrations', '153_pin_zang_module_defaults.sql');

  test('exists and every UPDATE is guarded by a missing-key predicate', () => {
    expect(fs.existsSync(file)).toBe(true);
    const sql = fs.readFileSync(file, 'utf8');
    const updates = sql.match(/UPDATE organizations/gi) || [];
    expect(updates.length).toBe(4);
    for (const key of ['quotes_enabled', 'vendor_quotes_enabled', 'submittals_enabled', 'change_orders_enabled']) {
      expect(sql).toContain(`'{"${key}": true}'::jsonb`);
      expect(sql).toContain(`NOT (COALESCE(features, '{}'::jsonb) ? '${key}')`);
    }
    // Only non-zang orgs are pinned (zang keeps the default-ON behavior).
    expect((sql.match(/profile IS DISTINCT FROM 'zang'/g) || []).length).toBe(4);
    // No unguarded schema statements.
    expect(sql).not.toMatch(/CREATE TABLE(?! IF NOT EXISTS)/i);
    expect(sql).not.toMatch(/ADD COLUMN(?! IF NOT EXISTS)/i);
  });
});

// ---------------------------------------------------------------------------
// 5. OPEN_SIGNUP
// ---------------------------------------------------------------------------
describe('bootstrapAdmin.initialStatusFor + OPEN_SIGNUP', () => {
  const prev = process.env.OPEN_SIGNUP;
  afterEach(() => {
    if (prev === undefined) delete process.env.OPEN_SIGNUP;
    else process.env.OPEN_SIGNUP = prev;
  });

  test('default (unset) → non-seed signups are pending_approval', () => {
    delete process.env.OPEN_SIGNUP;
    expect(bootstrapAdmin.initialStatusFor('someone@example.com')).toBe('pending_approval');
    expect(bootstrapAdmin.isOpenSignup()).toBe(false);
  });

  test('OPEN_SIGNUP=true → non-seed signups are active', () => {
    process.env.OPEN_SIGNUP = 'true';
    expect(bootstrapAdmin.initialStatusFor('someone@example.com')).toBe('active');
    expect(bootstrapAdmin.isOpenSignup()).toBe(true);
  });

  test('OPEN_SIGNUP=false is not open', () => {
    process.env.OPEN_SIGNUP = 'false';
    expect(bootstrapAdmin.initialStatusFor('someone@example.com')).toBe('pending_approval');
  });

  test('seed admins are always active', () => {
    delete process.env.OPEN_SIGNUP;
    const [seed] = bootstrapAdmin.seedEmails();
    expect(bootstrapAdmin.initialStatusFor(seed)).toBe('active');
  });
});
