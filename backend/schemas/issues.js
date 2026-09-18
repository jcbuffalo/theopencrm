// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod schemas for /api/issues.
//
// Hand-rolled rule was: title required on create. Everything else free-form
// strings / ints. status transitions to 'resolved' or 'bypassed' stamp
// resolved_at in the handler. blocks_workflow is coerced to !!value in the
// handler so we accept any truthy.
//
// urgency / status / category are open strings here — the UI offers fixed
// dropdowns (see filterRoutes.js for the canonical option lists) but the
// underlying column is text and migration history shows ad-hoc values, so we
// don't 400 on an unknown value at the API edge.

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
const optBool = z.union([z.boolean(), z.null(), z.undefined()]).optional();

const optNum = z
  .union([z.number(), z.string(), z.null(), z.undefined()])
  .transform((v, ctx) => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    const n = Number(v);
    if (Number.isNaN(n)) {
      ctx.addIssue({ code: 'custom', message: 'must be a number' });
      return z.NEVER;
    }
    return n;
  })
  .optional();

const createSchema = z.object({
  title: z.string().trim().min(1, 'Issue title required').max(500),
  related_type: optStr(64),
  related_id: optInt,
  description: optStr(10000),
  category: optStr(64),
  sub_category: optStr(120),
  urgency: optStr(32),
  financial_impact: optNum,
  blocks_workflow: optBool,
  status: optStr(64),
  assigned_to_user_id: optInt,
}).passthrough();

const updateSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  description: optStr(10000),
  category: optStr(64),
  sub_category: optStr(120),
  urgency: optStr(32),
  financial_impact: optNum,
  blocks_workflow: optBool,
  status: optStr(64),
  assigned_to_user_id: optInt,
  resolution_notes: optStr(10000),
}).passthrough();

module.exports = { createSchema, updateSchema };
