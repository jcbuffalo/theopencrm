-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 111 — Custom report builder: persisted report definitions.
--
-- Backs the ad-hoc report builder (services/reportBuilder.js + routes/
-- reportBuilderRoutes.js). Each row stores a *definition*, not results: the
-- `config` JSONB holds { filters, group_by, group_by_granularity, metric,
-- chart_type } exactly as the run engine validates it. Runs are computed live
-- against the org's data, so nothing here is a cache.
--
-- Scoping mirrors every other tenant table: org_id is the primary scope, with
-- user_id as the fallback for users who have no org (the qs(req) convention).
-- created_by records the actor (who saved it) independent of the scope owner.
--
-- Idempotent (CREATE TABLE / INDEX IF NOT EXISTS) so the startup runner's
-- 42P07/42710 "already exists" swallow never trips, and re-runs are no-ops.

BEGIN;

CREATE TABLE IF NOT EXISTS saved_reports (
  id          SERIAL PRIMARY KEY,
  org_id      INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name        VARCHAR(120) NOT NULL,
  entity      VARCHAR(32)  NOT NULL,
  config      JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_saved_reports_org_id  ON saved_reports(org_id);
CREATE INDEX IF NOT EXISTS idx_saved_reports_user_id ON saved_reports(user_id);

COMMIT;
