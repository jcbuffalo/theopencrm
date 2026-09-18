// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod schemas for /api/submittals.
//
// Hand-rolled rule was: deal_id required on create. version is server-derived
// from MAX(version)+1 when not supplied. status transitions to 'approved'
// stamp approved_at in the handler.

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

const createSchema = z.object({
  deal_id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)], { message: 'deal_id required' }),
  version: optInt,
  type: optStr(64),
  status: optStr(64),
  notes: optStr(10000),
}).passthrough();

const updateSchema = z.object({
  status: optStr(64),
  type: optStr(64),
  notes: optStr(10000),
}).passthrough();

module.exports = { createSchema, updateSchema };
