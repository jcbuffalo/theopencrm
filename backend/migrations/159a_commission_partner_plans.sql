-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 159a — Partner/channel commission plans (CMN item 1.5) on the migration-139
-- commission engine.
--
-- A plan is now either
--   kind = 'rep'     — the original model, byte-for-byte: owner_id points at
--                      the rep (NULL = org default). Every pre-159a row is
--                      a rep plan via the column default.
--   kind = 'partner' — a referral/channel fee owed to a COMPANY, not a user:
--                      partner_company_id points at the partner org (e.g. a
--                      dealer association) and owner_id stays NULL.
--
--   partner_company_id — the partner company this fee is paid to. ON DELETE
--                        CASCADE: deleting the company retires its fee plans.
--   source_filter      — optional channel matcher. Deals have NO built-in
--                        lead-source column, so this is matched (trimmed,
--                        case-insensitive) against the deal's custom-field
--                        convention: custom_fields.channel_source, falling
--                        back to .lead_source, then .source — see
--                        services/commission.js dealSource(). When NULL the
--                        plan attributes deals linked to the partner company
--                        directly (company_id / customer_id).
--
-- CRITICAL rate-resolution note: rep-plan resolution (applicablePlan) must
-- SKIP kind='partner' rows — a partner plan has owner_id NULL and would
-- otherwise masquerade as the org-default rep plan. services/commission.js
-- does exactly that; the rep report is unchanged.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS) — the
-- startup runner hard-fails on any error, so re-runs must be no-ops.

BEGIN;

ALTER TABLE commission_plans
  ADD COLUMN IF NOT EXISTS kind               VARCHAR(10) NOT NULL DEFAULT 'rep',
  ADD COLUMN IF NOT EXISTS partner_company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS source_filter      VARCHAR(80);

CREATE INDEX IF NOT EXISTS idx_commission_plans_partner
  ON commission_plans(org_id, partner_company_id) WHERE partner_company_id IS NOT NULL;

COMMENT ON COLUMN commission_plans.kind IS
  '''rep'' (owner_id-based, the migration-139 model — all pre-159a rows) or ''partner'' (fee to partner_company_id). App-validated.';
COMMENT ON COLUMN commission_plans.partner_company_id IS
  'kind=''partner'' only: the company the referral/channel fee is owed to (e.g. a dealer association).';
COMMENT ON COLUMN commission_plans.source_filter IS
  'kind=''partner'' only, optional: matched case-insensitively against the deal''s custom_fields.channel_source / .lead_source / .source. NULL = attribute deals linked to the partner company directly.';

COMMIT;
