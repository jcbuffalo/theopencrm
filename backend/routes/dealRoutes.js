// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Deals — the umbrella record for every opportunity / order / post-shipment
// engagement. The `phase` column (pre_sale / post_sale / post_ship) and
// `stage` column drive the Kanban view and most workflow gating.
//
// Endpoints (all auth-required, all org-scoped):
//   GET    /                        — list with filters: stage, phase, contact_id, company_id, customer_id, vendor_id, salesman_id, hot=true, search
//   GET    /:id                     — fetch one
//   POST   /                        — create (auto-derives phase from stage if not given)
//   PATCH  /:id/stage               — drag-drop on Kanban; stage validated against the org's effective pipeline (services/pipelines.js); phase auto-updates
//   PUT    /:id                     — partial COALESCE-style update of any field
//   GET    /:id/po-pdf              — stream a branded purchase-order PDF for the deal's selected vendor quote
//   DELETE /:id                     — hard delete
//
// Org-scoping: see qs(req) below. Every query goes through this; cross-org
// access is structurally impossible without bypassing the helper.
//
// VALID_STAGES is the union of:
//   • Zang's 28-stage Exhibit A lifecycle (TRIAGE → CLOSED → SERVICE → END_USER)
//   • Generic 6-stage pipeline (lead → closed_won/lost) — for non-Zang orgs
// The same column accepts both; the frontend's stages.js picks which set to render
// based on the org's profile.
//
// DEAL TYPES (spec 201, migration 156): every deal carries a `deal_type`
// (default 'default') and stage validation resolves the pipeline FOR THAT
// TYPE (services/pipelines.js fallback chain). A non-default type is only
// accepted once the org has created a pipeline for it; deal_type changes
// must arrive together with a stage valid on the target pipeline.

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const { renderPurchaseOrderPdf } = require('../services/pdfPurchaseOrder');
const stageTransitions = require('../services/stageTransitions');
const v2DualWrite = require('../services/v2DualWrite');
const webhookDispatcher = require('../services/webhookDispatcher');
const { validateCustomFieldsPayload } = require('./customFieldsRoutes');
const { validateBody } = require('../middleware/validate');
const dealSchemas = require('../schemas/deals');
// Per-org stage validation (migration 155): every stage check resolves the
// org's EFFECTIVE pipeline (custom row or profile default) first.
const dealStages = require('../utils/dealStages');
const pipelines = require('../services/pipelines');
const notificationDispatcher = require('../services/notificationDispatcher');
const { toCsv, sendCsv } = require('../utils/csvExport');
// Record ownership (migration 135) — owner_user_id validation + ?owner= filter.
const recordOwnership = require('../services/recordOwnership');
// Tier record caps (migration 136) — inert unless the org has an explicit
// capped limits_tier; comped/paid/super-admin exempt. See services/tierLimits.js.
const tierLimits = require('../services/tierLimits');
// Deal-stage-triggered success playbooks (migration 158).
const playbooks = require('../services/playbooks');
// Plugin trigger engine (migration 164) — fire-and-forget post-commit event
// dispatch to active plugins. emit() never throws and never blocks.
const pluginEvents = require('../services/pluginEvents');

// Fire deal_stage playbooks for a deal that just ENTERED `newStage`.
// Best-effort by design — a playbook failure must NEVER break the stage
// update the user asked for (mirrors the companyRoutes lifecycle wiring).
// Idempotency lives inside the service (partial UNIQUE (playbook_id, deal_id)
// guard), so repeat calls can't duplicate tasks.
async function fireDealStagePlaybooks(req, dealRow, newStage) {
  const [sf, sv] = qs(req);
  try {
    const fired = await playbooks.runPlaybooksForDealStageChange({
      orgScopeField: sf,
      orgScopeValue: sv,
      dealId: dealRow.id,
      newStage,
      dealType: dealRow.deal_type,
      companyId: dealRow.company_id || dealRow.customer_id || null,
      userId: req.userId,
    });
    if (fired.fired.length > 0 && req.log) {
      req.log.info('deal_playbooks_fired', { deal_id: dealRow.id, stage: newStage, fired: fired.fired });
    }
    // Fire-and-forget owner notification per fired playbook — same pattern as
    // the lifecycle path.
    for (const f of fired.fired) {
      notificationDispatcher.notifyPlaybookTasksCreated({
        playbookId: f.playbook_id,
        companyId: dealRow.company_id || dealRow.customer_id || null,
        tasksCreated: f.tasks_created,
        actorUserId: req.userId,
      }).catch(err => console.warn('notify_playbook_tasks_created_failed', err && err.message ? err.message : err));
    }
  } catch (playbookError) {
    if (req.log) req.log.error('deal_playbooks_fire_failed', { error: playbookError, deal_id: dealRow.id, stage: newStage });
    else console.error('Deal playbook trigger error:', playbookError);
  }
}

