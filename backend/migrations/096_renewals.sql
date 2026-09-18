-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Customer Success — CS-3 (renewals pipeline), migration 096.
--
-- Extends service_contracts (created in migration 046) with the columns the
-- renewals Kanban + forecast need. The base table already carries end_date,
-- renewal_notice_days, status, monthly_amount, and deal_id; this migration
-- adds the renewal-lifecycle fields on top.
--
--   renewal_stage      — Kanban column: 'upcoming' | 'at_risk' | 'renewed'
--                        | 'churned'. Defaults to 'upcoming'. The automation
--                        renewal rule flips it to 'at_risk' when the renewal
--                        window opens with no recent activity.
--   annual_value       — explicit annual contract value for forecasting. Do
--                        NOT proxy monthly_amount * 12 — annual / multi-year
--                        contracts price differently; this is the real number.
--   churn_reason       — free-text reason captured when a contract is moved
--                        to 'churned'.
--   renewed_contract_id — self-FK-style pointer to the successor contract row
--                        created on renewal, so the chain is traceable.
--
-- DUPLICATE-TABLE NOTE: service_contracts is NOT one of the duplicate-table
-- offenders (contacts/deals/activities), but we still use ADD COLUMN IF NOT
-- EXISTS so re-running the migration is a no-op.
--
-- IDEMPOTENT: re-running this file is a no-op.

BEGIN;

ALTER TABLE service_contracts ADD COLUMN IF NOT EXISTS renewal_stage VARCHAR(20) DEFAULT 'upcoming';
ALTER TABLE service_contracts ADD COLUMN IF NOT EXISTS annual_value NUMERIC(15, 2);
ALTER TABLE service_contracts ADD COLUMN IF NOT EXISTS churn_reason TEXT;
ALTER TABLE service_contracts ADD COLUMN IF NOT EXISTS renewed_contract_id INTEGER REFERENCES service_contracts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_service_contracts_renewal_stage
  ON service_contracts(renewal_stage);

COMMIT;
