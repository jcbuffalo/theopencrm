// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Extension discovery + enable UX:
//   A. GET /api/plugins/library — per-entry installed/active enrichment for
//      the caller's org (ONE status query, graceful degrade on failure).
//   B. POST /api/plugins/from-template with activate — atomic install+activate
//      (fresh clone inserted status='active'; an existing clone is activated
//      in place, never duplicated).
//   C. Chat tools via the test-only _buildChatToolRunner:
//      list_extensions (catalog + status, category/tag filters, flag-aware)
//      and propose_install_extension (confirm-first proposal card; unknown
//      slug, member-role, flag-off, already-active rejections).
//   D. POST /api/ai/actions/apply for extension.install — the SAME shared
//      install internals; owner/admin gate; unknown slug → 404.

// describe / test / expect / beforeEach / vi are vitest globals.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/usageMeter', () => ({
  increment:     vi.fn().mockResolvedValue(null),
  recordAiUsage: vi.fn().mockResolvedValue(null),
}));
vi.mock('../services/aiMetering', () => ({
  recordUsage: vi.fn().mockResolvedValue(null),
}));
vi.mock('../services/quotaEnforcer', () => {
  class QuotaExceeded extends Error {}
  return {
    QuotaExceeded,
    getSeatCount: vi.fn().mockResolvedValue(1),
    checkAiQuota: vi.fn().mockResolvedValue(null),
  };
});

process.env.ANTHROPIC_API_KEY = 'test-key-for-vitest';

const featureFlags = require('../services/featureFlags');
featureFlags.hasFeature = vi.fn().mockResolvedValue(true);

const audit = require('../services/audit');
audit.record  = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

const logger = require('../services/logger');
logger.info  = vi.fn();
logger.warn  = vi.fn();
logger.error = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const pluginRoutes = require('../routes/pluginRoutes');
const aiRoutes = require('../routes/aiRoutes');
const pluginLibrary = require('../services/pluginLibrary');
const extensionInstall = require('../services/extensionInstall');
const chatActions = require('../services/chatActions');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 4242;
const ORG_ID = 99;

// A slug guaranteed to exist in the curated catalog, whatever its size.
const FIRST = pluginLibrary.list()[0];
const KNOWN_SLUG = FIRST.slug;
const KNOWN_NAME = FIRST.name;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/plugins', pluginRoutes);
  app.use('/api/ai', aiRoutes);
  return app;
}

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

