// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Gmail Intel — gmailSummary service tests.
//
// We cover the four error/happy paths called out in the spec:
//   1. HAPPY PATH — mocked ai.callClaude returns valid JSON, insert succeeds.
//   2. UNPARSEABLE-THEN-RETRY — first call returns garbage, retry returns
//      valid JSON, insert succeeds (single retry policy per the service
//      doc-comment).
//   3. QUOTA pass-through — services/ai returns QUOTA_EXCEEDED, surfaces
//      as { code: 'QUOTA_EXCEEDED', statusCode: 402 }.
//   4. EMPTY THREAD — no email_thread_messages rows with extraction_status
//      = 'done' for the link → 422 NO_EXTRACTED_CONTENT with details
//      flagging `no_extracted_content`.
//
// We avoid hitting real Claude by overwriting services/ai's exports
// in-place — same pattern as test/intelSummary.test.js. We avoid hitting
// real Postgres by replacing pool.query with a mock.

// describe / test / expect / beforeEach / vi are global (vitest).

// Patch the pool — same pattern as the other vitest suites.
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

// Overwrite the live services/ai exports — gmailSummary does
// `const ai = require('./ai')`, so a mutation propagates.
const ai = require('../services/ai');
ai.isConfigured = vi.fn(() => true);
ai.callClaude   = vi.fn();

const gmailSummary = require('../services/gmailSummary');

beforeEach(() => {
  mockPool.query.mockReset();
  ai.callClaude.mockReset();
  ai.isConfigured.mockReturnValue(true);
});

// Helper — one valid extracted message row.
function fakeMessage(overrides = {}) {
  return {
    gmail_message_id: 'm1',
    internal_date:    new Date('2026-06-10T12:00:00Z'),
    from_addr:        'vendor@example.com',
    to_addrs:         ['rep@example.com'],
    subject:          'RE: RFQ for widgets',
    snippet:          'thanks for the RFQ…',
    body_text:        'Here is our quoted price: $48,500. Lead time 6 weeks.',
    attachment_names: [],
    ...overrides,
  };
}

// Standard happy-path Claude reply.
const HAPPY_JSON = JSON.stringify({
  summary_md: 'Vendor responded with a price quote of $48,500 and a 6-week lead time.',
  key_facts: [
    { label: 'Quoted price', value: '$48,500', source_message_id: 'm1' },
    { label: 'Lead time',    value: '6 weeks',  source_message_id: 'm1' },
  ],
  next_step: 'Confirm acceptance with the customer before vendor quote expires.',
});

// ============================================================================
// 1. HAPPY PATH
// ============================================================================

describe('gmailSummary.generate — happy path', () => {
  test('persists a row and returns it when Claude returns valid JSON', async () => {
    // 1) link verification query → row exists
    // 2) loadMessagesForThread query → one extracted message
    // 3) insert returns the new row
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 99 }] })
      .mockResolvedValueOnce({ rows: [fakeMessage()] })
      .mockResolvedValueOnce({
        rows: [{
          id: 5, org_id: 1, deal_id: 10, thread_link_id: 99,
          summary_md: 'Vendor responded with a price quote of $48,500 and a 6-week lead time.',
          key_facts: [
            { label: 'Quoted price', value: '$48,500', source_message_id: 'm1' },
            { label: 'Lead time',    value: '6 weeks',  source_message_id: 'm1' },
          ],
          next_step: 'Confirm acceptance with the customer before vendor quote expires.',
          prompt_version: 'gmail-intel-v1',
          generated_at: new Date(),
          generated_by_user_id: 7,
          ai_input_tokens: 120, ai_output_tokens: 80,
          ai_model: 'claude-sonnet-4-6',
        }],
      });

    ai.callClaude.mockResolvedValue({
      configured: true, ok: true,
      text: HAPPY_JSON,
      usage: { input_tokens: 120, output_tokens: 80 },
    });

    const row = await gmailSummary.generate({
      orgId: 1, dealId: 10, threadLinkId: 99, userId: 7,
    });
    expect(row.summary_md).toMatch(/Vendor responded/);
    expect(row.next_step).toMatch(/Confirm acceptance/);
    expect(row.key_facts).toHaveLength(2);
    expect(ai.callClaude).toHaveBeenCalledTimes(1);
    // Verify the call was tagged with the gmail-intel endpoint label so cost
    // attribution lands in the right ai_usage_events bucket.
    expect(ai.callClaude.mock.calls[0][0]).toMatchObject({
      endpoint: 'gmail-intel',
      orgId: 1,
      userId: 7,
    });
  });
});

