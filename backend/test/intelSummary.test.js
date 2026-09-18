// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Drive Intel — intel summary tests.
//
// We cover the three things that matter:
//   1. Prompt assembly is deterministic on a stable file set.
//   2. Token-budget truncation kicks in at / above the cap.
//   3. Reply parsing tolerates fenced JSON + drops malformed key_facts.
//
// We avoid hitting real Claude by overwriting services/ai's exports
// in-place — same pattern as test/notification-dispatcher.test.js (which
// patches the live email/sms module exports rather than fighting CJS
// mock interop).

// describe / test / expect / beforeEach / vi are global.

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

// Overwrite the live services/ai exports — intelSummary does
// `const ai = require('./ai')`, so a mutation propagates.
const ai = require('../services/ai');
ai.isConfigured = vi.fn(() => true);
ai.callClaude   = vi.fn();

// Set up env for prompt assembly tests (caps).
process.env.DRIVE_MAX_SUMMARY_TOKENS = '50000';

const intelSummary = require('../services/intelSummary');

beforeEach(() => {
  mockPool.query.mockReset();
  ai.callClaude.mockReset();
});

// Helper: a stable file fixture.
function fakeFiles() {
  return [
    {
      drive_file_id: 'F-newest',
      name: 'newest.txt',
      mime_type: 'text/plain',
      size_bytes: 100,
      drive_modified_at: '2026-06-01T12:00:00Z',
      content_text: 'newest content body here',
      extraction_status: 'done',
    },
    {
      drive_file_id: 'F-middle',
      name: 'middle.txt',
      mime_type: 'text/plain',
      size_bytes: 100,
      drive_modified_at: '2026-05-15T12:00:00Z',
      content_text: 'middle content',
      extraction_status: 'done',
    },
    {
      drive_file_id: 'F-old',
      name: 'oldest.txt',
      mime_type: 'text/plain',
      size_bytes: 100,
      drive_modified_at: '2026-01-01T12:00:00Z',
      content_text: 'oldest content',
      extraction_status: 'done',
    },
  ];
}

// ============================================================================
// buildPrompt — determinism + token budget
// ============================================================================

describe('intelSummary.buildPrompt', () => {
  test('produces a deterministic prompt for the same input', () => {
    const a = intelSummary.buildPrompt(fakeFiles());
    const b = intelSummary.buildPrompt(fakeFiles());
    expect(a.prompt).toBe(b.prompt);
    expect(a.includedCount).toBe(3);
    expect(a.truncated).toBe(false);
  });

  test('preserves the newest-first order in the prompt', () => {
    const { prompt } = intelSummary.buildPrompt(fakeFiles());
    const idxNewest = prompt.indexOf('F-newest');
    const idxMiddle = prompt.indexOf('F-middle');
    const idxOld    = prompt.indexOf('F-old');
    expect(idxNewest).toBeGreaterThan(-1);
    expect(idxNewest).toBeLessThan(idxMiddle);
    expect(idxMiddle).toBeLessThan(idxOld);
  });

  test('UNDER the cap — no truncation, all files included', () => {
    const out = intelSummary.buildPrompt(fakeFiles(), 100_000);
    expect(out.truncated).toBe(false);
    expect(out.includedCount).toBe(3);
  });

  test('OVER the cap — truncates and includes a partial-view note', () => {
    // Big enough content that only one file should fit at a small cap.
    const files = [
      {
        drive_file_id: 'BIG-1',
        name: 'big1.txt',
        mime_type: 'text/plain',
        size_bytes: 5000,
        drive_modified_at: '2026-06-01T00:00:00Z',
        content_text: 'x'.repeat(5000),
      },
      {
        drive_file_id: 'BIG-2',
        name: 'big2.txt',
        mime_type: 'text/plain',
        size_bytes: 5000,
        drive_modified_at: '2026-05-01T00:00:00Z',
        content_text: 'y'.repeat(5000),
      },
    ];
    const out = intelSummary.buildPrompt(files, 1000);
    expect(out.truncated).toBe(true);
    expect(out.includedCount).toBeLessThanOrEqual(2);
    expect(out.prompt).toContain('partial view');
    // The newest file should be present (in full or truncated).
    expect(out.prompt).toContain('BIG-1');
  });

  test('AT the cap — exact boundary still produces a valid prompt', () => {
    const files = [{
      drive_file_id: 'EXACT-1',
      name: 'e.txt',
      mime_type: 'text/plain',
      size_bytes: 10,
      drive_modified_at: '2026-06-01T00:00:00Z',
      content_text: 'short',
    }];
    // Cap exactly large enough for the header + the 5-char body.
    const out = intelSummary.buildPrompt(files, 500);
    expect(out.includedCount).toBe(1);
    expect(out.truncated).toBe(false);
  });
});

