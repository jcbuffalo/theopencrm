// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Deep verification of EVERY curated plugin-library entry. The bar the
// library promises is "one click → working extension", so for each entry we
// check the full chain:
//
//   1. Catalog integrity — slugs unique, required display fields present,
//      spec.name === slug, trigger event recognized.
//   2. Validation — the exact projection cloneTemplateForOrg builds passes
//      pluginSpecValidator.validateSpec.
//   3. Install — POST /api/plugins/from-template inserts a plugin row whose
//      source_code / trigger_event params match the template.
//   4. Execution — every runnable source_code executes without throwing in a
//      harness that mirrors the sandbox wrapper (module.exports.run({crm,
//      input})) against the REAL pluginSdk context (dryRun / confirm-first)
//      over a stubbed pg pool, twice: with a representative trigger payload
//      and with input=null (manual test run). Budgets must hold (≤50 queries,
//      ≤10 createTask) even against a generously sized fixture org.
//
// vitest globals.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const featureFlags = require('../services/featureFlags');
featureFlags.hasFeature = vi.fn().mockResolvedValue(true);

const audit = require('../services/audit');
audit.record  = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

const logger = require('../services/logger');
logger.info  = vi.fn();
logger.warn  = vi.fn();
logger.error = vi.fn();
logger.notice = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const pluginRoutes = require('../routes/pluginRoutes');
const pluginLibrary = require('../services/pluginLibrary');
const pluginSdk = require('../services/pluginSdk');
const {
  validateSpec,
  TRIGGER_EVENTS,
  ACTION_KINDS,
  SDK_METHOD_ALLOWLIST,
} = require('../services/pluginSpecValidator');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const USER_ID = 4242;
const ORG_ID = 99;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/plugins', pluginRoutes);
  return app;
}

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function queueAuthRow() {
  mockPool.query.mockResolvedValueOnce({
    rows: [{ org_id: ORG_ID, org_role: 'admin', status: 'active' }],
  });
}

// Same projection cloneTemplateForOrg builds before validating + inserting.
function projectForValidation(entry) {
  return {
    name:          entry.spec.name,
    description:   entry.summary,
    trigger_event: entry.spec.triggerEvent,
    source_kind:   'library',
    spec_json: {
      summary:       entry.spec.summary || entry.summary,
      triggerEvent:  entry.spec.triggerEvent,
      triggerFilter: entry.spec.triggerFilter || null,
      actions:       Array.isArray(entry.spec.actions) ? entry.spec.actions : [],
    },
    source_code: entry.spec.source_code ||
      '// Library template — actions are declarative.\n// Tell the copilot what to change to convert this into runnable code.',
  };
}

// ---------------------------------------------------------------------------
// Fixture org — sized to stress the run budgets. 60 deals / 40 contacts /
// 25 companies / 35 tasks, with deliberate data problems (dupes, missing
// fields, stale activity) so every entry's interesting branch executes.
// ---------------------------------------------------------------------------

const DAY = 86400000;
function daysAgoIso(n) { return new Date(Date.now() - n * DAY).toISOString(); }
function daysAgoDate(n) { return daysAgoIso(n).slice(0, 10); }

