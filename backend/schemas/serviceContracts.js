// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod schemas for /api/service-contracts.
//
// Hand-rolled rule was: name required on create; everything else free-form.
// renewal_notice_days defaults to 30 in the handler.

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

// Renewal-pipeline (CS-3) Kanban column. Validated against the allowed set so
// callers can't write an arbitrary string into renewal_stage.
const RENEWAL_STAGES = ['upcoming', 'at_risk', 'renewed', 'churned'];
const optRenewalStage = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => {
    if (v == null) return null;
    const t = v.trim();
    return t === '' ? null : t;
  })
  .pipe(z.union([z.null(), z.enum(RENEWAL_STAGES)]))
  .optional();

const createSchema = z.object({
  name: z.string().trim().min(1, 'Contract name required').max(255),
  customer_id: optInt,
  deal_id: optInt,
  contract_type: optStr(64),
  start_date: optDate,
  end_date: optDate,
  renewal_notice_days: optInt,
  status: optStr(64),
  monthly_amount: optNum,
  notes: optStr(10000),
  renewal_stage: optRenewalStage,
  annual_value: optNum,
  churn_reason: optStr(10000),
  renewed_contract_id: optInt,
}).passthrough();

const updateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  contract_type: optStr(64),
  start_date: optDate,
  end_date: optDate,
  renewal_notice_days: optInt,
  status: optStr(64),
  monthly_amount: optNum,
  notes: optStr(10000),
  customer_id: optInt,
  renewal_stage: optRenewalStage,
  annual_value: optNum,
  churn_reason: optStr(10000),
  renewed_contract_id: optInt,
}).passthrough();

module.exports = { createSchema, updateSchema, RENEWAL_STAGES };
