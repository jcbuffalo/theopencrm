// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Saved workspace templates (spec 203 Phase 2, migration 171):
//   A. sanitizeConfig / validateConfig — whitelist + pure structural checks
//   B. snapshotOrg — definitions only, planner shape out
//   C. planFromTemplate — deterministic clone: NO AI call, dupes skipped,
//      stage refs resolved, proposals re-validate against the apply validator
//   D. routes — visibility (own or public), owner/admin gates, public gallery
//      is summaries-only, generate-platform is super-admin only

// describe / test / expect / beforeEach / vi are vitest globals.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/usageMeter', () => ({ increment: vi.fn().mockResolvedValue(null), recordAiUsage: vi.fn().mockResolvedValue(null) }));
vi.mock('../services/aiMetering', () => ({ recordUsage: vi.fn().mockResolvedValue(null) }));
vi.mock('../services/quotaEnforcer', () => {
  class QuotaExceeded extends Error {}
  return { QuotaExceeded, getSeatCount: vi.fn().mockResolvedValue(1), checkAiQuota: vi.fn().mockResolvedValue(null) };
});

process.env.ANTHROPIC_API_KEY = 'test-key-for-vitest';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const featureFlags = require('../services/featureFlags');
featureFlags.hasFeature = vi.fn();
const ai = require('../services/ai');
const chatActions = require('../services/chatActions');
const wt = require('../services/workspaceTemplates');
const routes = require('../routes/workspaceTemplateRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 4242;
const ORG_ID = 7;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/workspace-templates', routes);
  app.use('/api/public/workspace-templates', routes.publicRouter);
  return app;
}
function authCookie() { return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`]; }

const CONFIG = {
  pipeline: {
    name: 'RFQ pipeline',
    stages: [
      { label: 'RFQ Received', tone: 'slate' },
      { label: 'Customer Quote', tone: 'yellow', probability: 50 },
      { label: 'PO Received', tone: 'green', is_won: true },
      { label: 'Lost', tone: 'red', is_lost: true },
    ],
  },
  fields: [
    { entity: 'deals', name: 'rfq_number', label: 'RFQ Number', type: 'text' },
    { entity: 'companies', name: 'vendor_line', label: 'Vendor Line', type: 'select', options: ['Eaton', 'ABB'] },
  ],
  automations: [
    { name: 'Quote follow-up', trigger: 'deal_idle_days', days: 7, action: 'create_task', title: 'Follow up' },
    { name: 'Hot at quote', trigger: 'deal_stage_is', stage: 'Customer Quote', action: 'set_hot_flag' },
  ],
  views: [{ entity: 'deals', name: 'Open quotes', filters: { stage: 'Customer Quote' } }],
};

const ROW = {
  id: 31, org_id: 99, created_by: 1, slug: 'rfq_pipeline', name: 'RFQ pipeline', tagline: 'For reps', vertical: 'manufacturer_rep',
  description: null, config: CONFIG, is_public: true, use_count: 3, created_at: '2026-09-19', updated_at: '2026-09-19',
};

function stubPool({ orgRole = 'owner', adminRole = null, rows = {}, dealCounts = [], fieldDefs = [] } = {}) {
  mockPool.query.mockImplementation((sql, params) => {
    const s = String(sql);
    if (/FROM users WHERE id/i.test(s)) return Promise.resolve({ rows: [{ org_id: ORG_ID, org_role: orgRole, status: 'active' }] });
    if (/FROM admin_users/i.test(s)) return Promise.resolve({ rows: adminRole ? [{ role: adminRole, user_id: USER_ID, permissions: {} }] : [] });
    if (/SELECT profile FROM organizations/i.test(s)) return Promise.resolve({ rows: [{ profile: 'generic' }] });
    if (/FROM pipelines/i.test(s)) return Promise.resolve({ rows: [] });
    if (/FROM deals WHERE org_id = \$1 AND deal_type/i.test(s)) return Promise.resolve({ rows: dealCounts });
    if (/FROM org_field_definitions/i.test(s)) return Promise.resolve({ rows: fieldDefs.filter((d) => !s.includes('entity = $2') || s.includes('entity = $2')) });
    if (/FROM automation_rules/i.test(s)) return Promise.resolve({ rows: rows.rules || [] });
    if (/FROM saved_views/i.test(s)) return Promise.resolve({ rows: rows.views || [] });
    if (/SELECT 1 FROM workspace_templates/i.test(s)) return Promise.resolve({ rows: rows.slugTaken ? [{ 1: 1 }] : [] });
    if (/INSERT INTO workspace_templates/i.test(s)) {
      // Org insert: (org_id, created_by, slug, name, tagline, vertical, description, config, is_public).
      // Platform insert: (NULL, created_by, slug, name, tagline, vertical, description, config).
      const platform = /VALUES \(NULL/.test(s);
      const o = platform ? -1 : 0;
      return Promise.resolve({ rows: [{ ...ROW, org_id: platform ? null : ORG_ID, id: 77, slug: params[2 + o], name: params[3 + o], tagline: params[4 + o], vertical: params[5 + o], description: params[6 + o], config: JSON.parse(params[7 + o]), is_public: platform ? true : params[8] === true }] });
    }
    if (/UPDATE workspace_templates SET use_count/i.test(s)) return Promise.resolve({ rows: [] });
    if (/UPDATE workspace_templates/i.test(s)) return Promise.resolve({ rows: rows.updated === undefined ? [{ ...ROW, org_id: ORG_ID }] : rows.updated });
    if (/DELETE FROM workspace_templates/i.test(s)) return Promise.resolve({ rows: rows.deleted === false ? [] : [{ id: 31 }] });
    if (/FROM workspace_templates WHERE id = \$1/i.test(s)) return Promise.resolve({ rows: rows.byId === undefined ? [ROW] : rows.byId });
    if (/FROM workspace_templates WHERE/i.test(s)) return Promise.resolve({ rows: rows.list || [ROW] });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  mockPool.query.mockReset();
  featureFlags.hasFeature.mockReset();
  featureFlags.hasFeature.mockResolvedValue(true);
  ai.callClaude = vi.fn();
});

// ===========================================================================
// A. sanitize / validate
// ===========================================================================
describe('workspaceTemplates.validateConfig', () => {
  test('accepts a well-formed config and normalizes stage ids', () => {
    const v = wt.validateConfig(CONFIG);
    expect(v.ok, v.errors.join('; ')).toBe(true);
    expect(v.config.pipeline.stages.map((s) => s.id)).toEqual(['rfq_received', 'customer_quote', 'po_received', 'lost']);
  });

  test('whitelists keys — ids, org refs, and unknown keys never survive', () => {
    const dirty = {
      ...CONFIG,
      org_id: 1, records: [{ company: 'Acme' }],
      fields: [{ entity: 'deals', name: 'rfq_number', type: 'text', org_id: 5, id: 9, sql: 'DROP TABLE' }],
    };
    const c = wt.sanitizeConfig(dirty);
    expect(c).not.toHaveProperty('org_id');
    expect(c).not.toHaveProperty('records');
    expect(Object.keys(c.fields[0]).sort()).toEqual(['entity', 'name', 'type']);
  });

  test('rejects: missing won stage, reserved column, unknown stage reference, empty template', () => {
    const noWon = wt.validateConfig({
      pipeline: { name: 'x', stages: [{ label: 'A' }, { label: 'B', is_lost: true }] },
      fields: [{ entity: 'deals', name: 'amount', type: 'number' }],
    });
    expect(noWon.ok).toBe(false);
    expect(noWon.errors.join(' | ')).toMatch(/won/);
    expect(noWon.errors.join(' | ')).toMatch(/amount/);

    const badRef = wt.validateConfig({
      ...CONFIG,
      automations: [{ name: 'r', trigger: 'deal_stage_is', stage: 'Nope', action: 'notify' }, { name: 'w', trigger: 'webhook', action: 'email' }],
    });
    expect(badRef.ok).toBe(false);
    expect(badRef.errors.join(' | ')).toMatch(/Nope/);
    expect(badRef.errors.join(' | ')).toMatch(/unsupported trigger "webhook"/);
    expect(badRef.errors.join(' | ')).toMatch(/unsupported action "email"/);

    expect(wt.validateConfig({}).errors.join(' ')).toMatch(/at least a pipeline/);
  });
});

// ===========================================================================
// B. snapshot
// ===========================================================================
describe('workspaceTemplates.snapshotOrg', () => {
  test('reads definitions only and emits the planner shape', async () => {
    stubPool({
      fieldDefs: [{ entity: 'deals', name: 'rfq_number', label: 'RFQ Number', type: 'text', options: null, required: false }],
      rows: {
        rules: [
          { name: 'Idle', trigger: 'deal_idle_days', conditions: { days: 10 }, action: { type: 'create_task', title: 'Nudge', priority: 'high' } },
          { name: 'Hot', trigger: 'deal_stage_is', conditions: { stage: 'proposal' }, action: { type: 'set_hot_flag' } },
        ],
        views: [{ name: 'Hot deals', filter_spec: { hot: true } }],
      },
    });
    const snap = await wt.snapshotOrg(ORG_ID);
    expect(snap.pipeline.stages.map((s) => s.id)).toEqual(['lead', 'qualified', 'proposal', 'negotiation', 'closed_won', 'closed_lost']);
    expect(snap.fields).toEqual([{ entity: 'deals', name: 'rfq_number', label: 'RFQ Number', type: 'text' }]);
    expect(snap.automations).toEqual([
      { name: 'Idle', trigger: 'deal_idle_days', action: 'create_task', days: 10, title: 'Nudge', priority: 'high' },
      { name: 'Hot', trigger: 'deal_stage_is', action: 'set_hot_flag', stage: 'proposal' },
    ]);
    expect(snap.views).toEqual([{ entity: 'deals', name: 'Hot deals', filters: { hot: true } }]);
    // Only shared deal views, only enabled planner-vocabulary rules, no record tables.
    const sqls = mockPool.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /is_shared = TRUE AND resource = 'deals'/.test(s))).toBe(true);
    expect(sqls.some((s) => /enabled = TRUE AND trigger IN/.test(s))).toBe(true);
    expect(sqls.some((s) => /FROM (companies|contacts)\b/.test(s))).toBe(false);
    // The snapshot itself round-trips through save validation.
    expect(wt.validateConfig(snap).ok).toBe(true);
  });
});

// ===========================================================================
// C. clone plan
// ===========================================================================
describe('workspaceTemplates.planFromTemplate', () => {
  test('is deterministic: no AI call; proposals re-validate; dupes skipped; stage refs resolved to the template pipeline', async () => {
    stubPool({ fieldDefs: [{ entity: 'deals', name: 'rfq_number', label: 'RFQ Number', type: 'text' }] });
    const plan = await wt.planFromTemplate(ROW, { orgId: ORG_ID });
    expect(ai.callClaude).not.toHaveBeenCalled();
    expect(plan.narrative).toMatch(/Start from "RFQ pipeline"/);
    const kinds = plan.proposals.map((p) => p.kind);
    expect(kinds).toEqual(['pipeline', 'field', 'automation', 'automation', 'view']); // rfq_number skipped as dupe
    for (const p of plan.proposals) expect(chatActions.validateAction(p.proposal).ok, p.label).toBe(true);
    expect(plan.skipped.find((s) => s.label === 'RFQ Number').reason).toMatch(/already exists/);
    const hot = plan.proposals.find((p) => p.kind === 'automation' && p.proposal.fields.action.type === 'set_hot_flag');
    expect(hot.proposal.fields.conditions.stage).toBe('customer_quote');
    expect(plan.proposals.find((p) => p.kind === 'view').proposal.fields.filter_spec).toEqual({ stage: 'customer_quote' });
    // use_count bump is fire-and-forget.
    expect(mockPool.query.mock.calls.some((c) => /use_count = use_count \+ 1/.test(String(c[0])))).toBe(true);
  });
});

// ===========================================================================
// D. routes
// ===========================================================================
describe('/api/workspace-templates', () => {
  test('GET list: all = own OR public; mine = own only', async () => {
    stubPool();
    let r = await request(buildApp()).get('/api/workspace-templates').set('Cookie', authCookie());
    expect(r.status).toBe(200);
    expect(r.body.templates[0]).toMatchObject({ id: 31, name: 'RFQ pipeline', stages: ['RFQ Received', 'Customer Quote', 'PO Received', 'Lost'], field_labels: ['RFQ Number', 'Vendor Line'], automation_count: 2, view_count: 1 });
    expect(r.body.templates[0]).not.toHaveProperty('config');
    let sql = mockPool.query.mock.calls.map((c) => String(c[0])).find((s) => /FROM workspace_templates WHERE/.test(s));
    expect(sql).toMatch(/org_id = \$1 OR is_public = TRUE/);

    mockPool.query.mockClear();
    r = await request(buildApp()).get('/api/workspace-templates?scope=mine').set('Cookie', authCookie());
    sql = mockPool.query.mock.calls.map((c) => String(c[0])).find((s) => /FROM workspace_templates WHERE/.test(s));
    expect(sql).toMatch(/WHERE org_id = \$1 ORDER/);
  });

  test('GET /:id — visible when own or public, 404 otherwise; can_edit only for own', async () => {
    stubPool();
    let r = await request(buildApp()).get('/api/workspace-templates/31').set('Cookie', authCookie());
    expect(r.status).toBe(200);
    expect(r.body.template.can_edit).toBe(false); // ROW.org_id = 99 ≠ caller's 7
    expect(r.body.template.config).toBeTruthy();
    const sql = mockPool.query.mock.calls.map((c) => String(c[0])).find((s) => /FROM workspace_templates WHERE id = \$1/.test(s));
    expect(sql).toMatch(/org_id = \$2 OR is_public = TRUE/);

    stubPool({ rows: { byId: [] } });
    r = await request(buildApp()).get('/api/workspace-templates/31').set('Cookie', authCookie());
    expect(r.status).toBe(404);
  });

  test('POST snapshot: owner saves the current workspace as a template; member gets 403', async () => {
    stubPool({ orgRole: 'owner' });
    let r = await request(buildApp()).post('/api/workspace-templates').set('Cookie', authCookie())
      .send({ name: 'Our sales process', tagline: 'How we sell', source: 'snapshot', is_public: false });
    expect(r.status).toBe(201);
    expect(r.body.template).toMatchObject({ name: 'Our sales process', slug: 'our_sales_process', can_edit: true });
    const insert = mockPool.query.mock.calls.find((c) => /INSERT INTO workspace_templates/.test(String(c[0])));
    const storedConfig = JSON.parse(insert[1][7]);
    expect(storedConfig.pipeline.stages.map((s) => s.id)).toContain('closed_won');
    expect(insert[1][0]).toBe(ORG_ID);

    stubPool({ orgRole: 'member' });
    r = await request(buildApp()).post('/api/workspace-templates').set('Cookie', authCookie()).send({ name: 'x', source: 'snapshot' });
    expect(r.status).toBe(403);
  });

  test('POST with an invalid config → 400 with validation_errors; missing name → 400', async () => {
    stubPool({ orgRole: 'admin' });
    let r = await request(buildApp()).post('/api/workspace-templates').set('Cookie', authCookie())
      .send({ name: 'Broken', config: { pipeline: { name: 'p', stages: [{ label: 'Only' }] } } });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_TEMPLATE');
    expect(r.body.validation_errors.join(' ')).toMatch(/won/);
    r = await request(buildApp()).post('/api/workspace-templates').set('Cookie', authCookie()).send({ config: CONFIG });
    expect(r.status).toBe(400);
  });

  test('PUT/DELETE are scoped to own org in SQL; 404 when the row is not ours', async () => {
    stubPool({ orgRole: 'owner' });
    let r = await request(buildApp()).put('/api/workspace-templates/31').set('Cookie', authCookie()).send({ is_public: true, tagline: 'Shared' });
    expect(r.status).toBe(200);
    const upd = mockPool.query.mock.calls.find((c) => /UPDATE workspace_templates/.test(String(c[0])) && !/SET use_count/.test(String(c[0])));
    expect(upd).toBeTruthy();
    expect(String(upd[0])).toMatch(/AND org_id = \$\d+ RETURNING/);
    expect(upd[1]).toContain(ORG_ID);

    stubPool({ orgRole: 'owner', rows: { deleted: false } });
    r = await request(buildApp()).delete('/api/workspace-templates/31').set('Cookie', authCookie());
    expect(r.status).toBe(404);
    const del = mockPool.query.mock.calls.find((c) => /DELETE FROM workspace_templates/.test(String(c[0])));
    expect(String(del[0])).toMatch(/WHERE id = \$1 AND org_id = \$2/);
  });

  test('POST /:id/plan returns proposals + can_apply by role, and writes nothing but audit', async () => {
    stubPool({ orgRole: 'member' });
    const r = await request(buildApp()).post('/api/workspace-templates/31/plan').set('Cookie', authCookie());
    expect(r.status).toBe(200);
    expect(r.body.can_apply).toBe(false);
    expect(r.body.template.name).toBe('RFQ pipeline');
    expect(r.body.plan.proposals.length).toBeGreaterThan(0);
    const writes = mockPool.query.mock.calls.map((c) => String(c[0])).filter((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s) && !/audit_log|use_count/i.test(s));
    expect(writes).toEqual([]);
    expect(ai.callClaude).not.toHaveBeenCalled();
  });

  test('generate-platform: super-admin only; drafts each static template with the AI and upserts public platform rows', async () => {
    stubPool({ orgRole: 'owner' });
    let r = await request(buildApp()).post('/api/workspace-templates/generate-platform').set('Cookie', authCookie()).send({});
    expect(r.status).toBe(403);

    stubPool({ orgRole: 'owner', adminRole: 'super_admin' });
    ai.callClaude.mockResolvedValue({ ok: true, text: JSON.stringify({ narrative: 'x', ...CONFIG }) });
    r = await request(buildApp()).post('/api/workspace-templates/generate-platform').set('Cookie', authCookie()).send({ only: ['saas', 'agency'] });
    expect(r.status).toBe(200);
    expect(r.body.generated.map((g) => g.slug).sort()).toEqual(['agency', 'saas']);
    expect(r.body.failed).toEqual([]);
    expect(ai.callClaude).toHaveBeenCalledTimes(2);
    const insert = mockPool.query.mock.calls.find((c) => /INSERT INTO workspace_templates/.test(String(c[0])));
    expect(String(insert[0])).toMatch(/VALUES \(NULL/);
    expect(String(insert[0])).toMatch(/ON CONFLICT \(\(COALESCE\(org_id, 0\)\), slug\)/);
  });

  test('public gallery: no auth, summaries only, cacheable', async () => {
    stubPool();
    const r = await request(buildApp()).get('/api/public/workspace-templates');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toMatch(/max-age=300/);
    expect(r.body.templates[0]).toMatchObject({ name: 'RFQ pipeline', is_public: true });
    expect(r.body.templates[0]).not.toHaveProperty('config');
    const sql = mockPool.query.mock.calls.map((c) => String(c[0])).find((s) => /FROM workspace_templates/.test(s));
    expect(sql).toMatch(/WHERE is_public = TRUE/);
  });
});
