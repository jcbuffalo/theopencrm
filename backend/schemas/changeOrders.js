// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod schemas for /api/change-orders.
//
// Hand-rolled rule was: deal_id required on create. amount_delta is a money
// number (positive or negative). status transitions to 'approved' stamp the
// approved_at column in the handler.

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
  deal_id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)], { message: 'deal_id required' }),
  description: optStr(10000),
  amount_delta: optNum,
  status: optStr(64),
}).passthrough();

const updateSchema = z.object({
  description: optStr(10000),
  amount_delta: optNum,
  status: optStr(64),
}).passthrough();

module.exports = { createSchema, updateSchema };
