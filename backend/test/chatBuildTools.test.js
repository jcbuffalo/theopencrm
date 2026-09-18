// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// "Chat and BUILD" — the workspace-building chat tools:
//   propose_add_custom_field / propose_automation_rule / propose_saved_view /
//   propose_report (confirm-first), open_page (navigation registry), and the
//   upgraded how_do_i / list_modules capability brain.
//
// Layers, mirroring chatControlPlane.test.js:
//   A. Pure validateAction specs (no DB) — each new spec reuses its admin
//      route's own validator.
//   B. POST /api/ai/actions/apply — role gates (member denied for field/rule,
//      allowed for view/report), mirrored INSERTs, 409 on a duplicate field.
//   C. propose_* / open_page through the real /api/ai/chat flow (stubbed
//      Claude): proposals NEVER write; chips come from the registry.
//   D. how_do_i synonym matching + list_modules effective flags via the
//      exported tool runner.

// describe / test / expect / beforeEach / afterEach / vi are vitest globals.

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

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const featureFlags = require('../services/featureFlags');
featureFlags.hasFeature = vi.fn();
const chatActions = require('../services/chatActions');
const chatCapabilities = require('../services/chatCapabilities');
const ai = require('../services/ai');
const aiRoutes = require('../routes/aiRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/ai', aiRoutes);
  return app;
}

const USER_ID = 4242;
const ORG_ID = 7;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function makeClient(writeRow) {
  return {
    calls: [],
    query: vi.fn(function (sql) {
      this.calls.push(String(sql));
      if (/^UPDATE|^INSERT/i.test(String(sql).trim())) {
        return Promise.resolve({ rows: writeRow ? [writeRow] : [] });
      }
      return Promise.resolve({ rows: [] });
    }),
    release: vi.fn(),
  };
}

