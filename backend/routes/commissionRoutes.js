// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Commission & goals reporting — per-rep commission over closed-won deals plus
// commission-plan CRUD. Mounted at /api/commission behind
// requireFeature('reports_enabled') (see index.js), so the whole surface
// degrades gracefully to the standard "module not enabled" 403 when reports
// are off for the org. Mirrors routes/forecastRoutes.js.
//
// Endpoints (all auth-required, all org-scoped via qs(req)):
//   GET    /            — commission report for an inclusive [from, to] window
//                         (?from=YYYY-MM-DD&to=YYYY-MM-DD; defaults to YTD).
//                         Includes per-partner statements (`partners` +
//                         `partner_totals`, migration 159a) alongside `reps`.
//   GET    /plans       — list this scope's commission plans (rep + partner)
//   POST   /plans       — create a plan: rep-specific / org default, or a
//                         partner plan (kind: 'partner' + partner_company_id
//                         + optional source_filter — see services/commission.js)
//   PUT    /plans/:id   — update a plan's rate / goal / effective date
//                         (+ source_filter on partner plans)
//   DELETE /plans/:id   — delete a plan
//
// All SQL safety lives in services/commission.js: the report runs three org-
// scoped, parameterized queries; the profile terminal-stage map is a constant,
// never user input. Plan CRUD binds every value as a parameter.

const express = require('express');
const { z } = require('zod');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const audit = require('../services/audit');
const commission = require('../services/commission');

const router = express.Router();
router.use(authMiddleware);

// Same helper every CRUD route uses: org scope, falling back to user scope.
function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The org's white-label profile drives the closed-won stage classification.
// Users with no org fall back to 'generic'. One tiny scoped lookup per request.
async function loadProfile(req) {
  if (!req.orgId) return 'generic';
  try {
    const r = await pool.query(
      `SELECT COALESCE(profile, 'generic') AS profile FROM organizations WHERE id = $1`,
      [req.orgId]
    );
    return r.rows[0]?.profile || 'generic';
  } catch {
    return 'generic';
  }
}

// ---------------------------------------------------------------------------
// GET / — commission report. Window defaults to YTD (Jan 1 → today).
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const today = new Date().toISOString().slice(0, 10);
    const from = ISO_DATE_RE.test(req.query.from || '') ? req.query.from : `${today.slice(0, 4)}-01-01`;
    const to = ISO_DATE_RE.test(req.query.to || '') ? req.query.to : today;
    if (from > to) return res.status(400).json({ error: 'from must be on or before to' });

    const profile = await loadProfile(req);
    const out = await commission.getCommissionReport({ sf, sv, profile, from, to }, pool);
    res.json({ success: true, ...out });
  } catch (error) {
    if (req.log) req.log.error('commission_report_failed', { error });
    else console.error('commission report error:', error);
    res.status(500).json({ error: 'Failed to compute commission report' });
  }
});

// ---------------------------------------------------------------------------
// GET /plans — list this scope's commission plans.
// ---------------------------------------------------------------------------
router.get('/plans', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `SELECT p.id, p.org_id, p.user_id, p.owner_id, p.rate_pct, p.goal_amount,
              p.effective_from, p.created_at,
              p.kind, p.partner_company_id, p.source_filter,
              u.name AS owner_name, u.email AS owner_email,
              pc.name AS partner_company_name
         FROM commission_plans p
         LEFT JOIN users u ON u.id = p.owner_id
         LEFT JOIN companies pc ON pc.id = p.partner_company_id
        WHERE p.${sf} = $1
        ORDER BY (p.kind = 'partner') ASC, p.owner_id NULLS FIRST, p.effective_from DESC, p.id DESC`,
      [sv]
    );
    res.json(r.rows);
  } catch (error) {
    if (req.log) req.log.error('commission_plan_list_failed', { error });
    else console.error('commission plan list error:', error);
    res.status(500).json({ error: 'Failed to load commission plans' });
  }
});

const planSchema = z.object({
  // 'rep' (default; the migration-139 model) or 'partner' (migration 159a:
  // a referral/channel fee owed to a company).
  kind: z.enum(['rep', 'partner']).optional(),
  // The rep this plan applies to; null/omitted = org-default plan. rep only.
  owner_id: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
  // partner only: the company the fee is paid to.
  partner_company_id: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
  // partner only, optional: channel matcher against the deal's custom-field
  // source convention (custom_fields.channel_source → .lead_source → .source
  // — see services/commission.js dealSource). '' clears.
  source_filter: z.union([z.string().max(80), z.null()]).optional(),
  rate_pct: z.coerce.number().finite().min(0).max(100),
  goal_amount: z.union([z.coerce.number().finite().min(0), z.null()]).optional(),
  effective_from: z.string().regex(ISO_DATE_RE, 'effective_from must be YYYY-MM-DD'),
});

