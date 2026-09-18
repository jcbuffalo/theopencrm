-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 156: Multiple pipelines per org via deal_type (spec 201).
--
-- An org can now run more than one sales motion: every deal carries a
-- `deal_type` (default 'default'), and each type MAY have its own `pipelines`
-- row. Resolution chain (services/pipelines.js getEffectivePipeline):
--
--   type row (deal_type = '<type>')  →  org default row (is_default = TRUE,
--   deal_type NULL, migration 155)   →  profile default (PROFILE_DEFAULTS)
--
-- SEED RULE — no rows are written and no values change here beyond the
-- column default: every existing deal becomes deal_type 'default' and every
-- existing pipeline row keeps deal_type NULL (= the org default pipeline),
-- so an org that never creates a second pipeline behaves exactly as today.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS only.
-- (deals was created by duplicate migrations 011/023 — ADD COLUMN IF NOT
-- EXISTS is mandatory here, per the CLAUDE.md gotcha.)

ALTER TABLE deals ADD COLUMN IF NOT EXISTS deal_type VARCHAR(40) NOT NULL DEFAULT 'default';
CREATE INDEX IF NOT EXISTS idx_deals_org_deal_type ON deals(org_id, deal_type);

-- NULL = the org's default pipeline row (migration 155). Non-NULL = the
-- pipeline for that deal type.
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS deal_type VARCHAR(40);

-- One pipeline per (org, type); the partial index tolerates the NULL default
-- row (which is already unique per org via ux_pipelines_org_default).
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipelines_org_deal_type
  ON pipelines(org_id, deal_type) WHERE deal_type IS NOT NULL;

COMMENT ON COLUMN deals.deal_type IS
  'Pipeline category. ''default'' = the org''s main pipeline. Tenant-extensible (application-validated): e.g. supply, candidate, partner.';
