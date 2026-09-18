// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Plugin spec validator.
//
// Conservative, allowlist-driven validation of the JSON shape Claude (or any
// future authoring surface — library install, code editor, future MCP-style
// builder) emits for a plugin. The rule: when in doubt, reject. The blast
// radius of a draft plugin is bounded by the isolated-vm sandbox, but we'd
// rather not let unsafe-looking code into the org's plugin list at all.
//
// USAGE:
//   const { validateSpec } = require('./pluginSpecValidator');
//   const result = validateSpec(spec);
//   if (!result.ok) return res.status(422).json({ errors: result.errors });
//
// SHAPE EXPECTED (mirrors pluginLibrary.js entries):
//   {
//     name:          string (1..120 chars)
//     description?:  string (<=2000)
//     trigger_event: string (one of TRIGGER_EVENTS)
//     source_kind:   'conversational' | 'library' | 'code'
//     spec_json:     { ...structured spec, freeform JSON object... }
//     source_code?:  string (<=200000) — optional, plain JS body for the
//                    runner. When present, scanned against an SDK allowlist;
//                    when absent, the runner will synthesize source from
//                    spec_json (Phase D build-out — currently the runner
//                    requires source_code).
//   }
//
// SDK ALLOWLIST — the only method names the spec / source_code may reference.
// Mirrors the surface exposed by services/pluginSdk.buildContext (which is
// what the sandbox actually binds). Authoring tools that emit unknown method
// names get rejected before the row hits the DB.

// Plugin SDK methods the sandbox actually exposes. Drawn from
// pluginSdk.buildContext's return value. Add to this list ONLY when the SDK
// gains a new method — never to "loosen" an existing rejection.
const SDK_METHOD_ALLOWLIST = [
  'getDeal', 'listDeals',
  'getContact', 'listContacts',
  'getCompany', 'listCompanies',
  'getTask', 'listTasks',
  // Module-object reads (2026-09 expansion). Flag-gated per org inside the
  // SDK: leads_enabled / customer_success_enabled / quotes_enabled — a
  // disabled module returns []/null + a run-log warning, never an error.
  'getLead', 'listLeads',
  'getCase', 'listCases',
  'getQuote', 'listQuotes',
  'getMeeting', 'listMeetings',
  'listServiceContracts',
  'updateDeal', 'updateContact', 'updateCompany', 'updateTask',
  'updateLead', 'updateCase',
  'createTask',
  // The metered AI bridge (crm.ai.complete — max 2 upstream calls per run,
  // billing-gated in-path; see PLUGIN_SDK_REFERENCE.md). Namespaced entries
  // are matched by the dedicated crm.ai.* scan below, not the flat scan.
  'ai.complete',
  'log',
];

// Methods allowed under the crm.ai.* namespace. Kept separate because the
// flat `crm.<name>(` regex can't see through the extra dot.
const AI_NAMESPACE_ALLOWLIST = ['complete'];

// Trigger events the platform recognizes. The fromPrompt system prompt
// (services/pluginGenerator.js) renders this array inline, so extending it
// here updates the authoring surface too. The DISPATCHED subset lives in
// services/pluginEvents.PLUGIN_EVENTS (migration 164) — this authoring list
// must stay a superset of it (test-enforced in test/pluginEvents.test.js).
// 'invoice.paid' and 'schedule.weekly' are accepted at authoring time but
// have no dispatch call site yet.
const TRIGGER_EVENTS = [
  'deal.created',
  'deal.updated',
  'deal.stage_changed',
  'contact.created',
  'company.created',
  'lead.created',
  'case.created',
  'task.overdue',
  'quote.sent',
  'invoice.paid',
  'task.completed',
  'schedule.daily',
  'schedule.weekly',
  'schedule.hourly',
  'manual',
];

// Allowed action.kind values in the structured spec_json.actions[] array.
//
// IMPORTANT — actions are DECLARATIVE METADATA, not an execution plan. The
// runner (services/pluginRunner.js) executes ONLY source_code; it never
// interprets spec_json.actions. The action list exists so describe_plugin
// and the library UI can explain a plugin's behavior without exposing raw
// source. In particular, 'claude_complete' does NOT make the runner call
// Claude — runnable AI behavior comes from source_code calling
// `await crm.ai.complete({...})` (metered, billing-gated; see
// PLUGIN_SDK_REFERENCE.md). A claude_complete action should mirror what the
// source actually does with crm.ai.complete.
const ACTION_KINDS = [
  'send_email',
  'create_task',
  'set_field',
  'claude_complete',
  'noop',
];