// ---------------------------------------------------------------------------
// POST /plans — create a commission plan.
// ---------------------------------------------------------------------------
router.post('/plans', async (req, res) => {
  try {
    const parsed = planSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Invalid commission plan', fields: parsed.error.issues });
    }
    const { owner_id, rate_pct, goal_amount, effective_from } = parsed.data;
    const kind = parsed.data.kind || 'rep';
    const partnerCompanyId = parsed.data.partner_company_id ?? null;
    const sourceFilter = (parsed.data.source_filter ?? '').trim() || null;

    if (kind === 'partner') {
      // Partner plans (159a): fee to a company, never to a rep.
      if (partnerCompanyId == null) {
        return res.status(400).json({ success: false, error: 'partner_company_id is required for a partner plan' });
      }
      if (owner_id != null) {
        return res.status(400).json({ success: false, error: 'a partner plan cannot also have an owner_id (rep)' });
      }
      // The partner company must be inside this scope's tenancy.
      const [sf, sv] = qs(req);
      const company = await pool.query(
        `SELECT id FROM companies WHERE id = $1 AND ${sf} = $2`,
        [partnerCompanyId, sv]
      );
      if (company.rows.length === 0) {
        return res.status(400).json({ success: false, error: 'partner_company_id must be a company in this workspace' });
      }
    } else {
      // Rep plans keep the original contract byte-for-byte; partner-only
      // fields are rejected rather than silently dropped.
      if (partnerCompanyId != null || sourceFilter != null) {
        return res.status(400).json({ success: false, error: 'partner_company_id / source_filter are only valid on a partner plan (kind: "partner")' });
      }
      // A rep-specific plan must point at a member of this scope's team —
      // the same in-org guarantee recordOwnership enforces on deal owners.
      if (owner_id != null) {
        const [sf, sv] = qs(req);
        const member = await pool.query(
          `SELECT id FROM users WHERE id = $1 AND ${sf === 'org_id' ? 'org_id' : 'id'} = $2`,
          [owner_id, sv]
        );
        if (member.rows.length === 0) {
          return res.status(400).json({ success: false, error: 'owner_id must be a member of this workspace' });
        }
      }
    }

    const r = await pool.query(
      `INSERT INTO commission_plans (org_id, user_id, owner_id, rate_pct, goal_amount, effective_from, created_by,
                                     kind, partner_company_id, source_filter)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, org_id, user_id, owner_id, rate_pct, goal_amount, effective_from, created_at,
                 kind, partner_company_id, source_filter`,
      [req.orgId || null, req.userId, owner_id ?? null, rate_pct, goal_amount ?? null, effective_from, req.userId,
       kind, kind === 'partner' ? partnerCompanyId : null, kind === 'partner' ? sourceFilter : null]
    );

    audit.fromReq(req, {
      event: audit.EVENTS.COMMISSION_PLAN_CREATED,
      targetType: 'commission_plan',
      targetId: r.rows[0].id,
      meta: {
        owner_id: owner_id ?? null, rate_pct, goal_amount: goal_amount ?? null, effective_from,
        kind, partner_company_id: kind === 'partner' ? partnerCompanyId : null,
        source_filter: kind === 'partner' ? sourceFilter : null,
      },
    });

    res.status(201).json(r.rows[0]);
  } catch (error) {
    if (req.log) req.log.error('commission_plan_create_failed', { error });
    else console.error('commission plan create error:', error);
    res.status(500).json({ error: 'Failed to create commission plan' });
  }
});

// ---------------------------------------------------------------------------
// PUT /plans/:id — update a plan's rate / goal / effective date (scoped).
// ---------------------------------------------------------------------------
router.put('/plans/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    // kind + partner_company_id are immutable (delete + recreate to re-point
    // a plan); source_filter is editable, but only ever lands on partner rows
    // (the SQL guard below keeps rep plans untouched).
    const parsed = planSchema.omit({ owner_id: true, kind: true, partner_company_id: true }).partial().safeParse(req.body || {});
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid commission plan update', fields: parsed.success ? [] : parsed.error.issues });
    }
    const { rate_pct, goal_amount, effective_from } = parsed.data;
    const sourceFilter = (parsed.data.source_filter ?? '').trim() || null;

    const [sf, sv] = qs(req);
    const r = await pool.query(
      `UPDATE commission_plans
          SET rate_pct       = COALESCE($1, rate_pct),
              goal_amount    = CASE WHEN $4 THEN $2 ELSE goal_amount END,
              effective_from = COALESCE($3, effective_from),
              source_filter  = CASE WHEN $7 AND kind = 'partner' THEN $8 ELSE source_filter END,
              updated_at     = CURRENT_TIMESTAMP
        WHERE id = $5 AND ${sf} = $6
        RETURNING id, org_id, user_id, owner_id, rate_pct, goal_amount, effective_from, created_at,
                  kind, partner_company_id, source_filter`,
      [rate_pct ?? null, goal_amount ?? null, effective_from ?? null,
       'goal_amount' in parsed.data, id, sv,
       'source_filter' in parsed.data, sourceFilter]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Commission plan not found' });

    audit.fromReq(req, {
      event: audit.EVENTS.COMMISSION_PLAN_UPDATED,
      targetType: 'commission_plan',
      targetId: id,
      meta: parsed.data,
    });

    res.json(r.rows[0]);
  } catch (error) {
    if (req.log) req.log.error('commission_plan_update_failed', { error });
    else console.error('commission plan update error:', error);
    res.status(500).json({ error: 'Failed to update commission plan' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /plans/:id — remove a plan (scoped).
// ---------------------------------------------------------------------------
router.delete('/plans/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const [sf, sv] = qs(req);
    const r = await pool.query(
      `DELETE FROM commission_plans WHERE id = $1 AND ${sf} = $2 RETURNING id`,
      [id, sv]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Commission plan not found' });

    audit.fromReq(req, {
      event: audit.EVENTS.COMMISSION_PLAN_DELETED,
      targetType: 'commission_plan',
      targetId: id,
    });

    res.json({ success: true });
  } catch (error) {
    if (req.log) req.log.error('commission_plan_delete_failed', { error });
    else console.error('commission plan delete error:', error);
    res.status(500).json({ error: 'Failed to delete commission plan' });
  }
});

module.exports = router;
