-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Phase 2.1 — Per-org feature flags (multi-tenant manageable)
--
-- WHY: new domain entities (RFQ, PO, Invoice, Allocation) ship behind a
-- feature flag so we can roll them out per-customer rather than for every
-- org at once. The Zang org gets phase2_entities=true at deploy; other orgs
-- continue to see the v1 surface only until their admin flips it (or we do
-- so on their behalf via the admin route).
--
-- Convention: features is a flat JSONB object of { flagName: boolean }.
-- We deliberately avoid per-flag tables to keep the surface small. If a
-- flag ever needs structured config (e.g., feature.maxItems = 100), we
-- can promote it to a column or split tables later.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Fast key existence checks. jsonb_path_ops is smaller than the default
-- jsonb_ops index when we only need @> containment queries.
CREATE INDEX IF NOT EXISTS idx_organizations_features_gin
  ON organizations USING gin (features jsonb_path_ops);
