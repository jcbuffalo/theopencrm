// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Gmail Intel — per-thread conversation summarization.
//
// `generate({ orgId, dealId, threadLinkId, userId })` reads cached messages
// from email_thread_messages for the thread (newest first), builds a
// deterministic prompt, calls services/ai.callClaude, parses the JSON-shaped
// reply, and inserts a deal_gmail_summaries row.
//
// CONTRACT WITH CLAUDE (prompt_version = 'gmail-intel-v1'):
//   The model is asked for a single JSON object with exactly:
//     {
//       "summary_md":  string,
//       "key_facts":   [{ "label": string, "value": string, "source_message_id"?: string }],
//       "next_step":   string | null
//     }
//   The system prompt forbids non-JSON output. We still defensively
//   strip ``` fences and find the first/last brace before parsing.
//
// TOKEN BUDGET:
//   - GMAIL_MAX_SUMMARY_TOKENS (default 50,000) caps the concatenated
//     message bodies fed to Claude. The cap is in TOKENS; we estimate
//     ~4 chars/token so 50K tokens ≈ 200K chars.
//   - When the cap would be exceeded, we keep the most-recent messages
//     in full, then add truncation markers + a note in the prompt so
//     Claude knows the summary may be partial.
//
// COST GUARD:
//   - services/ai.callClaude already calls quotaEnforcer.checkAiQuota
//     internally; we surface its 'QUOTA_EXCEEDED' code to the caller
//     so the route can return 402 (per spec). Tokens metering happens
//     for free via the standard ai.js path (endpoint='gmail-intel'
//     attribution lands in ai_usage_events).
//
// RETRY:
//   On a parse failure we retry exactly once with a tighter "JSON ONLY"
//   reminder. A second parse failure surfaces as a 422 BAD_MODEL_REPLY
//   with `no_parseable_json` so the UI can render a deterministic error.

const pool    = require('../db');
const logger  = require('./logger');
const ai      = require('./ai');
const aiModel = require('./aiModel');

const PROMPT_VERSION = 'gmail-intel-v1';
const DEFAULT_MAX_TOKENS = 50000;
// Cheap-and-cheerful token estimator: Anthropic published guidance puts
// English at ~4 chars/token. Good enough for budgeting — when we want
// exact counts we read Anthropic's response.usage.input_tokens after
// the call.
const CHARS_PER_TOKEN = 4;

function summaryTokenCap() {
  const env = Number(process.env.GMAIL_MAX_SUMMARY_TOKENS);
  return env > 0 ? env : DEFAULT_MAX_TOKENS;
}

function maxSummaryChars() {
  return summaryTokenCap() * CHARS_PER_TOKEN;
}

const SYSTEM_PROMPT = [
  'You summarize the current state of a B2B sales opportunity ("deal") based on',
  'an email thread the rep has linked to that deal. The user is a salesperson',
  'asking "where does this conversation stand right now and what do I do next?"',
  '',
  'Email thread(s) for this deal, most recent first. Treat the most recent',
  'message as the freshest signal — earlier messages give you context but the',
  'most recent reply is usually what determines the next step.',
  '',
  'You MUST output a single JSON object — no markdown, no prose preamble, no code',
  'fence. The object\'s shape is:',
  '{',
  '  "summary_md":  "<2-4 paragraphs of markdown narrative on conversation state>",',
  '  "key_facts": [',
  '    { "label": "Quoted price", "value": "$48K", "source_message_id": "..." },',
  '    ...',
  '  ],',
  '  "next_step": "<one short sentence describing the single most important next action, or null if none>"',
  '}',
  '',
  'Aim for 3-6 key facts. source_message_id is the gmail_message_id of the message',
  'the fact was derived from; omit if multi-source or general. Never invent facts',
  'not present in the messages.',
].join('\n');

/**
 * Load cached messages for a thread, newest-first, with only the fields the
 * prompt needs. Only includes messages with extraction_status='done' — pending
 * / failed / skipped rows have no body_text to feed the model. Exported for
 * tests.
 */
