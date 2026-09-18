// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Outlook / M365 sync — msgraphSync.syncMailOrg / syncCalendarOrg +
// normalization helper tests. Mirrors test/calendarSync.test.js.
//
// Coverage:
//   PURE HELPERS
//     • msgraphMail.normalizeMessage  — Graph message → stub shape (participants deduped).
//     • msgraphSync.normalizeMsEvent  — Graph event → outlook_calendar_events shape.
//     • msgraphSync.eventParticipants — attendees + organizer, lowercased/deduped.
//     • msgraphSync.buildSince        — cursor (with 60s overlap) vs. lookback window.
//     • msgraphCalendar.toGraphEvent  — CRM-neutral input → Graph event resource.
//   syncMailOrg / syncCalendarOrg
//     • GRACEFUL: not configured → { configured:false }, no DB touched.
//     • GRACEFUL: no active connection → { connected:false }, no Graph fetch.
//     • HAPPY PATH: matches deal-linked items, upserts them ORG-SCOPED,
//       advances the per-surface cursor; unmatched items are skipped.
//     • Empty email index → no Graph fetch at all (quota saver).
//
// Same isolation pattern as test/calendarSync.test.js: mutate the live
// service exports in place and replace pool.query with an SQL-pattern-
// matching mock so we don't depend on exact call ordering. No live Graph
// API calls anywhere.

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

// Overwrite the live service exports msgraphSync depends on.
const msgraphClient = require('../services/msgraphClient');
msgraphClient.isConfigured   = vi.fn(async () => true);
msgraphClient.loadConnection = vi.fn();

const msgraphMail = require('../services/msgraphMail');
const msgraphCalendar = require('../services/msgraphCalendar');
const origListMessages = msgraphMail.listMessages;
const origListEvents = msgraphCalendar.listEvents;
msgraphMail.listMessages = vi.fn();
msgraphCalendar.listEvents = vi.fn();

const msgraphSync = require('../services/msgraphSync');

beforeEach(() => {
  mockPool.query.mockReset();
  msgraphClient.isConfigured.mockReset().mockResolvedValue(true);
  msgraphClient.loadConnection.mockReset();
  msgraphMail.listMessages.mockReset();
  msgraphCalendar.listEvents.mockReset();
});

// ============================================================================
// PURE HELPERS
// ============================================================================

describe('msgraphMail.normalizeMessage', () => {
  test('maps a Graph message resource to the stub shape, deduping participants', () => {
    const stub = msgraphMail.normalizeMessage({
      id: 'AAMk_1',
      conversationId: 'conv_1',
      subject: 'RE: pricing',
      bodyPreview: 'sounds good, see attached…',
      from: { emailAddress: { name: 'Vendor', address: 'Vendor@Example.com' } },
      toRecipients: [
        { emailAddress: { address: 'rep@us.com' } },
        { emailAddress: { address: 'VENDOR@example.com' } }, // dup of from
      ],
      ccRecipients: [{ emailAddress: { address: 'cc@third.com' } }],
      receivedDateTime: '2026-07-10T15:00:00Z',
      webLink: 'https://outlook.office365.com/mail/x',
    });
    expect(stub.msgraph_message_id).toBe('AAMk_1');
    expect(stub.conversation_id).toBe('conv_1');
    expect(stub.subject).toBe('RE: pricing');
    expect(stub.from_addr).toBe('vendor@example.com');
    expect(stub.participants).toEqual(
      expect.arrayContaining(['vendor@example.com', 'rep@us.com', 'cc@third.com'])
    );
    expect(stub.participants.length).toBe(3); // deduped
    expect(stub.received_at).toBe('2026-07-10T15:00:00Z');
  });

  test('tolerates a bare message', () => {
    const stub = msgraphMail.normalizeMessage({ id: 'x' });
    expect(stub.msgraph_message_id).toBe('x');
    expect(stub.participants).toEqual([]);
    expect(stub.to_addrs).toEqual([]);
  });
});