// ============================================================================
// 2. UNPARSEABLE-THEN-RETRY
// ============================================================================

describe('gmailSummary.generate — single retry on unparseable reply', () => {
  test('retries once when the first reply is not parseable; succeeds on retry', async () => {
    // Pool: link check → messages → insert
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 99 }] })
      .mockResolvedValueOnce({ rows: [fakeMessage()] })
      .mockResolvedValueOnce({
        rows: [{
          id: 5, org_id: 1, deal_id: 10, thread_link_id: 99,
          summary_md: 'Recovered summary',
          key_facts: [],
          next_step: null,
          prompt_version: 'gmail-intel-v1',
          generated_at: new Date(),
          ai_input_tokens: 20, ai_output_tokens: 30,
          ai_model: 'claude-sonnet-4-6',
        }],
      });

    ai.callClaude
      .mockResolvedValueOnce({
        configured: true, ok: true,
        text: 'I am sorry, I cannot output JSON for legal reasons.',
        usage: { input_tokens: 10, output_tokens: 12 },
      })
      .mockResolvedValueOnce({
        configured: true, ok: true,
        text: JSON.stringify({
          summary_md: 'Recovered summary',
          key_facts: [],
          next_step: null,
        }),
        usage: { input_tokens: 20, output_tokens: 30 },
      });

    const row = await gmailSummary.generate({
      orgId: 1, dealId: 10, threadLinkId: 99,
    });
    expect(row.summary_md).toBe('Recovered summary');
    expect(ai.callClaude).toHaveBeenCalledTimes(2);
    // The retry prompt should carry the "JSON ONLY" reminder so we don't
    // accidentally regress to a silent no-op retry.
    const retryArgs = ai.callClaude.mock.calls[1][0];
    expect(retryArgs.messages[0].content).toMatch(/ONLY the JSON/i);
  });

  test('throws BAD_MODEL_REPLY / 422 when both attempts return garbage', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 99 }] })
      .mockResolvedValueOnce({ rows: [fakeMessage()] });

    ai.callClaude.mockResolvedValue({
      configured: true, ok: true,
      text: 'still not JSON',
      usage: { input_tokens: 5, output_tokens: 5 },
    });

    await expect(
      gmailSummary.generate({ orgId: 1, dealId: 10, threadLinkId: 99 })
    ).rejects.toMatchObject({
      code: 'BAD_MODEL_REPLY',
      statusCode: 422,
      details: { reason: 'no_parseable_json' },
    });
    expect(ai.callClaude).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// 3. QUOTA PASS-THROUGH
// ============================================================================

