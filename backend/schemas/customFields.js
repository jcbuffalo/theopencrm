// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod schemas for /api/custom-fields.
//
// Mirrors the hand-rolled NAME_RE / VALID_TYPES / VALID_ENTITIES rules in
// customFieldsRoutes.js. We re-import the constants where possible to avoid
// duplication; the regex / type list / entity list are owned by the route
// module which exports them.
//
// IMPORTANT: validateFieldDefShape() runs inside the route handler too — it
// also checks RESERVED_COLUMNS (a name can't shadow a real shared-schema
// column). That DB-shape check can't live in zod, so it stays in the handler.
// zod is the cheap shape gate; the handler still validates against the
// runtime context.

const { z } = require('zod');

const VALID_ENTITIES = ['companies', 'contacts', 'deals', 'tasks'];
const VALID_TYPES    = ['text', 'number', 'date', 'select', 'multiselect', 'boolean'];
const NAME_RE        = /^[a-z][a-z0-9_]{1,59}$/;

const createSchema = z.object({
  entity: z.enum(VALID_ENTITIES, { message: `entity must be one of: ${VALID_ENTITIES.join(', ')}` }),
  name: z.string().regex(NAME_RE, 'name must match /^[a-z][a-z0-9_]{1,59}$/ (lowercase, snake_case, max 60 chars)'),
  label: z.union([z.string().max(120, 'label must be a string ≤ 120 chars'), z.null(), z.undefined()]).optional(),
  type: z.enum(VALID_TYPES, { message: `type must be one of: ${VALID_TYPES.join(', ')}` }),
  options: z.union([
    z.array(z.string().min(1, 'Each option must be a non-empty string ≤ 80 chars').max(80, 'Each option must be a non-empty string ≤ 80 chars')),
    z.null(),
    z.undefined(),
  ]).optional(),
  required: z.union([z.boolean(), z.null(), z.undefined()]).optional(),
  position: z.union([z.number().int().min(0, 'position must be an integer 0..999').max(999, 'position must be an integer 0..999'), z.null(), z.undefined()]).optional(),
}).passthrough();
// NOTE: select/multiselect "options non-empty + unique" and the reserved-column
// check still live inside validateFieldDefShape — keeping the rules in one
// place. zod here is just the surface-level shape gate.

const updateSchema = z.object({
  label: z.union([z.string().max(120, 'label must be a string ≤ 120 chars'), z.null(), z.undefined()]).optional(),
  options: z.union([
    z.array(z.string().min(1).max(80)),
    z.null(),
    z.undefined(),
  ]).optional(),
  required: z.union([z.boolean(), z.null(), z.undefined()]).optional(),
  position: z.union([z.number().int().min(0).max(999), z.null(), z.undefined()]).optional(),
}).passthrough();

module.exports = { createSchema, updateSchema, VALID_ENTITIES, VALID_TYPES, NAME_RE };
