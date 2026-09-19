-- 171_workspace_templates.sql
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Saved, shareable workspace templates (spec 203, Phase 2). A template is a
-- STRUCTURAL snapshot of how a workspace is configured — pipeline stages,
-- custom-field definitions, automation rules, shared saved views — stored in
-- the same JSON shape the first-run planner consumes (services/
-- onboardingPlanner.js assemblePlan), so cloning one is the planner's
-- deterministic validate-and-propose step with NO AI call, applied through the
-- same confirm-first writer as everything else.
--
-- Never record data: no companies, contacts, deals, ids, or user references
-- are stored in `config`. org_id NULL = platform-authored (the public
-- starting gallery); an org's own templates are private unless is_public.
--
-- Idempotent: safe to re-run (CREATE TABLE/INDEX IF NOT EXISTS pattern).

CREATE TABLE IF NOT EXISTS workspace_templates (
  id           SERIAL PRIMARY KEY,
  org_id       INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  slug         VARCHAR(60)  NOT NULL,
  name         VARCHAR(120) NOT NULL,
  tagline      VARCHAR(200),
  vertical     VARCHAR(60),
  description  TEXT,
  config       JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_public    BOOLEAN NOT NULL DEFAULT FALSE,
  use_count    INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One slug per org; platform templates (org_id NULL) share one namespace.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_templates_org_slug
  ON workspace_templates (COALESCE(org_id, 0), slug);

CREATE INDEX IF NOT EXISTS idx_workspace_templates_public
  ON workspace_templates (is_public) WHERE is_public = TRUE;

CREATE INDEX IF NOT EXISTS idx_workspace_templates_org
  ON workspace_templates (org_id);