async function loadMessagesForThread({ orgId, threadLinkId }) {
  const res = await pool.query(
    `SELECT gmail_message_id, internal_date, from_addr, to_addrs,
            subject, snippet, body_text, attachment_names
       FROM email_thread_messages
      WHERE thread_link_id = $1 AND org_id = $2
        AND extraction_status = 'done'
        AND body_text IS NOT NULL
      ORDER BY internal_date DESC NULLS LAST, id DESC`,
    [threadLinkId, orgId]
  );
  return res.rows;
}

/**
 * Build the user-message string the model sees. Deterministic given the
 * same input rows so tests can assert prompt stability and so identical
 * threads never re-bill spuriously.
 *
 * Exported so the test suite can drive it directly without DB stubs.
 *
 * @param {array}  messages - email_thread_messages rows, newest-first
 * @param {number} [charCap]
 * @returns {{ prompt: string, includedCount: number, truncated: boolean, totalMessages: number }}
 */
function buildPrompt(messages, charCap) {
  const cap = Number(charCap) > 0 ? Number(charCap) : maxSummaryChars();
  const lines = [];
  let usedChars = 0;
  let includedCount = 0;
  let truncated = false;

  // Header — flat, no timestamps, so prompt-stability tests can assert
  // string equality on a static input set.
  lines.push('Messages analyzed (most recent first):');
  lines.push('');

  for (const m of messages) {
    const toAddrs = Array.isArray(m.to_addrs) ? m.to_addrs.join(', ') : '';
    const attachments = Array.isArray(m.attachment_names) && m.attachment_names.length > 0
      ? m.attachment_names.join(', ')
      : '';
    const header = [
      `--- MESSAGE ---`,
      `gmail_message_id: ${m.gmail_message_id}`,
      `from: ${m.from_addr || 'unknown'}`,
      `to: ${toAddrs}`,
      `subject: ${m.subject || '(no subject)'}`,
      `internal_date: ${m.internal_date ? new Date(m.internal_date).toISOString() : 'unknown'}`,
      attachments ? `attachments: ${attachments}` : null,
      'body:',
      '',
    ].filter(Boolean).join('\n');

    const headerLen = header.length;
    if (usedChars + headerLen > cap) {
      truncated = true;
      break;
    }
    const remainingForBody = cap - usedChars - headerLen;
    const body = String(m.body_text || '');
    let bodySlice;
    if (body.length <= remainingForBody) {
      bodySlice = body;
    } else {
      truncated = true;
      bodySlice = body.slice(0, Math.max(0, remainingForBody - 32));
      bodySlice += '\n[…truncated…]';
    }
    lines.push(header + bodySlice);
    lines.push('');
    usedChars += headerLen + bodySlice.length + 1;
    includedCount++;
    if (truncated) break;
  }

  if (truncated) {
    lines.push('');
    lines.push(
      `Note: this is a partial view (${includedCount} of ${messages.length} messages included; ` +
      'older messages omitted to stay within the context budget). The summary may miss facts ' +
      'present only in the omitted messages. Mention this caveat in summary_md when relevant.'
    );
  }
  lines.push('');
  lines.push('Produce the JSON object now. Output nothing other than JSON.');

  return {
    prompt: lines.join('\n'),
    includedCount,
    truncated,
    totalMessages: messages.length,
  };
}

/**
 * Parse Claude's reply. Strips ``` fences, finds the first '{' and last
 * '}', and JSON.parses the slice. Returns either { ok: true, parsed } or
 * { ok: false, error }.
 *
 * Modeled on intelSummary.parseModelReply but with `next_step` field
 * handling (string or null) plus source_message_id rather than
 * source_file_id on key_facts entries.
 */
