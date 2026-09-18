// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Streaming chat turns — POST /api/ai/chat/stream + ai.runChatTurn({ onEvent }).
//
// Anthropic is stubbed at globalThis.fetch with responses whose body is an
// async iterable of SSE chunks (split mid-event on purpose, so the parser's
// chunk-boundary handling is exercised). The pg pool is routed by SQL shape.
//
// Covers:
//   • the route emits status → token → done in order, with done carrying
//     the blocking route's shape (+ usage), and persists both turns;
//   • a Claude failure becomes a terminal `error` event (nothing persisted);
//   • metering records the merged per-message usage (message_start input
//     tokens + message_delta output tokens) once per model call;
//   • runChatTurn retracts a pre-tool preamble (`reset`), rebuilds tool
//     input from input_json_delta, and echoes thinking blocks back verbatim;
//   • pre-stream rejections stay plain JSON (400), and the mount-level
//     billing gate 402s an unbilled org exactly like POST /chat.

const realPool = require('../db');
const mockPool = realPool;
mockPool.query   = vi.fn();
mockPool.connect = vi.fn();

vi.mock('../services/logger', () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), notice: vi.fn(), debug: vi.fn(),
}));
vi.mock('../services/usageMeter', () => ({
  increment:     vi.fn().mockResolvedValue(null),
  recordAiUsage: vi.fn().mockResolvedValue(null),
}));
vi.mock('../services/quotaEnforcer', () => {
  class QuotaExceeded extends Error {}
  return { QuotaExceeded, getSeatCount: vi.fn().mockResolvedValue(1), checkAiQuota: vi.fn().mockResolvedValue(null) };
});
vi.mock('../services/audit', () => ({
  fromReq: vi.fn(),
  EVENTS: new Proxy({}, { get: (_t, k) => String(k) }),
}));
process.env.ANTHROPIC_API_KEY = 'test-key-for-vitest';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');

const featureFlags = require('../services/featureFlags');
featureFlags.hasFeature  = vi.fn().mockResolvedValue(true);
featureFlags.getFeatures = vi.fn().mockResolvedValue({ ai_billing_required: true });

const orgAiKeys = require('../services/orgAiKeys');
orgAiKeys.getOrgKey = vi.fn().mockResolvedValue(null);

// vi.mock does not intercept CJS require() in this suite (see ai-chat.test.js
// and auth.test.js) — patch the live module instance instead. ai.js looks
// `aiMetering.recordUsage` up at call time, so the spy is what runs.
const aiMetering = require('../services/aiMetering');
aiMetering.recordUsage = vi.fn().mockResolvedValue(null);
const { requireAiBilling, _resetCachesForTests } = require('../middleware/requireAiBilling');
const ai = require('../services/ai');
const aiRoutes = require('../routes/aiRoutes');
const { generateToken, AUTH_COOKIE_NAME, authMiddleware } = require('../auth');

const USER_ID = 9090;
const ORG_ID  = 654;

function authCookie() {
  return [`${AUTH_COOKIE_NAME}=${generateToken(USER_ID)}`];
}

// Same chain as index.js: auth → billing gate (status exempt) → router.
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET));
  const gate = requireAiBilling();
  const gateExceptStatus = (req, res, next) =>
    (req.method === 'GET' && req.path === '/status') ? next() : gate(req, res, next);
  app.use('/api/ai', authMiddleware, gateExceptStatus, aiRoutes);
  return app;
}

function wirePool({ billing = 'comped' } = {}) {
  mockPool.query.mockImplementation(async (sql) => {
    const q = String(sql);
    if (/FROM users WHERE id/i.test(q)) {
      return { rows: [{ org_id: ORG_ID, org_role: 'owner', status: 'active' }] };
    }
    if (/FROM admin_users/i.test(q)) return { rows: [] };
    if (/FROM organizations WHERE id/i.test(q)) {
      return { rows: [{ id: ORG_ID, ai_billing_status: billing }] };
    }
    if (/COUNT\(\*\)::int AS c/i.test(q)) return { rows: [{ c: 0 }] };
    if (/INSERT INTO chat_sessions/i.test(q)) return { rows: [{ id: 'sess-stream-1' }] };
    return { rows: [] };
  });
}

// --- Anthropic SSE stub -----------------------------------------------------

