-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 153: Pin the Zang-workflow module defaults on every EXISTING non-zang org.
--
-- services/featureFlags.js made module defaults profile-aware: the four
-- manufacturer's-rep modules (quotes_enabled, vendor_quotes_enabled,
-- submittals_enabled, change_orders_enabled) used to default ON for every org
-- and now default ON only for profile = 'zang' (OFF for generic / jcp / rin /
-- NULL). A missing key in organizations.features means "use the default", so
-- without this migration every existing non-zang org would silently lose
-- those modules the moment the new code booted.
--
-- Safety contract: for every existing org whose profile is not 'zang', write
-- the PREVIOUS effective default (true) as an explicit key wherever the key
-- is unset. Orgs that already set the key (either way) are untouched. Zang
-- orgs are untouched because their default stays true. New orgs created after
-- this migration get the lightweight default (OFF) — that is the point.
--
-- Idempotent: each UPDATE is guarded by `NOT (features ? '<key>')`, so a
-- re-run matches zero rows.

UPDATE organizations
   SET features = COALESCE(features, '{}'::jsonb) || '{"quotes_enabled": true}'::jsonb,
       updated_at = CURRENT_TIMESTAMP
 WHERE profile IS DISTINCT FROM 'zang'
   AND NOT (COALESCE(features, '{}'::jsonb) ? 'quotes_enabled');

UPDATE organizations
   SET features = COALESCE(features, '{}'::jsonb) || '{"vendor_quotes_enabled": true}'::jsonb,
       updated_at = CURRENT_TIMESTAMP
 WHERE profile IS DISTINCT FROM 'zang'
   AND NOT (COALESCE(features, '{}'::jsonb) ? 'vendor_quotes_enabled');

UPDATE organizations
   SET features = COALESCE(features, '{}'::jsonb) || '{"submittals_enabled": true}'::jsonb,
       updated_at = CURRENT_TIMESTAMP
 WHERE profile IS DISTINCT FROM 'zang'
   AND NOT (COALESCE(features, '{}'::jsonb) ? 'submittals_enabled');

UPDATE organizations
   SET features = COALESCE(features, '{}'::jsonb) || '{"change_orders_enabled": true}'::jsonb,
       updated_at = CURRENT_TIMESTAMP
 WHERE profile IS DISTINCT FROM 'zang'
   AND NOT (COALESCE(features, '{}'::jsonb) ? 'change_orders_enabled');
