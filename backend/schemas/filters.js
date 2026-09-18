// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod schemas for /api/filters.
//
// Only POST /saved takes a body. Hand-rolled rule was: scope, name, filters
// all required. `name` is truncated to 80 chars on insert (matches the
// `truncName` pattern in schemas/savedViews.js) so we preserve the silent
// truncate to avoid breaking existing callers.
//
// filters is opaque JSON (the DealFilters.js UI dumps a mixed-shape object).

const { z } = require('zod');

const opaqueJson = z.union([
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);

const truncName = z.string().trim().min(1, 'name required').transform(s => s.slice(0, 80));

const saveFilterSchema = z.object({
  scope: z.string().trim().min(1, 'scope required').max(64),
  name: truncName,
  filters: opaqueJson,
}).passthrough();

module.exports = { saveFilterSchema };