// Stages that represent a deal reaching a "closed" outcome. Moving INTO one of
// these fires a best-effort deal_activity notification to the deal owner (they
// like to know the moment a deal lands). Covers both the generic pipeline
// (closed_won/closed_lost) and the Zang lifecycle (CLOSED / CLOSED_PAID / LOST).
const CLOSED_STAGES = new Set([
  'CLOSED_WON', 'CLOSED_LOST', 'closed_won', 'closed_lost',
  'CLOSED', 'CLOSED_PAID', 'LOST',
]);

const router = express.Router();
router.use(authMiddleware);

// Returns [scopeField, scopeValue] for the current request's tenancy.
// Falls back to user_id when the user doesn't belong to an org.
function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

const VALID_PHASES = ['pre_sale', 'post_sale', 'post_ship'];

// Resolve a request-supplied deal_type (spec 201). 'default' is always
// valid; any other slug must have its own pipeline row for the org —
// otherwise a typo would silently mint a new type. Returns { type } or
// { error: <400 body> }.
async function resolveKnownDealType(req, raw) {
  let type;
  try {
    type = pipelines.normalizeDealType(raw);
  } catch (err) {
    return { error: err.body || { error: 'Invalid deal_type' } };
  }
  if (type === pipelines.DEFAULT_DEAL_TYPE) return { type };
  const known = await pipelines.listPipelines(req.orgId);
  if (!known.some((p) => p.deal_type === type)) {
    return {
      error: {
        error: `Unknown deal_type "${type}"`,
        code: 'INVALID_DEAL_TYPE',
        valid_deal_types: known.map((p) => p.deal_type),
      },
    };
  }
  return { type };
}

// Deal line items (migration 145) — nested products/quantities that roll up
// into deals.amount (server-authoritative, integer cents). A deal with no
// line items keeps its manually-set amount. See routes/dealLineItemRoutes.js.
router.use('/:dealId/line-items', require('./dealLineItemRoutes'));

router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { stage, phase, deal_type, contact_id, company_id, customer_id, vendor_id, salesman_id, hot, search, owner } = req.query;
    let query = `
      SELECT d.*,
        CASE WHEN c.id IS NOT NULL THEN c.first_name || ' ' || c.last_name END AS contact_name,
        co.name AS company_name,
        cu.name AS customer_name,
        v.name  AS vendor_name,
        uo.name AS owner_name
      FROM deals d
      LEFT JOIN contacts c   ON d.contact_id   = c.id
      LEFT JOIN companies co ON d.company_id   = co.id
      LEFT JOIN companies cu ON d.customer_id  = cu.id
      LEFT JOIN companies v  ON d.vendor_id    = v.id
      LEFT JOIN users uo     ON d.owner_user_id = uo.id
      WHERE d.${sf} = $1
    `;
    const params = [sv];

    if (stage)       { query += ` AND d.stage = $${params.length + 1}`;        params.push(stage); }
    if (phase)       { query += ` AND d.phase = $${params.length + 1}`;        params.push(phase); }
    if (deal_type)   { query += ` AND d.deal_type = $${params.length + 1}`;    params.push(deal_type); }
    if (contact_id)  { query += ` AND d.contact_id = $${params.length + 1}`;   params.push(contact_id); }
    if (company_id)  { query += ` AND d.company_id = $${params.length + 1}`;   params.push(company_id); }
    if (customer_id) { query += ` AND d.customer_id = $${params.length + 1}`;  params.push(customer_id); }
    if (vendor_id)   { query += ` AND d.vendor_id = $${params.length + 1}`;    params.push(vendor_id); }
    if (salesman_id) { query += ` AND d.salesman_id = $${params.length + 1}`;  params.push(salesman_id); }
    if (hot === 'true') { query += ` AND d.hot_flag = TRUE`; }
    if (search)      { query += ` AND (d.title ILIKE $${params.length + 1} OR d.po_number ILIKE $${params.length + 1})`; params.push(`%${search}%`); }
    // Record ownership (migration 135): ?owner=me → the caller's records,
    // ?owner=<id> → that user's records. Always ANDed with the org scope above.
    query = recordOwnership.applyOwnerFilter(query, params, owner, req, 'd.owner_user_id');

    query += ' ORDER BY d.kanban_position ASC, d.expected_close_date ASC, d.created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching deals:', error);
    res.status(500).json({ error: 'Failed to fetch deals' });
  }
});

