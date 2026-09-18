// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Record ownership (migration 135) — shared owner_user_id validation.
//
// One helper, used by companyRoutes + dealRoutes (contacts predate this via
// migration 125 and keep their cadence-endpoint validation). Lives in its own
// service file so the create/update handlers only gain a 3-line call — those
// handlers are shared merge territory with sibling features (tier
// enforcement), so we keep the footprint inside them minimal.
//
// Mirrors the in-org membership check pattern in services/segments.js
// (validateOwner): in an org, the owner must be a member of that org; in a
// personal (user_id-scoped) workspace, the only valid owner is yourself.
// null/undefined is always fine — it means "no owner / leave unchanged".

const pool = require('../db');

/**
 * Validate a proposed owner_user_id for the calling request's tenancy.
 * Returns an error STRING when invalid, or null when acceptable.
 * (String-return matches validateCustomFieldsPayload's contract, so handlers
 * can reuse the same `if (err) return res.status(400)` shape.)
 */
async function ownerValidationError(req, ownerUserId) {
  if (ownerUserId === null || ownerUserId === undefined) return null;
  const id = Number(ownerUserId);
  if (!Number.isInteger(id) || id < 1) {
    return 'owner_user_id must be a positive integer, or null to clear';
  }
  if (req.orgId) {
    const member = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND org_id = $2',
      [id, req.orgId]
    );
    if (member.rows.length === 0) {
      return 'owner_user_id must be a member of your organization';
    }
  } else if (id !== Number(req.userId)) {
    return 'owner_user_id must be your own user id in a personal workspace';
  }
  return null;
}

/**
 * Append the ?owner= list filter to an in-progress query string.
 * `owner=me` → the caller's own records; `owner=<id>` → that user's records.
 * Always ANDed with the org scope the caller already applied, so a foreign-org
 * id simply yields an empty set — no data can leak across tenants.
 * Returns the amended query string (params is mutated in place, matching how
 * the list handlers build their other filters).
 */
function applyOwnerFilter(query, params, owner, req, column = 'owner_user_id') {
  if (owner === 'me') {
    params.push(req.userId);
    return `${query} AND ${column} = $${params.length}`;
  }
  if (owner && /^\d+$/.test(String(owner))) {
    params.push(parseInt(owner, 10));
    return `${query} AND ${column} = $${params.length}`;
  }
  return query;
}

module.exports = { ownerValidationError, applyOwnerFilter };
