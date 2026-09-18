-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Per-user customizable dashboard layouts — migration 142.
--
-- The /dashboard page moves from a FIXED layout to a per-USER composition of
-- widgets. Each user gets at most ONE saved layout (UNIQUE on user_id — a user
-- belongs to at most one org, so user_id alone identifies the row and lets the
-- API upsert with ON CONFLICT (user_id)). org_id is carried for tenant scoping
-- / analytics, with the usual user_id fallback for org-less users.
--
-- layout is an ORDERED JSONB array of { "widgetKey": "...", "size": "half"|"full" }.
-- It stays opaque JSONB (same rationale as saved_views.filter_spec, migration
-- 068): widget composition evolves faster than we want to migrate. The
-- widgetKey allowlist is enforced in the API layer against
-- services/dashboardWidgets.js WIDGETS — NOT a CHECK constraint — so new
-- widgets ship without a migration. Users with NO row get the code-level
-- DEFAULT_LAYOUT; an empty-array row is a legitimate "I removed everything".
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS. The
-- startup runner hard-fails on 42P07 / 42710, so a bare CREATE without a guard
-- would crash-loop the deploy — do not remove the guards. `user_dashboards` is
-- a brand-new table (not one of the duplicate-table migrations' targets), so
-- CREATE TABLE IF NOT EXISTS is safe here.

BEGIN;

CREATE TABLE IF NOT EXISTS user_dashboards (
  id SERIAL PRIMARY KEY,
  org_id INTEGER,
  user_id INTEGER NOT NULL UNIQUE,
  layout JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Reads are WHERE user_id = $1 AND <scope> = $2; the UNIQUE(user_id) backing
-- index already covers the user half. This index serves org-side lookups
-- (admin/analytics sweeps over a tenant's layouts).
CREATE INDEX IF NOT EXISTS idx_user_dashboards_org ON user_dashboards(org_id);

COMMENT ON TABLE user_dashboards IS
  'One customizable dashboard layout per user (UNIQUE user_id). layout = ordered JSONB [{widgetKey, size}]; widgetKey allowlist enforced in the API layer against services/dashboardWidgets.js. See migration 142.';

COMMIT;