function parseModelReply(text) {
  if (!text) return { ok: false, error: 'empty reply' };
  let raw = String(text).trim();
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  const first = raw.indexOf('{');
  const last  = raw.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    return { ok: false, error: 'no JSON object found' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(first, last + 1));
  } catch (err) {
    return { ok: false, error: `JSON parse failed: ${err.message}` };
  }
  if (typeof parsed.summary_md !== 'string') {
    return { ok: false, error: 'summary_md missing or not a string' };
  }
  const keyFacts = Array.isArray(parsed.key_facts) ? parsed.key_facts : [];
  // Defensive normalization — strip non-string label/value, drop bad rows.
  const cleanFacts = keyFacts
    .filter(kf => kf && typeof kf === 'object' && typeof kf.label === 'string')
    .map(kf => ({
      label: String(kf.label).slice(0, 200),
      value: kf.value != null ? String(kf.value).slice(0, 500) : '',
      source_message_id: kf.source_message_id ? String(kf.source_message_id).slice(0, 100) : undefined,
    }));
  // next_step: string or null. Strip empty / whitespace to null so the DB
  // column reflects "no actionable next step" honestly.
  let nextStep = null;
  if (typeof parsed.next_step === 'string') {
    const trimmed = parsed.next_step.trim();
    if (trimmed.length > 0) nextStep = trimmed.slice(0, 1000);
  }
  return {
    ok: true,
    parsed: {
      summary_md: parsed.summary_md,
      key_facts:  cleanFacts,
      next_step:  nextStep,
    },
  };
}

/**
 * Generate and persist a new summary row for a deal/thread link.
 *
 * Error contract — every error thrown carries `code` + `statusCode`:
 *   503 AI_NOT_CONFIGURED   — ANTHROPIC_API_KEY unset
 *   402 QUOTA_EXCEEDED      — per-org AI cap reached
 *   429 RATE_LIMITED        — surfaced from ai.callClaude (rare; route-level
 *                              limiter usually catches this first)
 *   404 THREAD_NOT_FOUND    — thread_link_id missing in caller's org/deal
 *   422 NO_EXTRACTED_CONTENT — no email_thread_messages rows with
 *                              extraction_status='done' to summarize yet
 *   422 BAD_MODEL_REPLY     — model returned unparseable JSON twice
 *   502 AI_CALL_FAILED      — any other failure inside ai.callClaude
 *
 * @param {object} opts
 * @param {number} opts.orgId
 * @param {number} opts.dealId
 * @param {number} opts.threadLinkId
 * @param {number} [opts.userId]
 * @returns {Promise<object>} the newly inserted deal_gmail_summaries row
 */
