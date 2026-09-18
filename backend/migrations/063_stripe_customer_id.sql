-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Stripe billing scaffolding: link organizations to Stripe customers so
-- subscription webhooks can update the right org's tier.
--
-- The tier column already exists from migration 061; this just adds the
-- Stripe customer reference. Set by the checkout.session.completed
-- webhook handler when the first upgrade lands.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_organizations_stripe_customer_id
  ON organizations(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
