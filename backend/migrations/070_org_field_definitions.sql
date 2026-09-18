-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 070 — Per-org custom-field definitions + JSONB extension stores
--
-- The architectural moat for "Claude-authored org customizations" (the
-- COMPETITIVE_REVIEW.md Differentiation Bet #2). The rule, restated so future
-- editors don't forget it:
--
--   * Customizations NEVER run DDL on shared tables.
--   * Every first-class entity (companies / contacts / deals / tasks) gets a
--     `custom_fields JSONB` extension store, defaulting to '{}'.
--   * The shape of those JSONB keys is described per-org in this table.
--
-- That means an admin asking Claude "add a commission_tier field" results in:
--   (a) an INSERT into org_field_definitions, NOT an ALTER TABLE.
--   (b) the UI auto-rendering the new field for that org only.
--
-- Cross-tenant blast radius from a bad proposal is bounded to the rows of one
-- org_id. Schema sprawl is bounded to one well-typed table.
--
-- Idempotent: every block uses IF NOT EXISTS, wrapped in a single transaction
-- so partial failure rolls back cleanly.

BEGIN;

-- ---------------------------------------------------------------------------
-- org_field_definitions — the registry of customizations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_field_definitions (
  id          BIGSERIAL PRIMARY KEY,
  org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity      VARCHAR(32) NOT NULL CHECK (entity IN ('companies', 'contacts', 'deals', 'tasks')),
  name        VARCHAR(60) NOT NULL,
  label       VARCHAR(120),
  type        VARCHAR(20) NOT NULL CHECK (type IN ('text', 'number', 'date', 'select', 'multiselect', 'boolean')),
  options     JSONB NOT NULL DEFAULT '[]'::jsonb,
  required    BOOLEAN NOT NULL DEFAULT FALSE,
  position    INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, entity, name)
);

CREATE INDEX IF NOT EXISTS idx_org_field_definitions_org_entity
  ON org_field_definitions(org_id, entity);

-- ---------------------------------------------------------------------------
-- custom_fields JSONB on each first-class entity
-- ---------------------------------------------------------------------------
-- NOT NULL DEFAULT '{}' so every read returns a usable object — callers never
-- have to coalesce. JSONB (not JSON) so we can GIN-index and query by key.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE contacts  ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE deals     ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tasks     ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;

-- GIN indexes power "where custom_fields ? 'commission_tier'" filters at scale.
-- Use jsonb_path_ops if we move to deep-key queries; default jsonb_ops is
-- adequate for the existence/containment queries the filter UI emits today.
CREATE INDEX IF NOT EXISTS idx_companies_custom_fields_gin ON companies USING GIN (custom_fields);
CREATE INDEX IF NOT EXISTS idx_contacts_custom_fields_gin  ON contacts  USING GIN (custom_fields);
CREATE INDEX IF NOT EXISTS idx_deals_custom_fields_gin     ON deals     USING GIN (custom_fields);
CREATE INDEX IF NOT EXISTS idx_tasks_custom_fields_gin     ON tasks     USING GIN (custom_fields);

COMMIT;
