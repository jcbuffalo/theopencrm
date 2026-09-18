-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Phase 1.7 — Per-org branding overrides for white-label
--
-- WHY: the platform must be vertical-neutral at the schema level. The Zang
-- name and logo, and the user-facing labels for "deal" / "external_ref" /
-- etc., are per-org configuration — not hardcoded in code or schema.
--
-- Convention for the JSONB shape (kept deliberately small):
--
--   {
--     "displayName":  "HC Zang Agency Inc",
--     "logoUrl":      "https://.../zang-logo.svg",
--     "primaryColor": "#1e3a8a",
--     "labels": {
--       "externalRef": "Zang #",
--       "deal":        "Order",
--       "deals":       "Orders"
--     }
--   }
--
-- We do NOT build a labels-for-every-field config matrix. Only the few
-- user-facing nouns that genuinely vary across verticals. Profile-driven
-- behavior (stages, transitions, intent hints) continues to live in
-- `frontend/src/stages.js` + `services/stageTransitions.js`.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS branding JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Seed the Zang org's branding if an org named like Zang exists. Idempotent;
-- only updates if branding is empty (so we don't clobber later edits).
UPDATE organizations
   SET branding = jsonb_build_object(
         'displayName',  COALESCE(name, 'HC Zang Agency'),
         'primaryColor', '#1e3a8a',
         'labels', jsonb_build_object(
           'externalRef', 'Zang #',
           'deal',        'Order',
           'deals',       'Orders'
         )
       )
 WHERE branding = '{}'::jsonb
   AND (name ILIKE '%zang%' OR name ILIKE '%hc zang%');

-- Index for fast key lookups (mostly for reporting; not a hot path).
CREATE INDEX IF NOT EXISTS idx_organizations_branding_gin
  ON organizations USING gin (branding jsonb_path_ops);