// Bright-line dangerous patterns. If any of these appear in spec_json (as a
// string anywhere) or source_code, reject. The plugin sandbox already blocks
// most of these via the missing globals (no `require`, no `process`, no
// network), but rejecting at the authoring layer keeps the row clean and
// surfaces a clear error message to the user instead of a runtime failure.
const DANGEROUS_PATTERNS = [
  { re: /\brequire\s*\(/,                  reason: 'require() is not available inside the sandbox' },
  { re: /\bprocess\s*\.\s*env\b/,          reason: 'process.env is not exposed to plugins' },
  { re: /\bglobal(This)?\s*\.\s*\w+\s*=/,  reason: 'mutating globals is not allowed' },
  { re: /\beval\s*\(/,                     reason: 'eval() is not allowed' },
  { re: /\bnew\s+Function\s*\(/,           reason: 'new Function() is not allowed' },
  { re: /\bchild_process\b/,               reason: 'child_process is not available' },
  { re: /\bfs\s*\.\s*(read|write|append|unlink|rm)/, reason: 'fs is not available' },
  { re: /\b(import|importScripts)\s*\(/,   reason: 'dynamic import is not available' },
  { re: /\bfetch\s*\(/,                    reason: 'fetch is not available (no network egress)' },
  { re: /\bWebSocket\b/,                   reason: 'WebSocket is not available' },
];

// Per-field length ceilings. Mirror the zod schema in schemas/plugins.js so
// the validator alone is enough — callers don't need to re-check.
const LIMITS = {
  name_max:         120,
  description_max:  2000,
  source_code_max:  200000,
  trigger_event_max: 80,
  actions_max:      10,
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function pushErr(errors, field, msg) {
  errors.push({ field, message: msg });
}

/**
 * Validate a plugin spec object. Pure — no DB, no env reads, no AI calls.
 *
 * @param {object} spec
 * @returns {{ok: true} | {ok: false, errors: Array<{field, message}>}}
 */
function validateSpec(spec) {
  const errors = [];

  if (!isPlainObject(spec)) {
    return { ok: false, errors: [{ field: '(root)', message: 'spec must be a plain object' }] };
  }

  // ---- name ---------------------------------------------------------------
  if (typeof spec.name !== 'string' || !spec.name.trim()) {
    pushErr(errors, 'name', 'name must be a non-empty string');
  } else if (spec.name.length > LIMITS.name_max) {
    pushErr(errors, 'name', `name must be ${LIMITS.name_max} characters or fewer`);
  }

  // ---- description (optional) --------------------------------------------
  if (spec.description !== undefined && spec.description !== null) {
    if (typeof spec.description !== 'string') {
      pushErr(errors, 'description', 'description must be a string');
    } else if (spec.description.length > LIMITS.description_max) {
      pushErr(errors, 'description', `description must be ${LIMITS.description_max} characters or fewer`);
    }
  }

  // ---- trigger_event ------------------------------------------------------
  if (typeof spec.trigger_event !== 'string' || !spec.trigger_event) {
    pushErr(errors, 'trigger_event', 'trigger_event is required');
  } else if (!TRIGGER_EVENTS.includes(spec.trigger_event)) {
    pushErr(errors, 'trigger_event',
      `trigger_event must be one of: ${TRIGGER_EVENTS.join(', ')}`);
  }

  // ---- source_kind --------------------------------------------------------
  if (spec.source_kind !== undefined) {
    if (!['conversational', 'library', 'code'].includes(spec.source_kind)) {
      pushErr(errors, 'source_kind',
        `source_kind must be one of: conversational, library, code`);
    }
  }

  // ---- spec_json ----------------------------------------------------------
  if (!isPlainObject(spec.spec_json)) {
    pushErr(errors, 'spec_json', 'spec_json must be a plain object');
  } else {
    // actions[] is the structured-action list. If present it must be an
    // array of recognized action kinds; freeform is rejected to keep the
    // surface tight.
    if (spec.spec_json.actions !== undefined) {
      if (!Array.isArray(spec.spec_json.actions)) {
        pushErr(errors, 'spec_json.actions', 'actions must be an array');
      } else if (spec.spec_json.actions.length === 0) {
        pushErr(errors, 'spec_json.actions', 'actions must have at least one entry');
      } else if (spec.spec_json.actions.length > LIMITS.actions_max) {
        pushErr(errors, 'spec_json.actions',
          `actions must have at most ${LIMITS.actions_max} entries`);
      } else {
        spec.spec_json.actions.forEach((a, idx) => {
          if (!isPlainObject(a)) {
            pushErr(errors, `spec_json.actions[${idx}]`, 'action must be a plain object');
            return;
          }
          if (typeof a.kind !== 'string' || !ACTION_KINDS.includes(a.kind)) {
            pushErr(errors, `spec_json.actions[${idx}].kind`,
              `action.kind must be one of: ${ACTION_KINDS.join(', ')}`);
          }
        });
      }
    }
  }

  // ---- source_code (optional) — must reference only allowlisted SDK ------
  if (spec.source_code !== undefined && spec.source_code !== null) {
    if (typeof spec.source_code !== 'string') {
      pushErr(errors, 'source_code', 'source_code must be a string');
    } else if (spec.source_code.length > LIMITS.source_code_max) {
      pushErr(errors, 'source_code',
        `source_code must be ${LIMITS.source_code_max} characters or fewer`);
    } else {
      // Scan for dangerous patterns BEFORE the allowlist check — a clear
      // "you used eval" message is more actionable than "unknown SDK call".
      for (const { re, reason } of DANGEROUS_PATTERNS) {
        if (re.test(spec.source_code)) {
          pushErr(errors, 'source_code', reason);
        }
      }
      // SDK method allowlist. We look for `crm.<methodName>(` and reject if
      // any method name in that position is not in the allowlist. Catches
      // typos and disallowed surface alike. The regex matches the same shape
      // as the SDK call convention in pluginSdk.js (`crm.getDeal(id)` etc.).
      const crmCallRe = /\bcrm\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
      const seen = new Set();
      let m;
      while ((m = crmCallRe.exec(spec.source_code)) !== null) {
        const method = m[1];
        if (seen.has(method)) continue;
        seen.add(method);
        if (!SDK_METHOD_ALLOWLIST.includes(method)) {
          pushErr(errors, 'source_code',
            `unknown SDK method "crm.${method}". Allowed: ${SDK_METHOD_ALLOWLIST.join(', ')}`);
        }
      }
      // Namespaced AI calls: `crm.ai.<method>(`. The flat regex above never
      // matches these (the identifier after `crm.` is followed by another
      // dot, not `(`), so scan for them explicitly and hold them to the AI
      // namespace allowlist.
      const crmAiCallRe = /\bcrm\s*\.\s*ai\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
      const seenAi = new Set();
      while ((m = crmAiCallRe.exec(spec.source_code)) !== null) {
        const method = m[1];
        if (seenAi.has(method)) continue;
        seenAi.add(method);
        if (!AI_NAMESPACE_ALLOWLIST.includes(method)) {
          pushErr(errors, 'source_code',
            `unknown SDK method "crm.ai.${method}". Allowed: ${AI_NAMESPACE_ALLOWLIST.map(n => `crm.ai.${n}`).join(', ')}`);
        }
      }
    }
  }

  // ---- dangerous-pattern scan on spec_json --------------------------------
  // String values inside spec_json (template strings, prompt_template, etc.)
  // are not source code, but we still reject obvious shell-out / eval
  // attempts so a "creative" model can't smuggle them in.
  if (isPlainObject(spec.spec_json)) {
    try {
      const flatJson = JSON.stringify(spec.spec_json);
      for (const { re, reason } of DANGEROUS_PATTERNS) {
        if (re.test(flatJson)) {
          pushErr(errors, 'spec_json', `dangerous pattern in spec_json: ${reason}`);
          break; // one is enough to surface; no need to list every match
        }
      }
    } catch {
      // JSON.stringify on a value with a circular ref throws — treat as
      // malformed and reject.
      pushErr(errors, 'spec_json', 'spec_json could not be serialized (circular reference?)');
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

module.exports = {
  validateSpec,
  SDK_METHOD_ALLOWLIST,
  AI_NAMESPACE_ALLOWLIST,
  TRIGGER_EVENTS,
  ACTION_KINDS,
  DANGEROUS_PATTERNS,
  LIMITS,
};
