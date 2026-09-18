// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Shared zod validation middleware.
//
// Pattern: each resource owns its own schemas under backend/schemas/<resource>.js;
// the route file wires the schemas to handlers via validateBody / validateQuery /
// validateParams. The handler then trusts req.body / req.query / req.params as
// the typed, sanitized output of zod (req.body is replaced with result.data so
// transforms / defaults / strips take effect).
//
// Error shape intentionally matches the rest of the API: { success: false,
// error: <human string>, fields: [{ path, message }] }. The frontend's existing
// `error || response.data.error` parser only reads `.error`, so adding `fields`
// is additive and doesn't break callers.
//
// We use zod v4 here: the parsed-error iterable is `.issues`, not `.errors` as
// in v3 — keep that in mind if you copy this pattern elsewhere.

const { ZodError } = require('zod');

function formatIssues(issues) {
  return issues.map(i => ({ path: i.path.join('.'), message: i.message }));
}

// Build a human-readable summary so the API caller — and any non-form-aware
// client — gets a single sentence describing what was wrong. The `fields` array
// stays the source of truth for per-field UX.
function summarize(fieldErrors) {
  if (fieldErrors.length === 0) return 'Invalid request';
  const first = fieldErrors[0];
  return first.path ? `${first.path}: ${first.message}` : first.message;
}

function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const fields = formatIssues(result.error.issues);
      return res.status(400).json({ success: false, error: summarize(fields), fields });
    }
    req.body = result.data;
    next();
  };
}

function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const fields = formatIssues(result.error.issues);
      return res.status(400).json({ success: false, error: summarize(fields), fields });
    }
    // req.query is a getter in Express 5; safe-write the parsed values onto
    // req.validatedQuery so handlers that want the typed shape can use it
    // without losing the Express-native object.
    req.validatedQuery = result.data;
    next();
  };
}

function validateParams(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      const fields = formatIssues(result.error.issues);
      return res.status(400).json({ success: false, error: summarize(fields), fields });
    }
    req.validatedParams = result.data;
    next();
  };
}

module.exports = { validateBody, validateQuery, validateParams };
