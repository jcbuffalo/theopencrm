-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Per-user notification CHANNELS (email + SMS) and contact info.
--
-- This is the second-pass evolution of migration 064. The original schema
-- only supported "email me when X happens" booleans (one channel, hard-coded
-- to the login email). End users now want to:
--
--   (a) receive notifications at an address OTHER than their login email
--       (e.g. login is alice@work-sso.example.com but personal alerts should
--       go to alice@gmail.com), and
--   (b) optionally receive an SMS at a phone they control, on a per-category
--       basis.
--
-- COLUMN ADDITIONS
--   users.notification_email VARCHAR(254)  — RFC 5321 max length, nullable.
--                                            NULL means "fall back to u.email".
--   users.notification_phone VARCHAR(32)   — E.164 max is 15 digits + '+',
--                                            allow room for separators we
--                                            normalise out. NULL means
--                                            "no SMS — SMS channel is OFF
--                                            regardless of toggle state."
--
-- JSONB SHAPE CHANGE
--   Old (migration 064):
--     {
--       "email_task_assigned":  true,
--       "email_task_overdue":   true,
--       "email_deal_activity":  false,
--       "email_weekly_summary": true
--     }
--   New (this migration):
--     {
--       "task_assigned":   { "email": true,  "sms": false },
--       "task_overdue":    { "email": true,  "sms": false },
--       "deal_activity":   { "email": false, "sms": false },
--       "weekly_summary":  { "email": true,  "sms": false }
--     }
--
-- We migrate row-by-row using a single UPDATE with jsonb_build_object so the
-- transform is purely declarative and re-runnable: rows already in the new
-- shape (detected by the presence of a nested 'email' key under any category)
-- are left untouched.

BEGIN;

-- --------------------------------------------------------------------------
-- 1) Add the two contact-info columns. Nullable, no default — null carries
--    semantic meaning ("use login email" / "no SMS").
-- --------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS notification_email VARCHAR(254);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS notification_phone VARCHAR(32);

-- --------------------------------------------------------------------------
-- 2) Transform the JSONB from flat-key shape to per-channel shape.
--    Idempotent guard: skip any row whose 'task_assigned' value is already
--    a JSONB object (i.e. already migrated). Old shape has 'email_task_*'
--    top-level booleans, never a 'task_assigned' object, so the guard
--    distinguishes cleanly.
-- --------------------------------------------------------------------------
UPDATE users
   SET notification_preferences = jsonb_build_object(
         'task_assigned', jsonb_build_object(
           'email', COALESCE((notification_preferences ->> 'email_task_assigned')::boolean, TRUE),
           'sms',   FALSE
         ),
         'task_overdue', jsonb_build_object(
           'email', COALESCE((notification_preferences ->> 'email_task_overdue')::boolean, TRUE),
           'sms',   FALSE
         ),
         'deal_activity', jsonb_build_object(
           'email', COALESCE((notification_preferences ->> 'email_deal_activity')::boolean, FALSE),
           'sms',   FALSE
         ),
         'weekly_summary', jsonb_build_object(
           'email', COALESCE((notification_preferences ->> 'email_weekly_summary')::boolean, TRUE),
           'sms',   FALSE
         )
       )
 WHERE jsonb_typeof(notification_preferences -> 'task_assigned') IS DISTINCT FROM 'object';

COMMIT;
