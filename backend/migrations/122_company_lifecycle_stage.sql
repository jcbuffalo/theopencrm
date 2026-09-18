-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Account lifecycle stage — migration 122.
--
-- Makes the ACCOUNT (a company) a first-class, lifecycle-managed object. This
-- is distinct from a DEAL stage: a deal moves through the sales pipeline
-- (LEAD → … → CLOSED_WON), while an ACCOUNT moves through the *relationship*
-- lifecycle (prospect → onboarding → active → at_risk → renewed → churned).
-- One customer/company has exactly one lifecycle_stage; it can own many deals.
--
-- Default 'active' so every existing customer row is immediately a live account
-- (the safest neutral bucket — a company already in the CRM is a relationship
-- you're managing, not a cold prospect). New prospects get set explicitly.
--
-- ALLOWED VALUES (enforced in the API layer, not a CHECK constraint, so the
-- allowlist can evolve without a migration): prospect, onboarding, active,
-- at_risk, renewed, churned. companyRoutes.js validates every write against
-- schemas/companies.LIFECYCLE_STAGES.
--
-- Index on (org_id, lifecycle_stage): the Accounts home filters/groups accounts
-- by lifecycle within an org, so this composite matches the access pattern.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS. The startup
-- runner hard-fails on 42P07 / 42710, so a bare ADD/CREATE without a guard would
-- crash-loop the deploy — do not remove the guards. `companies` is one of the
-- duplicate-table migrations' targets, so NEVER use a bare CREATE TABLE here.

BEGIN;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS lifecycle_stage VARCHAR(32) DEFAULT 'active';

CREATE INDEX IF NOT EXISTS idx_companies_org_lifecycle
  ON companies(org_id, lifecycle_stage);

COMMENT ON COLUMN companies.lifecycle_stage IS
  'Account relationship lifecycle (prospect|onboarding|active|at_risk|renewed|churned), distinct from deal stage. Validated in the API layer against schemas/companies.LIFECYCLE_STAGES. See migration 122.';

COMMIT;
