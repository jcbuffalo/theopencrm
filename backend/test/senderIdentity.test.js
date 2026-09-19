// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Outbound sender identity (Wave 2, 2026-09-19): per-org From: display name +
// Reply-To stored on organizations.branding.email, read by the one-off
// composer send and the sequence worker.
//
//   1. resolveFromOrg: custom name wins over displayName over org name;
//      Reply-To validated; header-breaking characters stripped.
//   2. normalizeInput: clears on null/'', rejects bad addresses / injections.
//   3. email.fromHeader: verbatim vs "<Org> via <Product>" default.
//   4. GET/PUT /api/org/email-identity: member reads, member PUT 403, owner
//      PUT merges into branding.email + audits, 400 on a bad reply_to.
//   5. POST /api/emails/send uses the identity (From verbatim, Reply-To,
//      List-Unsubscribe header, plain-text unsubscribe footer).

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/logger', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), notice: vi.fn(), debug: vi.fn(),
}));

const audit = require('../services/audit');
audit.record  = vi.fn().mockResolvedValue(null);
audit.fromReq = vi.fn();

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { generateToken, AUTH_COOKIE_NAME } = require('../auth');
const email = require('../services/email');
const senderIdentity = require('../services/senderIdentity');
const orgRoutes = require('../routes/orgRoutes');
const emailRoutes = require('../routes/emailRoutes');

