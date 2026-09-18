// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Inbound email sync — gmailSync.syncOrg + matching/upsert helper tests.
//
// Coverage:
//   PURE HELPERS
//     • extractEmailAddr — pulls a bare address out of assorted header forms.
//     • buildEmailIndex  — dedupes, first-(most-recent)-wins, drops blanks.
//     • matchThreadToDeal — first matching participant wins; no-match → null.
//     • buildSyncQuery   — cursor vs. lookback window.
//   syncOrg
//     • GRACEFUL: not configured → { configured:false }, no DB touched.
//     • GRACEFUL: no active connection → { connected:false }, no fetch.
//     • HAPPY PATH: matches one of two discovered threads, links + syncs it,
//       dedupe-upserts its message, advances the cursor.
//
// Same isolation pattern as test/gmailSummary.test.js: mutate the live
// services/gmail + services/gmailExtract exports in place (require returns the
// cached object gmailSync already holds), and replace pool.query with a mock
// that pattern-matches SQL so we don't depend on exact call ordering.

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

// Overwrite the live service exports gmailSync depends on.
const gmail = require('../services/gmail');
gmail.isConfigured  = vi.fn(async () => true);
gmail.loadConnection = vi.fn();
gmail.searchThreads = vi.fn();
gmail.fetchThread   = vi.fn();

const gmailExtract = require('../services/gmailExtract');
gmailExtract.extractMessage = vi.fn();

const gmailSync = require('../services/gmailSync');

beforeEach(() => {
  mockPool.query.mockReset();
  gmail.isConfigured.mockReset().mockResolvedValue(true);
  gmail.loadConnection.mockReset();
  gmail.searchThreads.mockReset();
  gmail.fetchThread.mockReset();
  gmailExtract.extractMessage.mockReset();
});

// ============================================================================
// PURE HELPERS
// ============================================================================

describe('gmailSync.extractEmailAddr', () => {
  test('pulls the address out of a display-name form', () => {
    expect(gmailSync.extractEmailAddr('"Jane Doe" <jane@example.com>')).toBe('jane@example.com');
  });
  test('lowercases and trims a bare address', () => {
    expect(gmailSync.extractEmailAddr('  JANE@Example.COM ')).toBe('jane@example.com');
  });
  test('returns null when there is no address', () => {
    expect(gmailSync.extractEmailAddr('Jane Doe')).toBeNull();
    expect(gmailSync.extractEmailAddr('')).toBeNull();
    expect(gmailSync.extractEmailAddr(null)).toBeNull();
  });
});

describe('gmailSync.buildEmailIndex', () => {
  test('dedupes, keeps the first (most-recent) deal, drops blanks', () => {
    const rows = [
      { deal_id: 10, email: 'vendor@example.com', updated_at: '2026-06-10' }, // most recent
      { deal_id: 7,  email: 'VENDOR@example.com', updated_at: '2026-06-01' }, // same addr, older deal
      { deal_id: 3,  email: '',                    updated_at: '2026-05-01' }, // blank — dropped
      { deal_id: 4,  email: 'buyer@acme.com',      updated_at: '2026-04-01' },
    ];
    const idx = gmailSync.buildEmailIndex(rows);
    expect(idx.get('vendor@example.com')).toBe(10); // first-wins
    expect(idx.get('buyer@acme.com')).toBe(4);
    expect(idx.size).toBe(2);
  });
});

describe('gmailSync.matchThreadToDeal', () => {
  const idx = new Map([['vendor@example.com', 10], ['buyer@acme.com', 4]]);
  test('returns the dealId of the first matching participant', () => {
    expect(gmailSync.matchThreadToDeal(['rep@us.com', '"V" <vendor@example.com>'], idx)).toBe(10);
  });
  test('returns null when no participant matches', () => {
    expect(gmailSync.matchThreadToDeal(['stranger@nowhere.com'], idx)).toBeNull();
    expect(gmailSync.matchThreadToDeal([], idx)).toBeNull();
  });
});

describe('gmailSync.buildSyncQuery', () => {
  test('uses the cursor (with a 60s overlap) when present', () => {
    const at = new Date('2026-06-10T12:00:00Z');
    const expected = Math.floor(at.getTime() / 1000) - 60;
    expect(gmailSync.buildSyncQuery(at, 30)).toBe(`after:${expected}`);
  });
  test('falls back to a lookback window when no cursor', () => {
    const q = gmailSync.buildSyncQuery(null, 30);
    expect(q).toMatch(/^after:\d+$/);
    const epoch = Number(q.split(':')[1]);
    const approx = Math.floor((Date.now() - 30 * 86400 * 1000) / 1000);
    expect(Math.abs(epoch - approx)).toBeLessThan(5); // within 5s
  });
});

// ============================================================================
// syncOrg — graceful degradation
// ============================================================================

