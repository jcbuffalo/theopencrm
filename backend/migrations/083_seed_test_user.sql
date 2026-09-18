-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Seed a test account for automated end-to-end testing (Playwright + manual).
--
-- WHY:
--   The owner / super_admin (johncolesassistant@gmail.com) has TOTP enabled,
--   which blocks the Playwright auth fixture because the test doesn't carry a
--   TOTP secret. We need an account that:
--     * has email + password (so curl + Playwright can log in without OAuth)
--     * has email_verified=TRUE (so the EMAIL_VERIFICATION_REQUIRED gate
--       doesn't lock it out)
--     * has two_factor_enabled=FALSE (so login is single-step)
--     * is org_role='admin' (so it can hit /admin/* routes that protect the
--       most-touched surfaces) but NOT super_admin (so cross-tenant tools
--       stay gated, keeping the test suite scoped to one org)
--     * is in the same org as the main demo data so it has rows to look at
--
-- CREDENTIALS:
--     email:    crm-tester@theopencrm.com
--     password: ROTATED — the original plaintext that used to live here has
--               been removed. The live password is now a random value stored
--               only in GCP Secret Manager (secret `crm-tester-password`) and
--               the `TEST_USER_PASSWORD` CI secret. See migration 084.
--
-- The bcrypt hash below is the ORIGINAL seed hash. It is superseded at runtime
-- by migration 084, which rotates password_hash to the Secret-Manager value.
-- This account is scoped to admin of ONE existing org with no super_admin
-- privileges and no cross-tenant access.
--
-- IDEMPOTENT: re-running is a no-op via WHERE NOT EXISTS.

BEGIN;

INSERT INTO users (
  email,
  name,
  password_hash,
  status,
  email_verified,
  org_id,
  org_role,
  two_factor_enabled,
  created_at,
  updated_at
)
SELECT
  'crm-tester@theopencrm.com',
  'Automation Tester',
  '$2a$12$2JhpSP6Je2xjquD.KLtXM.5SdYKndWsNUfvXo2kJKcdKjaNVjhLI6',
  'active',
  TRUE,
  (SELECT id FROM organizations ORDER BY id LIMIT 1),
  'admin',
  FALSE,
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM users WHERE LOWER(email) = 'crm-tester@theopencrm.com'
);

COMMIT;
