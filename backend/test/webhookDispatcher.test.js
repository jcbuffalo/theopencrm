// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Outbound webhook dispatcher tests.
//
// COVERAGE
//   1. signBody — HMAC-SHA256 over the raw body, sha256=<hex> shape
//   2. dispatch — posts to each subscribed webhook with a correct X-Signature
//   3. dispatch — event filtering is delegated to SQL ($event = ANY(events))
//   4. dispatch — no subscribers → no fetch, no delivery rows
//   5. dispatch — best-effort: a failing fetch is caught + logged, never thrown
//   6. deliverOne — records ok=true on 2xx, ok=false on a network error
//   7. decryptSecret / signing — signs with the DECRYPTED secret for an
//      encrypted (secret_ct/iv/tag) row, and falls back to the legacy plaintext
//      `secret` column for pre-migration-114 rows
//
// Mock the live pool export + global fetch — no real DB, no real network.

const crypto = require('crypto');

// A valid 32-byte key must exist before driveTokens caches it (mirrors
// test/quickbooksTokenEncryption.test.js). driveTokens is the shared
// AES-256-GCM helper webhookDispatcher uses to decrypt the signing secret.
process.env.DRIVE_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const driveTokens = require('../services/driveTokens');
driveTokens._resetForTests();

const realPool = require('../db');
const mockPool = realPool;
mockPool.query = vi.fn();

const dispatcher = require('../services/webhookDispatcher');

beforeEach(() => {
  mockPool.query.mockReset();
  mockPool.query.mockResolvedValue({ rows: [] }); // default: delivery-log inserts succeed
  global.fetch = vi.fn();
});

describe('webhookDispatcher.signBody', () => {
  test('produces an HMAC-SHA256 hex signature prefixed with sha256=', () => {
    const body = JSON.stringify({ event: 'ping', data: {} });
    const secret = 'whsec_test';
    const sig = dispatcher.signBody(body, secret);
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(sig).toBe(expected);
  });

  test('different secrets yield different signatures for the same body', () => {
    const body = '{"a":1}';
    expect(dispatcher.signBody(body, 's1')).not.toBe(dispatcher.signBody(body, 's2'));
  });
});

describe('webhookDispatcher.dispatch', () => {
  test('posts to each subscribed webhook with a matching X-Signature', async () => {
    // SELECT of active, subscribed webhooks.
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 1, url: 'https://hook.example.com/a', secret: 'whsec_a', events: ['deal.created'] },
        { id: 2, url: 'https://hook.example.com/b', secret: 'whsec_b', events: ['deal.created'] },
      ],
    });
    global.fetch.mockResolvedValue({ status: 200 });

    await dispatcher.dispatch(7, 'deal.created', { id: 42, title: 'Big deal' });

    expect(global.fetch).toHaveBeenCalledTimes(2);

    // Each call's body is the shared envelope; the signature must verify with
    // that webhook's own secret over the exact bytes posted.
    for (const [i, secret] of [[0, 'whsec_a'], [1, 'whsec_b']]) {
      const [url, init] = global.fetch.mock.calls[i];
      expect(url).toMatch(/hook\.example\.com/);
      expect(init.method).toBe('POST');
      const sentBody = init.body;
      expect(init.headers['X-Signature']).toBe(dispatcher.signBody(sentBody, secret));
      expect(init.headers['X-Webhook-Event']).toBe('deal.created');
      // Envelope carries the event + our payload.
      const parsed = JSON.parse(sentBody);
      expect(parsed.event).toBe('deal.created');
      expect(parsed.data.id).toBe(42);
    }
  });

  test('delegates event filtering to SQL ($2 = ANY(events))', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await dispatcher.dispatch(7, 'deal.stage_changed', {});
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toMatch(/active = TRUE/);
    expect(sql).toMatch(/\$2 = ANY\(events\)/);
    expect(params).toEqual([7, 'deal.stage_changed']);
  });

  test('no subscribers → no fetch and no delivery rows', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await dispatcher.dispatch(7, 'deal.created', {});
    expect(global.fetch).not.toHaveBeenCalled();
    // Only the SELECT ran — no INSERT into webhook_deliveries.
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  test('is best-effort: a fetch rejection is swallowed, not thrown', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 1, url: 'https://down.example.com', secret: 'whsec_a', events: ['deal.created'] }],
    });
    global.fetch.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(dispatcher.dispatch(7, 'deal.created', {})).resolves.toBeUndefined();
    // A delivery row is still logged (ok=false).
    const insert = mockPool.query.mock.calls.find(([sql]) => /INSERT INTO webhook_deliveries/.test(sql));
    expect(insert).toBeTruthy();
    // params: [webhookId, event, statusCode, ok, responseMs]
    expect(insert[1][3]).toBe(false); // ok
    expect(insert[1][2]).toBeNull();  // status_code null on network error
  });

  test('does nothing when orgId or event is missing', async () => {
    await dispatcher.dispatch(null, 'deal.created', {});
    await dispatcher.dispatch(7, '', {});
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});

