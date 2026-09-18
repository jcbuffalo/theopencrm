-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Relationship Segments — migration 126.
--
-- A segment is a SAVED, DYNAMIC cohort of companies or contacts ("active
-- accounts in manufacturing we haven't touched in 45 days"). The membership is
-- never materialized: `criteria` is a JSONB array of {field, op, value} rows
-- that services/segments.js compiles — against a strict allowlist, fully
-- parameterized — into an org-scoped WHERE clause at read time. That keeps
-- segments live (a company that changes lifecycle_stage moves cohorts
-- instantly) and keeps this table tiny.
--
-- Columns:
--   • org_id / user_id — standard tenancy pair. org_id for org members,
--     user_id fallback for personal workspaces (qs(req) convention). Both
--     nullable at the DDL level; the API always writes user_id and writes
--     org_id when the caller has one.
--   • entity_type — 'company' | 'contact'. Enforced in the API layer (and by
--     the criteria compiler, which only knows those two entities), not a CHECK
--     constraint, so the allowlist can grow without a migration.
--   • criteria — JSONB array of {field, op, value}. NEVER trusted raw: every
--     read path goes through the compiler's allowlist. Rows saved before a
--     field is removed from the allowlist simply start failing compile → 400,
--     never raw SQL.
--   • created_by — who built it (distinct from user_id, which is tenancy).
--
-- Index on (org_id, entity_type): the Segments home lists an org's segments
-- filtered by entity type — matches the access pattern. A user_id index covers
-- the personal-workspace fallback path.
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS. The
-- startup runner hard-fails on 42P07 / 42710, so a bare CREATE without a guard
-- would crash-loop the deploy — do not remove the guards.

BEGIN;

CREATE TABLE IF NOT EXISTS segments (
  id SERIAL PRIMARY KEY,
  org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  entity_type VARCHAR(16) NOT NULL DEFAULT 'company',
  criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_segments_org_entity ON segments(org_id, entity_type);
CREATE INDEX IF NOT EXISTS idx_segments_user_id ON segments(user_id);

COMMENT ON TABLE segments IS
  'Saved dynamic cohorts of companies/contacts. criteria JSONB is compiled through the strict allowlist in services/segments.js — never interpolated into SQL. See migration 126.';

COMMIT;
