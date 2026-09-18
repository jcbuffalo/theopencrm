// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Calendar sync — calendarSync.syncOrg + matching/upsert helper tests.
//
// Coverage:
//   PURE HELPERS
//     • eventParticipants — collects attendee/organizer/creator emails, deduped.
//     • matchEventToDeal  — first matching participant wins; no-match → null.
//     • normalizeEvent    — maps a raw Google event → the calendar_events shape.
//     • buildUpdatedMin   — cursor (with 60s overlap) vs. lookback window.
//   syncOrg
//     • GRACEFUL: not configured → { configured:false }, no DB touched.
//     • GRACEFUL: no active connection → { connected:false }, no fetch.
//     • HAPPY PATH: matches one of two discovered events, upserts it, advances
//       the cursor; the unmatched event is skipped (never upserted).
//     • dedupe/skip: no deals carry an email → no Calendar fetch at all.
//
// Same isolation pattern as test/gmailInboundSync.test.js: mutate the live
// services/calendar exports in place (require returns the cached object
// calendarSync already holds), and replace pool.query with a mock that
// pattern-matches SQL so we don't depend on exact call ordering.

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

// Overwrite the live service exports calendarSync depends on.
const calendar = require('../services/calendar');
calendar.isConfigured   = vi.fn(async () => true);
calendar.loadConnection = vi.fn();
calendar.listEvents     = vi.fn();

const calendarSync = require('../services/calendarSync');

beforeEach(() => {
  mockPool.query.mockReset();
  calendar.isConfigured.mockReset().mockResolvedValue(true);
  calendar.loadConnection.mockReset();
  calendar.listEvents.mockReset();
});

// ============================================================================
// PURE HELPERS
// ============================================================================

describe('calendarSync.eventParticipants', () => {
  test('collects attendee + organizer + creator emails, lowercased + deduped', () => {
    const ev = {
      attendees: [{ email: 'Vendor@Example.com' }, { email: 'rep@us.com' }, { email: '' }],
      organizer: { email: 'REP@us.com' },  // dup of attendee (case-insensitive)
      creator:   { email: 'creator@x.com' },
    };
    const out = calendarSync.eventParticipants(ev);
    expect(out).toEqual(expect.arrayContaining(['vendor@example.com', 'rep@us.com', 'creator@x.com']));
    expect(out.length).toBe(3); // rep de-duped, blank dropped
  });
  test('tolerates a bare event with no participants', () => {
    expect(calendarSync.eventParticipants({})).toEqual([]);
    expect(calendarSync.eventParticipants(null)).toEqual([]);
  });
});

describe('calendarSync.matchEventToDeal', () => {
  const idx = new Map([['vendor@example.com', 10], ['buyer@acme.com', 4]]);
  test('returns the dealId of the first matching participant', () => {
    expect(calendarSync.matchEventToDeal(['rep@us.com', 'vendor@example.com'], idx)).toBe(10);
  });
  test('returns null when no participant matches', () => {
    expect(calendarSync.matchEventToDeal(['stranger@nowhere.com'], idx)).toBeNull();
    expect(calendarSync.matchEventToDeal([], idx)).toBeNull();
  });
});

describe('calendarSync.normalizeEvent', () => {
  test('maps summary/description/start/end/attendees/link', () => {
    const norm = calendarSync.normalizeEvent({
      id: 'evt_1',
      summary: 'Kickoff call',
      description: 'agenda…',
      status: 'confirmed',
      htmlLink: 'https://cal.google/evt_1',
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
      start: { dateTime: '2026-07-10T15:00:00Z' },
      end:   { dateTime: '2026-07-10T15:30:00Z' },
      organizer: { email: 'Rep@us.com' },
      attendees: [{ email: 'vendor@example.com' }, { email: 'rep@us.com' }],
    });
    expect(norm.google_event_id).toBe('evt_1');
    expect(norm.title).toBe('Kickoff call');
    expect(norm.start_at).toBe('2026-07-10T15:00:00Z');
    expect(norm.end_at).toBe('2026-07-10T15:30:00Z');
    expect(norm.meeting_link).toBe('https://meet.google.com/abc-defg-hij');
    expect(norm.organizer_email).toBe('rep@us.com');
    expect(norm.attendees).toEqual(expect.arrayContaining(['vendor@example.com', 'rep@us.com']));
    expect(norm.status).toBe('confirmed');
  });
  test('falls back to conferenceData video entry point for the meeting link', () => {
    const norm = calendarSync.normalizeEvent({
      id: 'evt_2',
      start: { dateTime: '2026-07-10T15:00:00Z' },
      end:   { dateTime: '2026-07-10T15:30:00Z' },
      conferenceData: { entryPoints: [
        { entryPointType: 'phone', uri: 'tel:+123' },
        { entryPointType: 'video', uri: 'https://zoom.us/j/123' },
      ] },
    });
    expect(norm.meeting_link).toBe('https://zoom.us/j/123');
  });
  test('handles all-day events (date, not dateTime)', () => {
    const norm = calendarSync.normalizeEvent({
      id: 'evt_3',
      start: { date: '2026-07-10' },
      end:   { date: '2026-07-11' },
    });
    expect(norm.start_at).toBe('2026-07-10');
    expect(norm.end_at).toBe('2026-07-11');
  });
});

