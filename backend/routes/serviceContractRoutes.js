// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Service contracts (Phase V — post-shipment services with renewal alerts).

const express = require('express');
const { authMiddleware } = require('../auth');
const pool = require('../db');
const { validateBody } = require('../middleware/validate');
const { requireFeature } = require('../middleware/featureGate');
const { createSchema, updateSchema } = require('../schemas/serviceContracts');

const router = express.Router();
router.use(authMiddleware);

function qs(req) { return req.orgId ? ['org_id', req.orgId] : ['user_id', req.userId]; }

router.get('/', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { status, customer_id, due_for_renewal } = req.query;
    let query = `
      SELECT sc.*, c.name AS customer_name, d.title AS deal_title,
             CASE WHEN sc.end_date IS NOT NULL
                  THEN sc.end_date - CURRENT_DATE
                  ELSE NULL END AS days_to_end
      FROM service_contracts sc
      LEFT JOIN companies c ON sc.customer_id = c.id AND c.${sf} = $1
      LEFT JOIN deals d ON sc.deal_id = d.id AND d.${sf} = $1
      WHERE sc.${sf} = $1
    `;
    const params = [sv];
    if (status)      { query += ` AND sc.status = $${params.length + 1}`;     params.push(status); }
    if (customer_id) { query += ` AND sc.customer_id = $${params.length + 1}`;params.push(customer_id); }
    if (due_for_renewal === 'true') {
      query += ` AND sc.status = 'active' AND sc.end_date IS NOT NULL AND sc.end_date <= CURRENT_DATE + (sc.renewal_notice_days || ' days')::INTERVAL`;
    }
    query += ' ORDER BY sc.end_date NULLS LAST, sc.created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Service contracts list error:', error.message);
    res.status(500).json({ error: 'Failed to fetch service contracts' });
  }
});

// GET /api/service-contracts/renewals — renewal pipeline rollup: counts +
// summed annual_value by renewal_stage, plus a next-90-day forecast (contracts
// ending within 90 days, by stage). Org-scoped via qs(req). Declared before
// the PUT/DELETE :id routes; GET '/renewals' is unambiguous against them.
// Gated to the customer-success module (base service-contract CRUD stays open).
router.get('/renewals', requireFeature('customer_success_enabled'), async (req, res) => {
  try {
    const [sf, sv] = qs(req);

    // Counts + summed annual_value per renewal_stage (active contracts only).
    const byStage = await pool.query(
      `SELECT COALESCE(renewal_stage, 'upcoming') AS renewal_stage,
              COUNT(*)::int AS count,
              COALESCE(SUM(annual_value), 0)::float AS annual_value
       FROM service_contracts
       WHERE ${sf} = $1
       GROUP BY COALESCE(renewal_stage, 'upcoming')`,
      [sv]
    );

    // Next-90-day forecast: active contracts ending within 90 days, summed by
    // stage so the front-end can show "what's coming up for renewal".
    const forecast = await pool.query(
      `SELECT COALESCE(renewal_stage, 'upcoming') AS renewal_stage,
              COUNT(*)::int AS count,
              COALESCE(SUM(annual_value), 0)::float AS annual_value
       FROM service_contracts
       WHERE ${sf} = $1
         AND status = 'active'
         AND end_date IS NOT NULL
         AND end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '90 days'
       GROUP BY COALESCE(renewal_stage, 'upcoming')`,
      [sv]
    );

    const STAGES = ['upcoming', 'at_risk', 'renewed', 'churned'];
    const emptyStage = () => ({ count: 0, annual_value: 0 });
    const stages = {};
    for (const s of STAGES) stages[s] = emptyStage();
    let totalCount = 0;
    let totalAnnualValue = 0;
    for (const row of byStage.rows) {
      const key = STAGES.includes(row.renewal_stage) ? row.renewal_stage : 'upcoming';
      stages[key].count += row.count;
      stages[key].annual_value += row.annual_value;
      totalCount += row.count;
      totalAnnualValue += row.annual_value;
    }

    const forecastStages = {};
    for (const s of STAGES) forecastStages[s] = emptyStage();
    let forecastCount = 0;
    let forecastAnnualValue = 0;
    for (const row of forecast.rows) {
      const key = STAGES.includes(row.renewal_stage) ? row.renewal_stage : 'upcoming';
      forecastStages[key].count += row.count;
      forecastStages[key].annual_value += row.annual_value;
      forecastCount += row.count;
      forecastAnnualValue += row.annual_value;
    }

    res.json({
      stages,
      total_count: totalCount,
      total_annual_value: totalAnnualValue,
      forecast_90d: {
        stages: forecastStages,
        total_count: forecastCount,
        total_annual_value: forecastAnnualValue,
      },
    });
  } catch (error) {
    console.error('Service contract renewals error:', error.message);
    res.status(500).json({ error: 'Failed to fetch renewals summary' });
  }
});

