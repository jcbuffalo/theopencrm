// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod schemas for /api/contacts.
//
// Hand-rolled rule was: first_name AND last_name required on create; everything
// else free-form text/int. Tags is a string[] (Postgres text[]). custom_fields
// re-validated in handler against org defs.

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
const optTags = z.union([z.array(z.string().max(120)).max(100), z.null(), z.undefined()]).optional();
const customFields = z.union([z.record(z.string(), z.unknown()), z.null()]).optional();

// Relationship cadence (migration 125): desired reconnect interval in days.
// 1..3650 keeps it sane (a day to a decade); null = no cadence.
const optCadenceDays = z.union([z.number().int().min(1).max(3650), z.null(), z.undefined()]).optional();

const createSchema = z.object({
  first_name: z.string().trim().min(1, 'First name required').max(120),
  last_name:  z.string().trim().min(1, 'Last name required').max(120),
  email: optStr(254),
  phone: optStr(64),
  company_id: optInt,
  job_title: optStr(255),
  status: optStr(64),
  tags: optTags,
  notes: optStr(10000),
  custom_fields: customFields,
  owner_user_id: optInt,
  cadence_days: optCadenceDays,
}).passthrough();

const updateSchema = z.object({
  first_name: z.string().trim().min(1).max(120).optional(),
  last_name:  z.string().trim().min(1).max(120).optional(),
  email: optStr(254),
  phone: optStr(64),
  company_id: optInt,
  job_title: optStr(255),
  status: optStr(64),
  tags: optTags,
  notes: optStr(10000),
  custom_fields: customFields,
  owner_user_id: optInt,
  cadence_days: optCadenceDays,
}).passthrough();

// Bulk allowlist enforced inside _bulkOps.js (owner_id / company_id / status).
const bulkPatchSchema = z.object({
  ids: z.array(z.union([z.number().int(), z.string().regex(/^\d+$/)])).min(1).max(1000),
  patch: z.record(z.string(), z.unknown()).refine(o => Object.keys(o).length > 0, { message: 'patch must contain at least one field' }),
});

// Merge — fold `loserId` into the :id winner. loserId accepts an int or a
// numeric string (route params arrive as strings from the client).
const mergeSchema = z.object({
  loserId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
});

module.exports = { createSchema, updateSchema, bulkPatchSchema, mergeSchema };
