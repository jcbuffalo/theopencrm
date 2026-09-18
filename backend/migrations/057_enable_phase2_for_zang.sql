-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Phase 2.2 — Turn on phase2_entities feature flag for the Zang org.
--
-- Targets any organization with profile='zang' OR name matching Zang. The
-- flag is set as a JSONB merge so this migration won't overwrite other flags
-- the org may have set in the future.
--
-- This is the equivalent of:
--   PUT /api/admin/feature-flags/<zangOrgId>/phase2_entities {"value": true}
-- but executed at deploy time so the contractor / pitch demo doesn't have to
-- manage it via the admin UI.

UPDATE organizations
   SET features = jsonb_set(COALESCE(features, '{}'::jsonb), '{phase2_entities}', 'true'::jsonb, TRUE),
       updated_at = CURRENT_TIMESTAMP
 WHERE profile = 'zang'
    OR name ILIKE '%zang%'
    OR name ILIKE '%hc zang%';