describe('webhookDispatcher.deliverOne', () => {
  test('records ok=true on a 2xx response', async () => {
    global.fetch.mockResolvedValue({ status: 204 });
    await dispatcher.deliverOne({ id: 3, url: 'https://ok.example.com', secret: 's' }, 'ping', '{}');
    const insert = mockPool.query.mock.calls.find(([sql]) => /INSERT INTO webhook_deliveries/.test(sql));
    expect(insert[1][2]).toBe(204); // status_code
    expect(insert[1][3]).toBe(true); // ok
  });

  test('records ok=false and null status on a network error', async () => {
    global.fetch.mockRejectedValue(new Error('boom'));
    await dispatcher.deliverOne({ id: 3, url: 'https://x.example.com', secret: 's' }, 'ping', '{}');
    const insert = mockPool.query.mock.calls.find(([sql]) => /INSERT INTO webhook_deliveries/.test(sql));
    expect(insert[1][2]).toBeNull();
    expect(insert[1][3]).toBe(false);
  });
});

describe('webhookDispatcher — encrypted signing secret at rest (migration 114)', () => {
  test('decryptSecret round-trips a ciphertext row and falls back to legacy plaintext', () => {
    const enc = driveTokens.encrypt('whsec_secret_value');
    const encRow = { secret_ct: enc.ciphertext, secret_iv: enc.iv, secret_tag: enc.tag, secret: null };
    expect(dispatcher.decryptSecret(encRow)).toBe('whsec_secret_value');

    // Legacy row (created before 114): no ciphertext, plaintext in `secret`.
    const legacyRow = { secret: 'whsec_legacy_plaintext' };
    expect(dispatcher.decryptSecret(legacyRow)).toBe('whsec_legacy_plaintext');
  });

  test('deliverOne signs with the DECRYPTED secret for an encrypted row', async () => {
    const plaintextSecret = 'whsec_' + crypto.randomBytes(8).toString('hex');
    const enc = driveTokens.encrypt(plaintextSecret);
    // The row as it now lives in the DB: plaintext `secret` NULLed, ciphertext set.
    const row = { id: 9, url: 'https://enc.example.com', secret: null, secret_ct: enc.ciphertext, secret_iv: enc.iv, secret_tag: enc.tag };
    global.fetch.mockResolvedValue({ status: 200 });

    const rawBody = JSON.stringify({ event: 'ping', data: {} });
    await dispatcher.deliverOne(row, 'ping', rawBody);

    const [, init] = global.fetch.mock.calls[0];
    // Signature must verify against the DECRYPTED secret, never the (NULL) column.
    expect(init.headers['X-Signature']).toBe(dispatcher.signBody(rawBody, plaintextSecret));
  });

  test('deliverOne signs a legacy plaintext row exactly as before', async () => {
    const row = { id: 10, url: 'https://legacy.example.com', secret: 'whsec_legacy' };
    global.fetch.mockResolvedValue({ status: 200 });

    const rawBody = JSON.stringify({ event: 'ping', data: {} });
    await dispatcher.deliverOne(row, 'ping', rawBody);

    const [, init] = global.fetch.mock.calls[0];
    expect(init.headers['X-Signature']).toBe(dispatcher.signBody(rawBody, 'whsec_legacy'));
  });
});
