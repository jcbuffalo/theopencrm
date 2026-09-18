// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod schemas for /api/activities.
//
// Hand-rolled rule was: type, title, activity_date required on create; every
// other field free-form. PUT is partial (COALESCE-style). Free text uses
// .trim() and reasonable length caps to keep multi-megabyte payloads out.

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
  type: z.string().trim().min(1, 'type required').max(64),
  title: z.string().trim().min(1, 'title required').max(500),
  activity_date: z
    .string()
    .trim()
    .min(1, 'activity_date required')
    .refine(v => !Number.isNaN(Date.parse(v)), { message: 'activity_date must be an ISO date string' }),
  contact_id: optInt,
  deal_id: optInt,
  description: optStr(10000),
  duration_minutes: optInt,
  outcome: optStr(255),
  notes: optStr(10000),
}).passthrough();

const updateSchema = z.object({
  type: optStr(64),
  title: optStr(500),
  contact_id: optInt,
  deal_id: optInt,
  activity_date: optDate,
  description: optStr(10000),
  duration_minutes: optInt,
  outcome: optStr(255),
  notes: optStr(10000),
}).passthrough();

module.exports = { createSchema, updateSchema };
