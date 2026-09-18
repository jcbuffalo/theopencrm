// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod schema for PUT /api/dashboard/layout.
//
// Rules:
//   * layout is a required array (may be empty — "I removed everything" is a
//     legitimate saved state, distinct from "no row" which yields the default).
//   * every widgetKey must be in the services/dashboardWidgets.js allowlist —
//     unknown keys are a 400, never silently dropped (a typo'd key should be
//     loud at save time, not invisible at render time).
//   * no duplicate widgetKeys — each widget appears at most once.
//   * size, when present, is 'half' | 'full' (route falls back to the
//     widget's defaultSize when omitted).
//   * hard cap well above the registry size so a runaway client can't persist
//     megabytes of JSONB.

const { z } = require('zod');
const { WIDGET_KEYS } = require('../services/dashboardWidgets');

const layoutItem = z.object({
  widgetKey: z.enum(WIDGET_KEYS, {
    message: `widgetKey must be one of: ${WIDGET_KEYS.join(', ')}`,
  }),
  size: z.enum(['half', 'full']).optional(),
}).passthrough();

const putLayoutSchema = z.object({
  layout: z.array(layoutItem)
    .max(WIDGET_KEYS.length * 2, 'layout has too many widgets')
    .superRefine((items, ctx) => {
      const seen = new Set();
      for (const it of items) {
        if (seen.has(it.widgetKey)) {
          ctx.addIssue({ code: 'custom', message: `duplicate widgetKey: ${it.widgetKey}`, path: [] });
          return;
        }
        seen.add(it.widgetKey);
      }
    }),
});

module.exports = { putLayoutSchema };
