// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Switcher-migration import presets (HubSpot / Salesforce CSV exports).
//
//   1. buildMapping — tolerant header matching (exact, case/spacing/
//      punctuation variants, Salesforce API names), unmatched fields listed.
//   2. mapStage — platform default stages resolve onto the generic pipeline;
//      stages nobody recognizes fall back to the pipeline default WITH a
//      warning (never an error); custom pipelines fall back too.
//   3. Routes — GET /api/import/presets; per-entity imports with `preset`
//      pre-applying the mapping server-side; owner-by-email matching
//      (unmatched → warning + unowned); full happy-path fixture imports for
//      both platforms; explicit user mapping overrides the preset.
//
// Pool is fully mocked with a SQL-shape router (same pattern as
// dealTypePipelines.test.js). The 30s effective-pipeline cache is cleared
// per test.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const importPresets = require('../services/importPresets');
const pipelines = require('../services/pipelines');
const importRoutes = require('../routes/importRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const ORG_ID = 93;

// A fresh user id per request keeps each call in its own importExecuteLimiter
// bucket (10 imports / 15 min per user) — the pool mock returns the same org
// for every id, so nothing else changes.
let uidCounter = 9301;
function authCookie() { return [`${AUTH_COOKIE_NAME}=${generateToken(uidCounter++)}`]; }

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/import', importRoutes);
  return app;
}

// SQL-shape router. `users` maps lowercased email → user id (org members),
// `companies` maps lowercased name → id. Captures every INSERT's params.
function primePool({ profile = 'generic', users = {}, companies = {} } = {}) {
  const state = { contactInserts: [], companyInserts: [], dealInserts: [], nextCompanyId: 500 };
  mockPool.query.mockImplementation(async (sql, params) => {
    const s = String(sql);
    if (/FROM admin_users/i.test(s)) return { rows: [] };
    if (/SELECT id FROM users WHERE org_id = \$1 AND LOWER\(email\)/i.test(s)) {
      const id = users[String(params[1]).toLowerCase()];
      return { rows: id ? [{ id }] : [] };
    }
    if (/FROM users WHERE id/i.test(s)) return { rows: [{ org_id: ORG_ID, org_role: 'owner', status: 'active' }] };
    if (/SELECT profile FROM organizations/i.test(s)) return { rows: [{ profile }] };
    if (/FROM pipelines WHERE org_id = \$1 AND is_default = TRUE/i.test(s)) return { rows: [] };
    if (/FROM pipelines WHERE org_id = \$1 AND deal_type = \$2/i.test(s)) return { rows: [] };
    if (/FROM pipelines\s+WHERE org_id = \$1 AND \(is_default = TRUE OR deal_type IS NOT NULL\)/i.test(s)) return { rows: [] };
    if (/SELECT id FROM companies WHERE/i.test(s)) {
      const id = companies[String(params[1]).toLowerCase()];
      return { rows: id ? [{ id }] : [] };
    }
    if (/INSERT INTO companies/i.test(s)) {
      state.companyInserts.push(params);
      return { rows: [{ id: state.nextCompanyId++ }] };
    }
    if (/INSERT INTO contacts/i.test(s)) {
      state.contactInserts.push(params);
      return { rows: [] };
    }
    if (/INSERT INTO deals/i.test(s)) {
      state.dealInserts.push(params);
      return { rows: [{ id: 4242 }] };
    }
    return { rows: [] };
  });
  return state;
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  pipelines._clearCache();
});

