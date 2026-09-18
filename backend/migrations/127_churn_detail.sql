-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Churn detail — migration 127.
--
-- Completes the account-lifecycle loop started in migration 122: WHEN an
-- account churned (`churned_at`) and WHY (`churned_reason`). Both are stamped
-- by the PATCH /:id/lifecycle-stage handler when an account moves INTO
-- 'churned', and cleared when it moves back out (a re-engaged account is a
-- live relationship again — stale churn detail on an active account would be
-- misleading on every surface that renders it).
--
-- `churned_reason` is TEXT but API-validated against the CHURN_REASONS
-- allowlist in schemas/companies.js (same pattern as lifecycle_stage itself:
-- no CHECK constraint, so the allowlist can evolve without a migration).
--
-- Index on (org_id, churned_at): the Win-back board lists an org's churned
-- accounts most-recent-first, and the summary counts churn inside a rolling
-- window — both filter by org and order/range on churned_at.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS. The
-- startup runner hard-fails on 42P07 / 42710, so a bare ADD/CREATE without a
-- guard would crash-loop the deploy — do not remove the guards. `companies`
-- is a duplicate-table-migration target, so NEVER use a bare CREATE TABLE here.

BEGIN;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS churned_reason TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS churned_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_companies_org_churned_at
  ON companies(org_id, churned_at);

COMMENT ON COLUMN companies.churned_reason IS
  'Why the account churned. Validated in the API layer against schemas/companies.CHURN_REASONS; stamped on the churned lifecycle transition, cleared when the account leaves churned. See migration 127.';
COMMENT ON COLUMN companies.churned_at IS
  'When the account entered the churned lifecycle stage. Cleared when it moves back out. Powers the /api/winback board ordering + 90-day churn window. See migration 127.';

COMMIT;
