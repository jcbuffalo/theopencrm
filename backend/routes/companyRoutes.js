// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Companies — customers, vendors, end users, partners. The `type` column
// (customer/vendor/end_user/partner/other) drives both the UI grouping and
// many automation rules (e.g. vendor performance leaderboard only counts
// type='vendor').
//
// `first_deal_at` and `last_deal_at` are denormalized timestamps maintained
// to power the "new customer" / "dormant customer" filters and reports.
// Backfilled by migration 046; not auto-updated by the deals endpoints (yet).
//
// Endpoints (all auth-required, all org-scoped):
//   GET    /                  — list (filters: search, industry, status, type)
//   GET    /:id               — fetch one
//   POST   /                  — create
//   PUT    /:id               — update
//   DELETE /:id               — delete

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const { buildBulkUpdate, buildBulkDelete } = require('./_bulkOps');
const { validateCustomFieldsPayload } = require('./customFieldsRoutes');
const { validateBody } = require('../middleware/validate');
const companySchemas = require('../schemas/companies');
const audit = require('../services/audit');
const enrichment = require('../services/enrichment');
const { requireFeature } = require('../middleware/featureGate');
const { mergeCompanies } = require('../services/mergeRecords');
const playbooks = require('../services/playbooks');
// Plugin trigger engine (migration 164) — fire-and-forget post-commit dispatch.
const pluginEvents = require('../services/pluginEvents');
const notificationDispatcher = require('../services/notificationDispatcher');
// Record ownership (migration 135) — owner_user_id validation + ?owner= filter.
const recordOwnership = require('../services/recordOwnership');
const { toCsv, sendCsv } = require('../utils/csvExport');
// Tier record caps (migration 136) — inert unless the org has an explicit
// capped limits_tier; comped/paid/super-admin exempt. See services/tierLimits.js.
const tierLimits = require('../services/tierLimits');

const router = express.Router();
router.use(authMiddleware);

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

// Only org owners/admins may merge — it hard-deletes a record and rewrites
// child FKs, so it's a privileged, irreversible data operation. Users without
// an org (user_id scope) are their own admin.
function isOrgAdmin(req) {
  if (!req.orgId) return true;
  return req.orgRole === 'owner' || req.orgRole === 'admin';
}

// Bulk routes must be mounted BEFORE /:id routes so /bulk isn't matched as
// an id. Columns allowed in bulk-update mirror what the bulk-action bar
// surfaces — owner, type, status. Everything else still flows through PUT.
// zod validates body SHAPE; the allowlist inside buildBulkUpdate is the
// authoritative gate against unexpected columns.
router.patch('/bulk', validateBody(companySchemas.bulkPatchSchema), buildBulkUpdate({
  resource:  'companies',
  table:     'companies',
  allowlist: ['owner_id', 'type', 'status'],
  qs, pool,
}));
router.delete('/bulk', buildBulkDelete({
  resource: 'companies', table: 'companies', qs, pool,
}));

// GET /duplicates — candidate duplicate groups within the caller's org. Two
// signals, in priority order:
//   1. same normalized name    (lower(trim(name)))
//   2. same normalized website "domain" (host part, stripped of scheme/www/path)
// A group is any signal value shared by 2+ companies. Mounted BEFORE /:id so
// "duplicates" isn't captured as an id.
router.get('/duplicates', async (req, res) => {
  try {
    const [sf, sv] = qs(req);

    // By name.
    const byName = await pool.query(
      `SELECT lower(trim(name)) AS key,
              json_agg(json_build_object(
                'id', id, 'name', name, 'type', type, 'website', website,
                'industry', industry, 'created_at', created_at
              ) ORDER BY created_at ASC) AS members
         FROM companies
        WHERE ${sf} = $1 AND name IS NOT NULL AND trim(name) <> ''
        GROUP BY lower(trim(name))
       HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC`,
      [sv]
    );

    // By website domain. Normalize: lowercase, strip scheme, strip leading
    // www., strip anything from the first slash on. Blank domains are excluded.
    const byDomain = await pool.query(
      `WITH normalized AS (
         SELECT id, name, type, website, industry, created_at,
                regexp_replace(
                  regexp_replace(lower(trim(website)), '^https?://', ''),
                  '^www\\.', ''
                ) AS host_raw
           FROM companies
          WHERE ${sf} = $1 AND website IS NOT NULL AND trim(website) <> ''
       ),
       domains AS (
         SELECT id, name, type, website, industry, created_at,
                split_part(host_raw, '/', 1) AS domain
           FROM normalized
       )
       SELECT domain AS key,
              json_agg(json_build_object(
                'id', id, 'name', name, 'type', type, 'website', website,
                'industry', industry, 'created_at', created_at
              ) ORDER BY created_at ASC) AS members
         FROM domains
        WHERE domain <> ''
        GROUP BY domain
       HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC`,
      [sv]
    );

    const groups = [
      ...byName.rows.map(r => ({ reason: 'name', key: r.key, members: r.members })),
      ...byDomain.rows.map(r => ({ reason: 'domain', key: r.key, members: r.members })),
    ];
    res.json({ groups });
  } catch (error) {
    if (req.log) req.log.error('company_duplicates_failed', { error });
    else console.error('Company duplicates error:', error);
    res.status(500).json({ error: 'Failed to detect duplicate companies' });
  }
});