// ===========================================================================
// 1. buildMapping — tolerant header matching
// ===========================================================================
describe('buildMapping — header matching', () => {
  test('HubSpot contacts export headers map exactly', () => {
    const headers = ['Record ID', 'First Name', 'Last Name', 'Email', 'Phone Number', 'Job Title', 'Associated Company', 'Lifecycle Stage'];
    const out = importPresets.buildMapping('hubspot', 'contacts', headers);
    expect(out.mapping).toMatchObject({
      first_name: 'First Name',
      last_name: 'Last Name',
      email: 'Email',
      phone: 'Phone Number',
      job_title: 'Job Title',
      company_name: 'Associated Company',
      status: 'Lifecycle Stage',
    });
    expect(out.unmatchedFields).toContain('owner_email'); // no owner column exported
    expect(out.matchedFields).toContain('first_name');
  });

  test('variant headers still match: case, underscores, extra spaces', () => {
    const headers = ['first_name', 'LAST NAME', ' Email ', 'phone-number', 'associated  company'];
    const out = importPresets.buildMapping('hubspot', 'contacts', headers);
    expect(out.mapping.first_name).toBe('first_name');
    expect(out.mapping.last_name).toBe('LAST NAME');
    expect(out.mapping.email).toBe(' Email ');
    expect(out.mapping.phone).toBe('phone-number');
    expect(out.mapping.company_name).toBe('associated  company');
  });

  test('HubSpot companies export: Name + Company Domain Name + Number of Employees', () => {
    const headers = ['Record ID', 'Name', 'Company Domain Name', 'Phone Number', 'City', 'Industry', 'Number of Employees', 'Annual Revenue', 'Description'];
    const out = importPresets.buildMapping('hubspot', 'companies', headers);
    expect(out.mapping).toMatchObject({
      name: 'Name',
      website: 'Company Domain Name',
      location: 'City',
      industry: 'Industry',
      employee_count: 'Number of Employees',
      annual_revenue: 'Annual Revenue',
      notes: 'Description',
    });
  });

  test('Salesforce opportunity report labels AND Data Loader API names both match', () => {
    const labels = importPresets.buildMapping('salesforce', 'deals',
      ['Opportunity Name', 'Stage', 'Amount', 'Close Date', 'Account Name', 'Opportunity Owner']);
    expect(labels.mapping).toMatchObject({
      title: 'Opportunity Name',
      stage: 'Stage',
      amount: 'Amount',
      expected_close_date: 'Close Date',
      company_name: 'Account Name',
      owner_email: 'Opportunity Owner',
    });

    const api = importPresets.buildMapping('salesforce', 'deals',
      ['Name', 'StageName', 'Amount', 'CloseDate', 'AccountName']);
    expect(api.mapping).toMatchObject({
      title: 'Name',
      stage: 'StageName',
      expected_close_date: 'CloseDate',
      company_name: 'AccountName',
    });
  });

  test('Salesforce accounts: Account Name, Website, Industry, Billing City', () => {
    const out = importPresets.buildMapping('salesforce', 'companies',
      ['Account Name', 'Website', 'Phone', 'Industry', 'Billing City', 'Employees', 'Annual Revenue']);
    expect(out.mapping).toMatchObject({
      name: 'Account Name',
      website: 'Website',
      industry: 'Industry',
      location: 'Billing City',
      employee_count: 'Employees',
      annual_revenue: 'Annual Revenue',
    });
  });

  test('a column feeds at most one field, and unknown entity/preset is empty', () => {
    // 'Name' could be title for salesforce deals; once claimed it is not reused.
    const out = importPresets.buildMapping('salesforce', 'deals', ['Name']);
    expect(out.mapping.title).toBe('Name');
    expect(Object.values(out.mapping).filter((h) => h === 'Name').length).toBe(1);
    expect(importPresets.buildMapping('nope', 'deals', ['Name']).mapping).toEqual({});
    expect(importPresets.buildMapping('hubspot', 'widgets', ['Name']).mapping).toEqual({});
  });
});