const STAGES = ['LEAD', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST'];
const now = new Date();
const prevMonthMid = new Date(now.getFullYear(), now.getMonth() - 1, 15).toISOString().slice(0, 10);

const DEALS = Array.from({ length: 60 }, (_, i) => {
  const id = i + 1;
  const stage = STAGES[i % STAGES.length];
  const dupTitle = i % 7 === 0; // several same-title-same-company pairs
  return {
    id,
    title: dupTitle ? 'Acme Renewal' : `Deal ${id}`,
    stage,
    phase: 'pre_sale',
    amount: i % 5 === 0 ? null : (i % 9 === 0 ? 0 : 1000 * (id + 3)),
    probability: i % 3 === 0 ? null : (i % 3 === 1 ? 0.6 : 60),
    expected_close_date:
      i % 11 === 0 ? null
        : i % 6 === 0 ? daysAgoDate(310)           // renewal window
        : stage === 'CLOSED_WON' && i % 4 === 0 ? prevMonthMid // month-end recap
        : i % 2 === 0 ? daysAgoDate(-7)            // closes soon
        : daysAgoDate(30),
    hot_flag: i % 8 === 0,
    owner_id: (i % 3) + 1,
    status: stage.startsWith('CLOSED') ? 'closed' : 'open',
    contact_id: i % 4 === 0 ? null : (i % 10) + 1,
    company_id: i % 6 === 0 ? null : (i % 8) + 1,
    customer_id: null,
    vendor_id: null,
    last_activity_at: i % 2 === 0 ? daysAgoIso(60) : daysAgoIso(0),
    created_at: i % 12 === 0 ? daysAgoIso(0) : daysAgoIso(90),
    updated_at: i % 2 === 0 ? daysAgoIso(45) : daysAgoIso(0),
  };
});

const CONTACTS = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1,
  first_name: `First${i + 1}`,
  last_name: `Last${i + 1}`,
  email: i % 3 === 0 ? null : `person${i + 1}@example.com`,
  phone: i % 4 === 0 ? null : '555-0100',
  job_title: 'Buyer',
  company_id: i % 5 === 0 ? null : (i % 8) + 1,
  owner_id: (i % 3) + 1,
  status: 'active',
  created_at: i % 10 === 0 ? daysAgoIso(0) : daysAgoIso(120),
  updated_at: daysAgoIso(1),
}));

const COMPANIES = Array.from({ length: 25 }, (_, i) => ({
  id: i + 1,
  name: `Company ${i + 1}`,
  industry: i % 3 === 0 ? null : 'Manufacturing',
  website: i % 4 === 0 ? null : `https://company${i + 1}.example.com`,
  type: 'customer',
  status: 'active',
  owner_id: (i % 3) + 1,
  created_at: i % 9 === 0 ? daysAgoIso(0) : daysAgoIso(200),
  updated_at: daysAgoIso(2),
}));

const TASKS = Array.from({ length: 35 }, (_, i) => ({
  id: i + 1,
  title: `Task ${i + 1}`,
  description: null,
  status: i % 4 === 0 ? 'completed' : 'open',
  priority: ['low', 'medium', 'high', 'urgent'][i % 4],
  due_date: i % 5 === 0 ? null : (i % 3 === 0 ? daysAgoDate(2) : daysAgoDate(0)),
  assigned_to: i % 3 === 0 ? null : (i % 2) + 1,
  contact_id: i % 6 === 0 ? null : (i % 10) + 1,
  deal_id: i % 2 === 0 ? (i % 12) + 1 : null,
  created_at: daysAgoIso(10),
  updated_at: i % 4 === 0 ? daysAgoIso(0) : daysAgoIso(3), // completed-today rows exist
}));

const DEAL_BY_ID = {
  id: 3, title: 'Acme Expansion', stage: 'CLOSED_WON', phase: 'pre_sale',
  amount: 60000, probability: 0.7, expected_close_date: daysAgoDate(1),
  hot_flag: false, owner_id: 1, status: 'open', contact_id: 17, company_id: 2,
  customer_id: null, vendor_id: null,
  last_activity_at: daysAgoIso(1), created_at: daysAgoIso(5), updated_at: daysAgoIso(0),
};
const CONTACT_BY_ID = {
  id: 17, first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com',
  phone: '555-0100', job_title: 'VP Ops', company_id: 2, owner_id: 1,
  status: 'active', created_at: daysAgoIso(30), updated_at: daysAgoIso(1),
};
const COMPANY_BY_ID = {
  id: 2, name: 'Acme Rentals', industry: null, website: null, type: 'customer',
  status: 'active', owner_id: 1, created_at: daysAgoIso(0), updated_at: daysAgoIso(0),
};
const TASK_BY_ID = {
  id: 11, title: 'Call back the buyer', description: null, status: 'open',
  priority: 'medium', due_date: daysAgoDate(2), assigned_to: 1,
  contact_id: 17, deal_id: 3, created_at: daysAgoIso(9), updated_at: daysAgoIso(2),
};