describe('calendarSync.buildUpdatedMin', () => {
  test('uses the cursor (with a 60s overlap) when present', () => {
    const at = new Date('2026-06-10T12:00:00Z');
    const expected = new Date(at.getTime() - 60_000).toISOString();
    expect(calendarSync.buildUpdatedMin(at, 30)).toBe(expected);
  });
  test('falls back to a lookback window when no cursor', () => {
    const iso = calendarSync.buildUpdatedMin(null, 30);
    const epoch = new Date(iso).getTime();
    const approx = Date.now() - 30 * 86400 * 1000;
    expect(Math.abs(epoch - approx)).toBeLessThan(5000); // within 5s
  });
});

// ============================================================================
// syncOrg — graceful degradation
// ============================================================================

describe('calendarSync.syncOrg — graceful degradation', () => {
  test('returns { configured:false } and never touches the DB when Calendar is not configured', async () => {
    calendar.isConfigured.mockResolvedValueOnce(false);
    const out = await calendarSync.syncOrg({ orgId: 1 });
    expect(out).toMatchObject({ configured: false, connected: false });
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(calendar.listEvents).not.toHaveBeenCalled();
  });

  test('returns { connected:false } when the org has no active connection', async () => {
    const err = new Error('No Calendar connection for this org');
    err.code = 'CALENDAR_NOT_CONNECTED';
    calendar.loadConnection.mockRejectedValueOnce(err);

    const out = await calendarSync.syncOrg({ orgId: 1 });
    expect(out).toMatchObject({ configured: true, connected: false, reason: 'CALENDAR_NOT_CONNECTED' });
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(calendar.listEvents).not.toHaveBeenCalled();
  });
});

// ============================================================================
// syncOrg — happy path (discover → match → upsert)
// ============================================================================

describe('calendarSync.syncOrg — happy path', () => {
  test('matches one of two discovered events, upserts it, advances the cursor', async () => {
    calendar.loadConnection.mockResolvedValue({ id: 1, org_id: 1, last_sync_at: null });

    // Email index: vendor@example.com → deal 10.
    const idxRows = [{ deal_id: 10, email: 'vendor@example.com', updated_at: new Date() }];

    // Two discovered events: e1 matches (vendor attendee), e2 does not.
    calendar.listEvents.mockResolvedValue([
      {
        id: 'evt_match',
        summary: 'Pricing review',
        status: 'confirmed',
        start: { dateTime: '2026-07-10T15:00:00Z' },
        end:   { dateTime: '2026-07-10T15:30:00Z' },
        attendees: [{ email: 'vendor@example.com' }, { email: 'rep@us.com' }],
      },
      {
        id: 'evt_nomatch',
        summary: 'Dentist',
        start: { dateTime: '2026-07-11T09:00:00Z' },
        end:   { dateTime: '2026-07-11T09:30:00Z' },
        attendees: [{ email: 'front-desk@dentist.com' }],
      },
    ]);

    // SQL-aware pool mock — order-independent.
    mockPool.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/assoc/.test(s)) return Promise.resolve({ rows: idxRows });                      // loadDealEmailIndex
      if (/INSERT INTO calendar_events/.test(s)) return Promise.resolve({ rows: [{ id: 55 }] }); // upsertEvent
      return Promise.resolve({ rows: [] });                                                // in_progress + cursor UPDATEs
    });

    const out = await calendarSync.syncOrg({ orgId: 1 });

    expect(out).toMatchObject({
      configured: true,
      connected: true,
      events_scanned: 2,
      events_matched: 1,
    });
    expect(out.events).toEqual([
      { deal_id: 10, calendar_event_id: 55, google_event_id: 'evt_match' },
    ]);

    // Exactly one event was upserted (the unmatched one is skipped).
    const upserts = mockPool.query.mock.calls.filter((c) => /INSERT INTO calendar_events/.test(String(c[0])));
    expect(upserts.length).toBe(1);
    // ...and it carried source='synced' + deal 10.
    expect(upserts[0][1]).toEqual(expect.arrayContaining([10, 'evt_match', 'synced']));

    // The cursor + status were advanced to 'ok'.
    const cursorUpdate = mockPool.query.mock.calls.find(
      (c) => /UPDATE org_calendar_connections/.test(String(c[0])) && /last_sync_at\s*=\s*NOW\(\)/.test(String(c[0]))
    );
    expect(cursorUpdate).toBeTruthy();
  });

  test('skips the Calendar fetch entirely when no deals carry an email', async () => {
    calendar.loadConnection.mockResolvedValue({ id: 1, org_id: 1, last_sync_at: null });
    mockPool.query.mockImplementation((sql) => {
      if (/assoc/.test(String(sql))) return Promise.resolve({ rows: [] }); // empty index
      return Promise.resolve({ rows: [] });
    });

    const out = await calendarSync.syncOrg({ orgId: 1 });
    expect(out).toMatchObject({ connected: true, events_scanned: 0, events_matched: 0 });
    expect(calendar.listEvents).not.toHaveBeenCalled();
  });
});
