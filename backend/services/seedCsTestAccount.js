// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Customer-Success e2e test-account seeder.
//
// PURPOSE: prod is Google-OAuth-primary (email verification required, no SMTP),
// which makes it hard to mint a *password-capable* account for Playwright @auth
// tests of the gated Customer-Success UI (/accounts/:id, /renewals). This seeder
// provisions exactly one such account — email+password, email-verified, in a
// `zang` org with `customer_success_enabled` — plus enough seed data that the
// Account-360 timeline and the Renewals board render with content.
//
// It runs ONCE on boot, and ONLY when CS_E2E_SEED=true. The password comes from
// CS_E2E_PASSWORD (env), never hardcoded. Fully idempotent — re-running ensures
// the account/data exist and refreshes the password to match the env.
//
// LIABILITY / SECURITY: this creates a REAL login-capable account. Treat its
// password as a secret, use a strong one, and UNSET CS_E2E_SEED + delete the
// account (its rows are tagged `[cs-e2e]`) once you're done validating. Never
// point this at a tenant that holds real customer data.
//
//   CS_E2E_SEED=true            — master switch (off by default)
//   CS_E2E_EMAIL=...            — login email (default cs-e2e@theopencrm.com)
//   CS_E2E_PASSWORD=...         — REQUIRED, min 10 chars; seeder skips if absent

const bcrypt = require('bcryptjs');
const pool = require('../db');
const logger = require('./logger');

const DEFAULT_EMAIL = 'cs-e2e@theopencrm.com';
const TAG = '[cs-e2e]';

