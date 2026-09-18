// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Record one-pager PDFs (migration 161, CMN_REQUIREMENTS.md §1.7).
//
// Three suites:
//   1. services/pdfOnePager — template resolution (field order, label
//      overrides, custom-field label/type resolution via
//      org_field_definitions, empty-value skipping), built-in defaults per
//      entity, photo loading that degrades silently when storage is
//      unconfigured, and an end-to-end render producing a real PDF stream.
//   2. pdf routes — auth required, org-scoping (cross-org → 404),
//      application/pdf content type, template_id 404.
//   3. template CRUD — member read OK, member write 403, owner/admin write,
//      default-flip transaction, scoped delete.
//
// Same harness as dealStagePlaybooks.test.js: tiny Express app, fully mocked
// pg pool. describe/test/expect/beforeEach/vi are vitest globals.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

const { Writable } = require('stream');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const storage = require('../services/storage');
const {
  getDefaultTemplate,
  normalizeTemplateConfig,
  resolveFieldRows,
  formatValue,
  loadPhotos,
  buildPalette,
  renderOnePagerPdf,
} = require('../services/pdfOnePager');
const { pdfRouter, templatesRouter } = require('../routes/onePagerRoutes');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');

const USER_ID = 4242;
const ORG_ID = 7;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api', pdfRouter);
  app.use('/api/one-pager-templates', templatesRouter);
  return app;
}

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

function authAs(role) {
  // authMiddleware — SELECT org_id, org_role, status FROM users.
  mockPool.query.mockResolvedValueOnce({ rows: [{ org_id: ORG_ID, org_role: role, status: 'active' }] });
}

function mockClient(responses) {
  const client = { query: vi.fn(), release: vi.fn() };
  const queue = [...responses];
  client.query.mockImplementation(() => Promise.resolve(queue.shift() || { rows: [] }));
  return client;
}