const USER_ID = 6101;
const ORG_ID  = 61;
function authCookie() { return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`]; }

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  app.use('/api/org', orgRoutes);
  app.use('/api/emails', emailRoutes);
  return app;
}

// SQL-shape router. `branding` is the stored org branding JSONB.
function wirePool({ orgRole = 'owner', branding = {}, captured = [] } = {}) {
  let current = branding;
  mockPool.query.mockImplementation(async (sql, params) => {
    const q = String(sql);
    captured.push({ sql: q, params });
    if (/FROM admin_users/i.test(q)) return { rows: [] };
    if (/FROM users WHERE id/i.test(q)) return { rows: [{ org_id: ORG_ID, org_role: orgRole, status: 'active', email: 'rep@acme.example', name: 'Rep' }] };
    if (/SELECT name, branding FROM organizations/i.test(q)) return { rows: [{ name: 'Acme Co', branding: current }] };
    if (/SELECT branding FROM organizations/i.test(q)) return { rows: [{ branding: current }] };
    if (/UPDATE organizations/i.test(q) && /jsonb_build_object\('email'/i.test(q)) {
      current = { ...current, email: JSON.parse(params[1]) };
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT email, name FROM users/i.test(q)) return { rows: [{ email: 'rep@acme.example', name: 'Rep' }] };
    if (/FROM email_unsubscribes/i.test(q)) return { rows: [] };
    if (/INSERT INTO email_sends/i.test(q)) return { rows: [{ id: 901 }] };
    return { rows: [], rowCount: 0 };
  });
  // The /send route uses a dedicated client for its txn.
  mockPool.connect.mockResolvedValue({ query: (...a) => mockPool.query(...a), release: vi.fn() });
  return captured;
}

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.connect.mockReset();
  audit.fromReq.mockReset();
});

describe('services/senderIdentity', () => {
  test('resolveFromOrg: custom sender name wins, then displayName, then org name', () => {
    expect(senderIdentity.resolveFromOrg({ name: 'Acme Co', branding: {} }))
      .toMatchObject({ fromName: 'Acme Co', fromNameIsCustom: false, replyTo: null });
    expect(senderIdentity.resolveFromOrg({ name: 'Acme Co', branding: { displayName: 'Acme Corporation' } }))
      .toMatchObject({ fromName: 'Acme Corporation', fromNameIsCustom: false });
    expect(senderIdentity.resolveFromOrg({ name: 'Acme Co', branding: { displayName: 'Acme Corporation', email: { senderName: 'John Coles', replyTo: 'john@acme.example' } } }))
      .toMatchObject({ fromName: 'John Coles', fromNameIsCustom: true, replyTo: 'john@acme.example', sender_name: 'John Coles', reply_to: 'john@acme.example' });
    // Missing / malformed row → platform defaults, never throws.
    expect(senderIdentity.resolveFromOrg(null)).toMatchObject({ fromName: null, replyTo: null });
    expect(senderIdentity.resolveFromOrg({ name: 'X', branding: 'garbage' })).toMatchObject({ fromName: 'X' });
  });

  test('resolveFromOrg: header-breaking characters are stripped; bad Reply-To ignored; fallback Reply-To applies', () => {
    const r = senderIdentity.resolveFromOrg(
      { name: 'Acme', branding: { email: { senderName: 'Evil <x@y.z>\r\nBcc: a@b.c', replyTo: 'not-an-email' } } },
      { fallbackReplyTo: 'rep@acme.example' }
    );
    expect(r.fromName).toBe('Evil x@y.z Bcc: a@b.c');
    expect(r.fromName).not.toMatch(/[\r\n<>"]/);
    expect(r.replyTo).toBe('rep@acme.example');
  });

  test('normalizeInput: clears on null / empty, rejects bad addresses and injections, needs at least one key', () => {
    expect(senderIdentity.normalizeInput({ sender_name: '  John Coles ', reply_to: 'John@Acme.Example' }))
      .toEqual({ value: { sender_name: 'John Coles', reply_to: 'john@acme.example' } });
    expect(senderIdentity.normalizeInput({ sender_name: null, reply_to: '' }))
      .toEqual({ value: { sender_name: null, reply_to: null } });
    expect(senderIdentity.normalizeInput({ reply_to: 'nope' }).error).toMatch(/valid email/);
    expect(senderIdentity.normalizeInput({ reply_to: 'a@b.co,c@d.co' }).error).toMatch(/valid email/);
    expect(senderIdentity.normalizeInput({ sender_name: 42 }).error).toMatch(/string/);
    expect(senderIdentity.normalizeInput({}).error).toMatch(/Provide/);
    // Only `reply_to` present → sender_name left undefined (untouched).
    expect(senderIdentity.normalizeInput({ reply_to: 'a@b.co' }).value).toEqual({ reply_to: 'a@b.co' });
  });

  test('email.fromHeader: verbatim custom name vs "<Org> via <Product>" default', () => {
    expect(email.fromHeader({ fromName: 'John Coles', verbatim: true })).toMatch(/^"John Coles" </);
    expect(email.fromHeader({ fromName: 'Acme Co' })).toMatch(/^"Acme Co via The Open CRM" </);
    expect(email.fromHeader({})).toMatch(/^"The Open CRM" </);
  });
});

describe('GET/PUT /api/org/email-identity', () => {
  test('a member reads the stored identity + effective From: preview', async () => {
    wirePool({ orgRole: 'member', branding: { email: { senderName: 'John Coles', replyTo: 'john@acme.example' } } });
    const res = await request(buildApp()).get('/api/org/email-identity').set('Cookie', authCookie());
    expect(res.status).toBe(200);
    expect(res.body.sender_name).toBe('John Coles');
    expect(res.body.reply_to).toBe('john@acme.example');
    expect(res.body.effective.from).toMatch(/^"John Coles" </);
    expect(res.body.effective.reply_to).toBe('john@acme.example');
    expect(typeof res.body.email_configured).toBe('boolean');
  });

  test('a plain member cannot change it (403)', async () => {
    wirePool({ orgRole: 'member' });
    const res = await request(buildApp()).put('/api/org/email-identity').set('Cookie', authCookie())
      .send({ sender_name: 'Mallory' });
    expect(res.status).toBe(403);
    expect(audit.fromReq).not.toHaveBeenCalled();
  });

  test('an owner sets both, the write merges into branding.email and is audited', async () => {
    const captured = wirePool({ orgRole: 'owner', branding: { displayName: 'Acme Corporation' } });
    const res = await request(buildApp()).put('/api/org/email-identity').set('Cookie', authCookie())
      .send({ sender_name: 'John Coles', reply_to: 'John@Acme.Example' });
    expect(res.status).toBe(200);
    expect(res.body.sender_name).toBe('John Coles');
    expect(res.body.reply_to).toBe('john@acme.example');
    expect(res.body.effective.from).toMatch(/^"John Coles" </);
    const upd = captured.find((c) => /UPDATE organizations/i.test(c.sql));
    expect(upd.params[0]).toBe(ORG_ID);
    expect(JSON.parse(upd.params[1])).toEqual({ senderName: 'John Coles', replyTo: 'john@acme.example' });
    expect(audit.fromReq).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'org.email_identity.updated',
      meta: { fields: ['sender_name', 'reply_to'] },
    }));
  });

  test('clearing the reply_to removes the key; a bad reply_to is a 400', async () => {
    const captured = wirePool({ orgRole: 'owner', branding: { email: { senderName: 'John Coles', replyTo: 'john@acme.example' } } });
    const ok = await request(buildApp()).put('/api/org/email-identity').set('Cookie', authCookie())
      .send({ reply_to: null });
    expect(ok.status).toBe(200);
    expect(ok.body.reply_to).toBeNull();
    expect(ok.body.sender_name).toBe('John Coles');
    const upd = captured.find((c) => /UPDATE organizations/i.test(c.sql));
    expect(JSON.parse(upd.params[1])).toEqual({ senderName: 'John Coles' });

    const bad = await request(buildApp()).put('/api/org/email-identity').set('Cookie', authCookie())
      .send({ reply_to: 'not an address' });
    expect(bad.status).toBe(400);
  });
});

describe('POST /api/emails/send uses the org sender identity', () => {
  test('From is the custom name verbatim, Reply-To is the org reply-to, List-Unsubscribe + text footer present', async () => {
    wirePool({ orgRole: 'member', branding: { email: { senderName: 'John Coles', replyTo: 'john@acme.example' } } });
    const sendSpy = vi.spyOn(email, 'sendMail').mockResolvedValue({ ok: true, kind: 'gmail', messageId: 'm-1' });
    const res = await request(buildApp()).post('/api/emails/send').set('Cookie', authCookie())
      .send({ to_email: 'dana@bravo.example', subject: 'Hello', body: 'Quick note.' });
    expect(res.status).toBe(200);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const mail = sendSpy.mock.calls[0][0];
    expect(mail.fromName).toBe('John Coles');
    expect(mail.fromNameVerbatim).toBe(true);
    expect(mail.replyTo).toBe('john@acme.example');
    expect(mail.listUnsubscribe).toMatch(/\/api\/emails\/unsubscribe\/[a-f0-9]{48}$/);
    expect(mail.text).toMatch(/Quick note\.\n\n--\nUnsubscribe from these messages: .*\/api\/emails\/unsubscribe\//);
    sendSpy.mockRestore();
  });

  test('with no identity set, From falls back to "<Org> via …" and Reply-To to the sending user', async () => {
    wirePool({ orgRole: 'member', branding: {} });
    const sendSpy = vi.spyOn(email, 'sendMail').mockResolvedValue({ ok: true, kind: 'gmail', messageId: 'm-2' });
    const res = await request(buildApp()).post('/api/emails/send').set('Cookie', authCookie())
      .send({ to_email: 'dana@bravo.example', subject: 'Hello', body: 'Quick note.' });
    expect(res.status).toBe(200);
    const mail = sendSpy.mock.calls[0][0];
    expect(mail.fromName).toBe('Acme Co');
    expect(mail.fromNameVerbatim).toBe(false);
    expect(mail.replyTo).toBe('rep@acme.example');
    sendSpy.mockRestore();
  });
});
