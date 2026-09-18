-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Leads — migration 130.
--
-- A LEAD is a pre-qualification record: someone who raised a hand (web form,
-- referral, import, manual entry) but hasn't yet earned a place in the real
-- CRM graph. Keeping leads in their own table (instead of overloading
-- contacts with a "lead" status) keeps the contacts list clean for the
-- relationship-management surfaces and gives the recruiting/qualifying motion
-- its own board.
--
-- LIFECYCLE (enforced in the API layer, not a CHECK constraint, so the
-- allowlist can evolve without a migration):
--   new → working → qualified → converted
--                 ↘ unqualified
-- 'converted' is terminal and stamped exclusively by the convert endpoint,
-- which creates a contacts row (and optionally a deals row) in the same
-- transaction and records the created ids in converted_contact_id /
-- converted_deal_id so the board can deep-link to what the lead became.
--
-- TENANCY: org_id with the standard user_id fallback for org-less personal
-- workspaces — same qs(req) convention as every other tenant table. Both are
-- nullable at the column level because exactly one of the two is meaningful
-- per row; routes always stamp user_id and org_id-when-present, mirroring
-- contacts/deals.
--
-- owner_user_id: the org member working the lead. Round-robin assignment
-- (services/leads.js assignRoundRobin) picks the member whose most recent
-- lead assignment is oldest, so new public-form submissions spread evenly.
-- No FK on owner_user_id → users deliberately: a removed member must not
-- block their historical leads (same looseness as deals.salesman_id).
--
-- INDEXES match the access patterns: the status board groups by (org, status),
-- the list view sorts newest-first within an org, and the capture endpoint's
-- duplicate-peek looks up (org, email).
--
-- IDEMPOTENT: CREATE TABLE/INDEX IF NOT EXISTS. The startup runner hard-fails
-- on 42P07/42710, so unguarded DDL would crash-loop the deploy.

BEGIN;

CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  email VARCHAR(254),
  phone VARCHAR(50),
  company_name VARCHAR(200),
  title VARCHAR(200),
  source VARCHAR(64),
  status VARCHAR(16) NOT NULL DEFAULT 'new',
  owner_user_id INTEGER,
  notes TEXT,
  converted_contact_id INTEGER,
  converted_deal_id INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_leads_org_status      ON leads(org_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_org_created_at  ON leads(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_org_email       ON leads(org_id, email);
-- user_id-scoped (org-less) workspaces filter by user_id alone.
CREATE INDEX IF NOT EXISTS idx_leads_user_id         ON leads(user_id);

COMMENT ON TABLE leads IS
  'Pre-qualification lead records (new|working|qualified|unqualified|converted). Status allowlist lives in services/leads.js; convert stamps converted_contact_id/_deal_id transactionally. See migration 130.';

COMMIT;
