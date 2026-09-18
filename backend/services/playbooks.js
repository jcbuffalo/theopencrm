// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Success Playbooks engine — spawn a templated task checklist when a company
// enters a lifecycle stage (migration 123).
//
// Two trigger entry points, both called best-effort AFTER the stage change
// commits:
//   * runPlaybooksForStageChange     — company lifecycle changes (PATCH
//     /api/companies/:id/lifecycle-stage + the AI apply mirror).
//   * runPlaybooksForDealStageChange — deal pipeline-stage changes, migration
//     158 (PATCH /api/deals/:id/stage, stage-changing PUT /api/deals/:id, and
//     the AI actions-apply deal.update path).
// They must therefore be:
//
//   * ORG-SCOPED — the caller passes the same [scopeField, scopeValue] pair
//     the route derived via qs(req); every query here threads it through, so a
//     playbook can only ever fire for companies in its own org (or its owning
//     user, for no-org users).
//   * IDEMPOTENT — playbook_runs carries a UNIQUE (playbook_id, company_id)
//     index; we INSERT ... ON CONFLICT DO NOTHING and only create tasks when
//     the insert actually landed. Two concurrent stage changes race safely:
//     exactly one wins the run row, exactly one set of tasks is created.
//   * ATOMIC PER PLAYBOOK — the run row + its tasks commit in one transaction,
//     so a mid-flight failure can't leave a run recorded with half its tasks
//     (which would block the retry forever).
//
// Tasks are created directly (not via the /api/tasks route) with the columns
// taskRoutes.js writes: title/description from the step, due_date = today +
// offset_days, status 'open', priority 'medium', company_id linking the task
// to the account, and user_id = the user who moved the stage (satisfies the
// NOT NULL and gives the task a sensible "created by").

const pool = require('./../db');

/**
 * Fire every active playbook whose trigger_stage matches the company's new
 * lifecycle stage — once per (playbook, company), ever.
 *
 * @param {object} opts
 * @param {string} opts.orgScopeField  'org_id' | 'user_id' (from qs(req))
 * @param {*}      opts.orgScopeValue  the org id (or user id fallback)
 * @param {number} opts.companyId
 * @param {string} opts.newStage       validated lifecycle stage
 * @param {number} opts.userId         acting user — owns the spawned tasks
 * @param {object} [opts.db]           pg pool override (tests)
 * @returns {Promise<{ fired: Array<{ playbook_id: number, name: string, tasks_created: number }> }>}
 */
async function runPlaybooksForStageChange({
  orgScopeField,
  orgScopeValue,
  companyId,
  newStage,
  userId,
  db = pool,
}) {
  if (orgScopeField !== 'org_id' && orgScopeField !== 'user_id') {
    throw new Error(`Invalid scope field: ${orgScopeField}`);
  }
  // org_id column value for the rows we write — null for no-org (user-scoped)
  // callers, mirroring how every route INSERT writes `req.orgId || null`.
  const orgId = orgScopeField === 'org_id' ? orgScopeValue : null;

  // Active LIFECYCLE playbooks in this scope listening for this stage.
  // trigger_kind (migration 158) keeps deal_stage playbooks out of the
  // lifecycle path — COALESCE covers rows read before the migration ran.
  const playbooks = await db.query(
    `SELECT id, name FROM playbooks
      WHERE ${orgScopeField} = $1 AND trigger_stage = $2 AND is_active = true
        AND COALESCE(trigger_kind, 'lifecycle_stage') = 'lifecycle_stage'
      ORDER BY id ASC`,
    [orgScopeValue, newStage]
  );
  if (playbooks.rows.length === 0) return { fired: [] };

  const fired = [];
  for (const playbook of playbooks.rows) {
    const result = await firePlaybook(db, { orgId, playbook, companyId, triggeredStage: newStage, userId });
    if (result) fired.push(result);
  }

  return { fired };
}

/**
 * Fire every active DEAL-STAGE playbook (migration 158) matching the stage a
 * deal just entered — once per (playbook, deal), ever. Mirrors
 * runPlaybooksForStageChange: org-scoped, idempotent (partial UNIQUE
 * (playbook_id, deal_id) index + ON CONFLICT DO NOTHING), atomic per playbook.
 * Called best-effort AFTER the stage change commits from every interactive
 * stage-change path (PATCH /deals/:id/stage, stage-changing PUT /deals/:id,
 * and the AI actions-apply writer).
 *
 * @param {object} opts
 * @param {string} opts.orgScopeField  'org_id' | 'user_id' (from qs(req))
 * @param {*}      opts.orgScopeValue  the org id (or user id fallback)
 * @param {number} opts.dealId
 * @param {string} opts.newStage       the stage the deal just entered
 * @param {string} [opts.dealType]     the deal's deal_type ('default' when unset)
 * @param {number} [opts.companyId]    the deal's company — linked on spawned tasks
 * @param {number} opts.userId         acting user — owns the spawned tasks
 * @param {object} [opts.db]           pg pool override (tests)
 * @returns {Promise<{ fired: Array<{ playbook_id: number, name: string, tasks_created: number }> }>}
 */
