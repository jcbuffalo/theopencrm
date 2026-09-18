// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Automation rules on custom date fields (CMN_REQUIREMENTS.md §1.3).
//
// The custom_date_offset trigger: "N days before/after <date custom field> on
// <entity>, create a task and/or notify the record owner." Values live in each
// entity's custom_fields JSONB store (migration 070); definitions in
// org_field_definitions.
//
// Suites:
//   1. The evaluator scan — org-scoped, JOINs the field definition (type must
//      still be 'date'), string-compares the date against the offset boundary
//      (dueMax/dueMin params), and dedupes per record × rule × DATE via the
//      automation_runs.meta->>'trigger_date' anti-join.
//   2. Actions — create_task (template substitution + due date + record
//      linkage + owner routing), notify (in-app row for companies/contacts),
//      create_task_and_notify (both).
//   3. Schema validation — bad entity / non-integer offset / missing title /
//      create_task_and_notify outside the date rule are all rejected.
//   4. Route validation — a rule naming a non-date (or missing) custom field
//      is rejected with 400 by POST /automation-rules.
//
// Pool fully mocked with a SQL-routing implementation, mirroring
// automationUserRules.test.js. describe/test/expect/beforeEach/vi are vitest
// globals.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/logger', () => ({
  info:   vi.fn(),
  warn:   vi.fn(),
  error:  vi.fn(),
  notice: vi.fn(),
  debug:  vi.fn(),
}));

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const automation = require('../services/automation');
const notifications = require('../services/notifications');
const ruleSchemas = require('../schemas/automationRules');
const automationRuleRoutes = require('../routes/automationRuleRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const ORG_ID = 7;
const USER_ID = 4242;

// Same UTC date math the engine uses, so boundary expectations line up.
function ymdUTC(d) { return d.toISOString().slice(0, 10); }
function addDaysUTC(base, days) {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function dateRule(overrides = {}) {
  return {
    id: 51,
    org_id: ORG_ID,
    name: 'Permit expiry heads-up',
    trigger: 'custom_date_offset',
    conditions: { entity: 'deals', field_name: 'permit_expiry', offset_days: -7 },
    action: { type: 'create_task', title: 'Renew permit for {name} ({field} = {date})', priority: 'high' },
    enabled: true,
    created_by: 12,
    ...overrides,
  };
}

// SQL-routing mock: captures every call, serves the scan rows, and records the
// side-effect writes.
function installRoutingMock({ scanRows = [] } = {}) {
  const captured = { sql: [], params: [], taskInserts: [], recordedRuns: [] };
  mockPool.query.mockImplementation((text, params) => {
    captured.sql.push(text);
    captured.params.push(params);
    if (/INSERT INTO automation_runs/i.test(text)) {
      captured.recordedRuns.push({ text, params });
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (/INSERT INTO tasks/i.test(text)) {
      captured.taskInserts.push({ text, params });
      return Promise.resolve({ rows: [{ id: 5000 }], rowCount: 1 });
    }
    if (/JOIN org_field_definitions/i.test(text)) {
      return Promise.resolve({ rows: scanRows, rowCount: scanRows.length });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  return captured;
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. The evaluator scan.
// ---------------------------------------------------------------------------
describe('custom_date_offset scan', () => {
  test('scan is org-scoped, joins the date field definition, and dedupes per record × rule × date', async () => {
    const captured = installRoutingMock({ scanRows: [] });
    const out = await automation.evaluateUserRule(dateRule());

    expect(out.ok).toBe(true);
    expect(out.fired).toBe(0);

    const scanSql = captured.sql.find(s => /JOIN org_field_definitions/i.test(s));
    expect(scanSql).toBeTruthy();
    expect(scanSql).toMatch(/FROM deals r/);
    expect(scanSql).toMatch(/fd\.entity = 'deals'/);
    expect(scanSql).toMatch(/fd\.type = 'date'/);
    expect(scanSql).toMatch(/r\.org_id = \$1/);
    // Per record × rule × DATE dedupe: the anti-join compares the recorded
    // trigger_date against the record's CURRENT field value.
    expect(scanSql).toMatch(/ar\.meta->>'trigger_date' = \(r\.custom_fields->>\$2\)/);
    expect(scanSql).toMatch(/ar\.rule = \$5/);
  });

  test('date-offset boundary: offset -7 means the scan threshold is today+7 (with a 30-day catch-up window)', async () => {
    const captured = installRoutingMock({ scanRows: [] });
    const before = new Date();
    await automation.evaluateUserRule(dateRule());
    const after = new Date();

    const idx = captured.sql.findIndex(s => /JOIN org_field_definitions/i.test(s));
    const params = captured.params[idx];
    // [orgId, fieldName, dueMax, dueMin, dedupeKey]
    expect(params[0]).toBe(ORG_ID);
    expect(params[1]).toBe('permit_expiry');
    // fires once today >= field_date - 7 ⇔ field_date <= today + 7
    const dueMaxCandidates = [ymdUTC(addDaysUTC(before, 7)), ymdUTC(addDaysUTC(after, 7))];
    expect(dueMaxCandidates).toContain(params[2]);
    const dueMinCandidates = [ymdUTC(addDaysUTC(before, 7 - 30)), ymdUTC(addDaysUTC(after, 7 - 30))];
    expect(dueMinCandidates).toContain(params[3]);
    expect(params[4]).toBe('user_rule:51');
  });

  test('positive offset (after the date) flips the boundary sign', async () => {
    const captured = installRoutingMock({ scanRows: [] });
    const before = new Date();
    await automation.evaluateUserRule(dateRule({
      conditions: { entity: 'companies', field_name: 'contract_end', offset_days: 14 },
    }));

    const idx = captured.sql.findIndex(s => /JOIN org_field_definitions/i.test(s));
    expect(captured.sql[idx]).toMatch(/FROM companies r/);
    // fires once today >= field_date + 14 ⇔ field_date <= today - 14
    expect([ymdUTC(addDaysUTC(before, -14)), ymdUTC(addDaysUTC(new Date(), -14))])
      .toContain(captured.params[idx][2]);
  });

  test('a malformed stored rule (bad entity) is skipped as invalid, not evaluated', async () => {
    const captured = installRoutingMock({ scanRows: [] });
    const out = await automation.evaluateUserRule(dateRule({
      conditions: { entity: 'quotes', field_name: 'x', offset_days: 1 },
    }));
    expect(out.ok).toBe(false);
    expect(out.skipped).toBe('invalid');
    expect(captured.sql.some(s => /JOIN org_field_definitions/i.test(s))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Actions.
// ---------------------------------------------------------------------------
describe('custom_date_offset actions', () => {
  const dealTarget = {
    id: 301, org_id: ORG_ID, user_id: 9, owner_user_id: 14,
    record_name: 'Main St site', field_date: '2026-10-01',
  };

  test('create_task fires once per match: templated title, due on the field date, linked to the deal, owned by the record owner', async () => {
    const captured = installRoutingMock({ scanRows: [dealTarget] });
    const out = await automation.evaluateUserRule(dateRule());

    expect(out.fired).toBe(1);
    expect(captured.taskInserts).toHaveLength(1);
    const task = captured.taskInserts[0];
    // createTaskForOrg: [user, org, contact, deal, company, title, description, due, priority]
    expect(task.params[0]).toBe(14);                 // owner_user_id preferred over user_id
    expect(task.params[1]).toBe(ORG_ID);
    expect(task.params[2]).toBe(null);               // contact_id
    expect(task.params[3]).toBe(301);                // deal_id
    expect(task.params[4]).toBe(null);               // company_id
    expect(task.params[5]).toBe('Renew permit for Main St site (permit_expiry = 2026-10-01)');
    expect(task.params[7]).toBe('2026-10-01');       // due_date = the field's date
    expect(task.params[8]).toBe('high');

    // The run is recorded with the trigger_date the dedupe anti-join matches on.
    expect(captured.recordedRuns).toHaveLength(1);
    const runMeta = JSON.parse(captured.recordedRuns[0].params[5]);
    expect(runMeta.trigger_date).toBe('2026-10-01');
    expect(captured.recordedRuns[0].params[1]).toBe('user_rule:51');
    expect(captured.recordedRuns[0].params[2]).toBe('deal');
    expect(captured.recordedRuns[0].params[3]).toBe(301);
  });

  test('a later tick where the scan excludes the fired record writes nothing (dedupe)', async () => {
    const captured = installRoutingMock({ scanRows: [] });
    const out = await automation.evaluateUserRule(dateRule());
    expect(out.fired).toBe(0);
    expect(captured.taskInserts).toHaveLength(0);
    expect(captured.recordedRuns).toHaveLength(0);
  });

  test('notify on a company match creates an in-app notification for the record owner', async () => {
    const createSpy = vi.spyOn(notifications, 'create').mockResolvedValue({ id: 1 });
    const captured = installRoutingMock({
      scanRows: [{ id: 88, org_id: ORG_ID, user_id: 9, owner_user_id: 21, record_name: 'Acme', field_date: '2026-09-20' }],
    });

    const out = await automation.evaluateUserRule(dateRule({
      conditions: { entity: 'companies', field_name: 'contract_end', offset_days: -30 },
      action: { type: 'notify' },
    }));

    expect(out.fired).toBe(1);
    expect(captured.taskInserts).toHaveLength(0);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      orgScope: ['org_id', ORG_ID],
      userId: 21,
      entityType: 'company',
      entityId: 88,
      body: 'contract_end = 2026-09-20',
    }));
  });

  test('create_task_and_notify does both, and a contact match links contact_id + falls back to the record creator', async () => {
    const createSpy = vi.spyOn(notifications, 'create').mockResolvedValue({ id: 2 });
    const captured = installRoutingMock({
      scanRows: [{ id: 61, org_id: ORG_ID, user_id: 33, owner_user_id: null, record_name: 'Jo Farmer', field_date: '2026-09-10' }],
    });

    const out = await automation.evaluateUserRule(dateRule({
      conditions: { entity: 'contacts', field_name: 'cert_expiry', offset_days: -14 },
      action: { type: 'create_task_and_notify', title: 'Recertify {name} by {date}' },
    }));

    expect(out.fired).toBe(1);
    expect(captured.taskInserts).toHaveLength(1);
    const task = captured.taskInserts[0];
    expect(task.params[0]).toBe(33);   // contacts have no owner column — creator owns the task
    expect(task.params[2]).toBe(61);   // contact_id
    expect(task.params[3]).toBe(null); // deal_id
    expect(task.params[5]).toBe('Recertify Jo Farmer by 2026-09-10');
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ userId: 33, entityType: 'contact', entityId: 61 }));
  });

  test('a notify failure is swallowed and the run is still recorded (no re-notify every tick)', async () => {
    vi.spyOn(notifications, 'create').mockRejectedValue(new Error('inbox on fire'));
    const captured = installRoutingMock({
      scanRows: [{ id: 88, org_id: ORG_ID, user_id: 9, owner_user_id: 21, record_name: 'Acme', field_date: '2026-09-20' }],
    });

    const out = await automation.evaluateUserRule(dateRule({
      conditions: { entity: 'companies', field_name: 'contract_end', offset_days: 0 },
      action: { type: 'notify' },
    }));

    expect(out.fired).toBe(1);
    expect(captured.recordedRuns).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Schema validation.
// ---------------------------------------------------------------------------
describe('custom_date_offset schema validation', () => {
  const base = {
    name: 'r', trigger: 'custom_date_offset',
    conditions: { entity: 'deals', field_name: 'permit_expiry', offset_days: -7 },
    action: { type: 'create_task', title: 't' },
  };

  test('accepts a well-formed rule (negative and positive offsets)', () => {
    expect(ruleSchemas.createSchema.safeParse(base).success).toBe(true);
    expect(ruleSchemas.createSchema.safeParse({
      ...base, conditions: { ...base.conditions, offset_days: 30 },
      action: { type: 'create_task_and_notify', title: 't' },
    }).success).toBe(true);
  });

  test('rejects an unsupported entity', () => {
    const r = ruleSchemas.createSchema.safeParse({ ...base, conditions: { ...base.conditions, entity: 'quotes' } });
    expect(r.success).toBe(false);
  });

  test('rejects a non-integer / out-of-range offset', () => {
    expect(ruleSchemas.createSchema.safeParse({ ...base, conditions: { ...base.conditions, offset_days: 1.5 } }).success).toBe(false);
    expect(ruleSchemas.createSchema.safeParse({ ...base, conditions: { ...base.conditions, offset_days: -99999 } }).success).toBe(false);
  });

  test('rejects a missing field_name and a missing task title', () => {
    expect(ruleSchemas.createSchema.safeParse({ ...base, conditions: { entity: 'deals', offset_days: 1 } }).success).toBe(false);
    expect(ruleSchemas.createSchema.safeParse({ ...base, action: { type: 'create_task_and_notify' } }).success).toBe(false);
  });

  test('create_task_and_notify is date-rule-only', () => {
    const r = ruleSchemas.createSchema.safeParse({
      name: 'r', trigger: 'deal_stage_is', conditions: { stage: 'closed_won' },
      action: { type: 'create_task_and_notify', title: 't' },
    });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Route validation — the field must be a real date custom field.
// ---------------------------------------------------------------------------
describe('POST /automation-rules field-kind validation', () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(cookieParser(process.env.COOKIE_SECRET));
    app.use('/automation-rules', automationRuleRoutes);
    return app;
  }
  function authCookie() { return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`]; }
  function authAs(role) {
    mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: role, status: 'active' }] });
  }
  const body = {
    name: 'Permit alert', trigger: 'custom_date_offset',
    conditions: { entity: 'deals', field_name: 'permit_expiry', offset_days: -7 },
    action: { type: 'create_task', title: 'Renew {name}' },
  };

  test('rejects a field of the wrong kind with 400', async () => {
    authAs('owner');
    mockPool.query.mockResolvedValueOnce({ rows: [{ type: 'text' }] }); // org_field_definitions lookup

    const res = await request(buildApp())
      .post('/automation-rules')
      .set('Cookie', authCookie())
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/type "text".*need a date field/);
    // Nothing was inserted.
    expect(mockPool.query.mock.calls.some(c => /INSERT INTO automation_rules/i.test(c[0]))).toBe(false);
  });

  test('rejects a field that does not exist with 400', async () => {
    authAs('owner');
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .post('/automation-rules')
      .set('Cookie', authCookie())
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No custom field named "permit_expiry"/);
  });

  test('accepts and inserts when the field is a date field', async () => {
    authAs('owner');
    mockPool.query.mockResolvedValueOnce({ rows: [{ type: 'date' }] });
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 1, org_id: ORG_ID, ...body, enabled: true, created_by: USER_ID, created_at: 'now' }],
    });

    const res = await request(buildApp())
      .post('/automation-rules')
      .set('Cookie', authCookie())
      .send(body);

    expect(res.status).toBe(201);
    const insert = mockPool.query.mock.calls.find(c => /INSERT INTO automation_rules/i.test(c[0]));
    expect(insert).toBeTruthy();
    expect(insert[1][2]).toBe('custom_date_offset');
  });
});
