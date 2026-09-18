// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Tiny server-side CSV serializer for the org-scoped list-export endpoints
// (GET /api/contacts|companies|deals/export.csv).
//
// Deliberately hand-rolled: the export column sets are small and fixed, the
// rows come straight from a single org-scoped SELECT, and csv-parse (already
// a dependency) only parses. RFC-4180 escaping: any field containing a comma,
// double-quote, or newline is wrapped in double-quotes with inner quotes
// doubled. Output uses CRLF line endings so Excel opens it cleanly.

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  let s;
  if (value instanceof Date) {
    s = value.toISOString();
  } else if (Array.isArray(value)) {
    s = value.join('; ');
  } else if (typeof value === 'object') {
    s = JSON.stringify(value);
  } else {
    s = String(value);
  }
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Serialize rows to a CSV string.
 * @param {Array<{key: string, label?: string}>} columns — ordered column set;
 *        `key` reads row[key], `label` (or key) becomes the header cell.
 * @param {Array<Object>} rows
 * @returns {string} CSV text incl. header row, CRLF-terminated.
 */
function toCsv(columns, rows) {
  const header = columns.map((c) => csvEscape(c.label || c.key)).join(',');
  const lines = rows.map((row) => columns.map((c) => csvEscape(row[c.key])).join(','));
  return [header, ...lines].join('\r\n') + '\r\n';
}

/**
 * Send a CSV string as a file download.
 */
function sendCsv(res, filename, csvText) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csvText);
}

module.exports = { csvEscape, toCsv, sendCsv };
