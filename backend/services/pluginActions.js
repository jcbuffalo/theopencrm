// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Confirm-first apply layer for plugin-proposed writes.
//
// This is the plugin analogue of services/chatActions.js. A user-triggered
// plugin run executes in the isolated-vm sandbox in DRY-RUN mode: its
// crm.update* / crm.createTask calls DO NOT write — they record proposals
// (see services/pluginSdk.js). The proposals are persisted on the plugin_runs
// row. The ONLY writer is POST /api/plugins/:id/apply, which:
//   1. loads the run's proposed_actions SERVER-SIDE (never trusts a client echo),
//   2. RE-VALIDATES each proposal here against the SAME plugin write allowlist
//      the sandbox uses (pluginSdk.sanitizePatch / normalizeTaskData), and
//   3. executes them in one org-scoped transaction (applyProposal).
//
// SECURITY MODEL (mirrors chatActions.js):
//   - Allowlist-only: sanitizePatch drops any field not in pluginSdk's
//     UPDATE_ALLOWLISTS. A tampered stored proposal with an extra column is
//     stripped on re-validation. org_id is NEVER a writable field.
//   - Org-scoping: every UPDATE is `WHERE id = $target AND org_id = $orgId`, so
//     a cross-org target can never be written even if the stored proposal named
//     a foreign id. INSERTs bind org_id from the caller's scope, not the payload.
//   - Referenced ids (contact_id / deal_id on a task) are ownership-checked
//     against the caller's org before apply (see referencedIds()).
//
// WHY NOT literally import chatActions.applyAction? The plugin write surface is
// a strict SUPERSET of chat's (chat can't updateContact/updateCompany/updateTask,
// nor set deal.probability/owner_id/status/notes). Reusing chatActions would
// silently DROP those proposals at apply time — a run would preview a change it
// could never apply. So this module deliberately PARALLELS chatActions' proven
// propose→re-validate→apply structure while sourcing its allowlist from the
// already-reviewed pluginSdk surface (which mirrors routes/_bulkOps.js). No
// widening, no narrowing of the existing plugin write surface.

const pool = require('../db');
const pluginSdk = require('./pluginSdk');

/**
 * Pure re-validation of a single stored proposal (no DB). Returns
 * { ok, errors:[], action } where `action` is the normalized, allowlist-scrubbed
 * { entity, op, table, target_id?, fields }.
 */
function validateProposal(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['proposal must be an object'] };
  }
  const { entity, op } = raw;
  const expectedTable = pluginSdk.TABLE_BY_ENTITY[entity];
  if (!expectedTable) {
    return { ok: false, errors: [`unknown or unsupported entity: ${entity}`] };
  }
  // If a table was stored, it must agree with the entity — defense against a
  // proposal whose entity/table were tampered to disagree.
  if (raw.table && raw.table !== expectedTable) {
    return { ok: false, errors: [`entity/table mismatch: ${entity} vs ${raw.table}`] };
  }

  if (op === 'update') {
    const nid = Number(raw.target_id);
    if (!Number.isInteger(nid) || nid <= 0) {
      errors.push('update requires a positive integer target_id');
    }
    let clean = null;
    try {
      // sanitizePatch throws if NO allowlisted field survives — that's the
      // right behavior: an update with nothing writable is rejected.
      clean = pluginSdk.sanitizePatch(raw.fields || {}, expectedTable);
    } catch (e) {
      errors.push(e.message);
    }
    if (errors.length) return { ok: false, errors };
    return {
      ok: true,
      errors: [],
      action: { entity, op: 'update', table: expectedTable, target_id: nid, fields: clean },
    };
  }

  if (op === 'create') {
    // Create is only exposed for tasks (mirrors pluginSdk — deals/contacts/
    // companies creation is intentionally NOT a plugin capability).
    if (expectedTable !== 'tasks') {
      return { ok: false, errors: [`create is only supported for tasks, not ${entity}`] };
    }
    let fields;
    try {
      fields = pluginSdk.normalizeTaskData(raw.fields || {});
    } catch (e) {
      return { ok: false, errors: [e.message] };
    }
    return {
      ok: true,
      errors: [],
      action: { entity: 'task', op: 'create', table: 'tasks', fields },
    };
  }

  return { ok: false, errors: [`unsupported op: ${op}`] };
}