function makeStubClient() {
  return {
    query: vi.fn().mockImplementation((sql) => {
      const s = String(sql).trim();
      if (/^BEGIN|^COMMIT|^ROLLBACK|^SET LOCAL/i.test(s)) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (/FROM deals WHERE id = \$1/i.test(s))     return Promise.resolve({ rows: [DEAL_BY_ID] });
      if (/FROM contacts WHERE id = \$1/i.test(s))  return Promise.resolve({ rows: [CONTACT_BY_ID] });
      if (/FROM companies WHERE id = \$1/i.test(s)) return Promise.resolve({ rows: [COMPANY_BY_ID] });
      if (/FROM tasks WHERE id = \$1/i.test(s))     return Promise.resolve({ rows: [TASK_BY_ID] });
      if (/FROM deals/i.test(s))     return Promise.resolve({ rows: DEALS });
      if (/FROM contacts/i.test(s))  return Promise.resolve({ rows: CONTACTS });
      if (/FROM companies/i.test(s)) return Promise.resolve({ rows: COMPANIES });
      if (/FROM tasks/i.test(s))     return Promise.resolve({ rows: TASKS });
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    release: vi.fn(),
  };
}

// Execute an entry's source_code the way the sandbox does: polyfilled
// `module`, then call module.exports.run({ crm, input }). The crm context is
// the REAL pluginSdk in confirm-first (dryRun) mode, so update*/createTask
// record proposals instead of writing — exactly what a preview run does.
async function smokeRun(entry, input) {
  const logBuffer = [];
  const counters = { db_queries: 0 };
  const proposedActions = [];
  const crm = pluginSdk.buildContext({
    orgId: ORG_ID, logBuffer, counters, dryRun: true, proposedActions,
  });
  // eslint-disable-next-line no-new-func
  const factory = new Function('crm', 'input', `
    "use strict";
    let module = { exports: {} };
    ${entry.spec.source_code}
    return (async () => {
      if (module.exports && typeof module.exports.run === 'function') {
        return await module.exports.run({ crm, input });
      }
      return null;
    })();
  `);
  const result = await factory(crm, input);
  return { result, counters, proposedActions, logBuffer };
}

// Representative trigger payloads per event, mirroring the event-trigger
// engine's taxonomy. Scheduled entries receive their own triggerFilter as
// input (thresholds/config), which is the richest input they can expect.
function representativeInput(entry) {
  switch (entry.spec.triggerEvent) {
    case 'quote.sent':
      return { quote: { id: 1, public_id: 'Q-100' }, customer: { name: 'Acme Rentals' } };
    case 'deal.created':
      return { deal: { id: 3, title: 'Acme Expansion', amount: 60000, stage: 'LEAD' } };
    case 'deal.stage_changed':
      return {
        dealId: 3, previousStage: 'NEGOTIATION', newStage: 'CLOSED_WON',
        deal: { id: 3, title: 'Acme Expansion', stage: 'CLOSED_WON' },
      };
    case 'lead.created':
      return { lead: { id: 9, name: 'Jane Doe', email: 'jane@example.com', phone: '555-0100', company: 'Acme Rentals', source: 'webform' } };
    case 'case.created':
      return { case: { id: 4, subject: 'Cannot log in', priority: 'high', company_name: 'Acme Rentals' } };
    case 'company.created':
      return { company: { id: 2, name: 'Acme Rentals', industry: null, website: null } };
    case 'task.overdue':
      return { task: { id: 11, title: 'Call back the buyer', priority: 'medium', due_date: daysAgoDate(2) } };
    default:
      return entry.spec.triggerFilter || null;
  }
}

const ALL = pluginLibrary.LIBRARY;
const RUNNABLE = ALL.filter(e => typeof e.spec.source_code === 'string' && e.spec.source_code.includes('module.exports'));

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  mockPool.connect.mockImplementation(() => Promise.resolve(makeStubClient()));
  audit.fromReq.mockClear();
  featureFlags.hasFeature.mockClear();
  featureFlags.hasFeature.mockResolvedValue(true);
});

