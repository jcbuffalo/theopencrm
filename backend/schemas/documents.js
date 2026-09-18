// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod schemas for /api/documents.
//
// Hand-rolled rule was: filename OR file required on create. Everything else
// optional. POST is multipart/form-data (multer middleware populates req.file
// + req.body); we run validateBody AFTER multer so req.body holds the parsed
// text fields. The file binary itself isn't part of the zod-validated shape —
// only the metadata is.
//
// related_id arrives over multipart as a string; we coerce to int via optInt.

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

// Accept int or numeric-string (multipart text fields are always strings).
const optInt = z
  .union([z.number().int(), z.string(), z.null(), z.undefined()])
  .transform((v, ctx) => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      ctx.addIssue({ code: 'custom', message: 'must be an integer' });
      return z.NEVER;
    }
    return n;
  })
  .optional();

const createSchema = z.object({
  related_type: optStr(64),
  related_id: optInt,
  doc_type: optStr(64),
  notes: optStr(10000),
  url: optStr(2000),
  filename: optStr(500),
}).passthrough();

module.exports = { createSchema };
