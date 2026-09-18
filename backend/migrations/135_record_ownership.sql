-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Record ownership — migration 135.
--
-- Adds an explicit RECORD OWNER to companies and deals, mirroring the
-- contacts.owner_user_id pattern from migration 125 (contacts already have
-- the column, so they are deliberately NOT touched here). The owner is "the
-- person on the team responsible for this record" — it powers the ?owner=me
-- ("My records") list filter on Companies and Deals and the owner picker on
-- the company form / deal panel.
--
-- Deliberately distinct from the older columns that sound similar:
--   * companies.owner_id  (migration 068) — the bulk-action "assign" column
--     surfaced by the bulk bar. Left untouched for back-compat.
--   * deals.salesman_id   — the selling rep on the deal (a Zang workflow
--     concept), not necessarily who owns the CRM record.
--
-- NO foreign key: matches contacts.owner_user_id (125), which is also a bare
-- INTEGER. API-layer validation (services/recordOwnership.js) enforces that
-- the owner is a member of the record's org on every write, which is the
-- actual tenancy guarantee we care about.
--
-- Indexes on (org_id, owner_user_id): the "My records" filter always ANDs the
-- org scope with the owner, so the composite matches the access pattern.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS. The
-- startup runner hard-fails on 42P07 / 42710, so a bare ADD/CREATE without a
-- guard would crash-loop the deploy — do not remove the guards. `deals` is one
-- of the duplicate-table migrations' targets (011/023), so NEVER use a bare
-- CREATE TABLE here.

BEGIN;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS owner_user_id INTEGER;
ALTER TABLE deals     ADD COLUMN IF NOT EXISTS owner_user_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_companies_org_owner ON companies(org_id, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_deals_org_owner     ON deals(org_id, owner_user_id);

COMMENT ON COLUMN companies.owner_user_id IS
  'Record owner (team member responsible for this account). In-org membership validated in the API layer (services/recordOwnership.js). Powers ?owner=me. See migration 135.';
COMMENT ON COLUMN deals.owner_user_id IS
  'Record owner (team member responsible for this deal) — distinct from salesman_id, the selling rep. In-org membership validated in the API layer. Powers ?owner=me. See migration 135.';

COMMIT;