describe('msgraphSync.eventParticipants + normalizeMsEvent', () => {
  test('collects attendee + organizer emails, lowercased + deduped', () => {
    const out = msgraphSync.eventParticipants({
      attendees: [
        { emailAddress: { address: 'Vendor@Example.com' } },
        { emailAddress: { address: 'rep@us.com' } },
      ],
      organizer: { emailAddress: { address: 'REP@us.com' } }, // dup
    });
    expect(out).toEqual(expect.arrayContaining(['vendor@example.com', 'rep@us.com']));
    expect(out.length).toBe(2);
  });

  test('normalizeMsEvent maps subject/start/end/attendees/Teams link/status', () => {
    const norm = msgraphSync.normalizeMsEvent({
      id: 'evt_1',
      subject: 'Kickoff call',
      bodyPreview: 'agenda…',
      isCancelled: false,
      webLink: 'https://outlook.office365.com/calendar/item/x',
      onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
      start: { dateTime: '2026-07-10T15:00:00.0000000', timeZone: 'UTC' },
      end:   { dateTime: '2026-07-10T15:30:00.0000000', timeZone: 'UTC' },
      organizer: { emailAddress: { address: 'Rep@us.com' } },
      attendees: [{ emailAddress: { address: 'vendor@example.com' } }],
    });
    expect(norm.msgraph_event_id).toBe('evt_1');
    expect(norm.title).toBe('Kickoff call');
    expect(norm.meeting_link).toBe('https://teams.microsoft.com/l/meetup-join/abc');
    expect(norm.organizer_email).toBe('rep@us.com');
    expect(norm.status).toBe('confirmed');
    expect(norm.attendees).toEqual(expect.arrayContaining(['vendor@example.com', 'rep@us.com']));
    // Graph omits the Z; normalization appends exactly one.
    expect(norm.start_at).toBe('2026-07-10T15:00:00.0000000Z');
    expect(new Date(norm.start_at).toString()).not.toBe('Invalid Date');
  });

  test('cancelled events map to status cancelled', () => {
    const norm = msgraphSync.normalizeMsEvent({ id: 'evt_2', isCancelled: true });
    expect(norm.status).toBe('cancelled');
  });
});

describe('msgraphSync.buildSince', () => {
  test('uses the cursor (with a 60s overlap) when present', () => {
    const at = new Date('2026-06-10T12:00:00Z');
    const expected = new Date(at.getTime() - 60_000).toISOString();
    expect(msgraphSync.buildSince(at, 30)).toBe(expected);
  });
  test('falls back to a lookback window when no cursor', () => {
    const iso = msgraphSync.buildSince(null, 30);
    const approx = Date.now() - 30 * 86400 * 1000;
    expect(Math.abs(new Date(iso).getTime() - approx)).toBeLessThan(5000);
  });
});

describe('msgraphCalendar.toGraphEvent', () => {
  test('translates the CRM-neutral shape into a Graph event resource', () => {
    const ev = msgraphCalendar.toGraphEvent({
      title: 'Pricing review',
      description: 'walk through v2 quote',
      start_at: '2026-07-10T15:00:00Z',
      end_at: '2026-07-10T15:30:00Z',
      attendees: ['vendor@example.com'],
      location: 'Teams',
    });
    expect(ev.subject).toBe('Pricing review');
    expect(ev.body.content).toBe('walk through v2 quote');
    expect(ev.start.dateTime).toBe('2026-07-10T15:00:00.000Z');
    expect(ev.start.timeZone).toBe('UTC');
    expect(ev.attendees).toEqual([
      { emailAddress: { address: 'vendor@example.com' }, type: 'required' },
    ]);
    expect(ev.location.displayName).toBe('Teams');
  });
});

// ============================================================================
// syncMailOrg
// ============================================================================

