// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Contact relationship cadence — the "who has gone quiet" read side plus the
// "mark touched" write side. Columns arrive in migration 125:
//   cadence_days  — desired reconnect interval (NULL = no cadence set)
//   last_touch_at — last meaningful touch (activity hook / explicit touch)
//   owner_user_id — relationship owner (distinct from owner_id, the record owner)
//
// Both functions take the route layer's qs(req) tuple ([scopeField, scopeValue])
// so every query is org-scoped exactly like the routes that call them — a
// contact in another org can neither surface in gone-quiet nor be touched.

const pool = require('../db');

const DAY_MS = 86400000;

// Whole days elapsed since `ts` (floor). Null in → null out, so the caller can
// distinguish "never touched" from "touched 0 days ago".
function daysSince(ts, now = new Date()) {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / DAY_MS);
}

// Contacts with a cadence set whose last touch is older than cadence_days.
// Never-touched contacts (last_touch_at NULL) are treated as maximally overdue:
// they pass the filter and sort to the top. Ordered most-overdue first.
//
// Each row is returned with two derived fields:
//   days_since_last_touch — whole days since last touch (null = never)
//   days_overdue          — days past the cadence (null = never touched, which
//                           the UI should read as "overdue since forever")
async function goneQuiet([sf, sv], { limit } = {}) {
  const capped = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

  const result = await pool.query(
    `SELECT id, first_name, last_name, email, job_title, status, company_id,
            owner_user_id, cadence_days, last_touch_at
       FROM contacts
      WHERE ${sf} = $1
        AND cadence_days IS NOT NULL
        AND (last_touch_at IS NULL
             OR last_touch_at < NOW() - make_interval(days => cadence_days))
      ORDER BY (last_touch_at IS NULL) DESC,
               (NOW() - last_touch_at - make_interval(days => cadence_days)) DESC
      LIMIT $2`,
    [sv, capped]
  );

  const now = new Date();
  return result.rows.map((r) => {
    const ds = daysSince(r.last_touch_at, now);
    return {
      ...r,
      days_since_last_touch: ds,
      days_overdue: ds == null || r.cadence_days == null ? null : ds - r.cadence_days,
      never_touched: r.last_touch_at == null,
    };
  });
}

// Stamp last_touch_at = now on an in-scope contact. Returns the updated row,
// or null when the id isn't visible under the caller's scope (route 404s).
async function touchContact([sf, sv], contactId) {
  const result = await pool.query(
    `UPDATE contacts
        SET last_touch_at = NOW(), updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND ${sf} = $2
      RETURNING *`,
    [contactId, sv]
  );
  return result.rows[0] || null;
}

module.exports = { goneQuiet, touchContact, daysSince };