// ===========================================================================
// 1. Catalog integrity
// ===========================================================================
describe('plugin library — catalog integrity', () => {
  test('has 30 entries with unique slugs', () => {
    expect(ALL.length).toBe(30);
    const slugs = ALL.map(e => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test('the original five entries are still present and untouched in shape', () => {
    for (const slug of [
      'follow-up-on-quote-sent', 'stalled-deal-digest', 'mark-hot-large-deal',
      'invoiced-survey', 'vendor-price-validation-30d',
    ]) {
      expect(pluginLibrary.getBySlug(slug)).toBeTruthy();
    }
    // The legacy entries stay declarative-only (no source_code) by design.
    expect(pluginLibrary.getBySlug('stalled-deal-digest').spec.source_code).toBeUndefined();
  });

  test.each(ALL.map(e => [e.slug, e]))('%s has complete display metadata', (slug, entry) => {
    expect(typeof entry.name).toBe('string');
    expect(entry.name.length).toBeGreaterThan(4);
    expect(typeof entry.category).toBe('string');
    expect(['sales', 'hygiene', 'cx', 'reporting', 'ops', 'procurement']).toContain(entry.category);
    expect(typeof entry.icon).toBe('string');
    expect(entry.icon.length).toBeGreaterThan(0);
    expect(typeof entry.summary).toBe('string');
    expect(entry.summary.length).toBeGreaterThan(60); // real copy, not a stub
    expect(Array.isArray(entry.tags)).toBe(true);
    expect(entry.tags.length).toBeGreaterThan(0);
    // The install path uses spec.name as the plugin row name — keep it the slug.
    expect(entry.spec.name).toBe(slug);
    expect(TRIGGER_EVENTS).toContain(entry.spec.triggerEvent);
    expect(Array.isArray(entry.spec.actions)).toBe(true);
    expect(entry.spec.actions.length).toBeGreaterThan(0);
    for (const a of entry.spec.actions) {
      expect(ACTION_KINDS).toContain(a.kind);
    }
  });

  test('every NEW entry ships runnable source_code (one click → working extension)', () => {
    const legacy = new Set([
      'follow-up-on-quote-sent', 'stalled-deal-digest', 'mark-hot-large-deal',
      'invoiced-survey', 'vendor-price-validation-30d',
    ]);
    for (const entry of ALL) {
      if (legacy.has(entry.slug)) continue;
      expect(typeof entry.spec.source_code, `${entry.slug} must carry source_code`).toBe('string');
      expect(entry.spec.source_code).toContain('module.exports');
      // The validator rejects globalThis assignment — the module.exports form
      // is the only supported result channel for library code.
      expect(entry.spec.source_code).not.toMatch(/globalThis\s*\./);
    }
    expect(RUNNABLE.length).toBe(25);
  });

  test('source_code references only allowlisted crm.* methods', () => {
    const crmCallRe = /\bcrm\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
    for (const entry of RUNNABLE) {
      let m;
      while ((m = crmCallRe.exec(entry.spec.source_code)) !== null) {
        expect(SDK_METHOD_ALLOWLIST, `${entry.slug} uses crm.${m[1]}`).toContain(m[1]);
      }
    }
  });

  test('list() exposes the catalog projection for every entry', () => {
    const listed = pluginLibrary.list();
    expect(listed.length).toBe(ALL.length);
    for (const item of listed) {
      expect(item).toHaveProperty('slug');
      expect(item).toHaveProperty('triggerEvent');
      expect(Array.isArray(item.requiredConfig)).toBe(true);
    }
  });
});

// ===========================================================================
// 2. Validation — the exact install-path projection passes the validator
// ===========================================================================
describe('plugin library — every entry validates', () => {
  test.each(ALL.map(e => [e.slug, e]))('%s passes pluginSpecValidator', (slug, entry) => {
    const r = validateSpec(projectForValidation(entry));
    if (!r.ok) {
      throw new Error(`${slug} failed validation: ${JSON.stringify(r.errors)}`);
    }
    expect(r.ok).toBe(true);
  });
});

// ===========================================================================
// 3. Install path — POST /from-template produces a plugin row per entry
// ===========================================================================
describe('plugin library — install path (cloneTemplateForOrg)', () => {
  test.each(ALL.map(e => [e.slug, e]))('%s installs into a draft plugin row', async (slug, entry) => {
    queueAuthRow();
    // collision check: no existing row with this name
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // INSERT → returning row
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 1000, name: slug, public_id: 'uuid', status: 'draft',
        source_kind: 'library', description: entry.summary,
        trigger_event: entry.spec.triggerEvent,
      }],
    });

    const res = await request(buildApp())
      .post('/api/plugins/from-template')
      .set('Cookie', authCookie())
      .send({ template_id: slug });

    expect(res.status).toBe(201);
    expect(res.body.plugin.status).toBe('draft');
    expect(res.body.plugin.source_kind).toBe('library');

    // Inspect the INSERT parameters:
    //   $2 name, $3 description, $4 spec_json, $5 source_code, $6 trigger_event
    const insertCall = mockPool.query.mock.calls.find(
      c => /INSERT INTO plugins/i.test(String(c[0]))
    );
    expect(insertCall).toBeTruthy();
    const params = insertCall[1];
    expect(params[1]).toBe(slug);
    expect(params[5]).toBe(entry.spec.triggerEvent);
    if (entry.spec.source_code) {
      // Runnable entries: the row carries the template's real implementation.
      expect(params[4]).toBe(entry.spec.source_code);
    } else {
      // Legacy declarative entries keep the documented placeholder.
      expect(params[4]).toMatch(/Library template/);
    }
    const specJson = JSON.parse(params[3]);
    expect(specJson.triggerEvent).toBe(entry.spec.triggerEvent);
    expect(Array.isArray(specJson.actions)).toBe(true);
  });
});