// GET /export.csv — download the caller's company list as a CSV attachment.
// Org-scoped and honours the same filters as GET / (search, industry, status,
// type, lifecycle_stage). Mounted BEFORE /:id so "export.csv" isn't captured
// as an id.
router.get('/export.csv', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { search, industry, status, type, lifecycle_stage } = req.query;
    let query = `
      SELECT id, name, type, industry, website, phone, location, employee_count,
             annual_revenue, status, lifecycle_stage, notes, created_at
        FROM companies
       WHERE ${sf} = $1`;
    const params = [sv];

    if (search) {
      query += ` AND (name ILIKE $${params.length + 1} OR website ILIKE $${params.length + 1})`;
      params.push(`%${search}%`);
    }
    if (industry) { query += ` AND industry = $${params.length + 1}`; params.push(industry); }
    if (status)   { query += ` AND status = $${params.length + 1}`;   params.push(status); }
    if (type)     { query += ` AND type = $${params.length + 1}`;     params.push(type); }
    if (lifecycle_stage && companySchemas.LIFECYCLE_STAGES.includes(lifecycle_stage)) {
      query += ` AND lifecycle_stage = $${params.length + 1}`; params.push(lifecycle_stage);
    }

    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);

    sendCsv(res, 'companies-export.csv', toCsv([
      { key: 'id',              label: 'ID' },
      { key: 'name',            label: 'Name' },
      { key: 'type',            label: 'Type' },
      { key: 'industry',        label: 'Industry' },
      { key: 'website',         label: 'Website' },
      { key: 'phone',           label: 'Phone' },
      { key: 'location',        label: 'Location' },
      { key: 'employee_count',  label: 'Employees' },
      { key: 'annual_revenue',  label: 'Annual Revenue' },
      { key: 'status',          label: 'Status' },
      { key: 'lifecycle_stage', label: 'Lifecycle Stage' },
      { key: 'notes',           label: 'Notes' },
      { key: 'created_at',      label: 'Created At' },
    ], result.rows));
  } catch (error) {
    if (req.log) req.log.error('company_export_failed', { error });
    else console.error('Company export error:', error);
    res.status(500).json({ error: 'Failed to export companies' });
  }
});

// POST /:id/merge  { loserId } — fold loserId into :id (winner). Org-admin
// gated. Verifies BOTH ids are in the caller's scope, then reassigns every
// child FK, backfills blank winner fields, deletes the loser, and audits —
// all in one transaction.
router.post('/:id/merge', validateBody(companySchemas.mergeSchema), async (req, res) => {
  if (!isOrgAdmin(req)) {
    return res.status(403).json({ error: 'Only org owners/admins can merge companies' });
  }
  const winnerId = parseInt(req.params.id, 10);
  const loserId = parseInt(req.body.loserId, 10);
  if (!Number.isInteger(winnerId) || !Number.isInteger(loserId)) {
    return res.status(400).json({ error: 'Invalid company id' });
  }
  if (winnerId === loserId) {
    return res.status(400).json({ error: 'Cannot merge a company into itself' });
  }

  const [sf, sv] = qs(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify BOTH ids belong to the caller's scope. A cross-org (or missing)
    // id yields fewer than 2 rows -> 404, and the txn rolls back untouched.
    const scoped = await client.query(
      `SELECT id FROM companies WHERE id IN ($1, $2) AND ${sf} = $3 FOR UPDATE`,
      [winnerId, loserId, sv]
    );
    if (scoped.rows.length < 2) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Company not found' });
    }

    const { reassigned } = await mergeCompanies(client, winnerId, loserId);

    await client.query('COMMIT');

    // Audit is append-only + fire-and-forget (own pool connection); write it
    // after COMMIT so a rolled-back merge never leaves a phantom audit row.
    await audit.record({
      event: audit.EVENTS.COMPANY_MERGED,
      actorUserId: req.userId || null,
      orgId: req.orgId || null,
      targetType: 'company',
      targetId: winnerId,
      ip: req.ip,
      userAgent: req.headers?.['user-agent'] || null,
      requestId: req.requestId || null,
      meta: { winner_id: winnerId, loser_id: loserId, reassigned },
    });

    const winner = await pool.query(`SELECT * FROM companies WHERE id = $1`, [winnerId]);
    res.json({ message: 'Companies merged', winner: winner.rows[0], reassigned });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (req.log) req.log.error('company_merge_failed', { error });
    else console.error('Company merge error:', error);
    res.status(500).json({ error: 'Failed to merge companies' });
  } finally {
    client.release();
  }
});

