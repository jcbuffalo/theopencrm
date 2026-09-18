// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod schemas for the communications surface — /api/sms and /api/calls.
//
// Both endpoints attach to a contact and/or a deal (at least one is required so
// the message/call lands on a timeline). Free text is trimmed + length-capped
// the same way schemas/activities.js does.

const { z } = require('zod');

const optInt = z.union([z.number().int(), z.null(), z.undefined()]).optional();

const optStr = (max) => z
  .union([z.string(), z.null(), z.undefined()])
  .transform(v => {
    if (v == null) return null;
    const t = v.trim();
    return t === '' ? null : t;
  })
  .pipe(z.union([z.null(), z.string().max(max)]))
  .optional();

const direction = z.enum(['inbound', 'outbound']);

// POST /api/sms — send an SMS. Either contact_id or deal_id must be present so
// the send has a home on a timeline; to_number is optional and, when omitted,
// resolved server-side from the contact's phone / deal POC phone.
const smsSendSchema = z.object({
  contact_id: optInt,
  deal_id: optInt,
  to_number: optStr(32),
  body: z.string().trim().min(1, 'body required').max(1600),
}).passthrough().refine(
  (v) => v.contact_id != null || v.deal_id != null,
  { message: 'contact_id or deal_id is required', path: ['contact_id'] }
);

// POST /api/calls/log — record a call as an activity(type='call').
const callLogSchema = z.object({
  contact_id: optInt,
  deal_id: optInt,
  direction: direction.optional().default('outbound'),
  duration_minutes: optInt,
  outcome: optStr(100),
  notes: optStr(10000),
  title: optStr(255),
  activity_date: z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v, ctx) => {
      if (v == null || v === '') return null;
      if (Number.isNaN(Date.parse(v))) {
        ctx.addIssue({ code: 'custom', message: 'activity_date must be an ISO date string' });
        return z.NEVER;
      }
      return v;
    })
    .optional(),
}).passthrough().refine(
  (v) => v.contact_id != null || v.deal_id != null,
  { message: 'contact_id or deal_id is required', path: ['contact_id'] }
);

module.exports = { smsSendSchema, callLogSchema };