function sseText(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

// Body = async iterable of byte chunks, sliced at an awkward width so events
// straddle chunk boundaries.
function sseResponse(events, { chunk = 23 } = {}) {
  const text = sseText(events);
  const buf = Buffer.from(text, 'utf8');
  async function* gen() {
    for (let i = 0; i < buf.length; i += chunk) yield buf.subarray(i, i + chunk);
  }
  return { ok: true, status: 200, body: gen(), text: async () => text, json: async () => { throw new Error('stream'); } };
}

function textMessage(text, { inputTokens = 12, outputTokens = 7 } = {}) {
  const pieces = text.match(/.{1,4}/g) || [];
  return [
    { type: 'message_start', message: { id: 'msg_t', type: 'message', role: 'assistant', content: [], usage: { input_tokens: inputTokens, output_tokens: 1, cache_read_input_tokens: 3 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...pieces.map((p) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens } },
    { type: 'message_stop' },
  ];
}

function toolUseMessage({ preamble = '', name, input, withThinking = false, inputTokens = 20, outputTokens = 9 }) {
  const raw = JSON.stringify(input);
  const half = Math.ceil(raw.length / 2);
  const evts = [
    { type: 'message_start', message: { id: 'msg_u', type: 'message', role: 'assistant', content: [], usage: { input_tokens: inputTokens, output_tokens: 1 } } },
  ];
  let idx = 0;
  if (withThinking) {
    evts.push({ type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '' } });
    evts.push({ type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: 'Need the tasks first.' } });
    evts.push({ type: 'content_block_delta', index: idx, delta: { type: 'signature_delta', signature: 'sig_abc' } });
    evts.push({ type: 'content_block_stop', index: idx });
    idx += 1;
  }
  if (preamble) {
    evts.push({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
    evts.push({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: preamble } });
    evts.push({ type: 'content_block_stop', index: idx });
    idx += 1;
  }
  evts.push({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: 'tu_1', name, input: {} } });
  evts.push({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: raw.slice(0, half) } });
  evts.push({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: raw.slice(half) } });
  evts.push({ type: 'content_block_stop', index: idx });
  evts.push({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: outputTokens } });
  evts.push({ type: 'message_stop' });
  return evts;
}

// Collect the raw SSE text of a supertest response and split it into events.
function collectSse(res, cb) {
  res.setEncoding('utf8');
  let text = '';
  res.on('data', (c) => { text += c; });
  res.on('end', () => cb(null, text));
}
function parseEvents(text) {
  return text.split(/\n\n/).map((block) => block.trim()).filter((b) => b && !b.startsWith(':')).map((block) => {
    const out = { event: 'message', data: null };
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) out.event = line.slice(6).trim();
      else if (line.startsWith('data:')) out.data = JSON.parse(line.slice(5).trim());
    }
    return out;
  });
}

let originalFetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  process.env.AI_BILLING_REQUIRED_IN_TESTS = 'true';
  _resetCachesForTests();
  mockPool.query.mockReset();
  aiMetering.recordUsage.mockClear();
  orgAiKeys.getOrgKey.mockResolvedValue(null);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.AI_BILLING_REQUIRED_IN_TESTS;
});