describe('gmailSummary.generate — quota / AI-error pass-through', () => {
  test('surfaces QUOTA_EXCEEDED as { code, statusCode: 402, details }', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 99 }] })
      .mockResolvedValueOnce({ rows: [fakeMessage()] });

    ai.callClaude.mockResolvedValue({
      configured: true, ok: false,
      code: 'QUOTA_EXCEEDED',
      error: 'AI usage cap reached for this org',
      details: { current: 1200, limit: 1000 },
    });

    await expect(
      gmailSummary.generate({ orgId: 1, dealId: 10, threadLinkId: 99 })
    ).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      statusCode: 402,
      details: { current: 1200, limit: 1000 },
    });
    // Should NOT retry on a quota failure.
    expect(ai.callClaude).toHaveBeenCalledTimes(1);
  });

  test('surfaces AI_NOT_CONFIGURED as 503 when ai.isConfigured() returns false', async () => {
    ai.isConfigured.mockReturnValueOnce(false);
    await expect(
      gmailSummary.generate({ orgId: 1, dealId: 10, threadLinkId: 99 })
    ).rejects.toMatchObject({
      code: 'AI_NOT_CONFIGURED',
      statusCode: 503,
    });
    // Should short-circuit before touching the DB.
    expect(mockPool.query).not.toHaveBeenCalled();
    expect(ai.callClaude).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 4. EMPTY THREAD
// ============================================================================

describe('gmailSummary.generate — empty thread', () => {
  test('throws NO_EXTRACTED_CONTENT / 422 when no extracted messages are cached yet', async () => {
    // Link exists, but no messages have been extracted yet (all rows would
    // still be extraction_status='pending' / failed, so loadMessagesForThread
    // returns []).
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ id: 99 }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(
      gmailSummary.generate({ orgId: 1, dealId: 10, threadLinkId: 99 })
    ).rejects.toMatchObject({
      code: 'NO_EXTRACTED_CONTENT',
      statusCode: 422,
      details: { reason: 'no_extracted_content' },
    });
    expect(ai.callClaude).not.toHaveBeenCalled();
  });

  test('throws THREAD_NOT_FOUND / 404 when the link does not belong to the deal/org', async () => {
    // Link verification returns no row.
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await expect(
      gmailSummary.generate({ orgId: 1, dealId: 10, threadLinkId: 99 })
    ).rejects.toMatchObject({
      code: 'THREAD_NOT_FOUND',
      statusCode: 404,
    });
    // Should not even attempt to load messages or call Claude.
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(ai.callClaude).not.toHaveBeenCalled();
  });
});

// ============================================================================
// SUPPLEMENTAL — prompt assembly + parser invariants
// ============================================================================

describe('gmailSummary.buildPrompt', () => {
  test('is deterministic for the same input set', () => {
    const msgs = [fakeMessage(), fakeMessage({ gmail_message_id: 'm2', body_text: 'hello again' })];
    const a = gmailSummary.buildPrompt(msgs);
    const b = gmailSummary.buildPrompt(msgs);
    expect(a.prompt).toBe(b.prompt);
    expect(a.includedCount).toBe(2);
    expect(a.truncated).toBe(false);
  });

  test('truncates when over the char cap', () => {
    const msgs = [
      fakeMessage({ gmail_message_id: 'BIG-1', body_text: 'x'.repeat(5000) }),
      fakeMessage({ gmail_message_id: 'BIG-2', body_text: 'y'.repeat(5000) }),
    ];
    const out = gmailSummary.buildPrompt(msgs, 1000);
    expect(out.truncated).toBe(true);
    expect(out.prompt).toContain('partial view');
    expect(out.prompt).toContain('BIG-1');
  });
});

describe('gmailSummary.parseModelReply', () => {
  test('parses a clean reply with next_step', () => {
    const out = gmailSummary.parseModelReply(HAPPY_JSON);
    expect(out.ok).toBe(true);
    expect(out.parsed.next_step).toMatch(/Confirm acceptance/);
    expect(out.parsed.key_facts).toHaveLength(2);
  });

  test('treats missing / empty next_step as null', () => {
    const out = gmailSummary.parseModelReply(JSON.stringify({
      summary_md: 's', key_facts: [], next_step: '   ',
    }));
    expect(out.ok).toBe(true);
    expect(out.parsed.next_step).toBeNull();
  });

  test('strips ```json fences', () => {
    const out = gmailSummary.parseModelReply('```json\n{"summary_md":"ok","key_facts":[]}\n```');
    expect(out.ok).toBe(true);
    expect(out.parsed.summary_md).toBe('ok');
  });

  test('rejects empty / non-JSON / missing summary_md', () => {
    expect(gmailSummary.parseModelReply('').ok).toBe(false);
    expect(gmailSummary.parseModelReply('no JSON here').ok).toBe(false);
    expect(gmailSummary.parseModelReply(JSON.stringify({ key_facts: [] })).ok).toBe(false);
  });
});