// Collect a binary supertest response as a Buffer.
function binaryParser(res, cb) {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

// Render helper — pipes the PDF into memory and resolves the full buffer.
function renderToBuffer(opts) {
  const chunks = [];
  const sink = new Writable({ write(chunk, _enc, done) { chunks.push(chunk); done(); } });
  const finished = new Promise((resolve) => sink.on('finish', () => resolve(Buffer.concat(chunks))));
  renderOnePagerPdf(opts, sink);
  return finished;
}

beforeEach(() => {
  vi.restoreAllMocks(); // clears any vi.spyOn(storage, …) from a prior test
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
});

// ===========================================================================
// 1. Service
// ===========================================================================

describe('pdfOnePager service', () => {
  test('built-in default template per entity carries entity-appropriate fields', () => {
    const deal = getDefaultTemplate('deal');
    const company = getDefaultTemplate('company');
    const contact = getDefaultTemplate('contact');

    expect(deal.config.fields.map((f) => f.key)).toContain('stage');
    expect(deal.config.fields.map((f) => f.key)).toContain('amount');
    expect(company.config.fields.map((f) => f.key)).toContain('industry');
    expect(contact.config.fields.map((f) => f.key)).toContain('email');
    for (const t of [deal, company, contact]) {
      expect(t.config.include_photos).toBe(true);
      expect(t.config.photo_count).toBe(2);
      expect(t.config.include_notes).toBe(true);
    }
  });

  test('normalizeTemplateConfig falls back to defaults and clamps photo_count', () => {
    const cfg = normalizeTemplateConfig('deal', { photo_count: 99, include_photos: false, footer_text: '  Call us  ' });
    expect(cfg.photo_count).toBe(4); // clamped to max
    expect(cfg.include_photos).toBe(false);
    expect(cfg.footer_text).toBe('Call us');
    expect(cfg.fields.length).toBeGreaterThan(0); // default field list kicks in

    const strFields = normalizeTemplateConfig('deal', { fields: ['stage', { key: 'amount', label: 'Value' }] });
    expect(strFields.fields).toEqual([{ key: 'stage', label: null }, { key: 'amount', label: 'Value' }]);
  });

  test('resolveFieldRows honors template order and label overrides', () => {
    const record = { stage: 'closed_won', amount: '12500', expected_close_date: '2026-03-05' };
    const rows = resolveFieldRows({
      entity: 'deal',
      record,
      fields: [
        { key: 'amount', label: 'Contract value' },
        { key: 'stage' },
        { key: 'expected_close_date' },
      ],
    });
    expect(rows.map((r) => r.label)).toEqual(['Contract value', 'Stage', 'Expected close']);
    expect(rows[0].value).toBe('$12,500');
    expect(rows[1].value).toBe('Closed Won');
    expect(rows[2].value).toBe('March 5, 2026');
  });

  test('custom fields resolve labels + types from org_field_definitions', () => {
    const record = {
      custom_fields: { site_traffic: 40000, geo_verified: true, panel_size: '14x48' },
    };
    const rows = resolveFieldRows({
      entity: 'deal',
      record,
      fields: [{ key: 'site_traffic' }, { key: 'geo_verified' }, { key: 'panel_size', label: 'Panel size' }],
      fieldDefs: [
        { name: 'site_traffic', label: 'Daily traffic', type: 'number' },
        { name: 'geo_verified', label: null, type: 'boolean' },
      ],
    });
    expect(rows).toEqual([
      { label: 'Daily traffic', value: '40,000' },
      { label: 'Geo Verified', value: 'Yes' },  // no def label → title-cased key
      { label: 'Panel size', value: '14x48' },  // template label override wins
    ]);
  });

  test('empty values and unknown keys are skipped — no orphan labels', () => {
    const record = { stage: 'lead', amount: null, tags: [], custom_fields: {} };
    const rows = resolveFieldRows({
      entity: 'deal',
      record,
      fields: [{ key: 'stage' }, { key: 'amount' }, { key: 'tags' }, { key: 'no_such_field' }],
    });
    expect(rows).toEqual([{ label: 'Stage', value: 'Lead' }]);
  });

  test('formatValue covers dates, currency, booleans, arrays', () => {
    expect(formatValue('2026-01-15', 'date')).toBe('January 15, 2026');
    expect(formatValue(1250000, 'currency')).toBe('$1,250,000');
    expect(formatValue(99.5, 'currency')).toBe('$99.50');
    expect(formatValue(false, 'boolean')).toBe('No');
    expect(formatValue(['a', 'b'], 'tags')).toBe('a · b');
    expect(formatValue('', 'text')).toBeNull();
  });

  test('buildPalette adopts the branding primary color and falls back cleanly', () => {
    expect(buildPalette({ primaryColor: '#1e3a8a' }).primary).toBe('#1e3a8a');
    expect(buildPalette({ primaryColor: 'not-a-color' }).primary).toBe('#1d4ed8');
    expect(buildPalette(null).primary).toBe('#1d4ed8');
  });

  test('loadPhotos skips silently when storage download fails (unconfigured)', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 1, filename: 'a.jpg', mime_type: 'image/jpeg', content: null, gcs_object_path: 'org/7/deal/1/a.jpg' },
        { id: 2, filename: 'b.png', mime_type: 'image/png', content: null, gcs_object_path: 'org/7/deal/1/b.png' },
      ],
    });
    vi.spyOn(storage, 'downloadBuffer').mockRejectedValue(new Error('Could not load the default credentials'));
    const photos = await loadPhotos({ entity: 'deal', recordId: 1, scopeField: 'org_id', scopeValue: ORG_ID, limit: 2 });
    expect(photos).toEqual([]);
  });

  test('loadPhotos prefers the DB blob and falls back to GCS per document', async () => {
    const blob = Buffer.from('jpegbytes');
    const gcsBytes = Buffer.from('gcsbytes');
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 1, filename: 'a.jpg', mime_type: 'image/jpeg', content: blob, gcs_object_path: null },
        { id: 2, filename: 'b.png', mime_type: 'image/png', content: null, gcs_object_path: 'org/7/deal/1/b.png' },
      ],
    });
    vi.spyOn(storage, 'downloadBuffer').mockResolvedValueOnce(gcsBytes);
    const photos = await loadPhotos({ entity: 'deal', recordId: 1, scopeField: 'org_id', scopeValue: ORG_ID, limit: 2 });
    expect(photos).toHaveLength(2);
    expect(photos[0].buffer).toBe(blob);
    expect(photos[1].buffer).toBe(gcsBytes);
    // The document query is entity + record + scope filtered.
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toContain('related_type = $1');
    expect(sql).toContain('org_id = $3');
    expect(params).toEqual(['deal', 1, ORG_ID, 2]);
  });

  test('loadPhotos returns [] when the query itself fails', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('relation "documents" does not exist'));
    const photos = await loadPhotos({ entity: 'deal', recordId: 1, scopeField: 'org_id', scopeValue: ORG_ID, limit: 2 });
    expect(photos).toEqual([]);
  });

  test('renderOnePagerPdf produces a single-page PDF stream', async () => {
    const buf = await renderToBuffer({
      entity: 'deal',
      record: {
        id: 9, title: 'I-80 Bulletin — Site 12', stage: 'proposal', amount: 85000,
        expected_close_date: '2026-10-01', company_name: 'Acme Outdoor',
        contact_name: 'Jane Doe', notes: 'South-facing, unlit.',
        custom_fields: {},
      },
      template: null, // built-in default
      fieldDefs: [],
      branding: { displayName: 'Northwind Media Group', primaryColor: '#b45309' },
      orgName: 'CMN LLC',
      photos: [],
      logo: null,
    });
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
    // pdfkit writes one /Type /Page object per page.
    const pages = buf.toString('latin1').match(/\/Type \/Page[^s]/g) || [];
    expect(pages.length).toBe(1);
  });

  test('renderOnePagerPdf survives undecodable photo buffers', async () => {
    const buf = await renderToBuffer({
      entity: 'company',
      record: { id: 3, name: 'Acme', industry: 'Construction', location: 'Cheyenne, WY', notes: null },
      template: { config: { fields: [{ key: 'industry' }, { key: 'location' }], include_photos: true, photo_count: 2 } },
      branding: null,
      orgName: 'CMN LLC',
      photos: [{ buffer: Buffer.from('not-actually-an-image') }],
      logo: { buffer: Buffer.from('not-a-logo-either') },
    });
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
  });
});

