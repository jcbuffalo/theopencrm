// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Zod schemas for /api/request-access (public).
//
// Hand-rolled rules were:
//   - name, email, password all required
//   - email regex /^[^\s@]+@[^\s@]+\.[^\s@]+$/
//   - password strength via auth.validatePassword (still runs in handler;
//     zod only checks shape — the handler returns the human-readable policy
//     error string)
//
// company / reason are optional free-text fields the operator sees when
// reviewing the request.

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

const createSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(255, 'name must be 255 characters or fewer'),
  email: z
    .string()
    .trim()
    .min(1, 'email is required')
    .max(254, 'email must be 254 characters or fewer')
    .regex(EMAIL_RX, 'Invalid email format'),
  // Shape-only; the policy check (auth.validatePassword) runs in the handler.
  password: z.string().min(1, 'password is required').max(1024),
  company: optStr(255),
  reason: optStr(5000),
}).passthrough();

module.exports = { createSchema };
