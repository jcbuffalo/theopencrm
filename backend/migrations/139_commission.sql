-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 139 — Commission plans: per-rep (or org-default) commission rates + goals.
--
-- Backs the Commission & Goals report (services/commission.js +
-- routes/commissionRoutes.js, mounted at /api/commission behind
-- requireFeature('reports_enabled')). Each row is a *rate definition*, not a
-- result: commission is computed live at request time as
--   Σ(closed-won deal value in period, per rep) × applicable rate_pct
-- so nothing here is a cache.
--
-- Scoping mirrors sales_quotas (migration 116) exactly:
--   org_id   — primary tenant scope; user_id is the fallback for users with
--              no org (the qs(req) convention).
--   owner_id — the REP this plan applies to (references users.id). When NULL
--              the plan is the ORG DEFAULT: it applies to any rep who has no
--              rep-specific plan effective at a deal's close date.
--
--   rate_pct       — commission percentage, e.g. 5.00 = 5%. NUMERIC(5,2)
--                    allows up to 999.99 but the API layer clamps to 0–100.
--   goal_amount    — OPTIONAL per-period revenue goal for the rep (or the
--                    org default). Drives the attainment column on the
--                    commission report; NULL = no goal tracking.
--   effective_from — the date this plan takes effect. The service picks, per
--                    deal, the plan with the latest effective_from that is
--                    <= the deal's close date (rep-specific first, then org
--                    default), so historical closes keep their historical rate.
--
-- Index (org_id, owner_id): the report always ANDs the org scope with the rep
-- lookup, so the composite matches the access pattern. user_id + effective_from
-- get their own indexes for the fallback scope and the effective-date scan.
--
-- IDEMPOTENT: CREATE TABLE / INDEX IF NOT EXISTS so the startup runner's
-- 42P07/42710 "already exists" swallow never trips, and re-runs are no-ops.

BEGIN;

CREATE TABLE IF NOT EXISTS commission_plans (
  id             SERIAL PRIMARY KEY,
  org_id         INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
  owner_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  rate_pct       NUMERIC(5, 2) NOT NULL DEFAULT 0,
  goal_amount    DECIMAL(15, 2),
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_commission_plans_org_owner      ON commission_plans(org_id, owner_id);
CREATE INDEX IF NOT EXISTS idx_commission_plans_user_id        ON commission_plans(user_id);
CREATE INDEX IF NOT EXISTS idx_commission_plans_effective_from ON commission_plans(effective_from);

COMMENT ON TABLE commission_plans IS
  'Per-rep (owner_id) or org-default (owner_id IS NULL) commission rate + optional goal. Commission is computed live by services/commission.js — see migration 139.';
COMMENT ON COLUMN commission_plans.owner_id IS
  'The rep this plan applies to (users.id). NULL = org-default plan, used for reps with no rep-specific plan effective at a deal''s close date.';
COMMENT ON COLUMN commission_plans.rate_pct IS
  'Commission percentage (5.00 = 5%). API layer clamps to 0–100.';
COMMENT ON COLUMN commission_plans.effective_from IS
  'Plan takes effect on this date; per deal, the latest plan with effective_from <= the close date wins.';

COMMIT;