describe('gmailSync.syncOrg — graceful degradation', () => {
  test('returns { configured:false } and never touches the DB when Gmail is not configured', async () => {
    gmail.isConfigured.mockResolvedValueOnce(false);
    const out = await gmailSync.syncOrg({ orgId: 1 });
    expect(out).toMatchObject({ configured: false, connected: false });
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(gmail.searchThreads).not.toHaveBeenCalled();
  });

  test('returns { connected:false } when the org has no active connection', async () => {
    const err = new Error('No Gmail connection for this org');
    err.code = 'GMAIL_NOT_CONNECTED';
    gmail.loadConnection.mockRejectedValueOnce(err);

    const out = await gmailSync.syncOrg({ orgId: 1 });
    expect(out).toMatchObject({ configured: true, connected: false, reason: 'GMAIL_NOT_CONNECTED' });
    // No in-progress UPDATE — we bail before marking state.
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(gmail.searchThreads).not.toHaveBeenCalled();
  });
});

// ============================================================================
// syncOrg — happy path (discover → match → link → sync)
// ============================================================================

describe('gmailSync.syncOrg — happy path', () => {
  test('matches one of two discovered threads, links + syncs its message', async () => {
    gmail.loadConnection.mockResolvedValue({ id: 1, org_id: 1, last_inbound_sync_at: null });

    // Email index: vendor@example.com → deal 10.
    const idxRows = [{ deal_id: 10, email: 'vendor@example.com', updated_at: new Date() }];

    // Two discovered threads: t1 matches (vendor participant), t2 does not.
    gmail.searchThreads.mockResolvedValue([
      {
        gmail_thread_id: 't1',
        subject: 'RE: RFQ for widgets',
        participants: ['"Vendor" <vendor@example.com>', 'rep@us.com'],
        message_count: 1,
        last_message_at: '2026-06-10T12:00:00Z',
      },
      {
        gmail_thread_id: 't2',
        subject: 'Unrelated newsletter',
        participants: ['news@nowhere.com'],
        message_count: 1,
        last_message_at: '2026-06-09T12:00:00Z',
      },
    ]);

    // Full-thread fetch for the matched thread → one plain-text message.
    gmail.fetchThread.mockResolvedValue({
      messages: [{
        id: 'm1',
        internalDate: String(Date.parse('2026-06-10T12:00:00Z')),
        snippet: 'here is our price',
        payload: { headers: [
          { name: 'From', value: 'vendor@example.com' },
          { name: 'To', value: 'rep@us.com' },
          { name: 'Subject', value: 'RE: RFQ for widgets' },
        ] },
      }],
    });
    gmailExtract.extractMessage.mockReturnValue({
      status: 'done', plaintext: 'Our price is $48,500.', attachmentNames: [], error: null,
    });

    // SQL-aware pool mock — order-independent.
    mockPool.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/assoc/.test(s)) return Promise.resolve({ rows: idxRows });           // loadDealEmailIndex
      if (/INSERT INTO deal_email_threads/.test(s)) return Promise.resolve({ rows: [{ id: 55 }] }); // upsertThreadLink
      if (/SELECT id, org_id, deal_id, gmail_thread_id/.test(s)) {              // sync() link verify
        return Promise.resolve({ rows: [{ id: 55, org_id: 1, deal_id: 10, gmail_thread_id: 't1' }] });
      }
      return Promise.resolve({ rows: [] });                                     // all UPDATEs / message upsert
    });

    const out = await gmailSync.syncOrg({ orgId: 1 });

    expect(out).toMatchObject({
      configured: true,
      connected: true,
      threads_scanned: 2,
      threads_matched: 1,
      messages_synced: 1,
    });
    expect(out.threads).toEqual([
      { deal_id: 10, thread_link_id: 55, gmail_thread_id: 't1', synced: 1 },
    ]);

    // Only the matched thread was fetched in full (t2 never hits fetchThread).
    expect(gmail.fetchThread).toHaveBeenCalledTimes(1);
    expect(gmail.fetchThread).toHaveBeenCalledWith(1, 't1');

    // The link was upserted with link_source='auto_sync'.
    const linkInsert = mockPool.query.mock.calls.find((c) => /INSERT INTO deal_email_threads/.test(String(c[0])));
    expect(linkInsert).toBeTruthy();
    expect(String(linkInsert[0])).toMatch(/auto_sync/);

    // The cursor + status were advanced to 'ok'.
    const cursorUpdate = mockPool.query.mock.calls.find(
      (c) => /UPDATE org_gmail_connections/.test(String(c[0])) && /last_inbound_sync_at\s*=\s*NOW\(\)/.test(String(c[0]))
    );
    expect(cursorUpdate).toBeTruthy();
  });

  test('skips the Gmail fetch entirely when no deals carry an email', async () => {
    gmail.loadConnection.mockResolvedValue({ id: 1, org_id: 1, last_inbound_sync_at: null });
    mockPool.query.mockImplementation((sql) => {
      if (/assoc/.test(String(sql))) return Promise.resolve({ rows: [] }); // empty index
      return Promise.resolve({ rows: [] });
    });

    const out = await gmailSync.syncOrg({ orgId: 1 });
    expect(out).toMatchObject({ connected: true, threads_scanned: 0, threads_matched: 0, messages_synced: 0 });
    expect(gmail.searchThreads).not.toHaveBeenCalled();
  });
});