router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { search, industry, status, type, lifecycle_stage, owner } = req.query;
    let query = `SELECT * FROM companies WHERE ${sf} = $1`;
    const params = [sv];

    if (search) {
      query += ` AND (name ILIKE $${params.length + 1} OR website ILIKE $${params.length + 1})`;
      params.push(`%${search}%`, `%${search}%`);
    }
    if (industry) { query += ` AND industry = $${params.length + 1}`; params.push(industry); }
    if (status)   { query += ` AND status = $${params.length + 1}`;   params.push(status); }
    if (type)     { query += ` AND type = $${params.length + 1}`;     params.push(type); }
    // Account lifecycle filter (migration 122). Validated against the allowlist
    // so a bogus ?lifecycle_stage= can't force an always-empty scan on a typo.
    if (lifecycle_stage && companySchemas.LIFECYCLE_STAGES.includes(lifecycle_stage)) {
      query += ` AND lifecycle_stage = $${params.length + 1}`; params.push(lifecycle_stage);
    }
    // Record ownership (migration 135): ?owner=me → the caller's records,
    // ?owner=<id> → that user's records. Always ANDed with the org scope above.
    query = recordOwnership.applyOwnerFilter(query, params, owner, req);

    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching companies:', error);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(`SELECT * FROM companies WHERE id = $1 AND ${sf} = $2`, [req.params.id, sv]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Company not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch company' });
  }
});

router.post('/', validateBody(companySchemas.createSchema), async (req, res) => {
  try {
    const { name, type, industry, website, phone, location, employee_count, annual_revenue, notes, lifecycle_stage, custom_fields, owner_user_id } = req.body;
    // zod has enforced name presence + shape gates (incl. lifecycle_stage enum);
    // no hand-rolled rechecks needed.

    // Validate any org-scoped extension fields against this org's defs. Unknown
    // keys reject with 400 — never silently dropped, or admins would lose data.
    const cfErr = await validateCustomFieldsPayload({ orgId: req.orgId, entity: 'companies', payload: custom_fields, isCreate: true });
    if (cfErr) return res.status(400).json({ error: cfErr });

    // Record ownership (migration 135): owner must be a member of the caller's
    // org (or the caller themself in a personal workspace). 400s otherwise.
    const ownerErr = await recordOwnership.ownerValidationError(req, owner_user_id);
    if (ownerErr) return res.status(400).json({ error: ownerErr });

    // --- Tier record cap (inert-by-default) -------------------------------
    // 402s ONLY when the org is explicitly on a capped limits_tier, is
    // neither comped nor paid, the caller isn't a super-admin, AND the org is
    // at its company cap. Fails OPEN on any internal error.
    const tierGate = await tierLimits.recordLimitGate(req, 'companies');
    if (tierGate) return res.status(tierGate.statusCode).json(tierGate.body);
    // -----------------------------------------------------------------------

    // SOFT duplicate check — same normalized-name signal as GET /duplicates,
    // but as a cheap single-key org-scoped lookup. NEVER blocks the create:
    // matches only decorate the 201 response with a warning, and a failure in
    // the check itself is swallowed so it can't fail the save.
    let possibleDuplicates = [];
    try {
      const [sf, sv] = qs(req);
      const dup = await pool.query(
        `SELECT id, name, website FROM companies
          WHERE ${sf} = $1 AND lower(trim(name)) = lower(trim($2))
          LIMIT 5`,
        [sv, name]
      );
      possibleDuplicates = dup.rows;
    } catch (dupError) {
      if (req.log) req.log.warn('company_duplicate_check_failed', { error: dupError });
    }

    const result = await pool.query(
      `INSERT INTO companies (user_id, org_id, name, type, industry, website, phone, location, employee_count, annual_revenue, notes, lifecycle_stage, custom_fields, owner_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, 'active'), $13::jsonb, $14) RETURNING *`,
      [req.userId, req.orgId || null, name, type || 'customer', industry || null, website || null, phone || null, location || null, employee_count || null, annual_revenue || null, notes || null, lifecycle_stage || null, JSON.stringify(custom_fields || {}), owner_user_id || null]
    );

    // Plugin trigger (migration 164) — post-commit, fire-and-forget, deduped
    // per company id.
    if (req.orgId && result.rows[0]) {
      pluginEvents.emit(req.orgId, 'company.created', {
        id: result.rows[0].id,
        name: result.rows[0].name,
        type: result.rows[0].type,
        industry: result.rows[0].industry,
        lifecycle_stage: result.rows[0].lifecycle_stage,
      });
    }

    if (possibleDuplicates.length > 0) {
      return res.status(201).json({
        ...result.rows[0],
        warning: {
          possibleDuplicates: possibleDuplicates.map((d) => ({
            id: d.id,
            name: d.name,
            website: d.website || null,
          })),
        },
      });
    }
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create company' });
  }
});

