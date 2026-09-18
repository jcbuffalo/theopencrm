-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 073 — saved_views: cross-org sharing, drag-to-reorder ordering, and a
-- one-time backfill of the legacy `saved_filters` table into `saved_views`.
--
-- Background:
--   Migration 068 introduced `saved_views` (per-user named filter/sort presets
--   rendered as tabs above each list page). It deliberately left out:
--     * cross-org sharing — `is_shared` flag so a user can publish a view to
--       the whole org without surrendering ownership
--     * an explicit ordering column — v1 sorted by `is_default DESC, LOWER(name)`,
--       which makes drag-to-reorder impossible
--   This migration adds both.
--
--   Migration 046 created `saved_filters` (scope/name/filters JSONB) used by the
--   Deals page filter sidebar pre-068. We never tore it down. This migration
--   does a one-shot idempotent backfill from `saved_filters` → `saved_views`
--   so the new tab-strip UI sees the legacy presets. We do NOT drop the old
--   table here — that's a follow-up after we've confirmed in prod that no
--   legacy reads remain.
--
-- All blocks are wrapped in a single transaction. The two ALTERs use
-- IF NOT EXISTS so re-running is a no-op. The backfill INSERT uses a
-- NOT EXISTS guard so re-running won't duplicate rows.
--
-- Note on `saved_filters` existence: migration 046 always runs before this
-- one (the migrate.js runner orders by filename) and uses CREATE TABLE IF
-- NOT EXISTS, so the table is guaranteed to exist in any environment that
-- reaches this migration. A fresh DB will simply find zero rows to backfill.

BEGIN;

-- ---------------------------------------------------------------------------
-- (1) Schema additions
-- ---------------------------------------------------------------------------

ALTER TABLE saved_views
  ADD COLUMN IF NOT EXISTS is_shared      BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE saved_views
  ADD COLUMN IF NOT EXISTS display_order  INT     NOT NULL DEFAULT 0;

-- Speeds up the "shared views visible to this org" half of the new
-- LIST query in savedViewsRoutes.GET '/'.
CREATE INDEX IF NOT EXISTS idx_saved_views_org_shared
  ON saved_views(org_id, resource) WHERE is_shared = TRUE;

-- ---------------------------------------------------------------------------
-- (2) One-time backfill: saved_filters → saved_views
-- ---------------------------------------------------------------------------
-- Mapping:
--   saved_filters.scope     → saved_views.resource     ('deals' for all legacy rows)
--   saved_filters.name      → saved_views.name         (truncated to 80 chars)
--   saved_filters.filters   → saved_views.filter_spec
--   (no legacy sort)        → saved_views.sort_spec    ('{}'::jsonb)
--   saved_filters.user_id   → saved_views.user_id
--   saved_filters.org_id    → saved_views.org_id
--   saved_filters.id        → saved_views.display_order (preserves legacy order)
--   FALSE                   → saved_views.is_shared
--
-- The NOT EXISTS subquery prevents duplicates on re-runs and also lets a user
-- pre-create a view of the same name without us clobbering it.

INSERT INTO saved_views
  (user_id, org_id, resource, name, filter_spec, sort_spec, is_default, is_shared, display_order, created_at)
SELECT
  sf.user_id,
  sf.org_id,
  'deals'                         AS resource,
  LEFT(sf.name, 80)               AS name,
  sf.filters                      AS filter_spec,
  '{}'::jsonb                     AS sort_spec,
  FALSE                           AS is_default,
  FALSE                           AS is_shared,
  sf.id                           AS display_order,
  sf.created_at                   AS created_at
FROM saved_filters sf
WHERE NOT EXISTS (
        SELECT 1 FROM saved_views sv
         WHERE sv.user_id  = sf.user_id
           AND sv.resource = 'deals'
           AND sv.name     = LEFT(sf.name, 80)
      );

-- Dropped in 079 (2026-05-15). filterRoutes.js now reads/writes saved_views
-- exclusively; the legacy table is gone.

COMMIT;
