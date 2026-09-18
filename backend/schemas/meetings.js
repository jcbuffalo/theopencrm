// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod schemas for /api/meetings.
//
// Shape gates only — tenancy (org-scoping of the row AND of every linked
// company/deal/contact) is enforced in meetingRoutes.js, mirroring how
// schemas/tasks.js splits responsibilities with taskRoutes.js.
//
// Nullable-link semantics: on update, "field absent" means don't change,
// "field: null" means clear it. The route reads hasOwnProperty flags to drive
// CASE expressions (the same pattern taskRoutes uses for recurrence_rule), so
// these schemas deliberately keep null distinct from undefined.

const { z } = require('zod');

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

// Timestamps arrive as ISO strings from the datetime-local inputs. '' → null
// so an emptied form field clears the value rather than 400ing.
const tsField = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v, ctx) => {
    if (v == null || v === '') return null;
    if (Number.isNaN(Date.parse(v))) {
      ctx.addIssue({ code: 'custom', message: 'must be an ISO date-time string' });
      return z.NEVER;
    }
    return v;
  });

const createSchema = z.object({
  title: z.string().trim().min(1, 'Meeting title required').max(500),
  starts_at: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'starts_at must be an ISO date-time string'),
  ends_at: tsField.optional(),
  company_id: optInt,
  deal_id: optInt,
  contact_id: optInt,
  location: optStr(255),
  notes: optStr(10000),
  external_event_id: optStr(255),
}).passthrough();

const updateSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  starts_at: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'starts_at must be an ISO date-time string').optional(),
  ends_at: tsField.optional(),
  company_id: optInt,
  deal_id: optInt,
  contact_id: optInt,
  location: optStr(255),
  notes: optStr(10000),
  external_event_id: optStr(255),
}).passthrough();

module.exports = { createSchema, updateSchema };