// ===========================================================================
// 2. mapStage — platform stages onto the effective pipeline
// ===========================================================================
describe('mapStage — stage-name mapping', () => {
  let genericPipeline;
  beforeEach(async () => {
    genericPipeline = await pipelines.getEffectivePipeline(null, 'generic');
  });

  test('HubSpot internal values and display labels resolve onto the generic pipeline', () => {
    expect(importPresets.mapStage('hubspot', 'appointmentscheduled', genericPipeline)).toMatchObject({ stage: 'lead', matched: true, warning: null });
    expect(importPresets.mapStage('hubspot', 'Appointment Scheduled', genericPipeline).stage).toBe('lead');
    expect(importPresets.mapStage('hubspot', 'qualifiedtobuy', genericPipeline).stage).toBe('qualified');
    expect(importPresets.mapStage('hubspot', 'presentationscheduled', genericPipeline).stage).toBe('proposal');
    expect(importPresets.mapStage('hubspot', 'Decision Maker Bought-In', genericPipeline).stage).toBe('negotiation');
    expect(importPresets.mapStage('hubspot', 'contractsent', genericPipeline).stage).toBe('negotiation');
    expect(importPresets.mapStage('hubspot', 'closedwon', genericPipeline).stage).toBe('closed_won');
    expect(importPresets.mapStage('hubspot', 'closedlost', genericPipeline).stage).toBe('closed_lost');
  });

  test('Salesforce default stages resolve onto the generic pipeline', () => {
    expect(importPresets.mapStage('salesforce', 'Prospecting', genericPipeline).stage).toBe('lead');
    expect(importPresets.mapStage('salesforce', 'Qualification', genericPipeline).stage).toBe('qualified');
    expect(importPresets.mapStage('salesforce', 'Needs Analysis', genericPipeline).stage).toBe('qualified');
    expect(importPresets.mapStage('salesforce', 'Value Proposition', genericPipeline).stage).toBe('proposal');
    expect(importPresets.mapStage('salesforce', 'Id. Decision Makers', genericPipeline).stage).toBe('negotiation');
    expect(importPresets.mapStage('salesforce', 'Identify Decision Makers', genericPipeline).stage).toBe('negotiation');
    expect(importPresets.mapStage('salesforce', 'Perception Analysis', genericPipeline).stage).toBe('negotiation');
    expect(importPresets.mapStage('salesforce', 'Proposal/Price Quote', genericPipeline).stage).toBe('proposal');
    expect(importPresets.mapStage('salesforce', 'Negotiation/Review', genericPipeline).stage).toBe('negotiation');
    expect(importPresets.mapStage('salesforce', 'Closed Won', genericPipeline).stage).toBe('closed_won');
    expect(importPresets.mapStage('salesforce', 'Closed Lost', genericPipeline).stage).toBe('closed_lost');
  });

  test('a stage already on the pipeline wins verbatim over the preset map', () => {
    // "Qualified" is a generic stage label — resolves directly, no remap.
    expect(importPresets.mapStage('hubspot', 'Qualified', genericPipeline).stage).toBe('qualified');
  });

  test('an unrecognized custom stage falls back to the default stage with a WARNING, not an error', () => {
    const out = importPresets.mapStage('hubspot', 'Discovery Call Booked', genericPipeline);
    expect(out.stage).toBe('lead'); // generic pipeline default
    expect(out.matched).toBe(false);
    expect(out.warning).toMatch(/Discovery Call Booked/);
    expect(out.warning).toMatch(/"lead"/);
  });

  test('a CUSTOM pipeline without generic slugs also falls back with a warning', () => {
    const custom = {
      is_custom: true,
      default_stage: 'new',
      stages: [
        { id: 'new', label: 'New' },
        { id: 'demo', label: 'Demo' },
        { id: 'won', label: 'Won', is_won: true },
        { id: 'lost', label: 'Lost', is_lost: true },
      ],
    };
    // closedwon maps to generic closed_won, which does not exist here → default + warning.
    const out = importPresets.mapStage('hubspot', 'closedwon', custom);
    expect(out.stage).toBe('new');
    expect(out.warning).toMatch(/closedwon/);
    // But a label that IS on the custom pipeline resolves directly.
    expect(importPresets.mapStage('hubspot', 'Demo', custom)).toMatchObject({ stage: 'demo', matched: true });
  });
});

// ===========================================================================
// 3. Routes — presets endpoint + preset-applied imports
// ===========================================================================
describe('GET /api/import/presets', () => {
  test('returns both preset descriptors with per-entity fields and help', async () => {
    primePool({});
    const r = await request(buildApp()).get('/api/import/presets').set('Cookie', authCookie());
    expect(r.status).toBe(200);
    const ids = r.body.presets.map((p) => p.id);
    expect(ids).toEqual(['hubspot', 'salesforce']);
    const hs = r.body.presets[0];
    expect(hs.label).toBe('HubSpot');
    expect(hs.entities.contacts.fields.first_name).toContain('First Name');
    expect(hs.help.contacts).toMatch(/Export/);
    expect(hs.stage_map.closedwon).toBe('closed_won');
  });
});