// Pattern-routed pool stub (mirrors chatBuildTools.test.js) — handlers are
// [regex, rows|fn] pairs; the auth lookup is served automatically.
function stubPool({ orgRole = 'admin', handlers = [] } = {}) {
  mockPool.query.mockImplementation((sql, params) => {
    const s = String(sql);
    for (const [re, rows] of handlers) {
      if (re.test(s)) {
        const out = typeof rows === 'function' ? rows(s, params) : rows;
        return Promise.resolve({ rows: out });
      }
    }
    if (/FROM users WHERE id/i.test(s)) {
      return Promise.resolve({ rows: [{ org_id: ORG_ID, org_role: orgRole, status: 'active' }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

const STATUS_QUERY = /library_slug IS NOT NULL/;
const EXISTING_BY_SLUG = /WHERE org_id = \$1 AND library_slug = \$2/;
const INSERT_PLUGIN = /INSERT INTO plugins/;
const ACTIVATE_UPDATE = /UPDATE plugins\s+SET status = 'active'/;

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  audit.fromReq.mockClear();
  featureFlags.hasFeature.mockReset();
  featureFlags.hasFeature.mockResolvedValue(true);
});

// ===========================================================================
// A. GET /api/plugins/library — install-status enrichment
// ===========================================================================
describe('GET /api/plugins/library — org install status', () => {
  test('marks installed/active per entry from one status query', async () => {
    stubPool({
      handlers: [
        [STATUS_QUERY, [{ id: 12, library_slug: KNOWN_SLUG, status: 'active' }]],
      ],
    });
    const res = await request(buildApp())
      .get('/api/plugins/library')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    const entry = res.body.data.find((it) => it.slug === KNOWN_SLUG);
    expect(entry).toMatchObject({ installed: true, active: true, installed_plugin_id: 12, installed_status: 'active' });
    const other = res.body.data.find((it) => it.slug !== KNOWN_SLUG);
    if (other) expect(other).toMatchObject({ installed: false, active: false });
    // Exactly ONE plugins-status query ran (plus the auth lookup) — not N.
    const statusCalls = mockPool.query.mock.calls.filter(([sql]) => STATUS_QUERY.test(String(sql)));
    expect(statusCalls.length).toBe(1);
  });

  test('degrades to the bare catalog when the status lookup fails', async () => {
    mockPool.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/FROM users WHERE id/i.test(s)) {
        return Promise.resolve({ rows: [{ org_id: ORG_ID, org_role: 'admin', status: 'active' }] });
      }
      if (STATUS_QUERY.test(s)) return Promise.reject(new Error('boom'));
      return Promise.resolve({ rows: [] });
    });
    const res = await request(buildApp())
      .get('/api/plugins/library')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// B. Atomic install+activate
// ===========================================================================
describe('POST /api/plugins/from-template — activate', () => {
  test('fresh enable inserts the clone with status=active + library_slug', async () => {
    stubPool({
      handlers: [
        [EXISTING_BY_SLUG, []],
        [INSERT_PLUGIN, (s, params) => [{
          id: 51, name: params[1], public_id: 'uuid', status: params[7],
          source_kind: 'library', description: 'x', trigger_event: params[5], library_slug: params[9],
        }]],
      ],
    });
    const res = await request(buildApp())
      .post('/api/plugins/from-template')
      .set('Cookie', authCookie())
      .send({ template_id: KNOWN_SLUG, activate: true });
    expect(res.status).toBe(201);
    expect(res.body.activated).toBe(true);
    expect(res.body.plugin.status).toBe('active');
    expect(res.body.plugin.library_slug).toBe(KNOWN_SLUG);
    // One INSERT carried both the status and the slug — no draft-then-PATCH.
    const insert = mockPool.query.mock.calls.find(([sql]) => INSERT_PLUGIN.test(String(sql)));
    expect(insert[1][7]).toBe('active');   // $8 status
    expect(insert[1][9]).toBe(KNOWN_SLUG); // $10 library_slug
    // Audit trail on the route wrapper.
    expect(audit.fromReq).toHaveBeenCalledTimes(1);
    expect(audit.fromReq.mock.calls[0][1].meta).toMatchObject({ template_slug: KNOWN_SLUG, activated: true });
  });

  test('enable with an existing draft clone activates it in place (no duplicate)', async () => {
    stubPool({
      handlers: [
        [EXISTING_BY_SLUG, [{ id: 40, name: KNOWN_NAME, public_id: 'uuid', status: 'draft', source_kind: 'library', description: 'x', trigger_event: 't', library_slug: KNOWN_SLUG }]],
        [ACTIVATE_UPDATE, [{ id: 40, name: KNOWN_NAME, public_id: 'uuid', status: 'active', source_kind: 'library', description: 'x', trigger_event: 't', library_slug: KNOWN_SLUG }]],
      ],
    });
    const res = await request(buildApp())
      .post('/api/plugins/from-template')
      .set('Cookie', authCookie())
      .send({ template_id: KNOWN_SLUG, activate: true });
    expect(res.status).toBe(200);
    expect(res.body.activated_existing).toBe(true);
    expect(res.body.plugin).toMatchObject({ id: 40, status: 'active' });
    expect(mockPool.query.mock.calls.some(([sql]) => INSERT_PLUGIN.test(String(sql)))).toBe(false);
  });

  test('enable when already active is a no-op (already_active)', async () => {
    stubPool({
      handlers: [
        [EXISTING_BY_SLUG, [{ id: 41, name: KNOWN_NAME, public_id: 'uuid', status: 'active', source_kind: 'library', description: 'x', trigger_event: 't', library_slug: KNOWN_SLUG }]],
      ],
    });
    const res = await request(buildApp())
      .post('/api/plugins/from-template')
      .set('Cookie', authCookie())
      .send({ template_id: KNOWN_SLUG, activate: true });
    expect(res.status).toBe(200);
    expect(res.body.already_active).toBe(true);
    expect(mockPool.query.mock.calls.some(([sql]) => ACTIVATE_UPDATE.test(String(sql)))).toBe(false);
    expect(mockPool.query.mock.calls.some(([sql]) => INSERT_PLUGIN.test(String(sql)))).toBe(false);
  });

  test('without activate, the legacy draft-clone semantics are untouched', async () => {
    stubPool({
      handlers: [
        [INSERT_PLUGIN, (s, params) => [{
          id: 52, name: params[1], public_id: 'uuid', status: params[7],
          source_kind: 'library', description: 'x', trigger_event: params[5], library_slug: params[9],
        }]],
      ],
    });
    const res = await request(buildApp())
      .post('/api/plugins/from-template')
      .set('Cookie', authCookie())
      .send({ template_id: KNOWN_SLUG });
    expect(res.status).toBe(201);
    expect(res.body.activated).toBe(false);
    expect(res.body.plugin.status).toBe('draft');
    // No existing-clone lookup on the draft path — it always clones.
    expect(mockPool.query.mock.calls.some(([sql]) => EXISTING_BY_SLUG.test(String(sql)))).toBe(false);
  });
});

// ===========================================================================
// C. Chat tools — list_extensions + propose_install_extension
// ===========================================================================
describe('chat tool: list_extensions', () => {
  const runnerReq = (over = {}) => ({ orgId: ORG_ID, userId: USER_ID, orgRole: 'member', ...over });

  test('returns the catalog with per-org install status and categories', async () => {
    stubPool({ handlers: [[STATUS_QUERY, [{ id: 12, library_slug: KNOWN_SLUG, status: 'active' }]]] });
    const runTool = aiRoutes._buildChatToolRunner(runnerReq());
    const out = await runTool('list_extensions', {});
    expect(Array.isArray(out.extensions)).toBe(true);
    expect(out.total).toBe(pluginLibrary.list().length);
    expect(out.categories.length).toBeGreaterThan(0);
    const hit = out.extensions.find((e) => e.slug === KNOWN_SLUG);
    expect(hit).toMatchObject({ installed: true, active: true, installed_plugin_id: 12 });
  });

  test('filters by tag and search', async () => {
    stubPool();
    const runTool = aiRoutes._buildChatToolRunner(runnerReq());
    const tagged = await runTool('list_extensions', { tag: 'follow-up' });
    expect(tagged.extensions.every((e) => e.tags.some((t) => t.includes('follow-up')))).toBe(true);
    const searched = await runTool('list_extensions', { search: KNOWN_NAME.slice(0, 12).toLowerCase() });
    expect(searched.extensions.some((e) => e.slug === KNOWN_SLUG)).toBe(true);
  });

  test('flag-aware: plugins_enabled off → FEATURE_DISABLED', async () => {
    stubPool();
    featureFlags.hasFeature.mockResolvedValue(false);
    const runTool = aiRoutes._buildChatToolRunner(runnerReq());
    const out = await runTool('list_extensions', {});
    expect(out.code).toBe('FEATURE_DISABLED');
    expect(out.feature).toBe('plugins_enabled');
  });
});

describe('chat tool: propose_install_extension', () => {
  const adminReq  = () => ({ orgId: ORG_ID, userId: USER_ID, orgRole: 'admin' });
  const memberReq = () => ({ orgId: ORG_ID, userId: USER_ID, orgRole: 'member' });

  test('returns a confirm-first proposal card — nothing written', async () => {
    stubPool();
    const runTool = aiRoutes._buildChatToolRunner(adminReq());
    const out = await runTool('propose_install_extension', { slug: KNOWN_SLUG });
    expect(out.error).toBeUndefined();
    expect(out.proposal).toMatchObject({ entity: 'extension', op: 'install' });
    expect(out.proposal.fields).toMatchObject({ slug: KNOWN_SLUG, activate: true });
    expect(out.proposal.summary).toContain(KNOWN_NAME);
    expect(out.extension).toMatchObject({ slug: KNOWN_SLUG, name: KNOWN_NAME });
    expect(out.apply_requires).toBe('org owner/admin');
    // No INSERT/UPDATE reached the pool.
    expect(mockPool.query.mock.calls.some(([sql]) => /INSERT|UPDATE/i.test(String(sql)))).toBe(false);
  });

  test('unknown slug → unknown_extension with the known slugs', async () => {
    stubPool();
    const runTool = aiRoutes._buildChatToolRunner(adminReq());
    const out = await runTool('propose_install_extension', { slug: 'not-a-real-extension' });
    expect(out.error).toBe('unknown_extension');
    expect(out.known_slugs).toContain(KNOWN_SLUG);
  });

  test('member (non-admin) → not_authorized', async () => {
    stubPool();
    const runTool = aiRoutes._buildChatToolRunner(memberReq());
    const out = await runTool('propose_install_extension', { slug: KNOWN_SLUG });
    expect(out.error).toBe('not_authorized');
  });

  test('plugins module off → FEATURE_DISABLED', async () => {
    stubPool();
    featureFlags.hasFeature.mockResolvedValue(false);
    const runTool = aiRoutes._buildChatToolRunner(adminReq());
    const out = await runTool('propose_install_extension', { slug: KNOWN_SLUG });
    expect(out.code).toBe('FEATURE_DISABLED');
  });

  test('already installed and active → already_installed, no proposal', async () => {
    stubPool({ handlers: [[STATUS_QUERY, [{ id: 12, library_slug: KNOWN_SLUG, status: 'active' }]]] });
    const runTool = aiRoutes._buildChatToolRunner(adminReq());
    const out = await runTool('propose_install_extension', { slug: KNOWN_SLUG });
    expect(out.error).toBe('already_installed');
    expect(out.plugin_id).toBe(12);
    expect(out.proposal).toBeUndefined();
  });
});

// ===========================================================================
// D. Apply — POST /api/ai/actions/apply { extension.install }
// ===========================================================================
describe('POST /api/ai/actions/apply — extension.install', () => {
  const proposal = (over = {}) => ({
    entity: 'extension', op: 'install',
    fields: { slug: KNOWN_SLUG, activate: true, name: KNOWN_NAME, ...over },
  });

  async function postApply(body) {
    return request(buildApp())
      .post('/api/ai/actions/apply')
      .set('Cookie', authCookie())
      .send({ proposal: body });
  }

  test('admin apply routes through the shared install internals (install+activate)', async () => {
    stubPool({
      orgRole: 'admin',
      handlers: [
        [EXISTING_BY_SLUG, []],
        [INSERT_PLUGIN, (s, params) => [{
          id: 61, name: params[1], public_id: 'uuid', status: params[7],
          source_kind: 'library', description: 'x', trigger_event: params[5], library_slug: params[9],
        }]],
      ],
    });
    const res = await postApply(proposal());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.applied).toMatchObject({
      plugin_id: 61,
      status: 'active',
      template_slug: KNOWN_SLUG,
    });
    // Audit stamped as an applied AI action targeting the plugin row.
    const auditCall = audit.fromReq.mock.calls.find(([, a]) => a.event === audit.EVENTS.AI_ACTION_APPLIED);
    expect(auditCall[1].targetId).toBe(61);
    expect(auditCall[1].meta).toMatchObject({ template_slug: KNOWN_SLUG, activated: true });
  });

  test('member apply → 403 (owner/admin only)', async () => {
    stubPool({ orgRole: 'member' });
    const res = await postApply(proposal());
    expect(res.status).toBe(403);
    expect(mockPool.query.mock.calls.some(([sql]) => INSERT_PLUGIN.test(String(sql)))).toBe(false);
  });

  test('unknown slug at apply → 404 TEMPLATE_NOT_FOUND (template re-resolved server-side)', async () => {
    stubPool({ orgRole: 'admin' });
    const res = await postApply(proposal({ slug: 'not-a-real-extension' }));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEMPLATE_NOT_FOUND');
  });

  test('plugins module off at apply → 403 FEATURE_DISABLED (stale proposal cannot write)', async () => {
    stubPool({ orgRole: 'admin' });
    featureFlags.hasFeature.mockResolvedValue(false);
    const res = await postApply(proposal());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
  });
});

// ===========================================================================
// Pure spec sanity
// ===========================================================================
describe('chatActions extension.install spec', () => {
  test('slug required; display fields allowlisted; summary is honest about activation', () => {
    const on = chatActions.validateAction({
      entity: 'extension', op: 'install',
      fields: { slug: 's', activate: true, name: 'Digest', trigger_event: 'schedule.daily' },
    });
    expect(on.ok).toBe(true);
    expect(on.action.summary).toMatch(/turn ON/i);

    const off = chatActions.validateAction({
      entity: 'extension', op: 'install',
      fields: { slug: 's', activate: false, name: 'Digest' },
    });
    expect(off.ok).toBe(true);
    expect(off.action.summary).toMatch(/draft/i);

    expect(chatActions.validateAction({ entity: 'extension', op: 'install', fields: {} }).ok).toBe(false);
    // Non-allowlisted fields are rejected, not silently written.
    const smuggled = chatActions.validateAction({
      entity: 'extension', op: 'install', fields: { slug: 's', source_code: 'evil()' },
    });
    expect(smuggled.ok).toBe(false);
  });
});

describe('extensionInstall.enrichLibraryList (pure)', () => {
  test('decorates entries without mutating the catalog', () => {
    const items = pluginLibrary.list();
    const out = extensionInstall.enrichLibraryList(items, {
      [KNOWN_SLUG]: { plugin_id: 7, status: 'draft', active: false },
    });
    const hit = out.find((i) => i.slug === KNOWN_SLUG);
    expect(hit).toMatchObject({ installed: true, active: false, installed_plugin_id: 7, installed_status: 'draft' });
    expect(items.find((i) => i.slug === KNOWN_SLUG).installed).toBeUndefined();
  });
});