async function generate({ orgId, dealId, threadLinkId, userId = null }) {
  if (!orgId || !dealId || !threadLinkId) {
    throw new Error('generate requires { orgId, dealId, threadLinkId }');
  }
  if (!ai.isConfigured()) {
    const err = new Error('AI not configured');
    err.code = 'AI_NOT_CONFIGURED';
    err.statusCode = 503;
    throw err;
  }

  // Verify the thread link exists in this org and points at this deal.
  // Cheaper than letting the message load return empty and erroring with
  // NO_EXTRACTED_CONTENT — the operator-facing error is more accurate.
  const linkRes = await pool.query(
    `SELECT id FROM deal_email_threads
      WHERE id = $1 AND deal_id = $2 AND org_id = $3`,
    [threadLinkId, dealId, orgId]
  );
  if (linkRes.rows.length === 0) {
    const err = new Error('Thread link not found for this deal');
    err.code = 'THREAD_NOT_FOUND';
    err.statusCode = 404;
    throw err;
  }

  const messages = await loadMessagesForThread({ orgId, threadLinkId });
  if (messages.length === 0) {
    const err = new Error(
      'No extracted message content to summarize. Run a sync first.'
    );
    err.code = 'NO_EXTRACTED_CONTENT';
    err.statusCode = 422;
    err.details = { reason: 'no_extracted_content' };
    throw err;
  }

  const { prompt, includedCount, truncated, totalMessages } = buildPrompt(messages);

  // First attempt.
  let result = await ai.callClaude({
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1500,
    orgId,
    userId,
    endpoint: 'gmail-intel',
  });

  // Cost guard surfaced from quotaEnforcer.
  if (result.code === 'QUOTA_EXCEEDED') {
    const err = new Error(result.error || 'AI quota exceeded for this org');
    err.code = 'QUOTA_EXCEEDED';
    err.statusCode = 402;
    err.details = result.details;
    throw err;
  }
  if (result.code === 'RATE_LIMITED') {
    const err = new Error(result.error || 'AI provider rate limit hit');
    err.code = 'RATE_LIMITED';
    err.statusCode = 429;
    throw err;
  }
  if (result.configured === false) {
    const err = new Error(result.message || 'AI not configured');
    err.code = 'AI_NOT_CONFIGURED';
    err.statusCode = 503;
    throw err;
  }
  if (!result.ok) {
    const err = new Error(result.error || 'AI call failed');
    err.code = 'AI_CALL_FAILED';
    err.statusCode = 502;
    throw err;
  }

  let parsed = parseModelReply(result.text);
  if (!parsed.ok) {
    // One retry with a tighter "JSON ONLY" reminder. Mirrors the defensive
    // posture of the Drive intel summarizer, with a single retry because
    // a second failure typically means the model is genuinely confused —
    // surfacing 422 lets the UI render a deterministic error.
    logger.warn('gmail_intel_parse_failed_retry', {
      orgId, dealId, threadLinkId, error: parsed.error,
    });
    const retryPrompt = prompt +
      '\n\nREMINDER: Reply with ONLY the JSON object. No prose, no code fence, no preamble.';
    result = await ai.callClaude({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: retryPrompt }],
      maxTokens: 1500,
      orgId,
      userId,
      endpoint: 'gmail-intel',
    });
    if (result.code === 'QUOTA_EXCEEDED') {
      const err = new Error(result.error || 'AI quota exceeded for this org');
      err.code = 'QUOTA_EXCEEDED';
      err.statusCode = 402;
      err.details = result.details;
      throw err;
    }
    if (!result.ok) {
      const err = new Error(result.error || 'AI call failed on retry');
      err.code = 'AI_CALL_FAILED';
      err.statusCode = 502;
      throw err;
    }
    parsed = parseModelReply(result.text);
    if (!parsed.ok) {
      logger.warn('gmail_intel_parse_failed_final', {
        orgId, dealId, threadLinkId, error: parsed.error,
      });
      const err = new Error(`Could not parse model reply: ${parsed.error}`);
      err.code = 'BAD_MODEL_REPLY';
      err.statusCode = 422;
      err.details = { reason: 'no_parseable_json' };
      throw err;
    }
  }

  // Record the model that actually ran. ai.callClaude surfaces the resolved
  // model on its result so we can persist it without re-querying organizations
  // — keeps deal_gmail_summaries.ai_model lined up with ai_usage_events.model
  // for the same call. Fall back to the hardcoded default if the AI service
  // omitted it (legacy callers / test mocks); avoids issuing a second pool
  // query just to learn what was already resolved upstream.
  const model = result.model || aiModel.DEFAULT_MODEL;
  const tokensInput  = result.usage?.input_tokens  || null;
  const tokensOutput = result.usage?.output_tokens || null;

  const ins = await pool.query(
    `INSERT INTO deal_gmail_summaries
       (org_id, deal_id, thread_link_id, summary_md, key_facts,
        next_step, prompt_version, generated_by_user_id,
        ai_input_tokens, ai_output_tokens, ai_model)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      orgId, dealId, threadLinkId,
      parsed.parsed.summary_md,
      JSON.stringify(parsed.parsed.key_facts),
      parsed.parsed.next_step,
      PROMPT_VERSION,
      userId,
      tokensInput, tokensOutput, model,
    ]
  );
  const row = ins.rows[0];
  logger.info('gmail_intel_generated', {
    orgId, dealId, threadLinkId,
    messages: includedCount, total_messages: totalMessages, truncated,
    tokens_input: tokensInput, tokens_output: tokensOutput,
  });
  return row;
}

module.exports = {
  generate,
  buildPrompt,
  parseModelReply,
  loadMessagesForThread,
  SYSTEM_PROMPT,
  PROMPT_VERSION,
  CHARS_PER_TOKEN,
  summaryTokenCap,
  maxSummaryChars,
};
