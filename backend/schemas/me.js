// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod schemas for the /api/me/* endpoints.
//
// PATTERN: each resource keeps its schemas under backend/schemas/<resource>.js
// and the route file wires them up via middleware/validate.js. The handler
// trusts req.body as zod's typed output (defaults applied, unknowns stripped
// per the schema, etc.). Hand-rolled rechecks should be removed once a schema
// goes live so we don't drift over time.
//
// Zod version: v4 (note: `.issues`, not `.errors`).

const { z } = require('zod');

// PUT /api/me — caller updates their own profile. Login email is not editable
// here (it's a stable identity field) but notification_email and
// notification_phone are user-controlled handles for outbound notifications.
//
// At least one field must be present (refine). null/empty string for
// notification_* clears the value; a non-empty string is validated.
//
// Phone is normalised to '+<digits>' (E.164-ish). We don't try to validate
// country-code correctness — accept any 7..15 digit number behind a leading +.
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const notificationEmail = z
  .union([
    z.null(),
    z.literal(''),
    z.string().trim().max(254, 'notification_email must be 254 characters or fewer').regex(EMAIL_RX, 'notification_email is not a valid email address'),
  ])
  .transform(v => (v == null || v === '' ? null : v));

// Phone normalisation: strip non-digit/plus, require leading '+', 7..15 digits,
// final string ≤ 32 chars. Returns null for empty/null input. Throws via
// z.NEVER with an explanatory message if it doesn't conform.
const notificationPhone = z
  .union([z.null(), z.string()])
  .transform((v, ctx) => {
    if (v == null || v === '') return null;
    const stripped = v.replace(/[^\d+]/g, '');
    if (!stripped.startsWith('+')) {
      ctx.addIssue({ code: 'custom', message: 'notification_phone must be in E.164 format (start with +, then country code and digits)' });
      return z.NEVER;
    }
    const digits = stripped.replace(/\+/g, '');
    if (digits.length < 7 || digits.length > 15) {
      ctx.addIssue({ code: 'custom', message: 'notification_phone must have 7–15 digits' });
      return z.NEVER;
    }
    const normalised = '+' + digits;
    if (normalised.length > 32) {
      ctx.addIssue({ code: 'custom', message: 'notification_phone must be 32 characters or fewer' });
      return z.NEVER;
    }
    return normalised;
  });

const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1, 'name cannot be empty').max(120, 'name must be 120 characters or fewer').optional(),
    notification_email: notificationEmail.optional(),
    notification_phone: notificationPhone.optional(),
  })
  .strict()
  .refine(
    obj => Object.keys(obj).length > 0,
    { message: 'No editable fields provided' }
  );

// POST /api/me/change-password. The full strength / reuse / HIBP policy still
// runs inside the handler (validatePasswordAsync) — this is the shape gate.
const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'currentPassword is required'),
    newPassword: z.string().min(10, 'newPassword must be at least 10 characters'),
  })
  .strict()
  .refine(
    obj => obj.currentPassword !== obj.newPassword,
    { message: 'New password must be different from current password', path: ['newPassword'] }
  );

// PUT /api/me/notification-preferences — the per-channel matrix introduced
// in migration 066. Each known category carries an object { email?, sms? }
// of booleans. All categories optional (partial update). All channels within
// a category optional (preserve untouched channel via JS merge in the handler).
const channelMatrix = z.object({
  email: z.boolean().optional(),
  sms:   z.boolean().optional(),
}).strict();

// Consolidated email delivery (spec 204, migration 173). Lives beside the
// categories in the same JSONB so a partial PUT merges like any category:
//   { email_delivery: { mode: 'daily', hour: 7, tz: 'America/New_York' } }
const emailDelivery = z.object({
  mode: z.enum(['instant', 'batched', 'daily']).optional(),
  hour: z.number().int().min(0).max(23).optional(),
  tz:   z.string().min(1).max(64).regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/, 'IANA timezone').optional(),
}).strict();

const updateNotificationPreferencesSchema = z
  .object({
    email_delivery:  emailDelivery.optional(),
    task_assigned:   channelMatrix.optional(),
    task_overdue:    channelMatrix.optional(),
    deal_activity:   channelMatrix.optional(),
    weekly_summary:  channelMatrix.optional(),
    // July-2026 module wave (migration 144) — wire channels default OFF.
    case_assigned:          channelMatrix.optional(),
    case_status_changed:    channelMatrix.optional(),
    lead_captured:          channelMatrix.optional(),
    lead_assigned:          channelMatrix.optional(),
    meeting_scheduled:      channelMatrix.optional(),
    sequence_completed:     channelMatrix.optional(),
    playbook_tasks_created: channelMatrix.optional(),
    // Record-comment @mentions (migration 146) — in-app is always on; these
    // control the optional email/SMS wire channels (default OFF).
    mention:                channelMatrix.optional(),
    // Customer-portal case submissions (148) / quote responses (149) — same
    // wire-channel opt-in model.
    portal_case_submitted:  channelMatrix.optional(),
    portal_quote_response:  channelMatrix.optional(),
    portal_message_received: channelMatrix.optional(),
    portal_document_uploaded: channelMatrix.optional(),
    // Platform AI budget / trial-slot alerts (migration 174) — only ever
    // dispatched to super-admins; harmless for anyone else to toggle.
    platform_budget:        channelMatrix.optional(),
  })
  .strict();

module.exports = {
  updateProfileSchema,
  changePasswordSchema,
  updateNotificationPreferencesSchema,
};
