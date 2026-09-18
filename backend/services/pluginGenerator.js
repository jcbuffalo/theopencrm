// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Plugin-spec generation from a natural-language description.
//
// EXTRACTED (verbatim) from routes/pluginRoutes.js so that the chat copilot's
// confirm-first `propose_build_plugin` tool and the original
// POST /api/plugins/from-prompt route share ONE generation engine — one
// system prompt, one parse/retry policy, one output contract. Do not fork a
// second LLM prompt for plugin authoring; extend this one.
//
// The generated spec is UNTRUSTED until it passes
// services/pluginSpecValidator.validateSpec — every caller must validate
// before persisting. This module never writes to the DB and never runs code.

const ai = require('./ai');
const { TRIGGER_EVENTS, ACTION_KINDS, SDK_METHOD_ALLOWLIST } = require('./pluginSpecValidator');

// System prompt for the spec-from-prompt LLM call. Inlined as a const so the
// test suite can spy on it and so a future "tweak the prompt" task can diff
// it cleanly without scrolling through route plumbing.
//
// Notes on the design:
//   • We tell Claude the OUTPUT FORMAT is the EXACT shape the DB column
//     names use (name / description / trigger_event / source_kind /
//     spec_json / source_code). That way the parsed JSON can be handed
//     directly to validateSpec + the INSERT without a translation step.
//   • The SDK allowlist is rendered inline so the model can't invent
//     `crm.deals.create` or `crm.email.send` — the validator would reject
//     them, but it's cheaper to nudge the model away upfront.
//   • We name the only supported source_kind for this endpoint as
//     'conversational' explicitly. Library installs and raw-code authoring
//     go through their own paths.
const FROM_PROMPT_SYSTEM = [
  'You are an assistant that turns a natural-language description from a CRM user into a structured PLUGIN SPEC for The Open CRM.',
  '',
  'OUTPUT CONTRACT — your reply MUST be a single JSON object, no prose, no markdown fence, with EXACTLY these top-level keys:',
  '{',
  '  "name":          "short kebab-case name, max 120 chars, no spaces",',
  '  "description":   "1-3 plain-English sentences explaining what the plugin does",',
  '  "trigger_event": one of [' + TRIGGER_EVENTS.map(e => `"${e}"`).join(', ') + '],',
  '  "source_kind":   "conversational",',
  '  "spec_json": {',
  '    "summary":     "same as description, for parity with the library templates",',
  '    "triggerEvent":   echo of trigger_event,',
  '    "triggerFilter":  optional object of simple key/value filters (e.g. { "stage": "ORDACK" }), or null,',
  '    "actions":     non-empty array (max 10) where each entry is an object with',
  '                   { "kind": one of [' + ACTION_KINDS.map(k => `"${k}"`).join(', ') + '], ...inline params... }',
  '  },',
  '  "source_code":   short plain-JS body the runner can execute. Reference the SDK',
  '                   as `crm.<methodName>(args)`. ALLOWED methods (and ONLY these):',
  '                   ' + SDK_METHOD_ALLOWLIST.map(m => `crm.${m}`).join(', ') + '.',
  '                   The plugin body has access to `input`, `crm`, and `console.log`. No require, no fetch, no process.',
  '                   Keep under 4000 characters. Single async function body that returns a small JSON-serializable summary.',
  '}',
  '',
  'RULES:',
  '- Output ONLY the JSON object. No preamble, no closing remarks, no markdown fence.',
  '- Never invent SDK methods. If the user asks for something not in the allowlist (e.g. "send a Slack message"), pick the closest supported approach (e.g. createTask with a clear title) and mention the limitation in the description.',
  '- Keep it conservative: one trigger, one to three actions at most.',
  '- triggerEvent must be one of the listed values; if unclear, pick "manual".',
  '- Use single quotes inside source_code so the JSON-encoding of the string stays clean.',
].join('\n');

// Strip optional markdown fences and locate the JSON object inside the
// model's reply. Mirrors services/intelSummary.parseModelReply but tailored
// to our shape — we don't require any particular subfield because the
// pluginSpecValidator runs immediately after.
function parseSpecReply(text) {
  if (!text || typeof text !== 'string') return { ok: false, error: 'empty reply' };
  let raw = text.trim();
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }
  const first = raw.indexOf('{');
  const last  = raw.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) {
    return { ok: false, error: 'no JSON object found in model reply' };
  }
  try {
    return { ok: true, parsed: JSON.parse(raw.slice(first, last + 1)) };
  } catch (err) {
    return { ok: false, error: `JSON parse failed: ${err.message}` };
  }
}

// Run the LLM call. Retries ONCE on a parse failure — same call, fresh
// sample, no prompt tweaks. The model is occasionally noisy with trailing
// prose; one retry is the cheap fix without spending a third call.
//
// `endpoint` tags the AI-usage metering row so /usage can attribute spend to
// the calling surface (route vs. chat tool). Defaults to the original route's
// tag for back-compat.
async function generatePluginSpec({ description, orgId, userId, endpoint = 'plugin-spec-from-prompt' }) {
  const userMessage = `User's description:\n\n${description}\n\nGenerate the plugin spec.`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const aiResult = await ai.callClaude({
      system: FROM_PROMPT_SYSTEM,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens: 4000,
      orgId,
      userId,
      endpoint,
    });
    // Surface AI-layer failures up to the caller verbatim — they map to
    // 503 / 429 in the route handler.
    if (!aiResult.configured) return { ok: false, configured: false };
    if (!aiResult.ok) {
      return {
        ok: false,
        configured: true,
        error: aiResult.error || 'AI generation failed',
        code: aiResult.code || null,
      };
    }
    const parsed = parseSpecReply(aiResult.text);
    if (parsed.ok) {
      return { ok: true, spec: parsed.parsed, rawText: aiResult.text };
    }
    // Save the first parse error so we can surface it if the retry also fails.
    if (attempt === 1) {
      return {
        ok: false,
        configured: true,
        parseFailed: true,
        error: parsed.error,
        rawText: aiResult.text,
      };
    }
  }
  // Unreachable, but defensive.
  return { ok: false, configured: true, error: 'spec generation exhausted retries' };
}

module.exports = { FROM_PROMPT_SYSTEM, parseSpecReply, generatePluginSpec };
