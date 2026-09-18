// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod schemas for /api/saved-views.
//
// Hand-rolled rules:
//   POST: resource must be in VALID_RESOURCES; name required (trimmed, ≤80).
//   PUT:  every field is optional; type-checking on booleans + display_order.
// filter_spec / sort_spec are kept opaque (JSONB) — see migration 068 header.

const { z } = require('zod');

const VALID_RESOURCES = ['companies', 'contacts', 'deals', 'tasks'];

const opaqueJson = z.union([
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
  z.null(),
  z.undefined(),
]).optional();

// Match the previous truncate-silently behaviour for `name` (trim + slice(0,80))
// so we don't 400 callers who were getting their long names quietly clipped.
const truncName = z.string().trim().min(1, 'name required').transform(s => s.slice(0, 80));

const createSchema = z.object({
  resource: z.enum(VALID_RESOURCES, { message: `resource must be one of: ${VALID_RESOURCES.join(', ')}` }),
  name: truncName,
  filter_spec: opaqueJson,
  sort_spec: opaqueJson,
  is_default: z.boolean().optional(),
  is_shared: z.boolean().optional(),
  display_order: z.number().int().optional(),
}).passthrough();

const updateSchema = z.object({
  name: truncName.optional(),
  filter_spec: opaqueJson,
  sort_spec: opaqueJson,
  is_default: z.boolean().optional(),
  is_shared: z.boolean().optional(),
  display_order: z.number().int().optional(),
}).passthrough();

module.exports = { createSchema, updateSchema, VALID_RESOURCES };