// ===========================================================================
// 2. PDF routes
// ===========================================================================

describe('one-pager pdf routes', () => {
  test('requires auth', async () => {
    const res = await request(buildApp()).get('/api/deals/1/one-pager.pdf');
    expect(res.status).toBe(401);
  });

  test('streams application/pdf for an org-scoped deal', async () => {
    authAs('member');
    // record fetch
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 1, org_id: ORG_ID, title: 'Big Deal', stage: 'lead', amount: 1000, custom_fields: {}, notes: null }],
    });
    // default template lookup — none saved → built-in
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // organizations name + branding
    mockPool.query.mockResolvedValueOnce({ rows: [{ name: 'CMN LLC', branding: { primaryColor: '#b45309' } }] });
    // org_field_definitions
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    // documents (photos)
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp())
      .get('/api/deals/1/one-pager.pdf')
      .set('Cookie', authCookie())
      .buffer(true).parse(binaryParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('Big_Deal-one-pager.pdf');
    expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
  });

  test('cross-org record → 404', async () => {
    authAs('member');
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // scoped fetch finds nothing
    const res = await request(buildApp())
      .get('/api/deals/999/one-pager.pdf')
      .set('Cookie', authCookie());
    expect(res.status).toBe(404);
    // The record query was org-scoped.
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toContain('d.org_id = $2');
    expect(params).toEqual(['999', ORG_ID]);
  });

  test('unknown template_id → 404', async () => {
    authAs('member');
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1, title: 'X', custom_fields: {} }] }); // record
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // template by id — not found
    const res = await request(buildApp())
      .get('/api/deals/1/one-pager.pdf?template_id=55')
      .set('Cookie', authCookie());
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Template not found');
  });

  test('company and contact routes are wired', async () => {
    authAs('member');
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 3, name: 'Acme', custom_fields: {}, notes: null }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // template
    mockPool.query.mockResolvedValueOnce({ rows: [{ name: 'Org', branding: null }] });
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // field defs
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // photos
    const res = await request(buildApp())
      .get('/api/companies/3/one-pager.pdf')
      .set('Cookie', authCookie())
      .buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });
});

// ===========================================================================
// 3. Template CRUD
// ===========================================================================

describe('one-pager template CRUD', () => {
  test('org members can list templates (org-scoped)', async () => {
    authAs('member');
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1, entity: 'deal', name: 'Site sheet', is_default: true }] });
    const res = await request(buildApp())
      .get('/api/one-pager-templates?entity=deal')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toContain('org_id = $1');
    expect(params[0]).toBe(ORG_ID);
  });

  test('member write → 403; invalid entity → 400', async () => {
    authAs('member');
    const res = await request(buildApp())
      .post('/api/one-pager-templates')
      .set('Cookie', authCookie())
      .send({ entity: 'deal', name: 'Nope' });
    expect(res.status).toBe(403);

    authAs('owner');
    const bad = await request(buildApp())
      .post('/api/one-pager-templates')
      .set('Cookie', authCookie())
      .send({ entity: 'invoice', name: 'Nope' });
    expect(bad.status).toBe(400);
  });

  test('owner create with is_default clears the previous default in one transaction', async () => {
    authAs('owner');
    const created = { id: 12, entity: 'deal', name: 'Site sheet', is_default: true };
    const client = mockClient([
      { rows: [] },          // BEGIN
      { rows: [] },          // clear old default
      { rows: [created] },   // INSERT … RETURNING
      { rows: [] },          // COMMIT
    ]);
    mockPool.connect.mockResolvedValueOnce(client);

    const res = await request(buildApp())
      .post('/api/one-pager-templates')
      .set('Cookie', authCookie())
      .send({ entity: 'deal', name: 'Site sheet', is_default: true, config: { fields: [{ key: 'stage' }] } });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(12);
    const calls = client.query.mock.calls.map((c) => c[0]);
    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toContain('SET is_default = FALSE');
    expect(calls[2]).toContain('INSERT INTO one_pager_templates');
    expect(calls[3]).toBe('COMMIT');
  });

  test('admin update is scope-checked and 404s on a foreign row', async () => {
    authAs('admin');
    const client = mockClient([
      { rows: [] },  // BEGIN
      { rows: [] },  // scoped SELECT — not found
    ]);
    mockPool.connect.mockResolvedValueOnce(client);
    const res = await request(buildApp())
      .put('/api/one-pager-templates/44')
      .set('Cookie', authCookie())
      .send({ name: 'Renamed' });
    expect(res.status).toBe(404);
  });

  test('delete is org-scoped', async () => {
    authAs('owner');
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 5 }] });
    const res = await request(buildApp())
      .delete('/api/one-pager-templates/5')
      .set('Cookie', authCookie());
    expect(res.status).toBe(200);
    const [sql, params] = mockPool.query.mock.calls[1];
    expect(sql).toContain('org_id = $2');
    expect(params).toEqual([5, ORG_ID]);
  });
});
