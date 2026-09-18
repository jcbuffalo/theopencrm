// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Curated plugin library — one-click-install templates.
//
// Split from the original single-file services/pluginLibrary.js into
// per-category modules once the list passed 30 entries. The export shape is
// unchanged ({ list, getBySlug, LIBRARY }) so every existing caller —
// routes/pluginRoutes.js and the test suite — keeps working untouched.
//
// AUTHORING CONTRACT (every entry):
//   • slug / name / category / icon / summary / tags — the marketing surface
//     the /plugins/library page renders. Summaries are customer-facing copy:
//     one tight paragraph, honest about what the extension actually does.
//   • spec.name MUST equal the slug (the install path uses it as the plugin
//     row name).
//   • spec.triggerEvent MUST be in pluginSpecValidator.TRIGGER_EVENTS.
//   • spec.actions[] — declarative description of the behavior (validated
//     action kinds). claude_complete entries describe the AI half; the AI is
//     metered per-org and every entry must be useful with AI unconfigured.
//   • spec.source_code — the RUNNABLE implementation. The install path
//     (routes/pluginRoutes.js cloneTemplateForOrg) copies it onto the plugin
//     row, and the sandbox runner executes exactly this. It must:
//       - use module.exports = { async run({ crm, input }) { ... } } (never
//         globalThis assignment — the validator rejects it),
//       - call ONLY allowlisted crm.* methods (see pluginSpecValidator
//         SDK_METHOD_ALLOWLIST) — no network, no AI call, no email from the
//         sandbox,
//       - stay inside the run budgets: 50 DB calls, 10 createTask, 5s wall
//         clock (see PLUGIN_SDK_REFERENCE.md) — cap every loop,
//       - tolerate ANY input shape, including null (manual test runs) and
//         whatever payload the event-trigger engine delivers,
//       - reference only fields on the SDK read allowlists (leads/cases/
//         meetings are NOT readable — entries for those events work from the
//         trigger payload alone).
//   • Entries needing per-org configuration declare requiredConfig; entries
//     needing an external integration declare requiredIntegration.
//
// The five original entries (follow-up-on-quote-sent, mark-hot-large-deal,
// invoiced-survey, stalled-deal-digest, vendor-price-validation-30d) are
// preserved verbatim in their category modules.

const LIBRARY = [
  ...require('./sales'),
  ...require('./hygiene'),
  ...require('./cx'),
  ...require('./reporting'),
  ...require('./ops'),
  ...require('./procurement'),
];

// Load-time integrity check: duplicate slugs would make getBySlug ambiguous
// and the install path nondeterministic. Fail the require, not the request.
{
  const seen = new Set();
  for (const item of LIBRARY) {
    if (seen.has(item.slug)) {
      throw new Error(`pluginLibrary: duplicate slug "${item.slug}"`);
    }
    seen.add(item.slug);
  }
}

function list() {
  return LIBRARY.map(item => ({
    slug: item.slug,
    name: item.name,
    category: item.category,
    icon: item.icon,
    summary: item.summary,
    tags: item.tags || [],
    triggerEvent: item.spec.triggerEvent,
    requiredConfig: item.requiredConfig || [],
    requiredIntegration: item.requiredIntegration || null,
  }));
}

function getBySlug(slug) {
  return LIBRARY.find(item => item.slug === slug) || null;
}

module.exports = { list, getBySlug, LIBRARY };
