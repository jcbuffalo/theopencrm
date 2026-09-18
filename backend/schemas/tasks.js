// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod schemas for /api/tasks.
//
// Hand-rolled rule was: title required on create; everything else free-form.
// `assigned_to` has special handling in the PUT handler (undefined vs null —
// preserved by treating undefined as "don't change" via the optional()
// modifier; if the caller explicitly sends null we forward null so the SQL
// COALESCE keeps the existing value).

const { z } = require('zod');

// Recurrence allowlist (migration 129). Single source of truth shared with
// services/recurringTasks.js — anything outside this list is a 400 at the
// validate layer, so garbage never reaches SQL. '' (frontend "None") → null.
const RECURRENCE_RULES = ['daily', 'weekly', 'biweekly', 'monthly'];
const recurrenceRule = z
  .union([z.enum(RECURRENCE_RULES), z.null(), z.literal('')])
  .transform(v => (v === '' ? null : v))
  .optional();

const optStr = (max) => z
  .union([z.string(), z.null()])
  .transform(v => {
    if (v == null) return null;
    const t = v.trim();
    return t === '' ? null : t;
  })
  .pipe(z.union([z.null(), z.string().max(max)]))
  .optional();

const optInt = z.union([z.number().int(), z.null(), z.undefined()]).optional();
const customFields = z.union([z.record(z.string(), z.unknown()), z.null()]).optional();

const optDate = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v, ctx) => {
    if (v == null || v === '') return null;
    if (Number.isNaN(Date.parse(v))) {
      ctx.addIssue({ code: 'custom', message: 'must be an ISO date string' });
      return z.NEVER;
    }
    return v;
  })
  .optional();

const createSchema = z.object({
  title: z.string().trim().min(1, 'Task title required').max(500),
  contact_id: optInt,
  deal_id: optInt,
  description: optStr(10000),
  due_date: optDate,
  status: optStr(64),
  priority: optStr(32),
  assigned_to: optInt,
  custom_fields: customFields,
  recurrence_rule: recurrenceRule,
}).passthrough();

const updateSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  contact_id: optInt,
  deal_id: optInt,
  description: optStr(10000),
  due_date: optDate,
  status: optStr(64),
  priority: optStr(32),
  assigned_to: optInt,
  custom_fields: customFields,
  recurrence_rule: recurrenceRule,
  // Stop/resume a series without deleting history; boolean only.
  recurrence_active: z.union([z.boolean(), z.null()]).optional(),
}).passthrough();

// Bulk allowlist (assigned_to / status / due_date / priority) still enforced
// inside _bulkOps.js.
const bulkPatchSchema = z.object({
  ids: z.array(z.union([z.number().int(), z.string().regex(/^\d+$/)])).min(1).max(1000),
  patch: z.record(z.string(), z.unknown()).refine(o => Object.keys(o).length > 0, { message: 'patch must contain at least one field' }),
});

module.exports = { createSchema, updateSchema, bulkPatchSchema, RECURRENCE_RULES };
