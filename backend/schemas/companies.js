// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod schemas for /api/companies.
//
// Mirrors the hand-rolled validation that previously lived in
// routes/companyRoutes.js: only `name` was strictly required; every other
// field was free-form text/number with COALESCE-friendly partial updates.
// Custom-fields validation (org-scoped, def-aware) still runs inside the
// handler via validateCustomFieldsPayload — zod can't reach the DB to know
// the def list. Reasonable length caps applied to long-text fields so a
// malicious 10MB notes blob can't sneak through.
//
// Field set mirrors the current INSERT/UPDATE column list. Anything not listed
// here is stripped by the schema's strictness (we use .passthrough() for
// forward-compat: a new column added by a migration shouldn't 400 in flight).

const { z } = require('zod');

// Open string-or-null helper. Trims; converts '' to null so the SQL writes
// land as NULL rather than empty strings (matches `value || null` in handlers).
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

const customFields = z.union([z.record(z.string(), z.unknown()), z.null()]).optional();

// Account lifecycle stage (migration 122). The ACCOUNT relationship lifecycle,
// distinct from a deal's pipeline stage. This is the single source of truth for
// the allowlist — companyRoutes.js (create/update/PATCH lifecycle-stage) and any
// future consumer imports LIFECYCLE_STAGES rather than re-declaring it.
const LIFECYCLE_STAGES = ['prospect', 'onboarding', 'active', 'at_risk', 'renewed', 'churned'];
const optLifecycle = z.union([z.enum(LIFECYCLE_STAGES), z.null(), z.undefined()]).optional();

// Churn-reason allowlist (migration 127). Optional detail captured on the
// churned lifecycle transition; single source of truth for companyRoutes.js
// (PATCH lifecycle-stage) and the Win-back board. Allowlisted — not free
// text — so churn reporting can aggregate cleanly.
const CHURN_REASONS = ['price', 'product_fit', 'competitor', 'lost_champion', 'went_out_of_business', 'no_budget', 'poor_engagement', 'other'];

const createSchema = z.object({
  name: z.string().trim().min(1, 'Company name required').max(255),
  type: optStr(64),
  industry: optStr(120),
  website: optStr(500),
  phone: optStr(64),
  location: optStr(255),
  employee_count: optInt,
  annual_revenue: optInt,
  notes: optStr(10000),
  status: optStr(64),
  lifecycle_stage: optLifecycle,
  // Record owner (migration 135) — in-org membership is enforced in the
  // handler via services/recordOwnership.js; zod only shapes the value.
  owner_user_id: optInt,
  custom_fields: customFields,
}).passthrough();

const updateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  type: optStr(64),
  industry: optStr(120),
  website: optStr(500),
  phone: optStr(64),
  location: optStr(255),
  employee_count: optInt,
  annual_revenue: optInt,
  notes: optStr(10000),
  status: optStr(64),
  lifecycle_stage: optLifecycle,
  // Record owner (migration 135) — see createSchema note.
  owner_user_id: optInt,
  custom_fields: customFields,
}).passthrough();

// Bulk PATCH /bulk — { ids: int[], patch: { ...allowed keys } }. The allowlist
// (`owner_id` / `type` / `status`) is still enforced inside _bulkOps.js as
// defense-in-depth; zod only checks the body SHAPE.
const bulkPatchSchema = z.object({
  ids: z.array(z.union([z.number().int(), z.string().regex(/^\d+$/)])).min(1).max(1000),
  patch: z.record(z.string(), z.unknown()).refine(o => Object.keys(o).length > 0, { message: 'patch must contain at least one field' }),
});

// Merge — fold `loserId` into the :id winner. loserId accepts an int or a
// numeric string (route params arrive as strings from the client).
const mergeSchema = z.object({
  loserId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
});

module.exports = { createSchema, updateSchema, bulkPatchSchema, mergeSchema, LIFECYCLE_STAGES, CHURN_REASONS };