// ===========================================================================
// 4. Smoke runs — every runnable entry executes without throwing, within
//    budget, with a representative payload AND with input=null.
// ===========================================================================
describe('plugin library — smoke runs (confirm-first preview over stub pool)', () => {
  test.each(RUNNABLE.map(e => [e.slug, e]))('%s runs with a representative trigger payload', async (slug, entry) => {
    const { counters, proposedActions } = await smokeRun(entry, representativeInput(entry));
    expect(counters.db_queries).toBeLessThanOrEqual(50);
    expect(counters.tasks_created || 0).toBeLessThanOrEqual(10);
    // Every proposal captured must be a well-formed confirm-first action.
    for (const p of proposedActions) {
      expect(['create', 'update']).toContain(p.op);
      expect(typeof p.summary).toBe('string');
    }
  });

  test.each(RUNNABLE.map(e => [e.slug, e]))('%s tolerates input=null (manual test run)', async (slug, entry) => {
    const { counters } = await smokeRun(entry, null);
    expect(counters.db_queries).toBeLessThanOrEqual(50);
    expect(counters.tasks_created || 0).toBeLessThanOrEqual(10);
  });

  test('representative payloads actually exercise the write paths', async () => {
    // Guard against a library of no-ops: across all runnable entries with
    // their representative inputs, a healthy majority must propose at least
    // one write against this (deliberately messy) fixture org.
    let entriesProposing = 0;
    for (const entry of RUNNABLE) {
      const { proposedActions } = await smokeRun(entry, representativeInput(entry));
      if (proposedActions.length > 0) entriesProposing++;
    }
    expect(entriesProposing).toBeGreaterThanOrEqual(20);
  });
});
