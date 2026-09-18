-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Per-type notification preferences for the July-2026 module wave.
--
-- Migration 128 shipped the in-app Notification Center, but only the four
-- original dispatcher categories (task_assigned, task_overdue, deal_activity,
-- weekly_summary) produced rows. The new modules — cases, leads, meetings,
-- email sequences, success playbooks — now emit through the same
-- services/notificationDispatcher.js choke point under seven new categories:
--
--   case_assigned            — a support case was assigned to you
--   case_status_changed      — a case you own changed status
--   lead_captured            — a lead arrived (web form / capture surface)
--   lead_assigned            — a lead was assigned to you
--   meeting_scheduled        — a meeting was scheduled on a record you own
--   sequence_completed       — a contact finished one of your email sequences
--   playbook_tasks_created   — a playbook spawned tasks on your account
--
-- NO SCHEMA CHANGE is needed: users.notification_preferences (migrations
-- 064/066) is already a per-category { "email": bool, "sms": bool } JSONB
-- matrix, and the dispatcher already treats a MISSING category key as
-- "wire channels off" (in-app/bell rows persist regardless — the bell is the
-- always-on record with no per-type opt-out, matching the existing four).
--
-- This migration only BACKFILLS explicit keys for the seven new categories so
-- the Settings UI reflects persisted state instead of client-side defaults.
--
-- DEFAULTS: email OFF + sms OFF for every new type — these are higher-volume
-- / system-generated events, and wire channels are strictly opt-in for them
-- (don't spam; note prod email transport is unconfigured anyway). Users
-- enable per-type via PUT /api/me/notification-preferences (/settings →
-- Notifications).
--
-- IDEMPOTENT + NON-DESTRUCTIVE: defaults sit on the LEFT of the jsonb `||`
-- merge, so any key a user already has (including any of the seven, if a
-- concurrent deploy raced) wins over the default. Re-running is a no-op for
-- rows that already carry all seven keys.

BEGIN;

UPDATE users
   SET notification_preferences =
       '{
          "case_assigned":          { "email": false, "sms": false },
          "case_status_changed":    { "email": false, "sms": false },
          "lead_captured":          { "email": false, "sms": false },
          "lead_assigned":          { "email": false, "sms": false },
          "meeting_scheduled":      { "email": false, "sms": false },
          "sequence_completed":     { "email": false, "sms": false },
          "playbook_tasks_created": { "email": false, "sms": false }
        }'::jsonb || COALESCE(notification_preferences, '{}'::jsonb)
 WHERE notification_preferences IS NULL
    OR NOT (notification_preferences ?& ARRAY[
         'case_assigned', 'case_status_changed', 'lead_captured',
         'lead_assigned', 'meeting_scheduled', 'sequence_completed',
         'playbook_tasks_created'
       ]);

COMMIT;