// GET /export.csv — download the caller's deal list as a CSV attachment.
// Org-scoped and honours the same filters as GET / (stage, phase, contact_id,
// company_id, customer_id, vendor_id, salesman_id, hot, search). Mounted
// BEFORE /:id so "export.csv" isn't captured as an id.
router.get('/export.csv', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { stage, phase, deal_type, contact_id, company_id, customer_id, vendor_id, salesman_id, hot, search } = req.query;
    let query = `
      SELECT d.id, d.title, d.stage, d.phase, d.deal_type, d.amount, d.expected_close_date,
        CASE WHEN c.id IS NOT NULL THEN c.first_name || ' ' || c.last_name END AS contact_name,
        co.name AS company_name,
        cu.name AS customer_name,
        v.name  AS vendor_name,
        d.po_number, d.hot_flag, d.notes, d.created_at,
        li.revenue_cents, li.cost_cents
      FROM deals d
      LEFT JOIN contacts c   ON d.contact_id   = c.id
      LEFT JOIN companies co ON d.company_id   = co.id
      LEFT JOIN companies cu ON d.customer_id  = cu.id
      LEFT JOIN companies v  ON d.vendor_id    = v.id
      -- Line-item P&L rollup (migrations 145/159): revenue vs cost lines per
      -- deal. Scoped with the same tenancy filter as the deals themselves.
      LEFT JOIN (
        SELECT deal_id,
               COALESCE(SUM(line_total_cents) FILTER (WHERE kind = 'revenue'), 0)::bigint AS revenue_cents,
               COALESCE(SUM(line_total_cents) FILTER (WHERE kind = 'cost'), 0)::bigint AS cost_cents
          FROM deal_line_items
         WHERE ${sf} = $1
         GROUP BY deal_id
      ) li ON li.deal_id = d.id
      WHERE d.${sf} = $1
    `;
    const params = [sv];

    if (stage)       { query += ` AND d.stage = $${params.length + 1}`;        params.push(stage); }
    if (phase)       { query += ` AND d.phase = $${params.length + 1}`;        params.push(phase); }
    if (deal_type)   { query += ` AND d.deal_type = $${params.length + 1}`;    params.push(deal_type); }
    if (contact_id)  { query += ` AND d.contact_id = $${params.length + 1}`;   params.push(contact_id); }
    if (company_id)  { query += ` AND d.company_id = $${params.length + 1}`;   params.push(company_id); }
    if (customer_id) { query += ` AND d.customer_id = $${params.length + 1}`;  params.push(customer_id); }
    if (vendor_id)   { query += ` AND d.vendor_id = $${params.length + 1}`;    params.push(vendor_id); }
    if (salesman_id) { query += ` AND d.salesman_id = $${params.length + 1}`;  params.push(salesman_id); }
    if (hot === 'true') { query += ` AND d.hot_flag = TRUE`; }
    if (search)      { query += ` AND (d.title ILIKE $${params.length + 1} OR d.po_number ILIKE $${params.length + 1})`; params.push(`%${search}%`); }

    query += ' ORDER BY d.created_at DESC';
    const result = await pool.query(query, params);

    // Margin columns (migration 159): only meaningful when the deal HAS line
    // items — deals without any stay blank rather than reading as $0 margin.
    const rows = result.rows.map((r) => {
      if (r.revenue_cents == null && r.cost_cents == null) {
        return { ...r, line_revenue: '', line_cost: '', contribution: '', margin_pct: '' };
      }
      const revenue = Number(r.revenue_cents || 0);
      const cost = Number(r.cost_cents || 0);
      const contribution = revenue - cost;
      return {
        ...r,
        line_revenue: (revenue / 100).toFixed(2),
        line_cost: (cost / 100).toFixed(2),
        contribution: (contribution / 100).toFixed(2),
        margin_pct: revenue > 0 ? ((contribution / revenue) * 100).toFixed(1) : '',
      };
    });

    sendCsv(res, 'deals-export.csv', toCsv([
      { key: 'id',                  label: 'ID' },
      { key: 'title',               label: 'Title' },
      { key: 'stage',               label: 'Stage' },
      { key: 'phase',               label: 'Phase' },
      { key: 'deal_type',           label: 'Deal Type' },
      { key: 'amount',              label: 'Amount' },
      { key: 'expected_close_date', label: 'Expected Close Date' },
      { key: 'contact_name',        label: 'Contact' },
      { key: 'company_name',        label: 'Company' },
      { key: 'customer_name',       label: 'Customer' },
      { key: 'vendor_name',         label: 'Vendor' },
      { key: 'po_number',           label: 'PO Number' },
      { key: 'hot_flag',            label: 'Hot' },
      { key: 'notes',               label: 'Notes' },
      { key: 'created_at',          label: 'Created At' },
      { key: 'line_revenue',        label: 'Line Revenue' },
      { key: 'line_cost',           label: 'Line Cost' },
      { key: 'contribution',        label: 'Contribution' },
      { key: 'margin_pct',          label: 'Margin %' },
    ], rows));
  } catch (error) {
    if (req.log) req.log.error('deal_export_failed', { error });
    else console.error('Deal export error:', error);
    res.status(500).json({ error: 'Failed to export deals' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(`SELECT * FROM deals WHERE id = $1 AND ${sf} = $2`, [req.params.id, sv]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch deal' });
  }
});

// Stage → phase now comes from utils/dealStages.phaseForStage(stage, pipeline):
// a custom pipeline stage carries its own phase; everything else keeps the
// legacy Exhibit A derivation.
const { phaseForStage } = dealStages;

router.post('/', validateBody(dealSchemas.createSchema), async (req, res) => {
  // Wrap v1 INSERT + v2 dual-write in a single transaction so they commit
  // atomically. If v2 throws, the v1 deal insert rolls back too — we never
  // end up with a v1-only deal that the new entities haven't tracked.
  const client = await pool.connect();
  try {
    const {
      title, contact_id, company_id, customer_id, vendor_id, salesman_id, vertical,
      description, amount, stage, phase, deal_type, expected_close_date, notes, tags, hot_flag,
      po_number, ship_to, poc_name, poc_email, poc_phone, target_ship_date,
      external_ref, custom_fields, owner_user_id,
    } = req.body;
    // deal_type (spec 201): 'default' unless the org has a pipeline for the
    // requested type; an unknown type is a 400 listing the valid ones.
    let dealType = pipelines.DEFAULT_DEAL_TYPE;
    if (deal_type) {
      const resolved = await resolveKnownDealType(req, deal_type);
      if (resolved.error) return res.status(400).json(resolved.error);
      dealType = resolved.type;
    }
    // zod enforced `title` presence + shape gates. The stage is re-checked
    // against the pipeline for the deal's type (authoritative). Legacy default
    // stays 'TRIAGE' for orgs on a profile default (unchanged behaviour); a
    // custom pipeline defaults to its first stage.
    const pipeline = await pipelines.getEffectivePipeline(req.orgId, undefined, { dealType });
    const finalStage = stage || (pipeline.is_custom ? pipeline.default_stage : 'TRIAGE');
    if (!dealStages.isValidStage(finalStage, pipeline)) {
      return res.status(400).json({ error: 'Invalid stage', code: 'INVALID_STAGE', stage: finalStage, valid_stages: pipeline.stages.map((st) => st.id) });
    }
    const finalPhase = phase || phaseForStage(finalStage, pipeline);

    // Validate org-scoped custom fields BEFORE we open the txn — cheaper
    // failure path and means the txn never holds locks on a bad request.
    const cfErr = await validateCustomFieldsPayload({ orgId: req.orgId, entity: 'deals', payload: custom_fields, isCreate: true });
    if (cfErr) return res.status(400).json({ error: cfErr });

    // Record ownership (migration 135): owner must be a member of the caller's
    // org. Validated BEFORE the txn for the same cheap-failure reason as above.
    const ownerErr = await recordOwnership.ownerValidationError(req, owner_user_id);
    if (ownerErr) return res.status(400).json({ error: ownerErr });

    // --- Tier record cap (inert-by-default) -------------------------------
    // Checked BEFORE the txn opens (same cheap-failure reasoning as above).
    // 402s ONLY when the org is explicitly on a capped limits_tier, is
    // neither comped nor paid, the caller isn't a super-admin, AND the org is
    // at its deal cap. Fails OPEN on any internal error.
    const tierGate = await tierLimits.recordLimitGate(req, 'deals');
    if (tierGate) return res.status(tierGate.statusCode).json(tierGate.body);
    // -----------------------------------------------------------------------

    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO deals (user_id, org_id, contact_id, company_id, customer_id, vendor_id, salesman_id, vertical,
                          title, description, amount, stage, phase, deal_type, expected_close_date, notes, tags, hot_flag,
                          po_number, ship_to, poc_name, poc_email, poc_phone, target_ship_date, external_ref,
                          created_by, updated_by, last_activity_at, custom_fields, owner_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$26,CURRENT_TIMESTAMP,$27::jsonb,$28) RETURNING *`,
      [
        req.userId, req.orgId || null,
        contact_id || null, company_id || null, customer_id || null, vendor_id || null,
        salesman_id || req.userId, vertical || null,
        title, description || null, amount || null, finalStage, finalPhase, dealType,
        expected_close_date || null, notes || null, tags || [], !!hot_flag,
        po_number || null, ship_to || null, poc_name || null, poc_email || null, poc_phone || null, target_ship_date || null,
        external_ref || null,
        req.userId,
        JSON.stringify(custom_fields || {}),
        owner_user_id || null,
      ]
    );

    await v2DualWrite.onDealCreated(client, result.rows[0]);

    await client.query('COMMIT');

    // Fire outbound webhook (best-effort — never blocks or fails the response).
    if (req.orgId) {
      webhookDispatcher.dispatch(req.orgId, 'deal.created', {
        id: result.rows[0].id, title: result.rows[0].title, stage: result.rows[0].stage,
      });
      // Plugin trigger (migration 164) — same posture as the webhook: post-
      // commit, fire-and-forget, deduped per deal id.
      pluginEvents.emit(req.orgId, 'deal.created', {
        id: result.rows[0].id,
        title: result.rows[0].title,
        stage: result.rows[0].stage,
        deal_type: result.rows[0].deal_type,
        amount: result.rows[0].amount,
      });
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (req.log) req.log.error('deal_create_failed', { error });
    else console.error('Deal create error:', error);
    res.status(500).json({ error: 'Failed to create deal' });
  } finally {
    client.release();
  }
});

router.patch('/:id/stage', validateBody(dealSchemas.stagePatchSchema), async (req, res) => {
  const { stage } = req.body;

  try {
    const [sf, sv] = qs(req);

    // Look up the current stage, the deal's type, and the org's profile so we
    // can resolve the RIGHT pipeline (spec 201) and check the transition
    // graph. If the org has no profile set, fall back to 'generic'.
    const ctx = await pool.query(
      `SELECT d.stage AS current_stage, d.deal_type, COALESCE(o.profile, 'generic') AS profile
         FROM deals d LEFT JOIN organizations o ON d.org_id = o.id
        WHERE d.id = $1 AND d.${sf} = $2`,
      [req.params.id, sv]
    );
    if (ctx.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const { current_stage, profile } = ctx.rows[0];

    // zod ensured stage is a non-empty string; the effective pipeline for the
    // deal's type (custom stages, or profile default + legacy union) is the
    // authoritative enum and stays here as the last-line check.
    const pipeline = await pipelines.getEffectivePipeline(req.orgId, undefined, { dealType: ctx.rows[0].deal_type });
    if (!dealStages.isValidStage(stage, pipeline)) {
      return res.status(400).json({ error: 'Invalid stage', code: 'INVALID_STAGE', stage, valid_stages: pipeline.stages.map((st) => st.id) });
    }

    // The per-profile transition graph only describes the PROFILE DEFAULT
    // stages; an org that edited its pipeline gets free movement (its stages
    // may not exist in the graph at all).
    const guard = pipeline.is_custom
      ? { allowed: true }
      : stageTransitions.check(profile, current_stage, stage);
    if (!guard.allowed) {
      // Always log invalid transitions so we can build a frequency map and
      // know which "missing" edges in the graph are legitimate workflows.
      if (req.log) {
        req.log.warn('invalid_stage_transition', {
          dealId: req.params.id, profile, from: current_stage, to: stage,
          reason: guard.reason, validNext: guard.validNextStages,
        });
      }
      // In enforce mode: block the transition. In warn-only mode (default
      // for the first 2 weeks): proceed.
      if (stageTransitions.isEnforced()) {
        return res.status(400).json({
          error: 'Invalid stage transition',
          code: 'INVALID_TRANSITION',
          from: current_stage, to: stage,
          validNextStages: guard.validNextStages,
          reason: guard.reason,
        });
      }
    }

    const phase = phaseForStage(stage, pipeline);

    // Wrap stage update + v2 dual-write in a single transaction. If the v2
    // hook throws, the stage update rolls back so v1 and v2 stay consistent.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `UPDATE deals SET stage = $1, phase = $2,
                last_activity_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP,
                updated_by = $3,
                entity_version = COALESCE(entity_version, 1) + 1
          WHERE id = $4 AND ${sf} = $5 RETURNING *`,
        [stage, phase, req.userId, req.params.id, sv]
      );
      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Deal not found' });
      }

      await v2DualWrite.onDealStageChanged(client, result.rows[0], current_stage, stage);

      await client.query('COMMIT');

      // Fire outbound webhook (best-effort — never blocks or fails the response).
      if (req.orgId) {
        webhookDispatcher.dispatch(req.orgId, 'deal.stage_changed', {
          id: result.rows[0].id, title: result.rows[0].title, from: current_stage, to: stage,
        });
        // Plugin trigger (migration 164). Deduped per transition — retries of
        // the same from->to can't double-fire; a NEW transition (different
        // `from`) fires again.
        if (stage !== current_stage) {
          pluginEvents.emit(req.orgId, 'deal.stage_changed', {
            id: result.rows[0].id,
            title: result.rows[0].title,
            stage,
            prev_stage: current_stage,
            deal_type: result.rows[0].deal_type,
            amount: result.rows[0].amount,
          }, { dedupeKey: `deal.stage_changed:${result.rows[0].id}:${current_stage}->${stage}` });
        }
      }
      // Fire-and-forget: when a deal reaches a closed outcome (and wasn't already
      // there), notify the deal owner via their preferred channel(s). Failures
      // must NEVER break the stage update — no await, swallowed .catch().
      if (CLOSED_STAGES.has(stage) && !CLOSED_STAGES.has(current_stage)) {
        notificationDispatcher.notifyDealActivity(result.rows[0].id, null)
          .catch(err => console.warn('notify_deal_closed_failed', err && err.message ? err.message : err));
      }
      // Deal-stage playbooks (migration 158): fire when the deal ENTERS a new
      // stage. Best-effort — awaited so tests can observe it, but never throws.
      if (stage !== current_stage) {
        await fireDealStagePlaybooks(req, result.rows[0], stage);
      }

      res.json(result.rows[0]);
    } catch (txnErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txnErr;
    } finally {
      client.release();
    }
  } catch (error) {
    if (req.log) req.log.error('deal_stage_update_failed', { error });
    else console.error('Deal stage update error:', error);
    res.status(500).json({ error: 'Failed to update stage' });
  }
});

router.put('/:id', validateBody(dealSchemas.updateSchema), async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const {
      title, contact_id, company_id, customer_id, vendor_id, salesman_id, vertical,
      description, amount, stage, phase, deal_type, expected_close_date, closed_date, closed_amount, probability,
      notes, tags, hot_flag, lost_reason,
      po_number, ship_to, poc_name, poc_email, poc_phone, target_ship_date, actual_ship_date,
      release_status, hold_reason, custom_fields, owner_user_id,
    } = req.body;

    // A stage supplied on a full update is checked against the pipeline for
    // the deal's type, same as create / PATCH stage. Changing deal_type
    // (spec 201) is only allowed together with a stage that is valid on the
    // TARGET type's pipeline — otherwise the deal would land off-board.
    let finalPhase = phase || null;
    let finalDealType = null; // null → COALESCE keeps the current type
    let previousStage = null; // known only when we had to look the deal up
    if (stage || deal_type) {
      const cur = await pool.query(`SELECT stage, deal_type FROM deals WHERE id = $1 AND ${sf} = $2`, [req.params.id, sv]);
      if (cur.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
      previousStage = cur.rows[0].stage;
      const currentType = cur.rows[0].deal_type || pipelines.DEFAULT_DEAL_TYPE;
      let targetType = currentType;
      if (deal_type) {
        const resolved = await resolveKnownDealType(req, deal_type);
        if (resolved.error) return res.status(400).json(resolved.error);
        targetType = resolved.type;
        if (targetType !== currentType) {
          finalDealType = targetType;
          if (!stage) {
            return res.status(400).json({
              error: 'Changing deal_type requires a stage that is valid on the target pipeline',
              code: 'DEAL_TYPE_NEEDS_STAGE',
              deal_type: targetType,
            });
          }
        }
      }
      if (stage) {
        const pipeline = await pipelines.getEffectivePipeline(req.orgId, undefined, { dealType: targetType });
        if (!dealStages.isValidStage(stage, pipeline)) {
          return res.status(400).json({ error: 'Invalid stage', code: 'INVALID_STAGE', stage, valid_stages: pipeline.stages.map((st) => st.id) });
        }
        finalPhase = phase || phaseForStage(stage, pipeline);
      }
    }

    const cfErr = await validateCustomFieldsPayload({ orgId: req.orgId, entity: 'deals', payload: custom_fields, isCreate: false });
    if (cfErr) return res.status(400).json({ error: cfErr });

    // Record ownership (migration 135): reject an owner outside the caller's org.
    const ownerErr = await recordOwnership.ownerValidationError(req, owner_user_id);
    if (ownerErr) return res.status(400).json({ error: ownerErr });

    const result = await pool.query(
      `UPDATE deals SET
        title = COALESCE($1, title),
        contact_id = COALESCE($2, contact_id),
        company_id = COALESCE($3, company_id),
        customer_id = COALESCE($4, customer_id),
        vendor_id = COALESCE($5, vendor_id),
        salesman_id = COALESCE($6, salesman_id),
        vertical = COALESCE($7, vertical),
        description = COALESCE($8, description),
        amount = COALESCE($9, amount),
        stage = COALESCE($10, stage),
        phase = COALESCE($11, phase),
        expected_close_date = COALESCE($12, expected_close_date),
        closed_date = COALESCE($13, closed_date),
        closed_amount = COALESCE($14, closed_amount),
        ai_win_probability = COALESCE($15, ai_win_probability),
        notes = COALESCE($16, notes),
        tags = COALESCE($17, tags),
        hot_flag = COALESCE($18, hot_flag),
        lost_reason = COALESCE($19, lost_reason),
        po_number = COALESCE($20, po_number),
        ship_to = COALESCE($21, ship_to),
        poc_name = COALESCE($22, poc_name),
        poc_email = COALESCE($23, poc_email),
        poc_phone = COALESCE($24, poc_phone),
        target_ship_date = COALESCE($25, target_ship_date),
        actual_ship_date = COALESCE($26, actual_ship_date),
        release_status = COALESCE($27, release_status),
        hold_reason = COALESCE($28, hold_reason),
        custom_fields = CASE WHEN $31::jsonb IS NULL THEN custom_fields ELSE custom_fields || $31::jsonb END,
        owner_user_id = COALESCE($32, owner_user_id),
        deal_type = COALESCE($33, deal_type),
        last_activity_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = $29 AND ${sf} = $30 RETURNING *`,
      [
        title, contact_id, company_id, customer_id, vendor_id, salesman_id, vertical,
        description, amount, stage, finalPhase, expected_close_date, closed_date, closed_amount, probability,
        notes, tags, hot_flag, lost_reason,
        po_number, ship_to, poc_name, poc_email, poc_phone, target_ship_date, actual_ship_date,
        release_status, hold_reason,
        req.params.id, sv,
        custom_fields ? JSON.stringify(custom_fields) : null,
        owner_user_id || null,
        finalDealType,
      ]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    // Deal-stage playbooks (migration 158): a full PUT that moved the deal to
    // a new stage counts as "entering" it. Best-effort, never throws.
    if (stage && previousStage !== null && stage !== previousStage) {
      await fireDealStagePlaybooks(req, result.rows[0], stage);
      // Plugin trigger (migration 164) — same transition-scoped dedupe as the
      // PATCH /:id/stage path.
      if (req.orgId) {
        pluginEvents.emit(req.orgId, 'deal.stage_changed', {
          id: result.rows[0].id,
          title: result.rows[0].title,
          stage,
          prev_stage: previousStage,
          deal_type: result.rows[0].deal_type,
          amount: result.rows[0].amount,
        }, { dedupeKey: `deal.stage_changed:${result.rows[0].id}:${previousStage}->${stage}` });
      }
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Deal update error:', error);
    res.status(500).json({ error: 'Failed to update deal' });
  }
});

router.get('/:id/po-pdf', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `SELECT d.*, v.name AS vendor_name, v.location AS vendor_location, v.website AS vendor_website, v.phone AS vendor_phone
       FROM deals d LEFT JOIN companies v ON d.vendor_id = v.id
       WHERE d.id = $1 AND d.${sf} = $2`,
      [req.params.id, sv]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    const deal = r.rows[0];

    // Pull selected vendor quote if available — its amount drives the PO total.
    const vqRes = await pool.query(
      `SELECT amount FROM vendor_quotes WHERE deal_id = $1 AND is_selected = TRUE LIMIT 1`,
      [deal.id]
    );
    const vendorAmount = vqRes.rows[0]?.amount || null;

    let orgName = null;
    if (req.orgId) {
      const o = await pool.query(`SELECT name FROM organizations WHERE id = $1`, [req.orgId]);
      orgName = o.rows[0]?.name || null;
    }

    const vendor = {
      name: deal.vendor_name,
      location: deal.vendor_location,
      website: deal.vendor_website,
      phone: deal.vendor_phone,
    };
    const safe = (deal.po_number || `deal-${deal.id}`).toString().replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="po-${safe}.pdf"`);
    renderPurchaseOrderPdf({ deal, vendor, orgName, vendorAmount, lineItems: [] }, res);
  } catch (error) {
    console.error('PO PDF error:', error);
    res.status(500).json({ error: 'Failed to generate PO PDF' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const result = await pool.query(`DELETE FROM deals WHERE id = $1 AND ${sf} = $2 RETURNING *`, [req.params.id, sv]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    res.json({ message: 'Deal deleted', deal: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete deal' });
  }
});

module.exports = router;
