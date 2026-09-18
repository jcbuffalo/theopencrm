-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Per-super-admin notification preferences for platform events.
--
-- WHY: super admins (johncolesassistant@gmail.com) want to be notified when
-- new users request access, sign up, or fail to log in. Existing code already
-- emails on access request; this migration adds the preference column so
-- admins can opt in/out per event type, and supports throttling.
--
-- SHAPE: notification_preferences JSONB =
--   {
--     "email":             "<override; defaults to user.email>",
--     "events": {
--       "access_request_submitted": true,
--       "signup":                   true,
--       "login_failed_threshold":   true,
--       "login_success_new_ip":     false,
--       "weekly_digest":            false
--     },
--     "throttle_minutes": 30
--   }
--
-- For each event flag absent or `null`, code falls back to the per-event
-- default in services/adminNotify.js.

ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS notification_preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_admin_users_notif_prefs_gin
  ON admin_users USING gin (notification_preferences jsonb_path_ops);

-- Seed sensible defaults for any existing super_admin row whose prefs are
-- still the empty default. Idempotent — only updates when prefs == '{}'.
UPDATE admin_users
   SET notification_preferences = '{
         "events": {
           "access_request_submitted": true,
           "signup":                   true,
           "login_failed_threshold":   true,
           "login_success_new_ip":     false,
           "weekly_digest":            false
         },
         "throttle_minutes": 30
       }'::jsonb
 WHERE role = 'super_admin'
   AND notification_preferences = '{}'::jsonb;