describe('POST /api/import/deals with preset', () => {
  const HUBSPOT_DEAL_ROWS = [
    { 'Record ID': '1', 'Deal Name': 'Acme expansion', 'Deal Stage': 'appointmentscheduled', 'Amount': '$1,200.50', 'Close Date': '2026-10-01', 'Associated Company': 'Acme Inc', 'Deal owner': 'rep@example.com' },
    { 'Record ID': '2', 'Deal Name': 'Globex renewal', 'Deal Stage': 'Closed Won', 'Amount': '9000', 'Close Date': '2026-09-15', 'Associated Company': 'Globex', 'Deal owner': 'rep@example.com' },
    { 'Record ID': '3', 'Deal Name': 'Initech pilot', 'Deal Stage': 'Discovery Call', 'Amount': '', 'Close Date': '', 'Associated Company': '', 'Deal owner': 'Jane Doe' },
  ];

  test('HubSpot happy path: no mapping sent, stage + owner + company all handled', async () => {
    const state = primePool({ users: { 'rep@example.com': 77 }, companies: { 'acme inc': 300 } });
    const r = await request(buildApp())
      .post('/api/import/deals')
      .set('Cookie', authCookie())
      .send({ rows: HUBSPOT_DEAL_ROWS, preset: 'hubspot' });

    expect(r.status).toBe(200);
    expect(r.body.created).toBe(3);
    expect(r.body.skipped).toBe(0);

    // INSERT params: [user, org, company, salesman, owner, title, amount, stage, phase, type, close, notes]
    const [d1, d2, d3] = state.dealInserts;
    expect(d1[5]).toBe('Acme expansion');
    expect(d1[7]).toBe('lead');           // appointmentscheduled → lead
    expect(d1[6]).toBe(1200.5);           // "$1,200.50" parsed
    expect(d1[2]).toBe(300);              // matched existing company by name
    expect(d1[4]).toBe(77);               // owner matched by email
    expect(d1[10]).toBe('2026-10-01');

    expect(d2[7]).toBe('closed_won');     // label resolves directly
    expect(d2[2]).toBe(500);              // Globex not found → created
    expect(state.companyInserts.length).toBe(1);

    expect(d3[7]).toBe('lead');           // unknown stage → default stage
    expect(d3[4]).toBeNull();             // "Jane Doe" is not an email → unowned

    // Warnings: unknown stage + non-email owner. Neither skipped the row.
    const reasons = r.body.warnings.map((w) => w.reason).join(' | ');
    expect(reasons).toMatch(/Discovery Call/);
    expect(reasons).toMatch(/Jane Doe/);
    expect(r.body.warnings.every((w) => w.row === 4)).toBe(true); // row 3 + header offset
  });

  test('Salesforce happy path with report-label headers', async () => {
    const state = primePool({ users: { 'ae@example.com': 88 }, companies: {} });
    const rows = [
      { 'Opportunity Name': 'Umbrella Corp - New Business', 'Stage': 'Needs Analysis', 'Amount': '25000', 'Close Date': '10/30/2026', 'Account Name': 'Umbrella Corp', 'Opportunity Owner': 'ae@example.com' },
      { 'Opportunity Name': 'Stark - Renewal', 'Stage': 'Negotiation/Review', 'Amount': '12,000', 'Close Date': '2026-11-05', 'Account Name': 'Stark Industries', 'Opportunity Owner': 'nobody@example.com' },
    ];
    const r = await request(buildApp())
      .post('/api/import/deals')
      .set('Cookie', authCookie())
      .send({ rows, preset: 'salesforce' });

    expect(r.status).toBe(200);
    expect(r.body.created).toBe(2);
    const [d1, d2] = state.dealInserts;
    expect(d1[7]).toBe('qualified');      // Needs Analysis → qualified
    expect(d1[4]).toBe(88);
    expect(d1[10]).toBe('2026-10-30');    // US date normalized
    expect(d2[7]).toBe('negotiation');    // Negotiation/Review → negotiation
    expect(d2[4]).toBeNull();             // email not in org → unowned + warning
    expect(r.body.warnings.some((w) => /nobody@example\.com/.test(w.reason))).toBe(true);
  });

  test('owner lookups are cached per email (one query for repeated owners)', async () => {
    primePool({ users: { 'rep@example.com': 77 } });
    await request(buildApp())
      .post('/api/import/deals')
      .set('Cookie', authCookie())
      .send({ rows: HUBSPOT_DEAL_ROWS.slice(0, 2), preset: 'hubspot' });
    const ownerLookups = mockPool.query.mock.calls.filter(([sql]) => /LOWER\(email\)/i.test(String(sql)));
    expect(ownerLookups.length).toBe(1);
  });

  test('explicit user mapping overrides the preset column choice', async () => {
    const state = primePool({});
    const rows = [{ 'Deal Name': 'Wrong', 'My Real Title': 'Right', 'Deal Stage': 'closedlost' }];
    const r = await request(buildApp())
      .post('/api/import/deals')
      .set('Cookie', authCookie())
      .send({ rows, preset: 'hubspot', mapping: { title: 'My Real Title' } });
    expect(r.status).toBe(200);
    expect(state.dealInserts[0][5]).toBe('Right');
    expect(state.dealInserts[0][7]).toBe('closed_lost');
  });

  test('without a preset, an invalid stage is still a hard row error (unchanged behavior)', async () => {
    primePool({});
    const r = await request(buildApp())
      .post('/api/import/deals')
      .set('Cookie', authCookie())
      .send({ rows: [{ Title: 'X', Stage: 'bogusstage' }], mapping: { title: 'Title', stage: 'Stage' } });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(0);
    expect(r.body.errors[0].reason).toMatch(/Invalid stage/);
  });

  test('unknown preset id → 400 naming the valid presets', async () => {
    primePool({});
    const r = await request(buildApp())
      .post('/api/import/deals')
      .set('Cookie', authCookie())
      .send({ rows: [{ 'Deal Name': 'X' }], preset: 'pipedrive' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/hubspot, salesforce/);
  });
});

describe('POST /api/import/contacts and /companies with preset', () => {
  test('HubSpot contacts: preset maps everything, owner by email, company by name', async () => {
    const state = primePool({ users: { 'rep@example.com': 77 }, companies: { 'acme inc': 300 } });
    const rows = [
      { 'First Name': 'Ada', 'Last Name': 'Lovelace', 'Email': 'ada@acme.com', 'Phone Number': '555-0100', 'Job Title': 'CTO', 'Associated Company': 'Acme Inc', 'Contact owner': 'rep@example.com' },
      { 'First Name': 'Grace', 'Last Name': 'Hopper', 'Email': 'grace@navy.mil', 'Phone Number': '', 'Job Title': '', 'Associated Company': '', 'Contact owner': '' },
    ];
    const r = await request(buildApp())
      .post('/api/import/contacts')
      .set('Cookie', authCookie())
      .send({ rows, preset: 'hubspot' });

    expect(r.status).toBe(200);
    expect(r.body.created).toBe(2);
    // [user, org, company, owner, first, last, email, phone, title, notes, status]
    const [c1, c2] = state.contactInserts;
    expect(c1[2]).toBe(300);
    expect(c1[3]).toBe(77);
    expect(c1[4]).toBe('Ada');
    expect(c1[6]).toBe('ada@acme.com');
    expect(c2[2]).toBeNull();
    expect(c2[3]).toBeNull();
  });

  test('Salesforce accounts: preset alone imports companies', async () => {
    const state = primePool({});
    const rows = [
      { 'Account Name': 'Wayne Enterprises', 'Website': 'wayne.com', 'Industry': 'Defense', 'Billing City': 'Gotham', 'Employees': '5,000', 'Annual Revenue': '$1,000,000' },
    ];
    const r = await request(buildApp())
      .post('/api/import/companies')
      .set('Cookie', authCookie())
      .send({ rows, preset: 'salesforce' });

    expect(r.status).toBe(200);
    expect(r.body.created).toBe(1);
    // [user, org, name, industry, website, location, employees, revenue, notes]
    const c = state.companyInserts[0];
    expect(c[2]).toBe('Wayne Enterprises');
    expect(c[4]).toBe('wayne.com');
    expect(c[5]).toBe('Gotham');
    expect(c[7]).toBe(1000000);
  });

  test('preset with a CSV missing required columns still 400s clearly', async () => {
    primePool({});
    const r = await request(buildApp())
      .post('/api/import/contacts')
      .set('Cookie', authCookie())
      .send({ rows: [{ 'Some Column': 'x' }], preset: 'hubspot' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/first_name/);
  });
});
