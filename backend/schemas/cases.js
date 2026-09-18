// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod schemas for /api/cases (CS-5).
//
// Unlike issues (whose status/urgency are open strings for historical
// reasons), cases are a NEW table with no legacy rows, so status and priority
// are STRICT allowlists — an unknown value 400s at the API edge before any
// SQL runs. resolved_at is never client-writable: caseRoutes.js stamps it on
// the transition into resolved/closed and clears it on reopen.

const { z } = require('zod');

const CASE_STATUSES = ['open', 'pending', 'resolved', 'closed'];
const CASE_PRIORITIES = ['low', 'normal', 'high', 'urgent'];

// Optional trimmed string: '' / null → null, otherwise max-length checked.
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

// Optional ISO-ish timestamp: '' / null → null; anything else must parse.
const optDate = z
  .union([z.string(), z.date(), z.null(), z.undefined()])
  .transform((v, ctx) => {
    if (v == null || v === '') return null;
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: 'custom', message: 'must be a valid date' });
      return z.NEVER;
    }
    return d.toISOString();
  })
  .optional();

const createSchema = z.object({
  subject: z.string().trim().min(1, 'Case subject required').max(500),
  description: optStr(10000),
  status: z.enum(CASE_STATUSES).optional(),
  priority: z.enum(CASE_PRIORITIES).optional(),
  company_id: optInt,
  contact_id: optInt,
  owner_user_id: optInt,
  sla_due_at: optDate,
}).passthrough();

const updateSchema = z.object({
  subject: z.string().trim().min(1).max(500).optional(),
  description: optStr(10000),
  status: z.enum(CASE_STATUSES).optional(),
  priority: z.enum(CASE_PRIORITIES).optional(),
  company_id: optInt,
  contact_id: optInt,
  owner_user_id: optInt,
  sla_due_at: optDate,
}).passthrough();

module.exports = { createSchema, updateSchema, CASE_STATUSES, CASE_PRIORITIES };
