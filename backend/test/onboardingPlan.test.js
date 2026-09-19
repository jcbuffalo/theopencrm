// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// First-run workspace builder (spec 203, Phase 1):
//   A. services/onboardingPlanner — one stubbed Claude call → a bundle of
//      proposals that each pass chatActions.validateAction (the apply
//      endpoint's validator), in apply order, with bad pieces SKIPPED (not
//      fatal) and automation stage labels resolved against the PROPOSED
//      pipeline.
//   B. routes/onboardingRoutes — templates list, 400s, template + description
//      merge, can_apply by role. Nothing writes.
//   C. services/selfServeOrg — new orgs get limits_tier='free' + the AI trial.

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
const planner = require('../services/onboardingPlanner');
const templates = require('../services/onboardingTemplates');
const selfServeOrg = require('../services/selfServeOrg');
const onboardingRoutes = require('../routes/onboardingRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 4242;
const ORG_ID = 7;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/onboarding', onboardingRoutes);
  return app;
}
function authCookie() { return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`]; }

// Org on the generic default pipeline, no custom pipeline row, no custom
// fields, and (by default) no deals.
function stubPool({ orgRole = 'owner', dealCounts = [], fieldDefs = [], profile = 'generic' } = {}) {
  mockPool.query.mockImplementation((sql) => {
    const s = String(sql);
    if (/FROM users WHERE id/i.test(s)) return Promise.resolve({ rows: [{ org_id: ORG_ID, org_role: orgRole, status: 'active' }] });
    if (/SELECT profile FROM organizations/i.test(s)) return Promise.resolve({ rows: [{ profile }] });
    if (/FROM pipelines/i.test(s)) return Promise.resolve({ rows: [] });
    if (/FROM deals WHERE org_id = \$1 AND deal_type/i.test(s)) return Promise.resolve({ rows: dealCounts });
    if (/FROM org_field_definitions/i.test(s)) return Promise.resolve({ rows: fieldDefs.filter((d) => s.includes('entity = $2')) });
    return Promise.resolve({ rows: [] });
  });
}

const GOOD_PLAN = {
  narrative: 'A six-stage RFQ-to-PO pipeline with the fields you track.',
  pipeline: {
    name: 'RFQ pipeline',
    stages: [
      { label: 'RFQ Received', desc: 'Customer sent an RFQ', tone: 'slate', is_won: false, is_lost: false, probability: 10 },
      { label: 'Vendor Quoting', desc: 'Waiting on manufacturer pricing', tone: 'blue', probability: 25 },
      { label: 'Customer Quote', desc: 'Quote sent', tone: 'yellow', probability: 50 },
      { label: 'Follow Up', desc: 'Chasing the PO', tone: 'amber', probability: 70 },
      { label: 'PO Received', desc: 'Won', tone: 'green', is_won: true, probability: 100 },
      { label: 'Lost', desc: 'Awarded elsewhere', tone: 'red', is_lost: true, probability: 0 },
    ],
  },
  fields: [
    { entity: 'deals', name: 'rfq_number', label: 'RFQ Number', type: 'text', why: 'You reference RFQs by number.' },
    { entity: 'deals', name: 'commission_rate', label: 'Commission Rate', type: 'percent', why: 'You track commission.' },
    { entity: 'deals', name: 'amount', label: 'Amount', type: 'number', why: 'dup of a shared column — must be skipped' },
    { entity: 'companies', name: 'vendor_line', label: 'Vendor Line', type: 'select', options: ['Eaton', 'ABB', 'Other'] },
    { entity: 'leads', name: 'source', label: 'Source', type: 'text' },
  ],
  automations: [
    { name: 'Quote follow-up', trigger: 'deal_idle_days', days: 7, action: 'create_task', title: 'Follow up on quote', priority: 'high', why: 'You said 7 days.' },
    { name: 'Flag PO stage', trigger: 'deal_stage_is', stage: 'Customer Quote', action: 'set_hot_flag' },
    { name: 'Bogus stage', trigger: 'deal_stage_is', stage: 'Nonexistent Stage', action: 'notify' },
    { name: 'Bad trigger', trigger: 'webhook', action: 'notify' },
  ],
  views: [
    { entity: 'deals', name: 'Open quotes', filters: { stage: 'Customer Quote' }, why: 'Quotes out the door.' },
    { entity: 'deals', name: 'Weird', filters: { colour: 'red' } },
  ],
};

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  featureFlags.hasFeature.mockReset();
  featureFlags.hasFeature.mockResolvedValue(true);
  ai.callClaude = vi.fn().mockResolvedValue({ ok: true, configured: true, text: JSON.stringify(GOOD_PLAN), usage: { input_tokens: 10, output_tokens: 20 } });
});

// ===========================================================================
// A. planner
// ===========================================================================
describe('onboardingPlanner.planWorkspace', () => {
  test('turns one structured Claude reply into apply-ordered proposals that all re-validate', async () => {
    stubPool();
    const out = await planner.planWorkspace({ orgId: ORG_ID, userId: USER_ID, description: 'We are a manufacturer rep. Customers send RFQs, we quote, chase the PO.' });
    expect(out.ok).toBe(true);
    const { plan } = out;
    expect(plan.narrative).toMatch(/RFQ/);
    expect(plan.pipeline_name).toBe('RFQ pipeline');

    // Order: pipeline → fields → automations → views.
    const kinds = plan.proposals.map((p) => p.kind);
    expect(kinds[0]).toBe('pipeline');
    expect(kinds.filter((k) => k === 'field').length).toBe(3);      // rfq_number, commission_rate, vendor_line
    expect(kinds.filter((k) => k === 'automation').length).toBe(2); // idle-days + resolved stage
    expect(kinds.filter((k) => k === 'view').length).toBe(1);
    expect(kinds).toEqual([...kinds].sort((a, b) => ['pipeline', 'field', 'automation', 'view'].indexOf(a) - ['pipeline', 'field', 'automation', 'view'].indexOf(b)));

    // Every proposal is exactly what POST /api/ai/actions/apply re-validates.
    for (const p of plan.proposals) {
      const v = chatActions.validateAction(p.proposal);
      expect(v.ok, `${p.kind} ${p.label}: ${(v.errors || []).join('; ')}`).toBe(true);
    }

    // Pipeline: labels slugged to ids, won/lost carried through.
    const stages = plan.proposals[0].proposal.fields.stages;
    expect(stages.map((s) => s.id)).toEqual(['rfq_received', 'vendor_quoting', 'customer_quote', 'follow_up', 'po_received', 'lost']);
    expect(stages.find((s) => s.id === 'po_received').is_won).toBe(true);
    expect(plan.proposals[0].proposal.fields.moveDealsTo).toBeUndefined(); // no deals → nothing to move

    // Fields: "percent" aliased to number; the reserved `amount` and the
    // unsupported `leads` entity were skipped with reasons, not fatal.
    const commission = plan.proposals.find((p) => p.kind === 'field' && p.proposal.fields.name === 'commission_rate');
    expect(commission.proposal.fields.type).toBe('number');
    const skippedLabels = plan.skipped.map((s) => s.label);
    expect(skippedLabels).toContain('Amount');
    expect(skippedLabels).toContain('Source');

    // Automations: the stage LABEL resolved to the PROPOSED stage id (which
    // does not exist on the org yet); the bogus stage + trigger were skipped.
    const hot = plan.proposals.find((p) => p.kind === 'automation' && p.proposal.fields.action.type === 'set_hot_flag');
    expect(hot.proposal.fields.conditions.stage).toBe('customer_quote');
    const idle = plan.proposals.find((p) => p.kind === 'automation' && p.proposal.fields.trigger === 'deal_idle_days');
    expect(idle.proposal.fields.conditions.days).toBe(7);
    expect(idle.proposal.fields.action).toMatchObject({ type: 'create_task', title: 'Follow up on quote', priority: 'high' });
    expect(skippedLabels).toContain('Bogus stage');
    expect(skippedLabels).toContain('Bad trigger');

    // Views: stage filter resolved to id, shared by default; unknown filter key skipped.
    const view = plan.proposals.find((p) => p.kind === 'view');
    expect(view.proposal.fields).toMatchObject({ resource: 'deals', name: 'Open quotes', filter_spec: { stage: 'customer_quote' }, is_shared: true });
    expect(skippedLabels).toContain('Weird');

    // The single planning call carried the description and the strict contract.
    expect(ai.callClaude).toHaveBeenCalledTimes(1);
    const call = ai.callClaude.mock.calls[0][0];
    expect(call.endpoint).toBe('onboarding-plan');
    expect(call.messages[0].content).toMatch(/manufacturer rep/);
    expect(call.system).toMatch(/Exactly one stage with "is_won": true/);
    expect(call.system).toMatch(/Lead → Qualified → Proposal → Negotiation → Closed Won → Closed Lost/);
  });

  test('a pipeline missing won/lost gets deterministic terminal stages instead of failing', async () => {
    stubPool();
    ai.callClaude.mockResolvedValue({ ok: true, text: JSON.stringify({
      narrative: 'ok',
      pipeline: { name: 'Simple', stages: [{ label: 'New' }, { label: 'Talking' }, { label: 'Signed' }] },
      fields: [], automations: [], views: [],
    }) });
    const out = await planner.planWorkspace({ orgId: ORG_ID, userId: USER_ID, description: 'We talk to people and they sign or not.' });
    expect(out.ok).toBe(true);
    const stages = out.plan.proposals[0].proposal.fields.stages;
    expect(stages.map((s) => s.label)).toEqual(['New', 'Talking', 'Signed', 'Closed Won', 'Closed Lost']);
    expect(out.plan.notes.join(' ')).toMatch(/Closed Won/);
    expect(out.plan.notes.join(' ')).toMatch(/Closed Lost/);
  });

  test('existing deals in dropped stages are parked in the first new stage (moveDealsTo) and the note says so', async () => {
    stubPool({ dealCounts: [{ stage: 'proposal', n: 3 }, { stage: 'lead', n: 1 }] });
    const out = await planner.planWorkspace({ orgId: ORG_ID, userId: USER_ID, description: 'We are a manufacturer rep. Customers send RFQs, we quote, chase the PO.' });
    expect(out.ok).toBe(true);
    expect(out.plan.proposals[0].proposal.fields.moveDealsTo).toBe('rfq_received');
    expect(out.plan.notes.join(' ')).toMatch(/4 existing deals will move to "RFQ Received"/);
  });

  test('pipeline: null keeps the default and automations resolve against the CURRENT stages', async () => {
    stubPool();
    ai.callClaude.mockResolvedValue({ ok: true, text: JSON.stringify({
      narrative: 'Your process matches the default.',
      pipeline: null,
      fields: [],
      automations: [{ name: 'Nudge on proposal', trigger: 'deal_stage_is', stage: 'Proposal', action: 'notify' }],
      views: [],
    }) });
    const out = await planner.planWorkspace({ orgId: ORG_ID, userId: USER_ID, description: 'Pretty standard B2B sales, lead to proposal to close.' });
    expect(out.ok).toBe(true);
    expect(out.plan.proposals.map((p) => p.kind)).toEqual(['automation']);
    expect(out.plan.proposals[0].proposal.fields.conditions.stage).toBe('proposal');
    expect(out.plan.pipeline_name).toBe('Pipeline');
  });

  test('automation module off → automations skipped with an actionable reason, rest of the plan survives', async () => {
    stubPool();
    featureFlags.hasFeature.mockImplementation(async (_org, flag) => flag !== 'automation_enabled');
    const out = await planner.planWorkspace({ orgId: ORG_ID, userId: USER_ID, description: 'We are a manufacturer rep. Customers send RFQs, we quote, chase the PO.' });
    expect(out.ok).toBe(true);
    expect(out.plan.proposals.some((p) => p.kind === 'automation')).toBe(false);
    expect(out.plan.skipped.find((s) => s.kind === 'automation').reason).toMatch(/switched off/);
    expect(ai.callClaude.mock.calls[0][0].system).toMatch(/Automations are switched off/);
  });

  test('duplicate of an existing custom field is skipped, and existing fields are in the prompt', async () => {
    stubPool({ fieldDefs: [{ entity: 'deals', name: 'rfq_number', label: 'RFQ Number', type: 'text' }] });
    const out = await planner.planWorkspace({ orgId: ORG_ID, userId: USER_ID, description: 'We are a manufacturer rep. Customers send RFQs, we quote, chase the PO.' });
    expect(out.ok).toBe(true);
    expect(out.plan.proposals.some((p) => p.kind === 'field' && p.proposal.fields.name === 'rfq_number')).toBe(false);
    expect(out.plan.skipped.find((s) => s.label === 'RFQ Number').reason).toMatch(/already exists/);
    expect(ai.callClaude.mock.calls[0][0].system).toMatch(/deals\.rfq_number \(text\)/);
  });

  test('a "not a business" reply yields an empty plan with the narrative, not an error', async () => {
    stubPool();
    ai.callClaude.mockResolvedValue({ ok: true, text: JSON.stringify({ narrative: 'Tell me how you find and close customers.', pipeline: null, fields: [], automations: [], views: [] }) });
    const out = await planner.planWorkspace({ orgId: ORG_ID, userId: USER_ID, description: 'asdf asdf asdf asdf asdf' });
    expect(out.ok).toBe(true);
    expect(out.plan.proposals).toEqual([]);
    expect(out.plan.narrative).toMatch(/find and close/);
  });

  test('malformed model output → 422; unconfigured AI → 503; quota → 429; short description → 400', async () => {
    stubPool();
    ai.callClaude.mockResolvedValue({ ok: true, text: 'Sure! Here is your CRM: lots of prose and no JSON' });
    let out = await planner.planWorkspace({ orgId: ORG_ID, userId: USER_ID, description: 'We sell widgets to hardware stores across the midwest.' });
    expect(out).toMatchObject({ ok: false, status: 422, code: 'MALFORMED_RESPONSE' });

    ai.callClaude.mockResolvedValue({ configured: false, message: 'AI not configured.' });
    out = await planner.planWorkspace({ orgId: ORG_ID, userId: USER_ID, description: 'We sell widgets to hardware stores across the midwest.' });
    expect(out).toMatchObject({ ok: false, status: 503, code: 'AI_NOT_CONFIGURED' });

    ai.callClaude.mockResolvedValue({ configured: true, ok: false, error: 'quota', code: 'QUOTA_EXCEEDED' });
    out = await planner.planWorkspace({ orgId: ORG_ID, userId: USER_ID, description: 'We sell widgets to hardware stores across the midwest.' });
    expect(out).toMatchObject({ ok: false, status: 429, code: 'QUOTA_EXCEEDED' });

    out = await planner.planWorkspace({ orgId: ORG_ID, userId: USER_ID, description: 'short' });
    expect(out).toMatchObject({ ok: false, status: 400, code: 'INVALID_DESCRIPTION' });
    expect(ai.callClaude).toHaveBeenCalledTimes(3);
  });

  test('the model cannot smuggle a write: only allowlisted action shapes come out', async () => {
    stubPool();
    ai.callClaude.mockResolvedValue({ ok: true, text: JSON.stringify({
      narrative: 'x', pipeline: null,
      fields: [{ entity: 'deals', name: 'note', type: 'text', __proto__: null, org_id: 999, sql: 'DROP TABLE deals' }],
      automations: [], views: [],
    }) });
    const out = await planner.planWorkspace({ orgId: ORG_ID, userId: USER_ID, description: 'We sell widgets to hardware stores across the midwest.' });
    expect(out.ok).toBe(true);
    const f = out.plan.proposals[0];
    expect(f.kind).toBe('field');
    expect(Object.keys(f.proposal.fields).sort()).toEqual(['entity', 'name', 'type']);
    expect(f.proposal).not.toHaveProperty('sql');
  });
});

// ===========================================================================
// B. routes
// ===========================================================================
describe('GET /api/onboarding/templates', () => {
  test('lists id/name/tagline only — descriptions stay server-side', async () => {
    stubPool();
    const r = await request(buildApp()).get('/api/onboarding/templates').set('Cookie', authCookie());
    expect(r.status).toBe(200);
    expect(r.body.templates.length).toBeGreaterThanOrEqual(10);
    const rep = r.body.templates.find((t) => t.id === 'manufacturer_rep');
    expect(rep).toMatchObject({ name: "Manufacturer's rep" });
    expect(rep.description).toBeUndefined();
    expect(ai.callClaude).not.toHaveBeenCalled();
  });

  test('every template description is itself a valid planner input', () => {
    for (const t of templates.TEMPLATES) {
      expect(planner.validateDescription(t.description), t.id).toBeNull();
    }
  });
});

describe('POST /api/onboarding/plan', () => {
  test('owner: template_id + extra description merge into one call; can_apply=true; nothing written', async () => {
    stubPool({ orgRole: 'owner' });
    const r = await request(buildApp()).post('/api/onboarding/plan').set('Cookie', authCookie())
      .send({ template_id: 'saas', description: 'We also sell through resellers.' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, can_apply: true, template_id: 'saas' });
    expect(r.body.plan.proposals.length).toBeGreaterThan(0);
    const sent = ai.callClaude.mock.calls[0][0].messages[0].content;
    expect(sent).toMatch(/software subscriptions/);
    expect(sent).toMatch(/Also: We also sell through resellers\./);
    // The only write a plan makes is its own audit row (AI_ACTION_PROPOSED).
    const writes = mockPool.query.mock.calls.map((c) => String(c[0])).filter((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s) && !/INSERT INTO audit_log/i.test(s));
    expect(writes).toEqual([]);
  });

  test('member gets the plan but can_apply=false', async () => {
    stubPool({ orgRole: 'member' });
    const r = await request(buildApp()).post('/api/onboarding/plan').set('Cookie', authCookie())
      .send({ description: 'We are a manufacturer rep. Customers send RFQs, we quote, chase the PO.' });
    expect(r.status).toBe(200);
    expect(r.body.can_apply).toBe(false);
  });

  test('400 on unknown template, missing/short description; 401 without a session', async () => {
    stubPool();
    let r = await request(buildApp()).post('/api/onboarding/plan').set('Cookie', authCookie()).send({ template_id: 'nope' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('UNKNOWN_TEMPLATE');
    r = await request(buildApp()).post('/api/onboarding/plan').set('Cookie', authCookie()).send({ description: 'hi' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('INVALID_DESCRIPTION');
    r = await request(buildApp()).post('/api/onboarding/plan').send({ description: 'We sell widgets to hardware stores across the midwest.' });
    expect(r.status).toBe(401);
    expect(ai.callClaude).not.toHaveBeenCalled();
  });

  test('planner failure codes pass through as HTTP statuses', async () => {
    stubPool();
    ai.callClaude.mockResolvedValue({ ok: true, text: 'not json at all' });
    const r = await request(buildApp()).post('/api/onboarding/plan').set('Cookie', authCookie())
      .send({ description: 'We sell widgets to hardware stores across the midwest.' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('MALFORMED_RESPONSE');
  });
});

// ===========================================================================
// C. self-serve org provisioning
// ===========================================================================
describe('selfServeOrg.createSelfServeOrg', () => {
  const db = { query: vi.fn() };
  beforeEach(() => { db.query.mockReset(); db.query.mockResolvedValue({ rows: [{ id: 99 }] }); });
  afterEach(() => { delete process.env.AI_SIGNUP_TRIAL_DAYS; });

  test('default: free caps armed + 14-day AI trial', async () => {
    const row = await selfServeOrg.createSelfServeOrg(db, { name: "Pat's Workspace", ownerUserId: 5 });
    expect(row).toEqual({ id: 99 });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/limits_tier/);
    expect(sql).toMatch(/'free'/);
    expect(sql).toMatch(/ai_billing_status, ai_billing_trial_ends_at/);
    expect(sql).toMatch(/'trial'/);
    expect(sql).not.toMatch(/ON CONFLICT/);
    expect(params).toEqual(["Pat's Workspace", 5, 14]);
  });

  test('AI_SIGNUP_TRIAL_DAYS=0 provisions without a trial; onConflictDoNothing returns null on a swallowed dup', async () => {
    process.env.AI_SIGNUP_TRIAL_DAYS = '0';
    db.query.mockResolvedValue({ rows: [] });
    const row = await selfServeOrg.createSelfServeOrg(db, { name: 'X', ownerUserId: 1, onConflictDoNothing: true });
    expect(row).toBeNull();
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).not.toMatch(/trial/);
    expect(sql).toMatch(/ON CONFLICT DO NOTHING/);
    expect(params).toEqual(['X', 1]);
  });

  test('garbage env falls back to the default; huge values are capped at a year', () => {
    process.env.AI_SIGNUP_TRIAL_DAYS = 'lots';
    expect(selfServeOrg.trialDays()).toBe(14);
    process.env.AI_SIGNUP_TRIAL_DAYS = '9999';
    expect(selfServeOrg.trialDays()).toBe(365);
  });
});