router.post('/', validateBody(createSchema), async (req, res) => {
  try {
    const { customer_id, deal_id, name, contract_type, start_date, end_date, renewal_notice_days, status,
            monthly_amount, notes, renewal_stage, annual_value, churn_reason, renewed_contract_id } = req.body;

    // Multi-tenancy: a contract may only point at a company in the caller's scope.
    if (customer_id != null) {
      const [sf, sv] = qs(req);
      const own = await pool.query(`SELECT 1 FROM companies WHERE id = $1 AND ${sf} = $2`, [customer_id, sv]);
      if (own.rows.length === 0) return res.status(400).json({ error: 'customer_id not found in your organization' });
    }

    const result = await pool.query(
      `INSERT INTO service_contracts (user_id, org_id, customer_id, deal_id, name, contract_type, start_date, end_date, renewal_notice_days, status, monthly_amount, notes, renewal_stage, annual_value, churn_reason, renewed_contract_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
      [req.userId, req.orgId || null, customer_id || null, deal_id || null, name, contract_type || 'service',
       start_date || null, end_date || null, renewal_notice_days || 30, status || 'active', monthly_amount || null, notes || null,
       renewal_stage || 'upcoming', annual_value ?? null, churn_reason || null, renewed_contract_id || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create service contract' });
  }
});

router.put('/:id', validateBody(updateSchema), async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const { name, contract_type, start_date, end_date, renewal_notice_days, status, monthly_amount, notes, customer_id,
            renewal_stage, annual_value, churn_reason, renewed_contract_id } = req.body;
    // Multi-tenancy: a contract may only be re-pointed at a company in the caller's scope.
    if (customer_id != null) {
      const own = await pool.query(`SELECT 1 FROM companies WHERE id = $1 AND ${sf} = $2`, [customer_id, sv]);
      if (own.rows.length === 0) return res.status(400).json({ error: 'customer_id not found in your organization' });
    }
    const result = await pool.query(
      `UPDATE service_contracts SET
         name = COALESCE($1, name), contract_type = COALESCE($2, contract_type),
         start_date = COALESCE($3, start_date), end_date = COALESCE($4, end_date),
         renewal_notice_days = COALESCE($5, renewal_notice_days), status = COALESCE($6, status),
         monthly_amount = COALESCE($7, monthly_amount), notes = COALESCE($8, notes),
         customer_id = COALESCE($9, customer_id),
         renewal_stage = COALESCE($10, renewal_stage), annual_value = COALESCE($11, annual_value),
         churn_reason = COALESCE($12, churn_reason), renewed_contract_id = COALESCE($13, renewed_contract_id),
         updated_at = NOW()
       WHERE id = $14 AND ${sf} = $15 RETURNING *`,
      [name, contract_type, start_date, end_date, renewal_notice_days, status, monthly_amount, notes, customer_id,
       renewal_stage, annual_value, churn_reason, renewed_contract_id, req.params.id, sv]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Contract not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update service contract' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const [sf, sv] = qs(req);
    const r = await pool.query(`DELETE FROM service_contracts WHERE id = $1 AND ${sf} = $2 RETURNING *`, [req.params.id, sv]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Contract not found' });
    res.json({ message: 'Contract deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete service contract' });
  }
});

module.exports = router;