describe('msgraphSync.syncMailOrg — graceful degradation', () => {
  test('returns { configured:false } and never touches the DB when not configured', async () => {
    msgraphClient.isConfigured.mockResolvedValueOnce(false);
    const out = await msgraphSync.syncMailOrg({ orgId: 1 });
    expect(out).toMatchObject({ configured: false, connected: false });
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(msgraphMail.listMessages).not.toHaveBeenCalled();
  });

  test('returns { connected:false } when the org has no active connection', async () => {
    const err = new Error('No Microsoft 365 connection for this org');
    err.code = 'MSGRAPH_NOT_CONNECTED';
    msgraphClient.loadConnection.mockRejectedValueOnce(err);

    const out = await msgraphSync.syncMailOrg({ orgId: 1 });
    expect(out).toMatchObject({ configured: true, connected: false, reason: 'MSGRAPH_NOT_CONNECTED' });
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(msgraphMail.listMessages).not.toHaveBeenCalled();
  });
});

describe('msgraphSync.syncMailOrg — happy path', () => {
  test('matches one of two discovered messages, upserts it org-scoped, advances the cursor', async () => {
    msgraphClient.loadConnection.mockResolvedValue({ id: 1, org_id: 1, last_mail_sync_at: null });

    const idxRows = [{ deal_id: 10, email: 'vendor@example.com', updated_at: new Date() }];

    msgraphMail.listMessages.mockResolvedValue([
      {
        msgraph_message_id: 'msg_match',
        conversation_id: 'conv_1',
        subject: 'RE: pricing',
        body_preview: 'sounds good',
        from_addr: 'vendor@example.com',
        to_addrs: ['rep@us.com'],
        participants: ['vendor@example.com', 'rep@us.com'],
        received_at: '2026-07-10T15:00:00Z',
        web_link: 'https://outlook.office365.com/mail/x',
      },
      {
        msgraph_message_id: 'msg_nomatch',
        conversation_id: 'conv_2',
        subject: 'Newsletter',
        participants: ['news@vendorblast.com'],
        to_addrs: [],
      },
    ]);

    mockPool.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/assoc/.test(s)) return Promise.resolve({ rows: idxRows });                        // loadDealEmailIndex
      if (/INSERT INTO outlook_messages/.test(s)) return Promise.resolve({ rows: [{ id: 77 }] }); // upsertMessage
      return Promise.resolve({ rows: [] });                                                  // status/cursor UPDATEs
    });

    const out = await msgraphSync.syncMailOrg({ orgId: 1 });

    expect(out).toMatchObject({
      configured: true,
      connected: true,
      messages_scanned: 2,
      messages_matched: 1,
    });
    expect(out.messages).toEqual([
      { deal_id: 10, outlook_message_id: 77, msgraph_message_id: 'msg_match' },
    ]);

    // Exactly one message upserted, org-scoped (org_id = 1 is the first param).
    const upserts = mockPool.query.mock.calls.filter((c) => /INSERT INTO outlook_messages/.test(String(c[0])));
    expect(upserts.length).toBe(1);
    expect(upserts[0][1][0]).toBe(1);   // org_id
    expect(upserts[0][1]).toEqual(expect.arrayContaining([10, 'msg_match']));

    // The mail cursor + status were advanced.
    const cursorUpdate = mockPool.query.mock.calls.find(
      (c) => /UPDATE org_msgraph_connections/.test(String(c[0])) && /last_mail_sync_at\s*=\s*NOW\(\)/.test(String(c[0]))
    );
    expect(cursorUpdate).toBeTruthy();
  });

  test('skips the Graph fetch entirely when no deals carry an email', async () => {
    msgraphClient.loadConnection.mockResolvedValue({ id: 1, org_id: 1, last_mail_sync_at: null });
    mockPool.query.mockImplementation((sql) => {
      if (/assoc/.test(String(sql))) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    const out = await msgraphSync.syncMailOrg({ orgId: 1 });
    expect(out).toMatchObject({ connected: true, messages_scanned: 0, messages_matched: 0 });
    expect(msgraphMail.listMessages).not.toHaveBeenCalled();
  });
});

