-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 155: Per-org editable pipeline stages (wave 2, workstream G).
--
-- Until now `deals.stage` was validated against a hardcoded per-profile enum
-- (utils/dealStages.js) and the Kanban read its columns from
-- frontend/src/stages.js. The `pipelines` table (026) existed but nothing
-- consumed it — its `stages VARCHAR[]` column only holds bare slugs.
--
-- This migration turns `pipelines` into the home of ONE default pipeline per
-- org with a rich, ordered stage definition:
--
--   stage_defs JSONB — [{ id, label, desc, tone, phase, is_won, is_lost,
--                         probability }, ...]  (order = column order)
--   is_default       — the org's effective pipeline (at most one per org,
--                      enforced by the partial unique index below)
--   profile          — the org profile the pipeline was authored under, so a
--                      later profile switch can be detected
--   created_by / updated_by — actor columns that survive user deletion
--
-- SEED RULE — no rows are written here. An org with NO default row keeps
-- exactly the profile default it has today (services/pipelines.js
-- PROFILE_DEFAULTS mirrors frontend/src/stages.js); only editing creates a
-- row. Nothing changes for existing orgs.
--
-- user_id loses NOT NULL: the legacy FK is ON DELETE CASCADE, and an org's
-- pipeline must not vanish when the person who saved it leaves. Org-default
-- rows are written with user_id NULL and created_by/updated_by set instead.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS; the
-- DROP NOT NULL is a no-op when already nullable.

ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS stage_defs JSONB;
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS profile VARCHAR(32);
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE pipelines ALTER COLUMN user_id DROP NOT NULL;

-- At most one default pipeline per org.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pipelines_org_default
  ON pipelines (org_id) WHERE is_default = TRUE AND org_id IS NOT NULL;
