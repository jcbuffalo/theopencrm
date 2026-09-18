-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 068 — saved_views table + nullable owner columns for bulk-assign
--
-- This migration covers two parity features:
--
-- (1) saved_views — per-user named tab presets on each list view
--     (Companies / Contacts / Deals / Tasks). filter_spec + sort_spec are
--     deliberately opaque JSONB so each page can stash whatever filter shape
--     it already uses without forcing a cross-page normalization layer.
--
-- (2) owner_id / assigned_to columns — the bulk-action UI exposes a "Change
--     owner" action; we add the columns nullable so existing rows are
--     unaffected and the bulk patch endpoint can write them. Indexed for the
--     "my records" filter that will follow once the UI surfaces it.
--
-- All blocks are wrapped in a single transaction. Every DDL uses IF NOT EXISTS
-- so re-running the migration is a no-op.

BEGIN;

-- ---------------------------------------------------------------------------
-- saved_views
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saved_views (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id       INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  resource     VARCHAR(32) NOT NULL,
  name         VARCHAR(80) NOT NULL,
  filter_spec  JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_spec    JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_default   BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_saved_views_user_resource
  ON saved_views(user_id, resource);

-- ---------------------------------------------------------------------------
-- Owner / assignee columns for the bulk-assign action
-- ---------------------------------------------------------------------------
ALTER TABLE companies ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE contacts  ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE tasks     ADD COLUMN IF NOT EXISTS assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_companies_owner_id ON companies(owner_id);
CREATE INDEX IF NOT EXISTS idx_contacts_owner_id  ON contacts(owner_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to  ON tasks(assigned_to);

COMMIT;
