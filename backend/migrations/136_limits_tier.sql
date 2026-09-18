-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Tier & seat enforcement (inert-by-default) — organizations.limits_tier.
--
-- WHY A NEW COLUMN instead of reusing organizations.tier (migration 061):
-- `tier` is NOT NULL DEFAULT 'free'. Every org created after 061's one-time
-- 'pro' backfill — including live paying / comped orgs — reads as 'free', so
-- keying seat/record caps off that column would instantly cap real production
-- orgs the moment enforcement ships. That is exactly the outage this feature
-- must not cause.
--
-- `limits_tier` is nullable with NO default and NO backfill:
--   NULL          → no tier explicitly assigned → UNLIMITED (fail-open).
--   'free' etc.   → the caps in backend/services/tierLimits.js apply, and
--                   only after the comped / paid / super-admin exemptions.
--
-- Enforcement is therefore completely inert on deploy: nothing sets this
-- column yet, so no existing org (the first customer org, owner workspace id=1, or
-- any other) can be blocked until a super-admin explicitly assigns a capped
-- tier to a specific org.
--
-- Values are validated in application code (tierLimits.js treats any unknown
-- value as UNLIMITED) rather than a CHECK constraint, so adding a tier never
-- needs a migration.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS limits_tier VARCHAR(16) DEFAULT NULL;
