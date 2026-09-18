-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Phase 1.2 — White-label generics + public IDs for external integrations
--
-- WHY: nothing in the schema should be named "zang." Add `external_ref` to
-- deals as the generic identifier (the Zang profile labels it "Zang #" via
-- the org branding override). Add `public_id uuid` to externally-referenced
-- entities so URLs and outbound integrations don't expose enumerable
-- BIGSERIAL IDs.
--
-- We do NOT swap primary keys — internal joins continue to use the existing
-- BIGSERIAL `id` column. `public_id` is for outbound use only.

-- Generic external reference number on deals (replaces vertical-specific names
-- like "zang_number" — none exists yet, but this column is what would catch
-- one if the Zang profile starts populating it).
ALTER TABLE deals ADD COLUMN IF NOT EXISTS external_ref VARCHAR(100);
CREATE INDEX IF NOT EXISTS idx_deals_external_ref ON deals(external_ref);

-- Public IDs for the four entities that get referenced externally:
-- companies (QuickBooks customer mappings), deals (kanban links sent in
-- email), quotes (signed PDF URLs, customer portals), and quotes' parent
-- relationships. We add invoices' public_id in migration 053.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS public_id UUID DEFAULT gen_random_uuid();
ALTER TABLE deals     ADD COLUMN IF NOT EXISTS public_id UUID DEFAULT gen_random_uuid();
ALTER TABLE quotes    ADD COLUMN IF NOT EXISTS public_id UUID DEFAULT gen_random_uuid();

-- Backfill any rows that pre-date the column. (DEFAULT only applies to new
-- inserts; existing rows have NULL until we update them.)
UPDATE companies SET public_id = gen_random_uuid() WHERE public_id IS NULL;
UPDATE deals     SET public_id = gen_random_uuid() WHERE public_id IS NULL;
UPDATE quotes    SET public_id = gen_random_uuid() WHERE public_id IS NULL;

-- Now make them required + unique now that everything has a value.
ALTER TABLE companies ALTER COLUMN public_id SET NOT NULL;
ALTER TABLE deals     ALTER COLUMN public_id SET NOT NULL;
ALTER TABLE quotes    ALTER COLUMN public_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_companies_public_id ON companies(public_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_deals_public_id     ON deals(public_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_quotes_public_id    ON quotes(public_id);

-- Per-company business fields the proposal added (and we agreed to adopt).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS source           VARCHAR(100);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tax_id           VARCHAR(50);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS taxable          BOOLEAN DEFAULT TRUE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS marketing_opt_in INTEGER DEFAULT 0;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS quickbooks_id    VARCHAR(100);

-- Per-contact role enum (proposal value). Free-text job_title stays as
-- supplemental data.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS contact_role VARCHAR(30)
  CHECK (contact_role IN ('buyer','decisionmaker','technical','operations','manager','other'));
