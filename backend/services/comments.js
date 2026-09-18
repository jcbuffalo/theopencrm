// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Record comments (migration 146) — shared validation core for
// routes/commentRoutes.js. Pure-ish helpers so the rules are unit-testable
// without HTTP plumbing (mirrors services/dealLineItems.js discipline).
//
// The load-bearing security piece is ENTITY_TABLES: a hard allowlist mapping
// entity_type → the physical table a comment may attach to. entityInScope()
// only ever interpolates table names from this map (never client input), and
// always filters on the caller's qs(req) scope column — so a cross-org
// entity_id 404s before any comment SQL runs, with no existence oracle.

const pool = require('../db');

// entity_type → table. Every table here carries org_id + user_id tenancy
// columns, which entityInScope depends on. Extending comments to a new
// record type is a one-line addition (plus a frontend wire-in).
const ENTITY_TABLES = {
  deal:    'deals',
  company: 'companies',
  contact: 'contacts',
  case:    'cases',
  lead:    'leads',
};

const MAX_BODY_LENGTH = 5000;

function isValidEntityType(entityType) {
  return Object.prototype.hasOwnProperty.call(ENTITY_TABLES, entityType);
}

// Validate + trim a comment body. Returns { error } or { body }.
function normalizeBody(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { error: 'body is required' };
  }
  const body = raw.trim();
  if (body.length > MAX_BODY_LENGTH) {
    return { error: `body must be ${MAX_BODY_LENGTH} characters or fewer` };
  }
  return { body };
}

// The target record must exist INSIDE the caller's tenancy. Table name comes
// from the allowlist only; entity_id and the scope value are parameterized.
// Returns true/false.
async function entityInScope(entityType, entityId, sf, sv) {
  const table = ENTITY_TABLES[entityType];
  if (!table) return false;
  const id = Number(entityId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const r = await pool.query(
    `SELECT id FROM ${table} WHERE id = $1 AND ${sf} = $2`,
    [id, sv],
  );
  return r.rows.length > 0;
}

// Validate an explicit mentioned_user_ids array. Every id must be an integer
// AND resolve to a user inside the caller's org (org-less workspaces can only
// "mention" themselves, which the route then drops as a self-mention).
// Returns { error } or { ids } (deduped integers, order preserved).
async function validateMentions(rawIds, req) {
  if (rawIds == null) return { ids: [] };
  if (!Array.isArray(rawIds)) return { error: 'mentioned_user_ids must be an array' };
  const ids = [...new Set(rawIds.map(Number))];
  if (ids.length === 0) return { ids: [] };
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    return { error: 'mentioned_user_ids must contain positive integers' };
  }
  if (ids.length > 50) return { error: 'Too many mentions (max 50)' };

  let inScope;
  if (req.orgId) {
    const r = await pool.query(
      `SELECT id FROM users WHERE id = ANY($1::int[]) AND org_id = $2`,
      [ids, req.orgId],
    );
    inScope = new Set(r.rows.map((row) => Number(row.id)));
  } else {
    // Personal workspace: the only in-scope user is the caller.
    inScope = new Set([Number(req.userId)]);
  }
  const outOfScope = ids.filter((id) => !inScope.has(id));
  if (outOfScope.length > 0) {
    return { error: 'mentioned_user_ids contains users outside your organization' };
  }
  return { ids };
}

// Org owner/admin may delete any comment in their org (moderation); everyone
// else only their own. Mirrors the portalRoutes isOrgAdmin convention.
function isOrgAdmin(req) {
  return req.orgId != null && ['owner', 'admin'].includes(req.orgRole);
}

module.exports = {
  ENTITY_TABLES,
  MAX_BODY_LENGTH,
  isValidEntityType,
  normalizeBody,
  entityInScope,
  validateMentions,
  isOrgAdmin,
};