/**
 * Collect the *_id references in an action that must be ownership-checked
 * against the caller's org before apply. Same contract as
 * chatActions.referencedIds.
 */
function referencedIds(action) {
  const out = [];
  if (action.op === 'create' && action.table === 'tasks') {
    if (action.fields.contact_id) out.push({ field: 'contact_id', table: 'contacts', id: action.fields.contact_id });
    if (action.fields.deal_id) out.push({ field: 'deal_id', table: 'deals', id: action.fields.deal_id });
  }
  return out;
}

/**
 * Execute a validated proposal inside an open pg client/transaction.
 * `scope` = { orgId, userId }. Every write is org-scoped so a cross-org target
 * cannot be written. Returns the affected row, or null when the scoped WHERE
 * matched nothing (caller should treat as 404 / skipped).
 */
async function applyProposal(client, action, scope) {
  const { orgId, userId } = scope;
  if (!Number.isInteger(orgId) || orgId <= 0) {
    throw new Error('applyProposal: orgId is required');
  }

  if (action.op === 'update') {
    const f = action.fields;
    const keys = Object.keys(f);
    const setSql = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const params = keys.map((k) => f[k]);
    params.push(action.target_id); const idIdx = params.length;
    params.push(orgId); const scopeIdx = params.length;
    const r = await client.query(
      `UPDATE ${action.table} SET ${setSql}, updated_at = CURRENT_TIMESTAMP
        WHERE id = $${idIdx} AND org_id = $${scopeIdx} RETURNING *`,
      params
    );
    return r.rows[0] || null;
  }

  // create task — org_id + user_id bound from the caller's scope, NOT the
  // payload. contact_id / deal_id were ownership-checked by the caller.
  const f = action.fields;
  const r = await client.query(
    `INSERT INTO tasks (org_id, user_id, contact_id, deal_id, title, description, due_date, status, priority)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [orgId, userId || null, f.contact_id, f.deal_id, f.title, f.description, f.due_date, f.status, f.priority]
  );
  return r.rows[0] || null;
}

/**
 * THE commit machinery for plugin-proposed writes — the single path through
 * which a stored proposal set reaches the DB. Shared by:
 *   • POST /api/plugins/:id/apply (routes/pluginRoutes.js) — the human
 *     confirm-first Apply button, and
 *   • pluginRunner's autonomous auto-apply (migration 167) — a plugin an org
 *     owner/admin flipped to run_mode='autonomous' has its SUCCESSFUL runs'
 *     proposals applied here immediately after the run, with `appliedBy`
 *     recording who/what triggered it (null for unattended triggered runs).
 *
 * Steps (identical for both callers):
 *   1. load the run's proposed_actions SERVER-SIDE, hard-scoped to the org,
 *   2. applied_at idempotency guard (re-asserted under FOR UPDATE),
 *   3. re-validate every proposal against the plugin write allowlist,
 *   4. ownership pre-flight for referenced ids,
 *   5. apply all proposals in ONE org-scoped transaction and stamp
 *      applied_at / applied_by / applied_result on the run row.
 *
 * Returns { ok:true, result:{ applied, applied_count, total } } or
 * { ok:false, http, error, code?, validation_errors? } for the caller to
 * translate. Throws only on unexpected DB errors (transaction already rolled
 * back). Callers own the audit trail.
 */
async function applyRunProposals({ runId, pluginId, orgId, appliedBy = null }) {
  if (!Number.isInteger(orgId) || orgId <= 0) {
    return { ok: false, http: 400, error: 'Org context required' };
  }
  // Load the run, joined to its plugin, and hard-scope BOTH to the org. A run
  // from another org (or another plugin) is a 404 — never applied.
  const runRes = await pool.query(
    `SELECT r.id, r.plugin_id, r.org_id, r.status, r.proposed_actions, r.applied_at
       FROM plugin_runs r
       JOIN plugins p ON p.id = r.plugin_id
      WHERE r.id = $1 AND r.plugin_id = $2 AND r.org_id = $3 AND p.org_id = $3`,
    [runId, pluginId, orgId]
  );
  if (runRes.rows.length === 0) {
    return { ok: false, http: 404, error: 'Run not found for this plugin in your org' };
  }
  const run = runRes.rows[0];

  // Idempotency: a run's proposals apply at most once.
  if (run.applied_at) {
    return { ok: false, http: 409, error: 'This run has already been applied', code: 'ALREADY_APPLIED' };
  }

  const proposals = Array.isArray(run.proposed_actions) ? run.proposed_actions : [];
  if (proposals.length === 0) {
    return { ok: false, http: 400, error: 'This run proposed no changes to apply', code: 'NO_PROPOSALS' };
  }

  // Re-validate every proposal from scratch against the plugin write
  // allowlist. The stored row is untrusted — a tampered field is stripped or
  // the whole proposal rejected here.
  const validated = [];
  for (let i = 0; i < proposals.length; i++) {
    const v = validateProposal(proposals[i]);
    if (!v.ok) {
      return {
        ok: false,
        http: 400,
        error: `Proposal #${i + 1} failed re-validation`,
        code: 'PROPOSAL_REJECTED',
        validation_errors: v.errors,
      };
    }
    validated.push(v.action);
  }

  // Ownership pre-flight for referenced ids (task contact_id / deal_id) BEFORE
  // opening the transaction, so a cross-org ref can never be written.
  const scope = { orgId, userId: appliedBy };
  for (const action of validated) {
    for (const ref of referencedIds(action)) {
      const r = await pool.query(`SELECT 1 FROM ${ref.table} WHERE id = $1 AND org_id = $2`, [ref.id, orgId]);
      if (r.rows.length === 0) {
        return {
          ok: false,
          http: 404,
          error: `${ref.field} #${ref.id} was not found in your org`,
          code: 'REF_NOT_IN_ORG',
        };
      }
    }
  }

  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('BEGIN');
    // Re-assert the not-yet-applied invariant inside the transaction and lock
    // the row so two concurrent applies (human click racing an autonomous
    // apply, or two clicks) can't double-write.
    const lock = await client.query(
      `SELECT applied_at FROM plugin_runs WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [runId, orgId]
    );
    if (lock.rows.length === 0) {
      await client.query('ROLLBACK').catch(() => {});
      return { ok: false, http: 404, error: 'Run not found for this plugin in your org' };
    }
    if (lock.rows[0].applied_at) {
      await client.query('ROLLBACK').catch(() => {});
      return { ok: false, http: 409, error: 'This run has already been applied', code: 'ALREADY_APPLIED' };
    }

    for (const action of validated) {
      const row = await applyProposal(client, action, scope);
      applied.push({
        entity: action.entity,
        op: action.op,
        target_id: action.op === 'update' ? action.target_id : (row ? row.id : null),
        ok: !!row,
        // A null row means the org-scoped WHERE matched nothing (e.g. the
        // record was deleted between preview and apply). We record it as
        // not-applied rather than failing the whole batch.
        skipped: !row,
      });
    }

    const result = { applied, applied_count: applied.filter((a) => a.ok).length, total: applied.length };
    await client.query(
      `UPDATE plugin_runs SET applied_at = NOW(), applied_by = $1, applied_result = $2::jsonb
        WHERE id = $3 AND org_id = $4`,
      [appliedBy, JSON.stringify(result), runId, orgId]
    );
    await client.query('COMMIT');
    return { ok: true, result };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { validateProposal, referencedIds, applyProposal, applyRunProposals };