function stubApplyPool({ orgRole = 'member', orgId = ORG_ID, handlers = [] } = {}) {
  mockPool.query.mockImplementation((sql, params) => {
    const s = String(sql);
    for (const [re, rows] of handlers) {
      if (re.test(s)) {
        const out = typeof rows === 'function' ? rows(s, params) : rows;
        return Promise.resolve({ rows: out });
      }
    }
    if (/FROM users WHERE id/i.test(s)) {
      return Promise.resolve({ rows: [{ org_id: orgId, org_role: orgRole, status: 'active' }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

async function postApply(proposal) {
  return request(buildApp())
    .post('/api/ai/actions/apply')
    .set('Cookie', authCookie())
    .send({ proposal });
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  featureFlags.hasFeature.mockReset();
  featureFlags.hasFeature.mockResolvedValue(true);
});

// ===========================================================================
// A. validateAction specs (pure)
// ===========================================================================
describe('chatActions.validateAction — workspace-building specs', () => {
  test('custom_field.create: reuses the custom-fields route validator (reserved column, options rules)', () => {
    const ok = chatActions.validateAction({
      entity: 'custom_field', op: 'create',
      fields: { entity: 'deals', name: 'contract_value', label: 'Contract Value', type: 'number' },
    });
    expect(ok.ok).toBe(true);
    expect(ok.action.summary).toMatch(/Contract Value/);

    // Shadowing a real column is refused by the route's RESERVED_COLUMNS rule.
    const reserved = chatActions.validateAction({
      entity: 'custom_field', op: 'create', fields: { entity: 'deals', name: 'amount', type: 'number' },
    });
    expect(reserved.ok).toBe(false);
    expect(reserved.errors.join(' ')).toMatch(/already exists on the deals shared schema/);

    // select needs options.
    const noOpts = chatActions.validateAction({
      entity: 'custom_field', op: 'create', fields: { entity: 'companies', name: 'region', type: 'select' },
    });
    expect(noOpts.ok).toBe(false);
    expect(noOpts.errors.join(' ')).toMatch(/options/);

    // Entity outside the route's VALID_ENTITIES (leads) is refused.
    expect(chatActions.validateAction({
      entity: 'custom_field', op: 'create', fields: { entity: 'leads', name: 'x', type: 'text' },
    }).ok).toBe(false);
  });

  test('automation_rule.create: same zod schema as /api/automation-rules, plain-English summary', () => {
    const ok = chatActions.validateAction({
      entity: 'automation_rule', op: 'create',
      fields: {
        name: 'Welcome email', trigger: 'deal_stage_is', conditions: { stage: 'closed_won' },
        action: { type: 'create_task', title: 'Send welcome email', priority: 'high' },
      },
    });
    expect(ok.ok).toBe(true);
    expect(ok.action.summary).toBe('When a deal moves to closed_won, create a task "Send welcome email" (high priority) for the owner (rule "Welcome email")');

    // deal_stage_is needs conditions.stage.
    const noStage = chatActions.validateAction({
      entity: 'automation_rule', op: 'create',
      fields: { name: 'x', trigger: 'deal_stage_is', action: { type: 'notify' } },
    });
    expect(noStage.ok).toBe(false);
    expect(noStage.errors.join(' ')).toMatch(/conditions\.stage/);

    // set_hot_flag is deal-only.
    const hotOnTask = chatActions.validateAction({
      entity: 'automation_rule', op: 'create',
      fields: { name: 'x', trigger: 'task_overdue', action: { type: 'set_hot_flag' } },
    });
    expect(hotOnTask.ok).toBe(false);
    expect(hotOnTask.errors.join(' ')).toMatch(/deal trigger/);

    // Unknown trigger is refused by the enum.
    expect(chatActions.validateAction({
      entity: 'automation_rule', op: 'create',
      fields: { name: 'x', trigger: 'full_moon', action: { type: 'notify' } },
    }).ok).toBe(false);
  });

  test('saved_view.create: resource enum + name; filters opaque', () => {
    const ok = chatActions.validateAction({
      entity: 'saved_view', op: 'create',
      fields: { resource: 'deals', name: 'Big & Hot', filter_spec: { hot: true, amount_min: 50000 }, is_shared: true },
    });
    expect(ok.ok).toBe(true);
    expect(ok.action.summary).toMatch(/shared deals view "Big & Hot"/);
    expect(ok.action.summary).toMatch(/hot=true/);

    expect(chatActions.validateAction({
      entity: 'saved_view', op: 'create', fields: { resource: 'leads', name: 'x' },
    }).ok).toBe(false);
  });

  test('report.create: config validated by the report engine allowlist', () => {
    const ok = chatActions.validateAction({
      entity: 'report', op: 'create',
      fields: {
        name: 'Won by month',
        config: { entity: 'deals', filters: [{ field: 'stage', op: 'eq', value: 'closed_won' }], group_by: 'closed_date', metric: 'sum:amount', chart_type: 'line' },
      },
    });
    expect(ok.ok).toBe(true);
    expect(ok.action.summary).toMatch(/sum of amount of deals grouped by closed_date/);

    const bad = chatActions.validateAction({
      entity: 'report', op: 'create',
      fields: { name: 'bad', config: { entity: 'deals', group_by: 'password_hash' } },
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(' ')).toMatch(/group_by must be one of/);
  });
});

// ===========================================================================
// B. POST /api/ai/actions/apply — role gates + mirrored INSERTs
// ===========================================================================
describe('actions/apply — custom_field.create (owner/admin only)', () => {
  const fieldProposal = {
    entity: 'custom_field', op: 'create',
    fields: { entity: 'deals', name: 'contract_value', label: 'Contract Value', type: 'number' },
  };

  test('org member -> 403, nothing written', async () => {
    stubApplyPool({ orgRole: 'member' });
    const res = await postApply(fieldProposal);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner\/admin/);
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  test('org admin -> INSERT INTO org_field_definitions in a txn, created_by stamped', async () => {
    const client = makeClient({ id: 12, entity: 'deals', name: 'contract_value', type: 'number' });
    mockPool.connect.mockResolvedValueOnce(client);
    stubApplyPool({ orgRole: 'admin' });

    const res = await postApply(fieldProposal);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.open_path).toBe('/admin/customizations');
    const insert = client.calls.find((s) => /INSERT INTO org_field_definitions/i.test(s));
    expect(insert).toBeDefined();
    expect(insert).toMatch(/created_by/);
    expect(client.calls.some((s) => /COMMIT/.test(s))).toBe(true);
    // The route's duplicate-name check ran first.
    expect(client.calls.some((s) => /SELECT id FROM org_field_definitions/i.test(s))).toBe(true);
  });

  test('duplicate field name -> 409 (same as POST /api/custom-fields), rolled back', async () => {
    const client = makeClient({ id: 12 });
    client.query = vi.fn(function (sql) {
      this.calls.push(String(sql));
      if (/SELECT id FROM org_field_definitions/i.test(String(sql))) return Promise.resolve({ rows: [{ id: 3 }] });
      return Promise.resolve({ rows: [] });
    });
    mockPool.connect.mockResolvedValueOnce(client);
    stubApplyPool({ orgRole: 'owner' });

    const res = await postApply(fieldProposal);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/);
    expect(client.calls.some((s) => /INSERT/i.test(s))).toBe(false);
    expect(client.calls.some((s) => /ROLLBACK/.test(s))).toBe(true);
  });

  test('personal workspace (no org) -> 400, org context required', async () => {
    stubApplyPool({ orgRole: 'owner', orgId: null });
    const res = await postApply(fieldProposal);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Org context/);
  });
});

describe('actions/apply — automation_rule.create (owner/admin only, automation_enabled)', () => {
  const ruleProposal = {
    entity: 'automation_rule', op: 'create',
    fields: {
      name: 'Welcome email', trigger: 'deal_stage_is', conditions: { stage: 'closed_won' },
      action: { type: 'create_task', title: 'Send welcome email' },
    },
  };

  test('org member -> 403', async () => {
    stubApplyPool({ orgRole: 'member' });
    const res = await postApply(ruleProposal);
    expect(res.status).toBe(403);
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  test('org owner -> INSERT INTO automation_rules (flag re-checked at apply)', async () => {
    const client = makeClient({ id: 5, name: 'Welcome email', trigger: 'deal_stage_is', enabled: true });
    mockPool.connect.mockResolvedValueOnce(client);
    stubApplyPool({ orgRole: 'owner' });

    const res = await postApply(ruleProposal);
    expect(res.status).toBe(200);
    expect(featureFlags.hasFeature).toHaveBeenCalledWith(ORG_ID, 'automation_enabled');
    const insert = client.calls.find((s) => /INSERT INTO automation_rules/i.test(s));
    expect(insert).toBeDefined();
    expect(res.body.open_path).toBe('/admin/automation');
  });

  test('automation_enabled off -> 403 FEATURE_DISABLED even for an owner', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    stubApplyPool({ orgRole: 'owner' });
    const res = await postApply(ruleProposal);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  test('a tampered echo (unknown action type) is re-validated and refused', async () => {
    stubApplyPool({ orgRole: 'owner' });
    const res = await postApply({
      ...ruleProposal,
      fields: { ...ruleProposal.fields, action: { type: 'delete_all_deals' } },
    });
    expect(res.status).toBe(400);
    expect(mockPool.connect).not.toHaveBeenCalled();
  });
});

describe('actions/apply — saved_view.create and report.create (member-level)', () => {
  test('a plain member can apply their own saved view (mirrors POST /api/saved-views)', async () => {
    const client = makeClient({ id: 21, resource: 'deals', name: 'Big & Hot' });
    mockPool.connect.mockResolvedValueOnce(client);
    stubApplyPool({ orgRole: 'member' });

    const res = await postApply({
      entity: 'saved_view', op: 'create',
      fields: { resource: 'deals', name: 'Big & Hot', filter_spec: { hot: true }, is_default: true },
    });
    expect(res.status).toBe(200);
    expect(res.body.open_path).toBe('/deals');
    // is_default clears the previous default on the same client, then inserts.
    expect(client.calls.some((s) => /UPDATE saved_views SET is_default = FALSE/i.test(s))).toBe(true);
    const insert = client.calls.find((s) => /INSERT INTO saved_views/i.test(s));
    expect(insert).toBeDefined();
    expect(insert).toMatch(/user_id, org_id, resource, name, filter_spec, sort_spec, is_default, is_shared/);
  });

  test('a plain member can apply a saved report; reports_enabled re-checked', async () => {
    const client = makeClient({ id: 31, name: 'Won by month', entity: 'deals' });
    mockPool.connect.mockResolvedValueOnce(client);
    stubApplyPool({ orgRole: 'member' });

    const res = await postApply({
      entity: 'report', op: 'create',
      fields: { name: 'Won by month', config: { entity: 'deals', group_by: 'closed_date', metric: 'sum:amount', chart_type: 'line' } },
    });
    expect(res.status).toBe(200);
    expect(featureFlags.hasFeature).toHaveBeenCalledWith(ORG_ID, 'reports_enabled');
    expect(res.body.open_path).toBe('/reports/builder');
    const insert = client.calls.find((s) => /INSERT INTO saved_reports/i.test(s));
    expect(insert).toBeDefined();
  });
});

// ===========================================================================
// C. propose_* / open_page through the real /api/ai/chat flow
// ===========================================================================
describe('build tools via /api/ai/chat — proposals never write', () => {
  let originalFetch;

  function fakeResponse(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body };
  }

  function stubClaudeWithToolCall(toolName, toolInput) {
    const responses = [
      { usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_build', name: toolName, input: toolInput }] },
      { usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Proposed — click Apply to confirm.' }] },
    ];
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(fakeResponse(responses.shift())));
  }

  // Captures the tool result Claude was handed back (second fetch call body)
  // so tests can assert on the raw tool output, not just the chips.
  function lastToolResult() {
    const calls = globalThis.fetch.mock.calls;
    const body = JSON.parse(calls[calls.length - 1][1].body);
    const msgs = body.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const content = msgs[i].content;
      if (Array.isArray(content)) {
        const tr = content.find((b) => b.type === 'tool_result');
        if (tr) return JSON.parse(typeof tr.content === 'string' ? tr.content : tr.content[0].text);
      }
    }
    return null;
  }

  function stubChatFlow({ orgRole = 'member', orgId = ORG_ID } = {}) {
    mockPool.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/FROM users WHERE id/i.test(s)) {
        return Promise.resolve({ rows: [{ org_id: orgId, org_role: orgRole, status: 'active' }] });
      }
      if (/COUNT\(\*\)::int AS c/i.test(s)) return Promise.resolve({ rows: [{ c: 0 }] });
      if (/INSERT INTO chat_sessions/i.test(s)) return Promise.resolve({ rows: [{ id: 'sess-build' }] });
      if (/SELECT profile FROM organizations/i.test(s)) return Promise.resolve({ rows: [{ profile: 'jcp' }] });
      return Promise.resolve({ rows: [] });
    });
  }

  function wroteAnything() {
    return mockPool.query.mock.calls.some(([sql]) =>
      /INSERT INTO (org_field_definitions|automation_rules|saved_views|saved_reports)|UPDATE (org_field_definitions|automation_rules|saved_views|saved_reports)/i.test(String(sql)));
  }

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  async function postChat(message) {
    return request(buildApp()).post('/api/ai/chat').set('Cookie', authCookie()).send({ message });
  }

  test('propose_add_custom_field (owner): apply_action chip with the derived key, NO write', async () => {
    stubClaudeWithToolCall('propose_add_custom_field', { entity: 'deal', name: 'Contract Value', type: 'currency' });
    stubChatFlow({ orgRole: 'owner' });

    const res = await postChat('add a Contract Value field to deals');
    expect(res.status).toBe(200);
    const chip = (res.body.actions || []).find((a) => a.kind === 'apply_action');
    expect(chip).toBeDefined();
    expect(chip.proposal.entity).toBe('custom_field');
    expect(chip.proposal.fields).toMatchObject({ entity: 'deals', name: 'contract_value', label: 'Contract Value', type: 'number' });
    expect(chip.proposal.summary).toMatch(/Contract Value/);
    // The dup pre-flight ran org-scoped; nothing wrote.
    const dup = mockPool.query.mock.calls.find(([sql]) => /SELECT id FROM org_field_definitions/i.test(String(sql)));
    expect(dup).toBeDefined();
    expect(dup[1]).toEqual([ORG_ID, 'deals', 'contract_value']);
    expect(mockPool.connect).not.toHaveBeenCalled();
    expect(wroteAnything()).toBe(false);
  });

  test('propose_add_custom_field (member): refused not_authorized, no chip, no DB probe', async () => {
    stubClaudeWithToolCall('propose_add_custom_field', { entity: 'deal', name: 'Contract Value', type: 'number' });
    stubChatFlow({ orgRole: 'member' });

    const res = await postChat('add a field');
    expect(res.status).toBe(200);
    expect((res.body.actions || []).find((a) => a.kind === 'apply_action')).toBeUndefined();
    expect(lastToolResult().error).toBe('not_authorized');
    expect(wroteAnything()).toBe(false);
  });

  test('propose_add_custom_field on leads is honestly refused', async () => {
    stubClaudeWithToolCall('propose_add_custom_field', { entity: 'lead', name: 'Budget', type: 'number' });
    stubChatFlow({ orgRole: 'owner' });
    const res = await postChat('add a budget field to leads');
    expect(res.status).toBe(200);
    expect(lastToolResult().validation_errors.join(' ')).toMatch(/leads/);
    expect((res.body.actions || []).find((a) => a.kind === 'apply_action')).toBeUndefined();
  });

  test('propose_automation_rule (admin): plain-English summary, stage resolved, NO write', async () => {
    stubClaudeWithToolCall('propose_automation_rule', {
      trigger: 'deal_stage_is', stage: 'Closed Won', action: 'create_task', params: { title: 'Send welcome email' },
    });
    stubChatFlow({ orgRole: 'admin' });

    const res = await postChat('when a deal moves to closed won create a task to send the welcome email');
    expect(res.status).toBe(200);
    const chip = (res.body.actions || []).find((a) => a.kind === 'apply_action');
    expect(chip).toBeDefined();
    expect(chip.proposal.entity).toBe('automation_rule');
    expect(chip.proposal.fields.conditions.stage).toBe('closed_won');
    expect(chip.proposal.fields.action).toEqual({ type: 'create_task', title: 'Send welcome email' });
    expect(chip.proposal.summary).toMatch(/^When a deal moves to closed_won, create a task "Send welcome email"/);
    expect(featureFlags.hasFeature).toHaveBeenCalledWith(ORG_ID, 'automation_enabled');
    expect(wroteAnything()).toBe(false);
  });

  test('propose_automation_rule (member): refused, no chip', async () => {
    stubClaudeWithToolCall('propose_automation_rule', { trigger: 'task_overdue', action: 'notify' });
    stubChatFlow({ orgRole: 'member' });
    const res = await postChat('notify me when tasks go overdue');
    expect(res.status).toBe(200);
    expect((res.body.actions || []).find((a) => a.kind === 'apply_action')).toBeUndefined();
    expect(lastToolResult().error).toBe('not_authorized');
  });

  test('propose_saved_view (member): allowed; unknown filter keys refused', async () => {
    stubClaudeWithToolCall('propose_saved_view', { entity: 'deal', name: 'Big & Hot', filters: { hot: true, amount_min: 50000 }, is_shared: true });
    stubChatFlow({ orgRole: 'member' });
    const res = await postChat('save a view of hot deals over 50k');
    expect(res.status).toBe(200);
    const chip = (res.body.actions || []).find((a) => a.kind === 'apply_action');
    expect(chip).toBeDefined();
    expect(chip.proposal.entity).toBe('saved_view');
    expect(chip.proposal.fields).toMatchObject({ resource: 'deals', name: 'Big & Hot', filter_spec: { hot: true, amount_min: 50000 }, is_shared: true });
    expect(wroteAnything()).toBe(false);

    stubClaudeWithToolCall('propose_saved_view', { entity: 'deal', name: 'Nope', filters: { colour: 'red' } });
    stubChatFlow({ orgRole: 'member' });
    const res2 = await postChat('save a view of red deals');
    expect(res2.status).toBe(200);
    expect((res2.body.actions || []).find((a) => a.kind === 'apply_action')).toBeUndefined();
    expect(lastToolResult().validation_errors.join(' ')).toMatch(/unknown filter key/);
  });

  test('propose_report (member): builds a validated config; bad group_by refused', async () => {
    stubClaudeWithToolCall('propose_report', { name: 'Deals by stage', entity: 'deal', group_by: 'stage', chart: 'pie' });
    stubChatFlow({ orgRole: 'member' });
    const res = await postChat('report of deals by stage as a pie');
    expect(res.status).toBe(200);
    const chip = (res.body.actions || []).find((a) => a.kind === 'apply_action');
    expect(chip).toBeDefined();
    expect(chip.proposal.entity).toBe('report');
    expect(chip.proposal.fields.config).toMatchObject({ entity: 'deals', group_by: 'stage', metric: 'count', chart_type: 'pie' });
    expect(featureFlags.hasFeature).toHaveBeenCalledWith(ORG_ID, 'reports_enabled');
    expect(wroteAnything()).toBe(false);

    stubClaudeWithToolCall('propose_report', { name: 'Bad', entity: 'contacts', metric: 'sum:amount' });
    stubChatFlow({ orgRole: 'member' });
    const res2 = await postChat('sum of amount of contacts');
    expect((res2.body.actions || []).find((a) => a.kind === 'apply_action')).toBeUndefined();
    expect(lastToolResult().validation_errors.join(' ')).toMatch(/count/);
  });

  test('open_page resolves a known page from the registry and mints a navigate chip', async () => {
    stubClaudeWithToolCall('open_page', { page: 'the report builder' });
    stubChatFlow();
    const res = await postChat('open the report builder');
    expect(res.status).toBe(200);
    expect(lastToolResult().page).toEqual({ key: 'report_builder', path: '/reports/builder', label: 'Open report builder' });
    const chip = (res.body.actions || []).find((a) => a.kind === 'navigate');
    expect(chip).toEqual({ kind: 'navigate', path: '/reports/builder', label: 'Open report builder' });
  });

  test('open_page for an unknown page returns suggestions and no chip', async () => {
    stubClaudeWithToolCall('open_page', { page: 'frobnicator' });
    stubChatFlow();
    const res = await postChat('open the frobnicator');
    expect(res.status).toBe(200);
    const out = lastToolResult();
    expect(out.error).toBe('unknown_page');
    expect(Array.isArray(out.known_pages)).toBe(true);
    expect(out.known_pages).toContain('automations');
    expect((res.body.actions || []).find((a) => a.kind === 'navigate')).toBeUndefined();
  });

  test('open_page is flag-aware: a disabled module page says so and gets no chip', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    stubClaudeWithToolCall('open_page', { page: 'plugins' });
    stubChatFlow();
    const res = await postChat('open plugins');
    expect(res.status).toBe(200);
    const out = lastToolResult();
    expect(out.disabled).toBe(true);
    expect(out.feature).toBe('plugins_enabled');
    expect(featureFlags.hasFeature).toHaveBeenCalledWith(ORG_ID, 'plugins_enabled');
    expect((res.body.actions || []).find((a) => a.kind === 'navigate')).toBeUndefined();
  });

  test('how_do_i (pipeline stages) is honest: stages are editable (live) + the org\'s own effective stage list', async () => {
    // Per-org editable stages (migration 155): the topic is live and
    // your_stages is the org's EFFECTIVE pipeline (profile default here).
    stubClaudeWithToolCall('how_do_i', { question: 'can I add a new stage to my pipeline?' });
    stubChatFlow({ orgRole: 'owner' });
    const res = await postChat('can I add a new stage to my pipeline?');
    expect(res.status).toBe(200);
    const out = lastToolResult();
    expect(out.capability.topic).toBe('pipeline_stages');
    expect(out.capability.status).toBe('live');
    expect(out.capability.where).toBe('/settings/pipeline');
    expect(out.capability.your_profile).toBe('jcp');
    expect(out.capability.your_pipeline_is_custom).toBe(false);
    expect(out.capability.your_stages.map((s) => s.id)).toEqual(['LEAD', 'INTRO', 'SCOPING', 'PITCH', 'ENGAGED', 'CLOSED_WON', 'CLOSED_LOST']);
    expect(out.capability.keywords).toBeUndefined();
  });
});

// ===========================================================================
// D. Capability brain: synonym matching, ambiguity, effective flags, registry
// ===========================================================================
describe('chatCapabilities — synonym matching + ranked lookup', () => {
  test('field/column/property phrasings resolve to custom_fields', () => {
    for (const q of [
      'how do I add a column to deals?',
      'can I add a property on contacts',
      'I need an extra field for contract value on deals',
      'where do I manage custom fields',
    ]) {
      expect(chatCapabilities.lookup(q)?.topic, q).toBe('custom_fields');
    }
  });

  test('rule/trigger/automation phrasings resolve to automation_rules — NOT plugins', () => {
    for (const q of [
      'how do I set up an automation?',
      'can I make a rule so when a deal moves to closed won a task is created',
      'trigger a follow-up task when a deal is idle',
      'automatically flag stale deals',
    ]) {
      expect(chatCapabilities.lookup(q)?.topic, q).toBe('automation_rules');
    }
    expect(chatCapabilities.lookup('how do I set up an automation?').gating).toBe('automation_enabled');
    expect(chatCapabilities.lookup('how do I set up an automation?').where).toBe('/admin/automation');
  });

  test('the new topics cover stages, views, reports, import, basics, sync, usage, modules', () => {
    const cases = [
      ['what stages do I have?', 'pipeline_stages'],
      ['how do I save this filter as a tab?', 'saved_views'],
      ['can I build a custom report grouped by stage?', 'reports'],
      ['how does forecasting work', 'forecast'],
      ['how do I import my data from a spreadsheet', 'csv_import'],
      ['how do I create a recurring task', 'tasks_basics'],
      ['how do I add a contact', 'contacts_companies_basics'],
      ['can I sync google drive folders to deals', 'drive_intel'],
      ['does it work with outlook', 'outlook_m365'],
      ['sync my google calendar', 'google_calendar_sync'],
      ['can I bring my own anthropic key', 'usage_and_ai_keys'],
      ['how do I turn on the portal module', 'modules_feature_flags'],
      ['what can you build for me', 'build_with_chat'],
    ];
    for (const [q, topic] of cases) {
      expect(chatCapabilities.lookup(q)?.topic, q).toBe(topic);
    }
  });

  test('lookupAll returns the two best topics for an ambiguous question', () => {
    const hits = chatCapabilities.lookupAll('can I automate a report?', 2);
    expect(hits.length).toBe(2);
    expect(hits.map((h) => h.capability.topic).sort()).toEqual(['automation_rules', 'reports']);
  });

  test('stemming: plurals and verb forms match keyword phrases', () => {
    expect(chatCapabilities.lookup('add fields to companies')?.topic).toBe('custom_fields');
    expect(chatCapabilities.lookup('automation rules')?.topic).toBe('automation_rules');
  });

  test('every gating flag on a capability or page is a registered flag', () => {
    const known = new Set((featureFlags.KNOWN_FLAGS || []).map((f) => f.name));
    for (const c of chatCapabilities.CAPABILITIES) {
      if (c.gating) expect(known.has(c.gating), `${c.topic} → ${c.gating}`).toBe(true);
    }
    for (const p of chatCapabilities.PAGES) {
      if (p.gating) expect(known.has(p.gating), `${p.key} → ${p.gating}`).toBe(true);
    }
  });

  test('resolvePage: keys, labels, aliases, paths; unknown -> null + suggestions', () => {
    expect(chatCapabilities.resolvePage('report builder').page.path).toBe('/reports/builder');
    expect(chatCapabilities.resolvePage('feature flags').page.key).toBe('modules');
    expect(chatCapabilities.resolvePage('go to my day').page.path).toBe('/today');
    expect(chatCapabilities.resolvePage('custom_fields').page.path).toBe('/admin/customizations');
    expect(chatCapabilities.resolvePage('/admin/automation').page.key).toBe('automations');
    expect(chatCapabilities.resolvePage('take me to automations').page.path).toBe('/admin/automation');
    const miss = chatCapabilities.resolvePage('frobnicate');
    expect(miss.page).toBeNull();
    expect(Array.isArray(miss.suggestions)).toBe(true);
    expect(() => chatCapabilities.pageFor('nope')).toThrow(/Unknown page key/);
  });
});

describe('navigation chips agree with the registry', () => {
  test('every read-tool chip path comes from PAGES (no hardcoded paths)', () => {
    const expected = {
      list_overdue_tasks: '/tasks?bucket=overdue',
      list_hot_deals: '/deals?hot=true',
      list_dormant_deals: '/deals?last_activity_window=30d',
      list_at_risk_accounts: '/companies',
      summarize_attention: '/dashboard',
      list_leads: '/leads',
      list_open_cases: '/cases',
      list_upcoming_meetings: '/calendar',
      list_sequences: '/sequences',
    };
    for (const [tool, path] of Object.entries(expected)) {
      const actions = aiRoutes._buildActionsFromToolCalls([{ name: tool, input: {}, result: { rows: [] } }]);
      const nav = actions.find((a) => a.kind === 'navigate');
      expect(nav, tool).toBeDefined();
      expect(nav.path, tool).toBe(path);
      expect(chatCapabilities.PAGES.some((p) => p.path === path), `${path} missing from PAGES`).toBe(true);
    }
    // list_deals only chips for the pre-sale phase.
    expect(aiRoutes._buildActionsFromToolCalls([{ name: 'list_deals', input: { phase: 'pre_sale' }, result: {} }])[0].path).toBe('/deals?phase=pre_sale');
    expect(aiRoutes._buildActionsFromToolCalls([{ name: 'list_deals', input: {}, result: {} }]).filter((a) => a.kind !== 'ask')).toEqual([]); // B's follow-up 'ask' chips are allowed; only navigation chips are asserted here
    // A disabled module never chips.
    expect(aiRoutes._buildActionsFromToolCalls([{ name: 'list_leads', input: {}, result: { code: 'FEATURE_DISABLED' } }])).toEqual([]);
    // open_page chips from its resolved result, not from the input.
    expect(aiRoutes._buildActionsFromToolCalls([{ name: 'open_page', input: { page: 'x' }, result: { page: { key: 'team', path: '/team', label: 'Open team' } } }]))
      .toEqual([{ kind: 'navigate', path: '/team', label: 'Open team' }]);
    expect(aiRoutes._buildActionsFromToolCalls([{ name: 'open_page', input: { page: 'x' }, result: { page: { path: '/plugins', label: 'Open plugins' }, disabled: true } }])).toEqual([]);
  });

  test('the registry covers every destination the task list names', () => {
    const keys = new Set(chatCapabilities.PAGES.map((p) => p.key));
    for (const k of ['deals', 'leads', 'contacts', 'companies', 'accounts', 'renewals', 'cases', 'playbooks', 'surveys', 'segments',
      'reports', 'report_builder', 'forecast', 'dashboard', 'my_day', 'calendar', 'tasks', 'activities', 'sequences', 'quotes',
      'products', 'import', 'settings', 'team', 'usage', 'plugins', 'modules', 'branding', 'custom_fields', 'automations',
      'email_templates', 'admin']) {
      expect(keys.has(k), k).toBe(true);
    }
  });
});

describe('list_modules via the tool runner — effective flags', () => {
  test('reports enabled_for_your_org from featureFlags.hasFeature per flag', async () => {
    featureFlags.hasFeature.mockImplementation(async (_org, name) => name !== 'plugins_enabled');
    const runTool = aiRoutes._buildChatToolRunner({ orgId: ORG_ID, userId: USER_ID, orgRole: 'member' });
    const out = await runTool('list_modules', {});
    expect(out.org_scoped).toBe(true);
    const plugins = out.flags.find((f) => f.name === 'plugins_enabled');
    expect(plugins.enabled_for_your_org).toBe(false);
    const leads = out.modules.find((m) => m.topic === 'leads');
    expect(leads.enabled_for_your_org).toBe(true);
    const ungated = out.modules.find((m) => m.topic === 'custom_fields');
    expect(ungated.gating).toBeNull();
    expect(ungated.enabled_for_your_org).toBeNull();
    // Platform flags are not offered as modules.
    expect(out.flags.some((f) => f.category === 'platform')).toBe(false);
  });

  test('how_do_i annotates the gating flag with the org\'s effective value and returns also_relevant when ambiguous', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    const runTool = aiRoutes._buildChatToolRunner({ orgId: ORG_ID, userId: USER_ID, orgRole: 'member' });
    const out = await runTool('how_do_i', { question: 'can I automate a report?' });
    expect(['automation_rules', 'reports']).toContain(out.capability.topic);
    expect(out.capability.enabled_for_your_org).toBe(false);
    expect(out.also_relevant).toBeDefined();
    expect(out.also_relevant.topic).not.toBe(out.capability.topic);

    const unknown = await runTool('how_do_i', { question: 'zxqv' });
    expect(unknown.capability.status).toBe('unknown');
    expect(unknown.known_topics).toContain('custom_fields');
  });
});

describe('tool schema + system prompt', () => {
  test('the five new tools are in CHAT_TOOLS with strict schemas', () => {
    const names = ai.CHAT_TOOLS.map((t) => t.name);
    for (const n of ['propose_add_custom_field', 'propose_automation_rule', 'propose_saved_view', 'propose_report', 'propose_update_pipeline', 'open_page']) {
      const tool = ai.CHAT_TOOLS.find((t) => t.name === n);
      expect(tool, n).toBeDefined();
      expect(tool.input_schema.additionalProperties).toBe(false);
    }
    expect(names.length).toBe(51); // 49 + list_extensions + propose_install_extension (extension library wave)
    expect(names[names.length - 1]).toBe('list_modules'); // prompt-cache anchor stays last
  });

  test('the system prompt teaches building + navigation and keeps the never-guess rule', () => {
    expect(ai.CHAT_SYSTEM_PROMPT).toMatch(/BUILDING THE WORKSPACE/);
    expect(ai.CHAT_SYSTEM_PROMPT).toMatch(/propose_add_custom_field/);
    expect(ai.CHAT_SYSTEM_PROMPT).toMatch(/propose_automation_rule/);
    expect(ai.CHAT_SYSTEM_PROMPT).toMatch(/open_page/);
    expect(ai.CHAT_SYSTEM_PROMPT).toMatch(/NEVER INVENT FEATURES/);
    // Stages are editable per org now (migration 155) — the prompt must
    // teach the tool, not the old "cannot be edited" disclaimer.
    expect(ai.CHAT_SYSTEM_PROMPT).toMatch(/propose_update_pipeline/);
    expect(ai.CHAT_SYSTEM_PROMPT).not.toMatch(/STAGES cannot be edited/);
  });
});
