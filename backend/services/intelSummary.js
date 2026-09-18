// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Drive Intel — opportunity summarization.
//
// `generate({ orgId, dealId, folderLinkId, userId })` pulls every
// drive_files row for the link, builds a deterministic prompt (most-
// recently-modified first), calls services/ai.callClaude, parses the
// JSON-shaped reply, and inserts a deal_intel_summaries row.
//
// CONTRACT WITH CLAUDE (prompt_version = 'intel-v1'):
//   The model is asked for a single JSON object with exactly:
//     {
//       "summary_md":  string,
//       "key_facts": [{ "label": string, "value": string, "source_file_id"?: string }]
//     }
//   The system prompt forbids non-JSON output. We still defensively
//   strip ``` fences and find the first/last brace before parsing.
//
// TOKEN BUDGET:
//   - DRIVE_MAX_SUMMARY_TOKENS (default 50,000) caps the concatenated
//     file content fed to Claude. The cap is in TOKENS; we estimate
//     ~4 chars/token so 50K tokens ≈ 200K chars.
//   - When the cap would be exceeded, we keep the top-most-recently-
//     modified files in full, then add truncation markers + a note in
//     the prompt so Claude knows the summary may be partial.
//
// COST GUARD:
//   - services/ai.callClaude already calls quotaEnforcer.checkAiQuota
//     internally; we surface its 'QUOTA_EXCEEDED' code to the caller
//     so the route can return 402 (per spec). Tokens metering happens
//     for free via the standard ai.js path.

const pool    = require('../db');
const logger  = require('./logger');
const ai      = require('./ai');
const aiModel = require('./aiModel');

const PROMPT_VERSION = 'intel-v1';
const DEFAULT_MAX_TOKENS = 50000;
// Cheap-and-cheerful token estimator: Anthropic published guidance puts
// English at ~4 chars/token. Good enough for budgeting — when we want
// exact counts we read Anthropic's response.usage.input_tokens after
// the call.
const CHARS_PER_TOKEN = 4;

function summaryTokenCap() {
  const env = Number(process.env.DRIVE_MAX_SUMMARY_TOKENS);
  return env > 0 ? env : DEFAULT_MAX_TOKENS;
}

function maxSummaryChars() {
  return summaryTokenCap() * CHARS_PER_TOKEN;
}

const SYSTEM_PROMPT = [
  'You summarize the current state of a B2B sales opportunity ("deal") based on',
  'documents collected in a shared Google Drive folder. The user is a salesperson',
  'asking "what is the state of this deal right now?"',
  '',
  'You MUST output a single JSON object — no markdown, no prose preamble, no code',
  'fence. The object\'s shape is:',
  '{',
  '  "summary_md":  "<2-4 paragraphs of markdown narrative on current state>",',
  '  "key_facts": [',
  '    { "label": "Annual contract value", "value": "$480K", "source_file_id": "..." },',
  '    ...',
  '  ]',
  '}',
  '',
  'Aim for 4-8 key facts. source_file_id is the drive_file_id of the file the fact',
  'was derived from; omit if multi-source or general. Never invent facts not present',
  'in the documents.',
].join('\n');

/**
 * Load drive_files for a folder link, newest-first, with only fields we
 * need for the prompt. Exported for tests.
 */
async function loadFilesForLink({ orgId, folderLinkId }) {
  const res = await pool.query(
    `SELECT drive_file_id, name, mime_type, size_bytes, drive_modified_at,
            content_text, extraction_status
       FROM drive_files
      WHERE folder_link_id = $1 AND org_id = $2
        AND extraction_status = 'done'
        AND content_text IS NOT NULL
      ORDER BY drive_modified_at DESC NULLS LAST, id DESC`,
    [folderLinkId, orgId]
  );
  return res.rows;
}

/**
 * Build the user-message string the model sees. Deterministic given the
 * same input rows so tests can assert prompt stability and so identical
 * folders never re-bill.
 *
 * Exported so the test suite can drive it directly without DB stubs.
 *
 * @param {array}  files  - drive_files rows, newest-first
 * @param {number} [charCap]
 * @returns {{ prompt: string, includedCount: number, truncated: boolean, totalFiles: number }}
 */
