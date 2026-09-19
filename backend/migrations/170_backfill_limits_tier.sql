-- 170_backfill_limits_tier.sql
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Arm the free-tier caps on legacy free orgs. Since 2026-09-14 every new
-- self-serve org is created with limits_tier='free' (routes/authRoutes.js,
-- routes/accessRequestRoutes.js) and the Stripe webhook keeps limits_tier in
-- step with the purchased tier (routes/billingRoutes.js). Orgs created before
-- that still carry the migration-136 NULL, which services/tierLimits.js treats
-- as UNLIMITED — so a pre-2026-09-14 free org never sees the upgrade prompt a
-- new one does. Bring them onto the same footing.
--
-- Deliberately narrow: only orgs that are on the free plan AND have no billing
-- relationship. Comped / active / trial orgs are exempt in tierLimits.js anyway,
-- but leaving their limits_tier NULL keeps the row honest about what was set.
--
-- Idempotent: a second run matches zero rows.

UPDATE organizations
   SET limits_tier = 'free',
       updated_at  = CURRENT_TIMESTAMP
 WHERE limits_tier IS NULL
   AND COALESCE(tier, 'free') = 'free'
   AND COALESCE(ai_billing_status, 'unconfigured') NOT IN ('comped', 'active', 'trial');
