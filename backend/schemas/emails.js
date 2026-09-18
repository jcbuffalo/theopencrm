// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod schemas for /api/emails.
//
// Endpoints with bodies:
//   POST /templates             — { name, subject, body } all required
//   PUT  /templates/:id         — partial subset of { name, subject, body }
//   POST /templates/:id/preview — { to_email?, to_contact_id?, to_deal_id? } all optional
//   POST /send                  — { to_email, subject, body, template_id?, to_contact_id?, to_deal_id? }
//
// Public unsubscribe + track routes don't take bodies and aren't validated here.
//
// Hand-rolled email format check on /send used /^[^\s@]+@[^\s@]+\.[^\s@]+$/ with a
// 254-char cap. We replicate exactly so we neither tighten nor loosen.

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

const createTemplateSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(120, 'name must be 120 characters or fewer'),
  subject: z.string().trim().min(1, 'subject is required').max(998, 'subject must be 998 characters or fewer'),
  body: z.string().min(1, 'body is required').max(200000, 'body must be 200000 characters or fewer'),
}).passthrough();

// PUT is partial — handler uses COALESCE so undefined fields stay unchanged.
const updateTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  subject: z.string().trim().min(1).max(998).optional(),
  body: z.string().min(1).max(200000).optional(),
}).passthrough();

// preview: every field optional — the resolver falls back to "preview as me"
// when to_email isn't supplied.
const previewSchema = z.object({
  to_email: z
    .union([
      z.null(),
      z.literal(''),
      z.string().trim().max(254).regex(EMAIL_RX, 'to_email is not a valid email address'),
    ])
    .optional(),
  to_contact_id: optInt,
  to_deal_id: optInt,
}).passthrough();

const sendSchema = z.object({
  to_email: z
    .string()
    .trim()
    .min(1, 'to_email is required')
    .max(254, 'to_email must be a valid email address')
    .regex(EMAIL_RX, 'to_email must be a valid email address'),
  subject: z.string().trim().min(1, 'subject is required').max(998, 'subject must be 998 characters or fewer'),
  body: z.string().min(1, 'body is required').max(200000, 'body must be 200000 characters or fewer'),
  template_id: optInt,
  to_contact_id: optInt,
  to_deal_id: optInt,
}).passthrough();

module.exports = {
  createTemplateSchema,
  updateTemplateSchema,
  previewSchema,
  sendSchema,
};
