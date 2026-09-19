// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod schemas for /api/deals.
//
// Hand-rolled rule was: `title` required on create; `stage` and `phase` are
// rechecked inside the handler against VALID_STAGES / VALID_PHASES (kept as
// the authoritative gate — duplicating those long lists here would drift).
// PATCH /:id/stage has its own schema for { stage } only.
//
// `amount` / `closed_amount` accept either number or numeric string (UIs send
// strings). We coerce to number for downstream pg consumption.

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

// Accepts number, numeric string, null, undefined. Returns number | null.
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

const optTags = z.union([z.array(z.string().max(120)).max(100), z.null(), z.undefined()]).optional();
const customFields = z.union([z.record(z.string(), z.unknown()), z.null()]).optional();

// Date can be an ISO string or null. Loose check — Postgres will reject if
// truly malformed.
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
  title: z.string().trim().min(1, 'Deal title required').max(255),
  contact_id: optInt,
  company_id: optInt,
  customer_id: optInt,
  vendor_id: optInt,
  salesman_id: optInt,
  vertical: optStr(120),
  description: optStr(10000),
  amount: optNum,
  stage: optStr(64),       // handler-side validation against VALID_STAGES still runs
  phase: optStr(32),       // handler-side validation against VALID_PHASES still runs
  deal_type: optStr(40),   // spec 201 — handler validates against the org's known types
  expected_close_date: optDate,
  notes: optStr(10000),
  tags: optTags,
  hot_flag: optBool,
  po_number: optStr(120),
  ship_to: optStr(500),
  poc_name: optStr(255),
  poc_email: optStr(254),
  poc_phone: optStr(64),
  target_ship_date: optDate,
  external_ref: optStr(120),
  // Record owner (migration 135) — in-org membership is enforced in the
  // handler via services/recordOwnership.js; zod only shapes the value.
  owner_user_id: optInt,
  custom_fields: customFields,
  // Next-step commitment (migration 172): one line + the day it's due.
  next_step: optStr(500),
  next_step_date: optDate,
  // One-motion create (Wave 3, 2026-09-19): free-text company / contact that
  // the handler finds-or-creates by name (services/recordUpsert.js) when the
  // matching *_id is absent. Same shape the chat copilot's propose_create_deal
  // accepts.
  company_name: optStr(200),
  contact_name: optStr(200),
  contact_email: optStr(254),
}).passthrough();

const updateSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  contact_id: optInt,
  company_id: optInt,
  customer_id: optInt,
  vendor_id: optInt,
  salesman_id: optInt,
  vertical: optStr(120),
  description: optStr(10000),
  amount: optNum,
  stage: optStr(64),
  phase: optStr(32),
  deal_type: optStr(40),   // spec 201 — changeable only together with a valid target stage
  expected_close_date: optDate,
  closed_date: optDate,
  closed_amount: optNum,
  probability: optNum,
  notes: optStr(10000),
  tags: optTags,
  hot_flag: optBool,
  lost_reason: optStr(500),
  po_number: optStr(120),
  ship_to: optStr(500),
  poc_name: optStr(255),
  poc_email: optStr(254),
  poc_phone: optStr(64),
  target_ship_date: optDate,
  actual_ship_date: optDate,
  release_status: optStr(64),
  hold_reason: optStr(500),
  // Record owner (migration 135) — see createSchema note.
  owner_user_id: optInt,
  custom_fields: customFields,
  // Next-step commitment (migration 172). Unlike the COALESCE'd columns,
  // the handler writes these whenever the KEY is present — an explicit
  // null / '' clears a finished step.
  next_step: optStr(500),
  next_step_date: optDate,
}).passthrough();

// PATCH /:id/stage — handler still re-checks against VALID_STAGES.
const stagePatchSchema = z.object({
  stage: z.string().min(1, 'stage required'),
}).passthrough();

module.exports = { createSchema, updateSchema, stagePatchSchema };
