// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod schemas for /api/quotes.
//
// Hand-rolled rule was: title required on create. line_items is an inline
// array on POST only — each is { vendor_id?, description?, quantity?,
// unit_price?, markup_pct?, position(set server-side) }. PUT supports
// create_revision: boolean to bump the revision counter.
//
// Numeric fields accept number | numeric string | null (matches deals.js).

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

// Inline line-item shape for POST /. Each field is optional except the row
// itself — the handler defaults description to '' and quantity to 1.
const lineItemSchema = z.object({
  vendor_id: optInt,
  description: optStr(2000),
  quantity: optNum,
  unit_price: optNum,
  markup_pct: optNum,
}).passthrough();

const createSchema = z.object({
  title: z.string().trim().min(1, 'Quote title required').max(255),
  deal_id: optInt,
  customer_id: optInt,
  status: optStr(64),
  total_amount: optNum,
  valid_until: optDate,
  notes: optStr(10000),
  line_items: z.union([z.array(lineItemSchema).max(500), z.null(), z.undefined()]).optional(),
}).passthrough();

const updateSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  status: optStr(64),
  total_amount: optNum,
  valid_until: optDate,
  notes: optStr(10000),
  customer_id: optInt,
  create_revision: optBool,
}).passthrough();

module.exports = { createSchema, updateSchema };
