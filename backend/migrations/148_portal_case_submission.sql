-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 148: Customer Portal v2 — portal case submission (first public write beyond
-- lead capture). Portal users can now open a support case through their
-- token-scoped portal link; those rows are ordinary `cases` rows tagged with
-- source = 'portal' so the portal read surface can list a company's OWN
-- portal-submitted tickets back (and internal triage can filter on origin).
--
-- No new table: the cases table (migration 134) already carries org_id /
-- user_id / company_id / contact_id scoping, status, priority, timestamps.
-- Nullable column, no backfill — existing app-created cases simply have
-- source IS NULL. Idempotent via ADD COLUMN IF NOT EXISTS.

ALTER TABLE cases ADD COLUMN IF NOT EXISTS source VARCHAR(24);

-- Backfill an explicit wire-channel pref key for the new
-- 'portal_case_submitted' notification category (same pattern as migration
-- 144: email/SMS strictly opt-in; the in-app bell has no per-type opt-out).
UPDATE users
   SET notification_preferences =
       '{ "portal_case_submitted": { "email": false, "sms": false } }'::jsonb
       || COALESCE(notification_preferences, '{}'::jsonb)
 WHERE notification_preferences IS NULL
    OR NOT (notification_preferences ? 'portal_case_submitted');
