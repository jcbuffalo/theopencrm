-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Support Cases — migration 134 (CS-5).
--
-- A CASE is a post-sale support request raised by (or on behalf of) a customer:
-- "invoice portal is down", "need a replacement part", "training question".
-- Distinct from an ISSUE (an internal workflow blocker attached to a deal /
-- quote) — a case is the customer-facing service ticket, owned by the
-- customer-success motion, and it feeds the Account 360 timeline.
--
-- LIFECYCLE (allowlist enforced in the API layer — schemas/cases.js — so it
-- can evolve without a migration): open → pending → resolved → closed, with
-- reopening allowed (resolved/closed → open|pending clears resolved_at).
-- resolved_at is stamped by caseRoutes.js when status enters resolved/closed.
--
-- PRIORITY: low | normal | high | urgent (same API-layer allowlist).
--
-- TENANCY: org_id with the standard user_id fallback for org-less personal
-- workspaces — same qs(req) convention as every other tenant table.
--
-- company_id is NULLABLE ON PURPOSE: a case can be logged before it's linked
-- to an account (e.g. an inbound email from an unrecognized address), then
-- attached later. ON DELETE SET NULL so removing a company never destroys its
-- support history. owner_user_id has NO FK deliberately — a removed member
-- must not block their historical cases (same looseness as leads.owner_user_id).
--
-- INDEXES match the access patterns:
--   (org_id, status)     — the Cases board groups/filters by status per org
--   (org_id, company_id) — the Account 360 pulls one company's cases
--   (org_id, sla_due_at) PARTIAL over still-open rows — the SLA-breach scan
--     (automation rule case_sla_breach + "sort by SLA" list) only ever looks
--     at unresolved cases, so the partial keeps the index tiny and hot.
--
-- IDEMPOTENT: CREATE TABLE/INDEX IF NOT EXISTS. The startup runner hard-fails
-- on 42P07/42710, so unguarded DDL would crash-loop the deploy.

BEGIN;

CREATE TABLE IF NOT EXISTS cases (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  subject VARCHAR(500) NOT NULL,
  description TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  priority VARCHAR(8) NOT NULL DEFAULT 'normal',
  owner_user_id INTEGER,
  sla_due_at TIMESTAMP NULL,
  resolved_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cases_org_status  ON cases(org_id, status);
CREATE INDEX IF NOT EXISTS idx_cases_org_company ON cases(org_id, company_id);
CREATE INDEX IF NOT EXISTS idx_cases_org_sla_open ON cases(org_id, sla_due_at)
  WHERE status NOT IN ('resolved', 'closed');
-- user_id-scoped (org-less) workspaces filter by user_id alone.
CREATE INDEX IF NOT EXISTS idx_cases_user_id ON cases(user_id);

COMMENT ON TABLE cases IS
  'Customer support cases (open|pending|resolved|closed; priority low|normal|high|urgent). Allowlists live in schemas/cases.js; resolved_at stamped/cleared by caseRoutes.js on status transitions. Feeds the Account 360 timeline. See migration 134.';

COMMIT;
