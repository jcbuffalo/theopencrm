// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Chat control plane (Spec 200 follow-on): confirm-first write actions for
// every module + the cohort harness.
//
// Three layers, mirroring the established suites:
//   A. Pure validateAction specs (chatActions.test.js pattern — no DB).
//   B. POST /api/ai/actions/apply behaviors (aiActionsApply.test.js pattern —
//      bare-mounted aiRoutes + mocked pool, services spied at the module
//      boundary): org-scoping, flag re-checks, owner validation, cohort
//      role-gating + cap, and the email guardrail (a cohort enroll must never
//      send mail — enrollment rows only).
//   C. propose_* through the real /api/ai/chat flow (aiChatNewModules.test.js
//      pattern — stubbed Claude): proposals NEVER write; the cohort proposal
//      carries the exact affected count + sample.

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

// Set the API key BEFORE requiring services/ai so isConfigured() is true.
process.env.ANTHROPIC_API_KEY = 'test-key-for-vitest';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

// Monkey-patch the shared CJS export objects (the requireAiBilling.test.js
// pattern): aiRoutes resolves these at call time via property lookup, so the
// stubs are what run, and everything stays off the mocked pool.
const featureFlags = require('../services/featureFlags');
featureFlags.hasFeature = vi.fn();
const segments = require('../services/segments');
const sequences = require('../services/sequences');
const playbooks = require('../services/playbooks');
const emailService = require('../services/email');
const chatActions = require('../services/chatActions');
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
const ATTACKER_ORG_ID = 999;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

// A fake pg client that records its queries (BEGIN/INSERT/UPDATE/COMMIT).
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

