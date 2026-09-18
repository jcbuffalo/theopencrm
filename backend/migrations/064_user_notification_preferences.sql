-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Per-user notification preferences for transactional / activity emails.
--
-- WHY: end users (not just super admins) want to control which emails they
-- receive about their own work — task assignments, overdue tasks, deal
-- activity, and a weekly summary. Existing migration 058 covers super-admin
-- platform-level notifications; this migration is the user-facing analogue.
--
-- SHAPE: notification_preferences JSONB =
--   {
--     "email_task_assigned":  true,
--     "email_task_overdue":   true,
--     "email_deal_activity":  false,
--     "email_weekly_summary": true
--   }
--
-- All four keys are booleans meaning "email me when X happens." Partial
-- updates merge via `||` on the application side, so missing keys keep their
-- prior value.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS notification_preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Backfill existing rows whose prefs are still the empty default with the
-- four documented defaults. Idempotent — only touches rows still at '{}'.
UPDATE users
   SET notification_preferences = '{
         "email_task_assigned":  true,
         "email_task_overdue":   true,
         "email_deal_activity":  false,
         "email_weekly_summary": true
       }'::jsonb
 WHERE notification_preferences = '{}'::jsonb;

COMMIT;
