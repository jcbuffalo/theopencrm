// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Shared bulk-update / bulk-delete helpers for the table-style CRUD resources
// (contacts, companies, tasks). Each resource registers an allowlist of
// columns that may be patched in bulk; anything else is rejected at request
// time — we don't want a bulk endpoint to be a backdoor for editing fields
// the per-record PUT handler intentionally guards (created_by, public_id, etc).
//
// Tenancy: every write is scoped through the caller's qs(req) helper. The
// resource-specific route file owns that helper so it can fall back to user_id
// for users who aren't in an org.
//
// Audit: one row per bulk call (not per affected record) so a 1000-id patch
// produces one log entry, not 1000. The id list + patch object are stored in
// `meta` for full reconstructibility.

const audit = require('../services/audit');

const VALID_IDS_RE = /^\d+$/;

function sanitizeIds(ids) {
  if (!Array.isArray(ids)) return null;
  const clean = ids
    .map(v => typeof v === 'string' ? v.trim() : v)
    .filter(v => typeof v === 'number' || (typeof v === 'string' && VALID_IDS_RE.test(v)))
    .map(v => Number(v));
  if (clean.length === 0 || clean.length > 1000) return null;
  return clean;
}

// Build the PATCH /bulk handler for a given resource.
//
//   resource    — string used in audit meta + target_type (e.g. 'contacts')
//   table       — SQL table name
//   allowlist   — array of column names that may be set via bulk patch
//   qs          — function(req) → ['org_id'|'user_id', value], scoping pair
//   pool        — pg pool
function buildBulkUpdate({ resource, table, allowlist, qs, pool }) {
  const allowSet = new Set(allowlist);

  return async function bulkUpdate(req, res) {
    try {
      const { ids, patch } = req.body || {};
      const cleanIds = sanitizeIds(ids);
      if (!cleanIds) return res.status(400).json({ error: 'ids must be a non-empty array of up to 1000 integer ids' });
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return res.status(400).json({ error: 'patch must be an object' });
      }

      const patchKeys = Object.keys(patch);
      if (patchKeys.length === 0) return res.status(400).json({ error: 'patch must contain at least one field' });

      const bad = patchKeys.filter(k => !allowSet.has(k));
      if (bad.length > 0) {
        return res.status(400).json({
          error: `Fields not allowed in bulk update: ${bad.join(', ')}`,
          allowed: Array.from(allowSet),
        });
      }

      const [sf, sv] = qs(req);

      // Build SET clause: col = $N. Tenancy + ids filter is appended after.
      const setFragments = [];
      const params = [];
      patchKeys.forEach((k) => {
        params.push(patch[k]);
        setFragments.push(`${k} = $${params.length}`);
      });
      // Always bump updated_at if the column exists; cheap and matches the
      // per-record PUT handlers' behaviour.
      setFragments.push(`updated_at = CURRENT_TIMESTAMP`);

      params.push(sv);
      const scopeParamIdx = params.length;
      params.push(cleanIds);
      const idsParamIdx = params.length;

      const sql = `UPDATE ${table} SET ${setFragments.join(', ')}
                   WHERE ${sf} = $${scopeParamIdx} AND id = ANY($${idsParamIdx}::int[])
                   RETURNING id`;

      const result = await pool.query(sql, params);
      const updated_count = result.rowCount;

      audit.fromReq(req, {
        event: audit.EVENTS.BULK_UPDATE,
        targetType: resource,
        meta: { resource, ids: cleanIds, patch, matched: updated_count },
      });

      res.json({ success: true, updated_count });
    } catch (error) {
      if (req.log) req.log.error('bulk_update_failed', { error, resource });
      else console.error(`Bulk update failed for ${resource}:`, error);
      res.status(500).json({ error: `Failed to bulk update ${resource}` });
    }
  };
}

// Build the DELETE /bulk handler. Soft-deletes if the table has deleted_at,
// otherwise hard-deletes. We detect this once at boot (via information_schema)
// rather than per request.
function buildBulkDelete({ resource, table, qs, pool, hasSoftDelete = false }) {
  return async function bulkDelete(req, res) {
    try {
      const { ids } = req.body || {};
      const cleanIds = sanitizeIds(ids);
      if (!cleanIds) return res.status(400).json({ error: 'ids must be a non-empty array of up to 1000 integer ids' });

      const [sf, sv] = qs(req);

      const sql = hasSoftDelete
        ? `UPDATE ${table} SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE ${sf} = $1 AND id = ANY($2::int[]) AND deleted_at IS NULL RETURNING id`
        : `DELETE FROM ${table} WHERE ${sf} = $1 AND id = ANY($2::int[]) RETURNING id`;

      const result = await pool.query(sql, [sv, cleanIds]);
      const updated_count = result.rowCount;

      audit.fromReq(req, {
        event: audit.EVENTS.BULK_DELETE,
        targetType: resource,
        meta: { resource, ids: cleanIds, soft: hasSoftDelete, matched: updated_count },
      });

      res.json({ success: true, updated_count });
    } catch (error) {
      if (req.log) req.log.error('bulk_delete_failed', { error, resource });
      else console.error(`Bulk delete failed for ${resource}:`, error);
      res.status(500).json({ error: `Failed to bulk delete ${resource}` });
    }
  };
}

module.exports = { buildBulkUpdate, buildBulkDelete };