async function runPlaybooksForDealStageChange({
  orgScopeField,
  orgScopeValue,
  dealId,
  newStage,
  dealType,
  companyId,
  userId,
  db = pool,
}) {
  if (orgScopeField !== 'org_id' && orgScopeField !== 'user_id') {
    throw new Error(`Invalid scope field: ${orgScopeField}`);
  }
  const orgId = orgScopeField === 'org_id' ? orgScopeValue : null;

  // Active deal_stage playbooks in this scope listening for this stage,
  // honoring the optional trigger_deal_type filter (NULL = any type).
  const playbooks = await db.query(
    `SELECT id, name FROM playbooks
      WHERE ${orgScopeField} = $1 AND trigger_stage = $2 AND is_active = true
        AND trigger_kind = 'deal_stage'
        AND (trigger_deal_type IS NULL OR trigger_deal_type = $3)
      ORDER BY id ASC`,
    [orgScopeValue, newStage, dealType || 'default']
  );
  if (playbooks.rows.length === 0) return { fired: [] };

  const fired = [];
  for (const playbook of playbooks.rows) {
    const result = await fireDealPlaybook(db, {
      orgId, playbook, dealId, companyId: companyId || null, triggeredStage: newStage, userId,
    });
    if (result) fired.push(result);
  }

  return { fired };
}

// The atomic per-playbook body for DEAL firings: idempotency-guarded run row
// (company_id stays NULL — two deals of one company must each get a run), then
// one task per step linked to both the deal and its company, in one txn.
async function fireDealPlaybook(db, { orgId, playbook, dealId, companyId, triggeredStage, userId }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Idempotency gate: the partial UNIQUE (playbook_id, deal_id) index means
    // a second firing (including a concurrent one) inserts nothing.
    const run = await client.query(
      `INSERT INTO playbook_runs (org_id, playbook_id, deal_id, triggered_stage)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (playbook_id, deal_id) WHERE deal_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [orgId, playbook.id, dealId, triggeredStage]
    );
    if (run.rows.length === 0) {
      await client.query('ROLLBACK');
      return null; // already ran for this deal
    }

    const steps = await client.query(
      `SELECT title, description, offset_days FROM playbook_steps
        WHERE playbook_id = $1 ORDER BY sort_order ASC, id ASC`,
      [playbook.id]
    );
    for (const step of steps.rows) {
      const offset = Number.isInteger(step.offset_days) ? step.offset_days : 0;
      await client.query(
        `INSERT INTO tasks (user_id, org_id, deal_id, company_id, title, description, due_date, status, priority)
         VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE + $7::int, 'open', 'medium')`,
        [userId, orgId, dealId, companyId, step.title, step.description || null, offset]
      );
    }

    await client.query('COMMIT');
    return { playbook_id: playbook.id, name: playbook.name, tasks_created: steps.rows.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// The atomic per-playbook body shared by the stage trigger and the manual
// (chat) run: insert the idempotency-guarded run row, then spawn one task per
// step, all in one transaction. Returns { playbook_id, name, tasks_created }
// or null when the (playbook, company) pair already ran.
async function firePlaybook(db, { orgId, playbook, companyId, triggeredStage, userId }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Idempotency gate: the UNIQUE (playbook_id, company_id) index means a
    // second firing (including a concurrent one) inserts nothing and we skip.
    const run = await client.query(
      `INSERT INTO playbook_runs (org_id, playbook_id, company_id, triggered_stage)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (playbook_id, company_id) DO NOTHING
       RETURNING id`,
      [orgId, playbook.id, companyId, triggeredStage]
    );
    if (run.rows.length === 0) {
      await client.query('ROLLBACK');
      return null; // already ran for this company
    }

    // Spawn one task per step, in checklist order, due today + offset_days.
    const steps = await client.query(
      `SELECT title, description, offset_days FROM playbook_steps
        WHERE playbook_id = $1 ORDER BY sort_order ASC, id ASC`,
      [playbook.id]
    );
    for (const step of steps.rows) {
      const offset = Number.isInteger(step.offset_days) ? step.offset_days : 0;
      await client.query(
        `INSERT INTO tasks (user_id, org_id, company_id, title, description, due_date, status, priority)
         VALUES ($1, $2, $3, $4, $5, CURRENT_DATE + $6::int, 'open', 'medium')`,
        [userId, orgId, companyId, step.title, step.description || null, offset]
      );
    }

    await client.query('COMMIT');
    return { playbook_id: playbook.id, name: playbook.name, tasks_created: steps.rows.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run ONE named playbook against a company on demand (the chat copilot's
 * confirm-first playbook.run action). Unlike the stage trigger, this fires
 * exactly the requested playbook — no siblings on the same stage. Same
 * org-scoping and (playbook, company) idempotency as the trigger path, so a
 * re-apply can never duplicate tasks.
 *
 * @returns null when the playbook isn't visible/active in the caller's scope;
 *   { playbook_id, name, tasks_created, already_ran } otherwise.
 */
async function runPlaybookForCompany({
  orgScopeField,
  orgScopeValue,
  playbookId,
  companyId,
  userId,
  db = pool,
}) {
  if (orgScopeField !== 'org_id' && orgScopeField !== 'user_id') {
    throw new Error(`Invalid scope field: ${orgScopeField}`);
  }
  const orgId = orgScopeField === 'org_id' ? orgScopeValue : null;

  const r = await db.query(
    `SELECT id, name, trigger_stage FROM playbooks
      WHERE id = $1 AND ${orgScopeField} = $2 AND is_active = true`,
    [playbookId, orgScopeValue]
  );
  if (r.rows.length === 0) return null;
  const playbook = r.rows[0];

  const result = await firePlaybook(db, {
    orgId, playbook, companyId,
    triggeredStage: playbook.trigger_stage, userId,
  });
  if (result) return { ...result, already_ran: false };
  return { playbook_id: playbook.id, name: playbook.name, tasks_created: 0, already_ran: true };
}

module.exports = { runPlaybooksForStageChange, runPlaybooksForDealStageChange, runPlaybookForCompany };