// Content-dispatched pool stub for the apply endpoint. `orgRole` drives the
// auth row; `handlers` is an ordered [regex, rowsOrFn] list checked before the
// defaults.
function stubApplyPool({ orgRole = 'member', handlers = [] } = {}) {
  mockPool.query.mockImplementation((sql, params) => {
    const s = String(sql);
    for (const [re, rows] of handlers) {
      if (re.test(s)) {
        const out = typeof rows === 'function' ? rows(s, params) : rows;
        return Promise.resolve({ rows: out });
      }
    }
    // ownerValidationError's in-org membership probe (must come before the
    // generic auth-row match — both mention FROM users WHERE id).
    if (/SELECT id FROM users WHERE id = \$1 AND org_id = \$2/i.test(s)) {
      return Promise.resolve({ rows: [] });
    }
    if (/FROM users WHERE id/i.test(s)) {
      return Promise.resolve({ rows: [{ org_id: ORG_ID, org_role: orgRole, status: 'active' }] });
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
  featureFlags.hasFeature.mockResolvedValue(true); // modules ON by default
});

// ===========================================================================
// A. validateAction specs (pure — no DB)
// ===========================================================================
describe('chatActions.validateAction — control-plane specs', () => {
  test('meeting.create: valid input passes; ends_at before starts_at rejected', () => {
    const ok = chatActions.validateAction({
      entity: 'meeting', op: 'create',
      fields: { title: 'Kickoff', starts_at: '2026-07-20T10:00', ends_at: '2026-07-20T11:00' },
    });
    expect(ok.ok).toBe(true);
    expect(ok.action.summary).toMatch(/Kickoff/);

    const bad = chatActions.validateAction({
      entity: 'meeting', op: 'create',
      fields: { title: 'Kickoff', starts_at: '2026-07-20T11:00', ends_at: '2026-07-20T10:00' },
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(' ')).toMatch(/ends_at must be after starts_at/);
  });

  test('meeting.create: drops a smuggled non-allowlisted field', () => {
    const v = chatActions.validateAction({
      entity: 'meeting', op: 'create',
      fields: { title: 'X', starts_at: '2026-07-20', org_id: ATTACKER_ORG_ID },
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/org_id/);
  });

  test('company.set_lifecycle_stage: bad stage rejected; churned_reason only with churned', () => {
    expect(chatActions.validateAction({
      entity: 'company', op: 'set_lifecycle_stage', target_id: 3,
      fields: { lifecycle_stage: 'vaporized' },
    }).ok).toBe(false);

    const wrongReason = chatActions.validateAction({
      entity: 'company', op: 'set_lifecycle_stage', target_id: 3,
      fields: { lifecycle_stage: 'active', churned_reason: 'price' },
    });
    expect(wrongReason.ok).toBe(false);
    expect(wrongReason.errors.join(' ')).toMatch(/churned_reason/);

    expect(chatActions.validateAction({
      entity: 'company', op: 'set_lifecycle_stage', target_id: 3,
      fields: { lifecycle_stage: 'churned', churned_reason: 'price' },
    }).ok).toBe(true);
  });

  test('assign_owner specs require a target and a positive owner id', () => {
    expect(chatActions.validateAction({
      entity: 'deal', op: 'assign_owner', fields: { owner_user_id: 5 },
    }).ok).toBe(false); // no target_id
    expect(chatActions.validateAction({
      entity: 'deal', op: 'assign_owner', target_id: 9, fields: { owner_user_id: -2 },
    }).ok).toBe(false);
    expect(chatActions.validateAction({
      entity: 'lead', op: 'assign_owner', target_id: 9, fields: { owner_user_id: 5 },
    }).ok).toBe(true);
  });

  test('sequence.enroll: rejects an empty / oversized / non-integer contact_ids array', () => {
    expect(chatActions.validateAction({
      entity: 'sequence', op: 'enroll', fields: { sequence_id: 4, contact_ids: [] },
    }).ok).toBe(false);
    expect(chatActions.validateAction({
      entity: 'sequence', op: 'enroll', fields: { sequence_id: 4, contact_ids: ['1'] },
    }).ok).toBe(false);
    expect(chatActions.validateAction({
      entity: 'sequence', op: 'enroll',
      fields: { sequence_id: 4, contact_ids: Array.from({ length: 501 }, (_, i) => i + 1) },
    }).ok).toBe(false);
    expect(chatActions.validateAction({
      entity: 'sequence', op: 'enroll', fields: { sequence_id: 4, contact_ids: [1, 2] },
    }).ok).toBe(true);
  });

  test('cohort.action: requires exactly one selector and an allowlisted verb', () => {
    // No selector at all.
    expect(chatActions.validateAction({
      entity: 'cohort', op: 'action', fields: { action: 'assign_owner' },
    }).ok).toBe(false);
    // Both a saved segment AND an inline filter.
    expect(chatActions.validateAction({
      entity: 'cohort', op: 'action',
      fields: { segment_id: 1, entity_type: 'company', criteria: [{ field: 'industry', op: 'eq', value: 'x' }], action: 'assign_owner' },
    }).ok).toBe(false);
    // Unknown verb.
    expect(chatActions.validateAction({
      entity: 'cohort', op: 'action', fields: { segment_id: 1, action: 'delete_everything' },
    }).ok).toBe(false);
    // Saved segment + allowlisted verb: fine.
    expect(chatActions.validateAction({
      entity: 'cohort', op: 'action',
      fields: { segment_id: 1, action: 'set_lifecycle_stage', action_params: { lifecycle_stage: 'at_risk' } },
    }).ok).toBe(true);
  });

  test('service specs can never reach the generic table writer', async () => {
    const v = chatActions.validateAction({
      entity: 'sequence', op: 'enroll', fields: { sequence_id: 4, contact_ids: [1] },
    });
    expect(v.ok).toBe(true);
    await expect(
      chatActions.applyAction({ query: vi.fn() }, v.action, { sf: 'org_id', sv: ORG_ID, userId: USER_ID, orgId: ORG_ID })
    ).rejects.toThrow(/service action/);
  });
});

// ===========================================================================
// B. POST /api/ai/actions/apply — the lone writer
// ===========================================================================
describe('actions/apply — meeting.create', () => {
  test('creates the meeting in a txn, stamping created_by from the caller', async () => {
    const client = makeClient({ id: 9, title: 'Kickoff' });
    mockPool.connect.mockResolvedValueOnce(client);
    stubApplyPool({
      handlers: [
        [/SELECT 1 FROM deals/i, [{ '?column?': 1 }]],
      ],
    });

    const res = await postApply({
      entity: 'meeting', op: 'create',
      fields: { title: 'Kickoff', starts_at: '2026-07-20T10:00', deal_id: 5 },
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const insert = client.calls.find((s) => /INSERT INTO meetings/i.test(s));
    expect(insert).toBeDefined();
    expect(insert).toMatch(/user_id, org_id, created_by/);
    expect(client.calls.some((s) => /COMMIT/.test(s))).toBe(true);
  });

  test('a cross-org deal_id ref is rejected 404 before any txn', async () => {
    stubApplyPool({
      handlers: [
        [/SELECT 1 FROM deals/i, []], // not in the caller's org
      ],
    });

    const res = await postApply({
      entity: 'meeting', op: 'create',
      fields: { title: 'Kickoff', starts_at: '2026-07-20T10:00', deal_id: 31337 },
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found_in_org');
    expect(mockPool.connect).not.toHaveBeenCalled();
  });
});

describe('actions/apply — assign_owner', () => {
  test('happy path: scoped UPDATE of owner_user_id after in-org owner check', async () => {
    const client = makeClient({ id: 3, owner_user_id: 8 });
    mockPool.connect.mockResolvedValueOnce(client);
    stubApplyPool({
      handlers: [
        [/SELECT 1 FROM companies/i, [{ '?column?': 1 }]],
        [/SELECT id FROM users WHERE id = \$1 AND org_id = \$2/i, [{ id: 8 }]],
      ],
    });

    const res = await postApply({
      entity: 'company', op: 'assign_owner', target_id: 3, fields: { owner_user_id: 8 },
    });

    expect(res.status).toBe(200);
    const update = client.calls.find((s) => /UPDATE companies SET owner_user_id/i.test(s));
    expect(update).toBeDefined();
    expect(update).toMatch(/org_id = \$3/);
  });

  test('an owner outside the caller org is rejected 400, no write', async () => {
    stubApplyPool({
      handlers: [
        [/SELECT 1 FROM companies/i, [{ '?column?': 1 }]],
        // users membership probe -> empty (foreign user id)
        [/SELECT id FROM users WHERE id = \$1 AND org_id = \$2/i, []],
      ],
    });

    const res = await postApply({
      entity: 'company', op: 'assign_owner', target_id: 3, fields: { owner_user_id: 777 },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_owner');
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  test('lead.assign_owner re-checks leads_enabled at apply time', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    stubApplyPool({});

    const res = await postApply({
      entity: 'lead', op: 'assign_owner', target_id: 3, fields: { owner_user_id: 8 },
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
    expect(featureFlags.hasFeature).toHaveBeenCalledWith(ORG_ID, 'leads_enabled');
    expect(mockPool.connect).not.toHaveBeenCalled();
  });
});

describe('actions/apply — company.set_lifecycle_stage', () => {
  test('runs the churn-aware UPDATE then fires playbooks post-commit (best-effort)', async () => {
    const client = makeClient({ id: 3, lifecycle_stage: 'at_risk' });
    mockPool.connect.mockResolvedValueOnce(client);
    const pbSpy = vi.spyOn(playbooks, 'runPlaybooksForStageChange').mockResolvedValue({ fired: [] });
    stubApplyPool({
      handlers: [
        [/SELECT 1 FROM companies/i, [{ '?column?': 1 }]],
      ],
    });

    const res = await postApply({
      entity: 'company', op: 'set_lifecycle_stage', target_id: 3,
      fields: { lifecycle_stage: 'at_risk' },
    });

    expect(res.status).toBe(200);
    expect(featureFlags.hasFeature).toHaveBeenCalledWith(ORG_ID, 'customer_success_enabled');
    const update = client.calls.find((s) => /UPDATE companies SET lifecycle_stage/i.test(s));
    expect(update).toBeDefined();
    expect(update).toMatch(/churned_at/);
    expect(pbSpy).toHaveBeenCalledWith(expect.objectContaining({
      orgScopeField: 'org_id', orgScopeValue: ORG_ID, companyId: 3, newStage: 'at_risk', userId: USER_ID,
    }));
    pbSpy.mockRestore();
  });
});

describe('actions/apply — sequence.enroll (service action)', () => {
  test('routes to sequences.enroll after per-contact org checks; NEVER sends mail', async () => {
    const enrollSpy = vi.spyOn(sequences, 'enroll').mockResolvedValue({ enrolled: 2, skipped: 0 });
    const mailSpy = vi.spyOn(emailService, 'sendMail');
    stubApplyPool({
      handlers: [
        [/SELECT 1 FROM sequences/i, [{ '?column?': 1 }]],
        [/SELECT 1 FROM contacts/i, [{ '?column?': 1 }]],
      ],
    });

    const res = await postApply({
      entity: 'sequence', op: 'enroll', fields: { sequence_id: 4, contact_ids: [1, 2] },
    });

    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual({ enrolled: 2, skipped: 0 });
    expect(featureFlags.hasFeature).toHaveBeenCalledWith(ORG_ID, 'campaigns_enabled');
    expect(enrollSpy).toHaveBeenCalledWith({ orgId: ORG_ID, userId: USER_ID }, 4, [1, 2]);
    // EMAIL GUARDRAIL: enrollment writes rows only. No transport is touched.
    expect(mailSpy).not.toHaveBeenCalled();
    enrollSpy.mockRestore();
    mailSpy.mockRestore();
  });

  test('a single smuggled cross-org contact id rejects the whole apply', async () => {
    const enrollSpy = vi.spyOn(sequences, 'enroll');
    let contactCalls = 0;
    stubApplyPool({
      handlers: [
        [/SELECT 1 FROM sequences/i, [{ '?column?': 1 }]],
        [/SELECT 1 FROM contacts/i, () => (++contactCalls === 1 ? [{ '?column?': 1 }] : [])],
      ],
    });

    const res = await postApply({
      entity: 'sequence', op: 'enroll', fields: { sequence_id: 4, contact_ids: [1, 31337] },
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found_in_org');
    expect(enrollSpy).not.toHaveBeenCalled();
    enrollSpy.mockRestore();
  });

  test('campaigns_enabled off -> 403, enroll never called', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    const enrollSpy = vi.spyOn(sequences, 'enroll');
    stubApplyPool({});

    const res = await postApply({
      entity: 'sequence', op: 'enroll', fields: { sequence_id: 4, contact_ids: [1] },
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
    expect(enrollSpy).not.toHaveBeenCalled();
    enrollSpy.mockRestore();
  });
});

describe('actions/apply — playbook.run (service action)', () => {
  test('routes to playbooks.runPlaybookForCompany, org-scoped', async () => {
    const spy = vi.spyOn(playbooks, 'runPlaybookForCompany').mockResolvedValue({
      playbook_id: 2, name: 'Onboarding', tasks_created: 4, already_ran: false,
    });
    stubApplyPool({
      handlers: [
        [/SELECT 1 FROM playbooks/i, [{ '?column?': 1 }]],
        [/SELECT 1 FROM companies/i, [{ '?column?': 1 }]],
      ],
    });

    const res = await postApply({
      entity: 'playbook', op: 'run', fields: { playbook_id: 2, company_id: 3 },
    });

    expect(res.status).toBe(200);
    expect(res.body.applied.tasks_created).toBe(4);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      orgScopeField: 'org_id', orgScopeValue: ORG_ID, playbookId: 2, companyId: 3, userId: USER_ID,
    }));
    spy.mockRestore();
  });
});

describe('actions/apply — cohort.action (the harness)', () => {
  const inlineCompanyCohort = {
    entity: 'cohort', op: 'action',
    fields: {
      entity_type: 'company',
      criteria: [{ field: 'lifecycle_stage', op: 'eq', value: 'active' }],
      action: 'set_lifecycle_stage',
      action_params: { lifecycle_stage: 'at_risk' },
    },
  };

  test('org member (non-admin) -> 403, nothing executed', async () => {
    const bulkSpy = vi.spyOn(segments, 'runBulkAction');
    stubApplyPool({ orgRole: 'member' });

    const res = await postApply(inlineCompanyCohort);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner\/admin/);
    expect(bulkSpy).not.toHaveBeenCalled();
    bulkSpy.mockRestore();
  });

  test('admin apply: executes via segments.runBulkAction (membership re-evaluated there)', async () => {
    const bulkSpy = vi.spyOn(segments, 'runBulkAction').mockResolvedValue({ affected: 12 });
    stubApplyPool({ orgRole: 'admin' });

    const res = await postApply(inlineCompanyCohort);

    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual({ action: 'set_lifecycle_stage', affected: 12 });
    expect(bulkSpy).toHaveBeenCalledWith(
      expect.objectContaining({ scopeField: 'org_id', scopeValue: ORG_ID, userId: USER_ID, orgId: ORG_ID }),
      expect.objectContaining({ entity_type: 'company' }),
      'set_lifecycle_stage',
      { lifecycle_stage: 'at_risk' }
    );
    // Audit trail: ai.action_applied with the affected count.
    const auditCall = mockPool.query.mock.calls.find(
      ([sql, params]) => /INSERT INTO audit_log/i.test(String(sql)) && Array.isArray(params) && params.includes('ai.action_applied')
    );
    expect(auditCall).toBeDefined();
    bulkSpy.mockRestore();
  });

  test('a saved segment is re-resolved org-scoped at apply time; foreign id -> 404', async () => {
    const bulkSpy = vi.spyOn(segments, 'runBulkAction');
    stubApplyPool({
      orgRole: 'owner',
      handlers: [
        [/FROM segments WHERE id/i, []], // not in this org
      ],
    });

    const res = await postApply({
      entity: 'cohort', op: 'action',
      fields: { segment_id: 31337, action: 'assign_owner', action_params: { owner_id: 8 } },
    });

    expect(res.status).toBe(404);
    expect(bulkSpy).not.toHaveBeenCalled();
    bulkSpy.mockRestore();
  });

  test('cohort enroll_in_sequence: batches through sequences.enroll; email stays untouched', async () => {
    const countSpy = vi.spyOn(segments, 'count').mockResolvedValue(3);
    const idsSpy = vi.spyOn(segments, 'memberIds').mockResolvedValue([11, 12, 13]);
    const enrollSpy = vi.spyOn(sequences, 'enroll').mockResolvedValue({ enrolled: 3, skipped: 0 });
    const mailSpy = vi.spyOn(emailService, 'sendMail');
    stubApplyPool({
      orgRole: 'admin',
      handlers: [
        [/SELECT 1 FROM sequences/i, [{ '?column?': 1 }]],
      ],
    });

    const res = await postApply({
      entity: 'cohort', op: 'action',
      fields: {
        entity_type: 'contact',
        criteria: [{ field: 'title', op: 'ilike', value: 'vp' }],
        action: 'enroll_in_sequence',
        action_params: { sequence_id: 4 },
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual({ action: 'enroll_in_sequence', affected: 3, skipped: 0 });
    expect(enrollSpy).toHaveBeenCalledWith({ orgId: ORG_ID, userId: USER_ID }, 4, [11, 12, 13]);
    // EMAIL GUARDRAIL: a cohort enroll creates enrollments only — no send path
    // is reachable from the apply endpoint, configured transport or not.
    expect(mailSpy).not.toHaveBeenCalled();
    countSpy.mockRestore(); idsSpy.mockRestore(); enrollSpy.mockRestore(); mailSpy.mockRestore();
  });

  test('cohort enroll over MAX_BULK_AFFECTED is refused 400 before any enrollment', async () => {
    const countSpy = vi.spyOn(segments, 'count').mockResolvedValue(segments.MAX_BULK_AFFECTED + 1);
    const enrollSpy = vi.spyOn(sequences, 'enroll');
    stubApplyPool({
      orgRole: 'admin',
      handlers: [
        [/SELECT 1 FROM sequences/i, [{ '?column?': 1 }]],
      ],
    });

    const res = await postApply({
      entity: 'cohort', op: 'action',
      fields: {
        entity_type: 'contact',
        criteria: [{ field: 'title', op: 'ilike', value: 'vp' }],
        action: 'enroll_in_sequence',
        action_params: { sequence_id: 4 },
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(new RegExp(`over the ${segments.MAX_BULK_AFFECTED} limit`));
    expect(enrollSpy).not.toHaveBeenCalled();
    countSpy.mockRestore(); enrollSpy.mockRestore();
  });

  test('customer_success_enabled off -> 403 before any cohort work', async () => {
    featureFlags.hasFeature.mockResolvedValue(false);
    const bulkSpy = vi.spyOn(segments, 'runBulkAction');
    stubApplyPool({ orgRole: 'owner' });

    const res = await postApply(inlineCompanyCohort);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
    expect(bulkSpy).not.toHaveBeenCalled();
    bulkSpy.mockRestore();
  });
});

// ===========================================================================
// C. propose_* through the real /api/ai/chat flow — proposals NEVER write
// ===========================================================================
describe('propose_* via /api/ai/chat', () => {
  let originalFetch;

  function fakeResponse(body, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  }

  function stubClaudeWithToolCall(toolName, toolInput) {
    const responses = [
      {
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_cp', name: toolName, input: toolInput }],
      },
      {
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Proposed — click Apply to confirm.' }],
      },
    ];
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(fakeResponse(responses.shift()))
    );
  }

  function stubChatFlow({ orgRole = 'member' } = {}) {
    mockPool.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/FROM users WHERE id/i.test(s)) {
        return Promise.resolve({ rows: [{ org_id: ORG_ID, org_role: orgRole, status: 'active' }] });
      }
      if (/COUNT\(\*\)::int AS c/i.test(s)) return Promise.resolve({ rows: [{ c: 0 }] }); // daily cap
      if (/INSERT INTO chat_sessions/i.test(s)) return Promise.resolve({ rows: [{ id: 'sess-cp' }] });
      return Promise.resolve({ rows: [] });
    });
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function postChat(message) {
    return request(buildApp())
      .post('/api/ai/chat')
      .set('Cookie', authCookie())
      .send({ message });
  }

  test('propose_create_meeting returns an apply_action chip and writes NOTHING', async () => {
    stubClaudeWithToolCall('propose_create_meeting', { title: 'Kickoff', starts_at: '2026-07-20T10:00' });
    stubChatFlow();

    const res = await postChat('book a kickoff meeting Monday 10am');
    expect(res.status).toBe(200);

    const chip = (res.body.actions || []).find((a) => a.kind === 'apply_action');
    expect(chip).toBeDefined();
    expect(chip.proposal.entity).toBe('meeting');
    expect(chip.proposal.summary).toMatch(/Kickoff/);

    // NO write of any kind was issued (pool or txn client).
    expect(mockPool.connect).not.toHaveBeenCalled();
    const wrote = mockPool.query.mock.calls.some(
      ([sql]) => /INSERT INTO meetings|UPDATE meetings/i.test(String(sql))
    );
    expect(wrote).toBe(false);
  });

  test('propose_cohort_action shows the exact count + sample and writes NOTHING', async () => {
    const countSpy = vi.spyOn(segments, 'count').mockResolvedValue(37);
    const evalSpy = vi.spyOn(segments, 'evaluate').mockResolvedValue([
      { id: 1, name: 'Acme' }, { id: 2, name: 'Beta' },
    ]);
    const bulkSpy = vi.spyOn(segments, 'runBulkAction');

    stubClaudeWithToolCall('propose_cohort_action', {
      entity_type: 'company',
      criteria: [{ field: 'last_touch_older_than_days', op: 'gt', value: 90 }],
      action: 'set_lifecycle_stage',
      action_params: { lifecycle_stage: 'at_risk' },
    });
    stubChatFlow({ orgRole: 'owner' });

    const res = await postChat('mark every account untouched for 90 days at-risk');
    expect(res.status).toBe(200);

    const chip = (res.body.actions || []).find((a) => a.kind === 'apply_action');
    expect(chip).toBeDefined();
    expect(chip.proposal.entity).toBe('cohort');
    expect(chip.proposal.fields.expected_count).toBe(37);
    expect(chip.proposal.summary).toMatch(/37 current members/);

    // The count/sample came from the segments evaluator — and nothing wrote.
    expect(countSpy).toHaveBeenCalled();
    expect(evalSpy).toHaveBeenCalled();
    expect(bulkSpy).not.toHaveBeenCalled();
    const wrote = mockPool.query.mock.calls.some(
      ([sql]) => /UPDATE companies|INSERT INTO tasks|INSERT INTO cases/i.test(String(sql))
    );
    expect(wrote).toBe(false);

    countSpy.mockRestore(); evalSpy.mockRestore(); bulkSpy.mockRestore();
  });

  test('propose_cohort_action is refused for a non-admin org member', async () => {
    const countSpy = vi.spyOn(segments, 'count');
    stubClaudeWithToolCall('propose_cohort_action', {
      entity_type: 'company',
      criteria: [{ field: 'lifecycle_stage', op: 'eq', value: 'active' }],
      action: 'set_lifecycle_stage',
      action_params: { lifecycle_stage: 'at_risk' },
    });
    stubChatFlow({ orgRole: 'member' });

    const res = await postChat('bulk update everything');
    expect(res.status).toBe(200); // the copilot relays the refusal as prose

    // No proposal chip was minted and the cohort was never even counted.
    const chip = (res.body.actions || []).find((a) => a.kind === 'apply_action');
    expect(chip).toBeUndefined();
    expect(countSpy).not.toHaveBeenCalled();
    countSpy.mockRestore();
  });
});