describe('POST /api/ai/chat/stream', () => {
  test('emits status → token → done in order, done matches the blocking shape, and persists the turn', async () => {
    wirePool();
    const responses = [
      toolUseMessage({ name: 'list_overdue_tasks', input: { limit: 5 } }),
      textMessage('You have no overdue tasks today.'),
    ];
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(sseResponse(responses.shift())));

    const res = await request(buildApp())
      .post('/api/ai/chat/stream')
      .set('Cookie', authCookie())
      .send({ message: 'what is overdue?' })
      .buffer(true)
      .parse(collectSse);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['cache-control']).toMatch(/no-transform/);
    expect(res.headers['x-accel-buffering']).toBe('no');

    const events = parseEvents(res.body);
    const names = events.map((e) => e.event);
    expect(names[0]).toBe('status');
    expect(names[names.length - 1]).toBe('done');
    expect(names.indexOf('status')).toBeLessThan(names.indexOf('token'));
    expect(names.indexOf('token')).toBeLessThan(names.indexOf('actions'));
    expect(names.indexOf('actions')).toBeLessThan(names.indexOf('done'));
    expect(names.filter((n) => n === 'error')).toHaveLength(0);

    expect(events[0].data).toEqual({ tool: 'list_overdue_tasks', text: 'Looking at overdue tasks…' });
    const streamed = events.filter((e) => e.event === 'token').map((e) => e.data.text).join('');
    expect(streamed).toBe('You have no overdue tasks today.');

    const done = events[events.length - 1].data;
    expect(done).toMatchObject({
      session_id: 'sess-stream-1',
      reply: 'You have no overdue tasks today.',
      explanation: 'Looked up: list overdue tasks.',
    });
    expect(Array.isArray(done.actions)).toBe(true);
    expect(done.usage).toEqual({ input_tokens: 32, output_tokens: 16 });

    // Both model calls streamed.
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    for (const call of globalThis.fetch.mock.calls) {
      expect(JSON.parse(call[1].body).stream).toBe(true);
    }

    // Persistence: user + assistant rows and the session bump, same as POST /chat.
    const sqls = mockPool.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /INSERT INTO chat_messages \(session_id, role, content\) VALUES \(\$1, 'user'/.test(s))).toBe(true);
    const asst = mockPool.query.mock.calls.find((c) => /VALUES \(\$1, 'assistant'/.test(String(c[0])));
    expect(asst).toBeTruthy();
    expect(asst[1][1]).toBe('You have no overdue tasks today.');
    expect(JSON.parse(asst[1][2])[0]).toMatchObject({ name: 'list_overdue_tasks', input: { limit: 5 } });
    expect(sqls.some((s) => /UPDATE chat_sessions SET last_message_at/.test(s))).toBe(true);

    // Metering: one row per model call with the MERGED usage.
    expect(aiMetering.recordUsage).toHaveBeenCalledTimes(2);
    expect(aiMetering.recordUsage.mock.calls[0][0]).toMatchObject({
      orgId: ORG_ID, userId: USER_ID, endpoint: 'chat',
      usage: { input_tokens: 20, output_tokens: 9 },
    });
    expect(aiMetering.recordUsage.mock.calls[1][0]).toMatchObject({
      endpoint: 'chat-tool-iter',
      usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 3 },
    });
  });

  test('a Claude failure becomes a terminal error event and nothing is persisted', async () => {
    wirePool();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 529, text: async () => '{"error":{"type":"overloaded_error"}}',
    });

    const res = await request(buildApp())
      .post('/api/ai/chat/stream')
      .set('Cookie', authCookie())
      .send({ message: 'hi' })
      .buffer(true)
      .parse(collectSse);

    expect(res.status).toBe(200);
    const events = parseEvents(res.body);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('error');
    expect(events[0].data).toMatchObject({ code: 'AI_ERROR', status: 502 });
    expect(typeof events[0].data.error).toBe('string');
    expect(mockPool.query.mock.calls.some((c) => /INSERT INTO chat_messages/.test(String(c[0])))).toBe(false);
  });

  test('a mid-stream Anthropic error event is surfaced as an error event too', async () => {
    wirePool();
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Half' } },
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    ]));

    const res = await request(buildApp())
      .post('/api/ai/chat/stream')
      .set('Cookie', authCookie())
      .send({ message: 'hi' })
      .buffer(true)
      .parse(collectSse);

    const events = parseEvents(res.body);
    expect(events.map((e) => e.event)).toEqual(['token', 'error']);
    expect(events[1].data).toMatchObject({ code: 'AI_ERROR', status: 502 });
    expect(events[1].data.error).toMatch(/Overloaded/);
    // The partial message's input tokens were still metered.
    expect(aiMetering.recordUsage).toHaveBeenCalledTimes(1);
    expect(aiMetering.recordUsage.mock.calls[0][0].usage).toMatchObject({ input_tokens: 5 });
  });

  test('pre-stream validation stays plain JSON (400) — the client handles it like POST /chat', async () => {
    wirePool();
    globalThis.fetch = vi.fn();
    const res = await request(buildApp())
      .post('/api/ai/chat/stream')
      .set('Cookie', authCookie())
      .send({ message: '   ' });
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: 'message is required' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('respects the AI billing gate: unbilled org → 402 with code + action, no stream', async () => {
    wirePool({ billing: 'unconfigured' });
    globalThis.fetch = vi.fn();
    const res = await request(buildApp())
      .post('/api/ai/chat/stream')
      .set('Cookie', authCookie())
      .send({ message: 'hi' });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ success: false, code: 'AI_BILLING_REQUIRED', action: 'start_billing', status: 'unconfigured' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('ai.runChatTurn({ onEvent }) — streamed tool loop', () => {
  test('retracts a pre-tool preamble, rebuilds tool input from deltas, echoes thinking blocks back', async () => {
    const responses = [
      toolUseMessage({ preamble: 'Let me check.', name: 'list_deals', input: { stage: 'OPEN', limit: 3 }, withThinking: true }),
      textMessage('Three open deals.'),
    ];
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(sseResponse(responses.shift(), { chunk: 7 })));
    const runTool = vi.fn().mockResolvedValue({ deals: [] });
    const events = [];

    const out = await ai.runChatTurn({
      userMessage: 'open deals?', history: [], runTool, orgId: 1, userId: 2,
      onEvent: (e) => events.push(e),
    });

    expect(out.ok).toBe(true);
    expect(out.reply).toBe('Three open deals.');
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]).toMatchObject({ name: 'list_deals', input: { stage: 'OPEN', limit: 3 } });
    expect(runTool).toHaveBeenCalledWith('list_deals', { stage: 'OPEN', limit: 3 });

    // Preamble streamed as tokens, then retracted when the tool call started.
    const types = events.map((e) => e.type);
    expect(types.slice(0, 3)).toEqual(['token', 'reset', 'status']);
    expect(events[0].text).toBe('Let me check.');
    expect(events[1].text).toBe('Let me check.');
    expect(events[2]).toEqual({ type: 'status', tool: 'list_deals', text: 'Looking at your deals…' });
    // The final reply streams as tokens only (no further reset).
    expect(types.filter((t) => t === 'reset')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'token').slice(1).map((e) => e.text).join('')).toBe('Three open deals.');

    // The second request replays the assistant turn with the thinking block
    // + signature intact, followed by the tool_result.
    const second = JSON.parse(globalThis.fetch.mock.calls[1][1].body);
    const assistantTurn = second.messages[second.messages.length - 2];
    expect(assistantTurn.role).toBe('assistant');
    expect(assistantTurn.content[0]).toEqual({ type: 'thinking', thinking: 'Need the tasks first.', signature: 'sig_abc' });
    expect(assistantTurn.content[2]).toMatchObject({ type: 'tool_use', id: 'tu_1', name: 'list_deals', input: { stage: 'OPEN', limit: 3 } });
    const toolResultTurn = second.messages[second.messages.length - 1];
    expect(toolResultTurn.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1' });
  });

  test('an aborted signal ends the turn with code ABORTED', async () => {
    const controller = new AbortController();
    // Like real fetch: reject at once if the signal is already aborted (the
    // abort below lands while runChatTurn is still resolving settings), else
    // reject when it fires.
    const abortErr = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    globalThis.fetch = vi.fn().mockImplementation((_url, opts) => new Promise((_resolve, reject) => {
      if (opts.signal.aborted) return reject(abortErr());
      opts.signal.addEventListener('abort', () => reject(abortErr()));
    }));
    const p = ai.runChatTurn({
      userMessage: 'hi', history: [], runTool: async () => ({}), orgId: 1,
      onEvent: () => {}, signal: controller.signal,
    });
    controller.abort();
    const out = await p;
    expect(out.ok).toBe(false);
    expect(out.code).toBe('ABORTED');
  });

  test('without onEvent the request is NOT streamed (blocking path unchanged)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hi.' }] }),
      text: async () => '',
    });
    const out = await ai.runChatTurn({ userMessage: 'hi', history: [], runTool: async () => ({}), orgId: 1 });
    expect(out.ok).toBe(true);
    expect(JSON.parse(globalThis.fetch.mock.calls[0][1].body).stream).toBeUndefined();
  });
});

describe('ai.toolStatusLabel', () => {
  test('maps known tools and derives sensible labels for the rest', () => {
    expect(ai.toolStatusLabel('list_overdue_tasks')).toBe('Looking at overdue tasks…');
    expect(ai.toolStatusLabel('propose_update_pipeline')).toBe('Preparing a change for you to confirm…');
    expect(ai.toolStatusLabel('list_widgets')).toBe('Looking at widgets…');
    expect(ai.toolStatusLabel('get_thing')).toBe('Pulling up thing…');
    expect(ai.toolStatusLabel('frobnicate_all')).toBe('Working on frobnicate all…');
  });
});
