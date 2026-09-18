-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- ============================================================================
-- AI Pay-as-you-go Billing (Stripe metered product prod_Uj9hvCriplpPrA).
-- ============================================================================
-- Adds per-org status columns that gate any /api/ai or /api/plugins request
-- through the new middleware/requireAiBilling.js. Read by:
--   - middleware/requireAiBilling.js    — block / allow decision
--   - routes/billingRoutes.js           — /api/billing/ai/* CRUD
--   - services/aiThresholdWorker.js     — hourly $50 threshold notifier
--
-- Status state machine (text values are case-sensitive):
--   unconfigured  — BLOCK. Org has never started a pay-as-you-go subscription.
--   trial         — ALLOW until ai_billing_trial_ends_at.
--   active        — ALLOW. Stripe subscription is healthy.
--   past_due      — ALLOW for 7 days from updated_at, then BLOCK.
--   halted        — BLOCK. Admin or threshold-worker turned it off.
--   comped        — ALLOW with no Stripe involvement (super-admin manual grant
--                   for early customers, e.g. Northwind).
--
-- ai_monthly_threshold_usd: when the admin notifier fires. Default $50 per
-- owner spec. Manual halt only — never auto-halt (per owner).
--
-- All columns use ADD COLUMN IF NOT EXISTS so a re-run is a no-op even if a
-- prior migration in some branch added a subset of these.
-- ============================================================================

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS ai_billing_status TEXT NOT NULL DEFAULT 'unconfigured';

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS ai_billing_subscription_id TEXT;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS ai_billing_trial_ends_at TIMESTAMPTZ;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS ai_monthly_threshold_usd NUMERIC(10,2) NOT NULL DEFAULT 50.00;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS ai_threshold_last_warned_period TEXT;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS ai_halted_at TIMESTAMPTZ;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS ai_halted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS ai_halted_reason TEXT;

-- Status is read on every gated /api/ai request — small but hot.
CREATE INDEX IF NOT EXISTS idx_organizations_ai_billing_status
  ON organizations (ai_billing_status);