function buildPrompt(files, charCap) {
  const cap = Number(charCap) > 0 ? Number(charCap) : maxSummaryChars();
  const lines = [];
  let usedChars = 0;
  let includedCount = 0;
  let truncated = false;

  // Header — flat, no timestamps, so prompt-stability tests can assert
  // string equality on a static input set.
  lines.push('Files analyzed (most recently modified first):');
  lines.push('');

  for (const f of files) {
    const header = [
      `--- FILE ---`,
      `drive_file_id: ${f.drive_file_id}`,
      `name: ${f.name}`,
      `mime_type: ${f.mime_type}`,
      `size_bytes: ${f.size_bytes || 0}`,
      `drive_modified_at: ${f.drive_modified_at ? new Date(f.drive_modified_at).toISOString() : 'unknown'}`,
      'content:',
      '',
    ].join('\n');

    const headerLen = header.length;
    if (usedChars + headerLen > cap) {
      truncated = true;
      break;
    }
    const remainingForContent = cap - usedChars - headerLen;
    const body = String(f.content_text || '');
    let contentSlice;
    if (body.length <= remainingForContent) {
      contentSlice = body;
    } else {
      truncated = true;
      contentSlice = body.slice(0, Math.max(0, remainingForContent - 32));
      contentSlice += '\n[…truncated…]';
    }
    lines.push(header + contentSlice);
    lines.push('');
    usedChars += headerLen + contentSlice.length + 1;
    includedCount++;
    if (truncated) break;
  }

  if (truncated) {
    lines.push('');
    lines.push(
      `Note: this is a partial view (${includedCount} of ${files.length} files included; ` +
      'others omitted to stay within the context budget). The summary may miss facts ' +
      'present only in the omitted files. Mention this caveat in summary_md when relevant.'
    );
  }
  lines.push('');
  lines.push('Produce the JSON object now. Output nothing other than JSON.');

  return {
    prompt: lines.join('\n'),
    includedCount,
    truncated,
    totalFiles: files.length,
  };
}

/**
 * Parse Claude's reply. Strips ``` fences, finds the first '{' and last
 * '}', and JSON.parses the slice. Returns either { ok: true, parsed } or
 * { ok: false, error }.
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
      source_file_id: kf.source_file_id ? String(kf.source_file_id).slice(0, 100) : undefined,
    }));
  return {
    ok: true,
    parsed: {
      summary_md: parsed.summary_md,
      key_facts:  cleanFacts,
    },
  };
}

/**
 * Generate and persist a new summary row for a deal/folder link.
 *
 * @param {object} opts
 * @param {number} opts.orgId
 * @param {number} opts.dealId
 * @param {number} opts.folderLinkId
 * @param {number} [opts.userId]
 * @returns {Promise<object>} the newly inserted deal_intel_summaries row
 */
async function generate({ orgId, dealId, folderLinkId, userId = null }) {
  if (!orgId || !dealId || !folderLinkId) {
    throw new Error('generate requires { orgId, dealId, folderLinkId }');
  }
  if (!ai.isConfigured()) {
    const err = new Error('AI not configured');
    err.code = 'AI_NOT_CONFIGURED';
    err.statusCode = 503;
    throw err;
  }

  const files = await loadFilesForLink({ orgId, folderLinkId });
  if (files.length === 0) {
    const err = new Error('No extracted file content to summarize. Run a sync first.');
    err.code = 'NO_CONTENT';
    err.statusCode = 400;
    throw err;
  }

  const { prompt, includedCount, truncated, totalFiles } = buildPrompt(files);

  const result = await ai.callClaude({
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1500,
    orgId,
    userId,
    endpoint: 'drive-intel-summary',
  });

  // Cost guard surfaced from quotaEnforcer.
  if (result.code === 'QUOTA_EXCEEDED') {
    const err = new Error(result.error || 'AI quota exceeded for this org');
    err.code = 'QUOTA_EXCEEDED';
    err.statusCode = 402;
    err.details = result.details;
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

  const parsed = parseModelReply(result.text);
  if (!parsed.ok) {
    logger.warn('drive_intel_parse_failed', {
      orgId, dealId, folderLinkId, error: parsed.error,
    });
    const err = new Error(`Could not parse model reply: ${parsed.error}`);
    err.code = 'BAD_MODEL_REPLY';
    err.statusCode = 502;
    throw err;
  }

  // Record the model that actually ran. ai.callClaude surfaces the resolved
  // model on its result so we can persist it without re-querying organizations
  // — keeps deal_intel_summaries.model lined up with ai_usage_events.model for
  // the same call. Fall back to the hardcoded default if the AI service
  // omitted it (legacy callers / test mocks); avoids issuing a second pool
  // query just to learn what was already resolved upstream.
  const model = result.model || aiModel.DEFAULT_MODEL;
  const tokensInput  = result.usage?.input_tokens  || null;
  const tokensOutput = result.usage?.output_tokens || null;

  const ins = await pool.query(
    `INSERT INTO deal_intel_summaries
       (org_id, deal_id, folder_link_id, model, prompt_version,
        summary_md, key_facts_json, files_analyzed_count,
        tokens_input, tokens_output, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
     RETURNING *`,
    [
      orgId, dealId, folderLinkId, model, PROMPT_VERSION,
      parsed.parsed.summary_md,
      JSON.stringify(parsed.parsed.key_facts),
      includedCount,
      tokensInput, tokensOutput, userId,
    ]
  );
  const row = ins.rows[0];
  logger.info('drive_intel_generated', {
    orgId, dealId, folderLinkId,
    files: includedCount, total_files: totalFiles, truncated,
    tokens_input: tokensInput, tokens_output: tokensOutput,
  });
  return row;
}

module.exports = {
  generate,
  buildPrompt,
  parseModelReply,
  loadFilesForLink,
  SYSTEM_PROMPT,
  PROMPT_VERSION,
  CHARS_PER_TOKEN,
  summaryTokenCap,
  maxSummaryChars,
};