async function ensureCsTestAccount() {
  if (process.env.CS_E2E_SEED !== 'true') {
    return { skipped: 'CS_E2E_SEED not set to true' };
  }
  const email = String(process.env.CS_E2E_EMAIL || DEFAULT_EMAIL).trim().toLowerCase();
  const password = process.env.CS_E2E_PASSWORD;
  if (!password || password.length < 10) {
    logger.warn('cs_e2e_seed_skipped', { reason: 'CS_E2E_PASSWORD missing or < 10 chars', email });
    return { skipped: 'CS_E2E_PASSWORD missing or too short' };
  }

  const passwordHash = await bcrypt.hash(password, 12);

  // ---- 1. Upsert the user (active + email-verified so it bypasses the
  //         Google-primary verification wall) ----------------------------------
  let userId;
  let orgId = null;
  const existing = await pool.query('SELECT id, org_id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    userId = existing.rows[0].id;
    orgId = existing.rows[0].org_id;
    await pool.query(
      `UPDATE users
          SET password_hash = $1, status = 'active', email_verified = TRUE,
              name = COALESCE(name, 'CS E2E Test'), updated_at = NOW()
        WHERE id = $2`,
      [passwordHash, userId]
    );
  } else {
    const ins = await pool.query(
      `INSERT INTO users (email, name, password_hash, status, email_verified, requested_at, created_at, updated_at)
       VALUES ($1, 'CS E2E Test', $2, 'active', TRUE, NOW(), NOW(), NOW())
       RETURNING id`,
      [email, passwordHash]
    );
    userId = ins.rows[0].id;
  }

  // ---- 2. Ensure the org: zang profile + customer_success_enabled ------------
  if (!orgId) {
    const orgIns = await pool.query(
      `INSERT INTO organizations (name, owner_user_id, profile, features)
       VALUES ('CS E2E Test Org', $1, 'zang', '{"customer_success_enabled": true}'::jsonb)
       RETURNING id`,
      [userId]
    );
    orgId = orgIns.rows[0].id;
    await pool.query(
      `UPDATE users SET org_id = $1, org_role = 'owner', updated_at = NOW() WHERE id = $2`,
      [orgId, userId]
    );
  } else {
    await pool.query(
      `UPDATE organizations
          SET profile = 'zang',
              features = jsonb_set(COALESCE(features, '{}'::jsonb), '{customer_success_enabled}', 'true', TRUE)
        WHERE id = $1`,
      [orgId]
    );
    await pool.query(
      `UPDATE users SET org_role = COALESCE(org_role, 'owner') WHERE id = $1`,
      [userId]
    );
  }

  // ---- 3. Seed CS data (idempotent via the [cs-e2e] note tag) ----------------
  // Company → the account whose 360 + renewals we exercise.
  let companyId;
  const co = await pool.query(
    `SELECT id FROM companies WHERE org_id = $1 AND notes LIKE '%[cs-e2e]%' ORDER BY id LIMIT 1`,
    [orgId]
  );
  if (co.rows.length > 0) {
    companyId = co.rows[0].id;
  } else {
    const coIns = await pool.query(
      `INSERT INTO companies (user_id, org_id, name, type, industry, status, notes, first_deal_at, last_deal_at)
       VALUES ($1, $2, 'Westvale Power & Light (CS E2E)', 'customer', 'Utility', 'active', '[cs-e2e] account',
               NOW() - INTERVAL '120 days', NOW() - INTERVAL '5 days')
       RETURNING id`,
      [userId, orgId]
    );
    companyId = coIns.rows[0].id;
  }

  // Deal + activity → gives the Account-360 timeline something to show.
  const dealSel = await pool.query(
    `SELECT id FROM deals WHERE org_id = $1 AND notes LIKE '%[cs-e2e]%' LIMIT 1`,
    [orgId]
  );
  if (dealSel.rows.length === 0) {
    const dealIns = await pool.query(
      `INSERT INTO deals (user_id, org_id, salesman_id, customer_id, company_id, title, description,
                          amount, stage, phase, notes, last_activity_at)
       VALUES ($1, $2, $1, $3, $3, 'UPS service retrofit (CS E2E)', '[cs-e2e]',
               75000, 'CUSTOMER_QUOTING', 'pre_sale', '[cs-e2e]', NOW() - INTERVAL '5 days')
       RETURNING id`,
      [userId, orgId, companyId]
    );
    await pool.query(
      `INSERT INTO activities (user_id, org_id, deal_id, type, title, description, activity_date, outcome)
       VALUES ($1, $2, $3, 'call', 'Renewal check-in (CS E2E)', '[cs-e2e] generated', NOW() - INTERVAL '5 days', 'Positive')`,
      [userId, orgId, dealIns.rows[0].id]
    );
  }

  // Two service contracts in different renewal stages → a non-empty Renewals
  // board + a 90-day-forecast entry.
  const scCount = await pool.query(
    `SELECT COUNT(*)::int AS n FROM service_contracts WHERE org_id = $1 AND notes LIKE '%[cs-e2e]%'`,
    [orgId]
  );
  if (scCount.rows[0].n === 0) {
    await pool.query(
      `INSERT INTO service_contracts
         (user_id, org_id, customer_id, name, contract_type, start_date, end_date, renewal_notice_days,
          status, monthly_amount, notes, renewal_stage, annual_value)
       VALUES ($1, $2, $3, 'UPS fleet service (CS E2E)', 'service', CURRENT_DATE - 300, CURRENT_DATE + 45, 60,
               'active', 1200, '[cs-e2e] sample', 'upcoming', 30000)`,
      [userId, orgId, companyId]
    );
    await pool.query(
      `INSERT INTO service_contracts
         (user_id, org_id, customer_id, name, contract_type, start_date, end_date, renewal_notice_days,
          status, monthly_amount, notes, renewal_stage, annual_value)
       VALUES ($1, $2, $3, 'Battery monitoring (CS E2E)', 'maintenance', CURRENT_DATE - 350, CURRENT_DATE + 20, 30,
               'active', 800, '[cs-e2e] sample', 'at_risk', 12000)`,
      [userId, orgId, companyId]
    );
  }

  logger.notice('cs_e2e_seed_complete', { email, orgId, companyId });
  return { email, orgId, companyId };
}

module.exports = { ensureCsTestAccount };