// ============================================================================
// syncCalendarOrg
// ============================================================================

describe('msgraphSync.syncCalendarOrg — graceful degradation', () => {
  test('returns { configured:false } when not configured', async () => {
    msgraphClient.isConfigured.mockResolvedValueOnce(false);
    const out = await msgraphSync.syncCalendarOrg({ orgId: 1 });
    expect(out).toMatchObject({ configured: false, connected: false });
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(msgraphCalendar.listEvents).not.toHaveBeenCalled();
  });

  test('returns { connected:false } when the connection is inactive', async () => {
    const err = new Error('Microsoft 365 connection status is "revoked"');
    err.code = 'MSGRAPH_CONNECTION_INACTIVE';
    msgraphClient.loadConnection.mockRejectedValueOnce(err);

    const out = await msgraphSync.syncCalendarOrg({ orgId: 1 });
    expect(out).toMatchObject({ configured: true, connected: false, reason: 'MSGRAPH_CONNECTION_INACTIVE' });
  });
});

describe('msgraphSync.syncCalendarOrg — happy path', () => {
  test('matches one of two discovered events, upserts it org-scoped, advances the calendar cursor', async () => {
    msgraphClient.loadConnection.mockResolvedValue({ id: 1, org_id: 1, last_calendar_sync_at: null });

    const idxRows = [{ deal_id: 4, email: 'buyer@acme.com', updated_at: new Date() }];

    msgraphCalendar.listEvents.mockResolvedValue([
      {
        id: 'evt_match',
        subject: 'Contract review',
        isCancelled: false,
        start: { dateTime: '2026-07-10T15:00:00.0000000', timeZone: 'UTC' },
        end:   { dateTime: '2026-07-10T15:30:00.0000000', timeZone: 'UTC' },
        attendees: [{ emailAddress: { address: 'buyer@acme.com' } }],
        organizer: { emailAddress: { address: 'rep@us.com' } },
      },
      {
        id: 'evt_nomatch',
        subject: 'Dentist',
        start: { dateTime: '2026-07-11T09:00:00.0000000', timeZone: 'UTC' },
        end:   { dateTime: '2026-07-11T09:30:00.0000000', timeZone: 'UTC' },
        attendees: [{ emailAddress: { address: 'front-desk@dentist.com' } }],
      },
    ]);

    mockPool.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/assoc/.test(s)) return Promise.resolve({ rows: idxRows });
      if (/INSERT INTO outlook_calendar_events/.test(s)) return Promise.resolve({ rows: [{ id: 88 }] });
      return Promise.resolve({ rows: [] });
    });

    const out = await msgraphSync.syncCalendarOrg({ orgId: 1 });

    expect(out).toMatchObject({
      configured: true,
      connected: true,
      events_scanned: 2,
      events_matched: 1,
    });
    expect(out.events).toEqual([
      { deal_id: 4, outlook_event_id: 88, msgraph_event_id: 'evt_match' },
    ]);

    const upserts = mockPool.query.mock.calls.filter((c) => /INSERT INTO outlook_calendar_events/.test(String(c[0])));
    expect(upserts.length).toBe(1);
    expect(upserts[0][1][0]).toBe(1);   // org_id
    expect(upserts[0][1]).toEqual(expect.arrayContaining([4, 'evt_match', 'synced']));

    const cursorUpdate = mockPool.query.mock.calls.find(
      (c) => /UPDATE org_msgraph_connections/.test(String(c[0])) && /last_calendar_sync_at\s*=\s*NOW\(\)/.test(String(c[0]))
    );
    expect(cursorUpdate).toBeTruthy();
  });
});

// Restore the real client functions for any later suites in the same worker.
afterAll(() => {
  msgraphMail.listMessages = origListMessages;
  msgraphCalendar.listEvents = origListEvents;
});
