-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 116 — Sales quotas: per-scope revenue targets for forecast attainment.
--
-- Backs the quota-tracking half of the sales-forecasting surface (services/
-- forecast.js + routes/forecastRoutes.js). Each row is a *target*, not a result:
-- attainment is computed live against the org's won/open deals at request time,
-- so nothing here is a cache.
--
-- Scoping mirrors every other tenant table: org_id is the primary scope, with
-- user_id as the fallback for users who have no org (the qs(req) convention).
-- owner_id is OPTIONAL — a per-salesperson quota (references users.id). When
-- null the quota is org-wide.
--
--   period_type  — 'month' | 'quarter' | 'year' (enforced by CHECK)
--   period_start — the first day of the quota window (a DATE); the service
--                  derives the exclusive end from period_type.
--   target_amount — the revenue goal for that window.
--
-- Idempotent (CREATE TABLE / INDEX IF NOT EXISTS) so the startup runner's
-- 42P07/42710 "already exists" swallow never trips, and re-runs are no-ops.

BEGIN;

CREATE TABLE IF NOT EXISTS sales_quotas (
  id            SERIAL PRIMARY KEY,
  org_id        INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  owner_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  period_type   VARCHAR(16) NOT NULL DEFAULT 'month'
                  CHECK (period_type IN ('month', 'quarter', 'year')),
  period_start  DATE NOT NULL,
  target_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sales_quotas_org_id       ON sales_quotas(org_id);
CREATE INDEX IF NOT EXISTS idx_sales_quotas_user_id      ON sales_quotas(user_id);
CREATE INDEX IF NOT EXISTS idx_sales_quotas_period_start ON sales_quotas(period_start);

COMMIT;