// ============================================================================
// parseModelReply — fence stripping + bad-shape handling
// ============================================================================

describe('intelSummary.parseModelReply', () => {
  test('parses a plain JSON reply', () => {
    const out = intelSummary.parseModelReply(JSON.stringify({
      summary_md: 'hello world',
      key_facts: [{ label: 'X', value: 'Y' }],
    }));
    expect(out.ok).toBe(true);
    expect(out.parsed.summary_md).toBe('hello world');
    expect(out.parsed.key_facts).toEqual([{ label: 'X', value: 'Y' }]);
  });

  test('strips ```json code fences', () => {
    const reply = '```json\n{"summary_md":"ok","key_facts":[]}\n```';
    const out = intelSummary.parseModelReply(reply);
    expect(out.ok).toBe(true);
    expect(out.parsed.summary_md).toBe('ok');
  });

  test('handles leading prose before the JSON object', () => {
    const reply = 'Here is the summary:\n{"summary_md":"x","key_facts":[]}';
    const out = intelSummary.parseModelReply(reply);
    expect(out.ok).toBe(true);
  });

  test('drops malformed key_facts entries', () => {
    const reply = JSON.stringify({
      summary_md: 's',
      key_facts: [
        { label: 'good', value: 'v' },
        { value: 'no label' },
        'string',
        null,
        { label: 'good2', value: 'v2', source_file_id: 'F1' },
      ],
    });
    const out = intelSummary.parseModelReply(reply);
    expect(out.ok).toBe(true);
    expect(out.parsed.key_facts).toHaveLength(2);
    expect(out.parsed.key_facts[0].label).toBe('good');
    expect(out.parsed.key_facts[1].source_file_id).toBe('F1');
  });

  test('returns ok=false on empty / non-JSON input', () => {
    expect(intelSummary.parseModelReply('').ok).toBe(false);
    expect(intelSummary.parseModelReply('no braces here').ok).toBe(false);
    expect(intelSummary.parseModelReply('{not json').ok).toBe(false);
  });

  test('rejects when summary_md is not a string', () => {
    const reply = JSON.stringify({ summary_md: 42, key_facts: [] });
    const out = intelSummary.parseModelReply(reply);
    expect(out.ok).toBe(false);
  });
});

// ============================================================================
// generate — end-to-end with mocked Claude + pool
// ============================================================================

describe('intelSummary.generate', () => {
  test('persists a row and returns it on a happy path', async () => {
    // 1) loadFilesForLink query
    mockPool.query.mockResolvedValueOnce({
      rows: fakeFiles(),
    });
    // 2) the insert returns the new row
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 5, org_id: 1, deal_id: 10, folder_link_id: 99,
        model: 'claude-sonnet-4-6', prompt_version: 'intel-v1',
        summary_md: 'state is good', key_facts_json: [{ label: 'A', value: 'B' }],
        files_analyzed_count: 3, tokens_input: 12, tokens_output: 34,
        generated_at: new Date(), created_by_user_id: 7,
      }],
    });
    ai.callClaude.mockResolvedValue({
      configured: true, ok: true,
      text: JSON.stringify({ summary_md: 'state is good', key_facts: [{ label: 'A', value: 'B' }] }),
      usage: { input_tokens: 12, output_tokens: 34 },
    });

    const row = await intelSummary.generate({
      orgId: 1, dealId: 10, folderLinkId: 99, userId: 7,
    });
    expect(row.summary_md).toBe('state is good');
    expect(row.files_analyzed_count).toBe(3);
    expect(ai.callClaude).toHaveBeenCalledTimes(1);
  });

  test('surfaces QUOTA_EXCEEDED as a 402 error', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: fakeFiles() });
    ai.callClaude.mockResolvedValue({
      configured: true, ok: false,
      code: 'QUOTA_EXCEEDED', error: 'over cap', details: {},
    });
    await expect(
      intelSummary.generate({ orgId: 1, dealId: 10, folderLinkId: 99 })
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', statusCode: 402 });
  });

  test('throws NO_CONTENT when there are no extracted files', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await expect(
      intelSummary.generate({ orgId: 1, dealId: 10, folderLinkId: 99 })
    ).rejects.toMatchObject({ code: 'NO_CONTENT', statusCode: 400 });
  });

  test('throws BAD_MODEL_REPLY when Claude returns non-JSON', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: fakeFiles() });
    ai.callClaude.mockResolvedValue({
      configured: true, ok: true, text: 'this is not JSON',
      usage: { input_tokens: 5, output_tokens: 3 },
    });
    await expect(
      intelSummary.generate({ orgId: 1, dealId: 10, folderLinkId: 99 })
    ).rejects.toMatchObject({ code: 'BAD_MODEL_REPLY', statusCode: 502 });
  });
});