router.put('/:id', validateBody(companySchemas.updateSchema), async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { name, type, industry, website, phone, location, employee_count, annual_revenue, notes, status, lifecycle_stage, custom_fields, owner_user_id } = req.body;

    // Optional partial patch of custom_fields. We MERGE (||) so a PUT that
    // only includes one custom key doesn't wipe the rest. Use isCreate=false
    // so the "required" check doesn't fire on partial updates.
    const cfErr = await validateCustomFieldsPayload({ orgId: req.orgId, entity: 'companies', payload: custom_fields, isCreate: false });
    if (cfErr) return res.status(400).json({ error: cfErr });

    // Record ownership (migration 135): reject an owner outside the caller's org.
    const ownerErr = await recordOwnership.ownerValidationError(req, owner_user_id);
    if (ownerErr) return res.status(400).json({ error: ownerErr });

    const result = await pool.query(
      `UPDATE companies SET name = COALESCE($1, name), type = COALESCE($2, type),
       industry = COALESCE($3, industry), website = COALESCE($4, website),
       phone = COALESCE($5, phone), location = COALESCE($6, location),
       employee_count = COALESCE($7, employee_count), annual_revenue = COALESCE($8, annual_revenue),
       notes = COALESCE($9, notes), status = COALESCE($10, status),
       lifecycle_stage = COALESCE($14, lifecycle_stage),
       owner_user_id = COALESCE($15, owner_user_id),
       custom_fields = CASE WHEN $13::jsonb IS NULL THEN custom_fields ELSE custom_fields || $13::jsonb END,
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $11 AND ${sf} = $12 RETURNING *`,
      [name, type, industry, website, phone, location, employee_count, annual_revenue, notes, status, req.params.id, sv, custom_fields ? JSON.stringify(custom_fields) : null, lifecycle_stage || null, owner_user_id || null]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Company not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update company' });
  }
});

