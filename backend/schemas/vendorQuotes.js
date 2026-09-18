// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod schemas for /api/vendor-quotes.
//
// Hand-rolled rule was:
//   POST /              — deal_id and vendor_id required.
//   PUT /:id            — partial; any combination of status, amounts, dates.
//   POST /:id/send-rfq  — recipient_email required; optional name + message.
//
// The send-rfq email body is a free-text message — we accept long strings
// but cap at 10000 chars (matches notes elsewhere).

const { z } = require('zod');

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

const createSchema = z.object({
  deal_id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)], { message: 'deal_id required' }),
  vendor_id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)], { message: 'vendor_id required' }),
  status: optStr(64),
  rfq_sent_at: optDate,
  quote_received_at: optDate,
  amount: optNum,
  lead_time_days: optInt,
  notes: optStr(10000),
}).passthrough();

const updateSchema = z.object({
  status: optStr(64),
  rfq_sent_at: optDate,
  quote_received_at: optDate,
  amount: optNum,
  lead_time_days: optInt,
  is_selected: optBool,
  notes: optStr(10000),
}).passthrough();

const sendRfqSchema = z.object({
  recipient_email: z
    .string()
    .trim()
    .min(1, 'recipient_email is required')
    .max(254, 'recipient_email must be 254 characters or fewer')
    .regex(EMAIL_RX, 'recipient_email is not a valid email address'),
  recipient_name: optStr(255),
  custom_message: optStr(10000),
}).passthrough();

module.exports = { createSchema, updateSchema, sendRfqSchema };