// PATCH /:id/lifecycle-stage  { lifecycle_stage } — move an account along its
// relationship lifecycle (prospect → onboarding → active → at_risk → renewed →
// churned). This is the ACCOUNT lifecycle, distinct from a deal's pipeline
// stage. Org-scoped + allowlist-validated so a bad value 400s rather than
// writing garbage. Powers the inline stage editor on the /accounts home. Gated
// to the customer-success module (base company CRUD stays open) so the surface
// disappears cleanly when an org turns the CS motion off.
router.patch('/:id/lifecycle-stage', requireFeature('customer_success_enabled'), async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { lifecycle_stage, churned_reason } = req.body || {};
    if (!lifecycle_stage || !companySchemas.LIFECYCLE_STAGES.includes(lifecycle_stage)) {
      return res.status(400).json({
        error: `lifecycle_stage must be one of: ${companySchemas.LIFECYCLE_STAGES.join(', ')}`,
      });
    }
    // Churn detail (migration 127): entering churned stamps churned_at + an
    // optional allowlisted churned_reason; leaving churned clears both (a
    // re-engaged account is a live relationship again). Repeat churned PATCHes
    // keep the original timestamp/reason unless a new reason is supplied.
    const isChurn = lifecycle_stage === 'churned';
    if (churned_reason != null && (!isChurn || !companySchemas.CHURN_REASONS.includes(churned_reason))) {
      return res.status(400).json({
        error: `churned_reason is only valid when moving to churned and must be one of: ${companySchemas.CHURN_REASONS.join(', ')}`,
      });
    }
    const result = await pool.query(
      `UPDATE companies SET lifecycle_stage = $1,
              churned_at = CASE WHEN $4::boolean THEN COALESCE(churned_at, CURRENT_TIMESTAMP) ELSE NULL END,
              churned_reason = CASE WHEN $4::boolean THEN COALESCE($5::text, churned_reason) ELSE NULL END,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $2 AND ${sf} = $3 RETURNING *`,
      [lifecycle_stage, req.params.id, sv, isChurn, churned_reason || null]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Company not found' });

    // Success Playbooks (migration 123): fire any active playbook listening for
    // the stage this account just entered. Best-effort by design — a playbook
    // failure must NEVER break the stage update the user asked for, so we
    // swallow + log rather than 500. Idempotency lives inside the service
    // (playbook_runs UNIQUE guard), so re-PATCHes don't duplicate tasks.
    try {
      const fired = await playbooks.runPlaybooksForStageChange({
        orgScopeField: sf,
        orgScopeValue: sv,
        companyId: result.rows[0].id,
        newStage: lifecycle_stage,
        userId: req.userId,
      });
      if (fired.fired.length > 0 && req.log) {
        req.log.info('playbooks_fired', { company_id: result.rows[0].id, stage: lifecycle_stage, fired: fired.fired });
      }
      // Fire-and-forget: tell the account owner (or the actor) what each
      // playbook just spawned. Best-effort — never breaks the stage change.
      for (const f of fired.fired) {
        notificationDispatcher.notifyPlaybookTasksCreated({
          playbookId: f.playbook_id, companyId: result.rows[0].id,
          tasksCreated: f.tasks_created, actorUserId: req.userId,
        }).catch(err => console.warn('notify_playbook_tasks_created_failed', err && err.message ? err.message : err));
      }
    } catch (playbookError) {
      if (req.log) req.log.error('playbooks_fire_failed', { error: playbookError, company_id: result.rows[0].id, stage: lifecycle_stage });
      else console.error('Playbook trigger error:', playbookError);
    }

    res.json(result.rows[0]);
  } catch (error) {
    if (req.log) req.log.error('company_lifecycle_stage_failed', { error });
    else console.error('Company lifecycle-stage error:', error);
    res.status(500).json({ error: 'Failed to update lifecycle stage' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(`DELETE FROM companies WHERE id = $1 AND ${sf} = $2 RETURNING *`, [req.params.id, sv]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Company not found' });
    res.json({ message: 'Company deleted', company: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete company' });
  }
});

// POST /:id/enrich — fetch an enrichment PROPOSAL for this company, keyed by its
// website domain. Gated by enrichment_enabled, org-scoped, never mutates the
// company. Degrades gracefully to configured:false when no provider key is set.
router.post('/:id/enrich', requireFeature('enrichment_enabled'), async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const found = await pool.query(`SELECT id, website FROM companies WHERE id = $1 AND ${sf} = $2`, [req.params.id, sv]);
    if (found.rows.length === 0) return res.status(404).json({ error: 'Company not found' });
    const company = found.rows[0];

    const result = await enrichment.enrichCompany({ domain: company.website, orgId: req.orgId });
    audit.fromReq(req, {
      event: audit.EVENTS.RECORD_ENRICHED,
      targetType: 'company',
      targetId: String(company.id),
      meta: { configured: result.configured, cached: !!result.cached, has_domain: !!company.website },
    });
    res.json({
      configured: result.configured,
      cached: !!result.cached,
      message: result.message || null,
      fields: result.fields || {},
    });
  } catch (error) {
    if (req.log) req.log.error('company_enrich_failed', { error });
    res.status(500).json({ error: 'Failed to enrich company' });
  }
});

// POST /:id/enrich/apply — merge user-accepted enrichment fields into the
// company's custom_fields JSONB (namespaced under enrichment_* keys). Org-scoped
// + audited.
router.post('/:id/enrich/apply', requireFeature('enrichment_enabled'), async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const fields = req.body?.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      return res.status(400).json({ error: 'A `fields` object of accepted values is required' });
    }
    const merged = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === null || v === undefined || v === '') continue;
      merged[`enrichment_${k}`] = v;
    }
    if (Object.keys(merged).length === 0) {
      return res.status(400).json({ error: 'No non-empty fields to apply' });
    }
    const result = await pool.query(
      `UPDATE companies
          SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) || $1::jsonb,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $2 AND ${sf} = $3 RETURNING *`,
      [JSON.stringify(merged), req.params.id, sv]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Company not found' });
    audit.fromReq(req, {
      event: audit.EVENTS.RECORD_ENRICHMENT_APPLIED,
      targetType: 'company',
      targetId: String(req.params.id),
      meta: { applied_keys: Object.keys(merged) },
    });
    res.json(result.rows[0]);
  } catch (error) {
    if (req.log) req.log.error('company_enrich_apply_failed', { error });
    res.status(500).json({ error: 'Failed to apply enrichment' });
  }
});

module.exports = router;
