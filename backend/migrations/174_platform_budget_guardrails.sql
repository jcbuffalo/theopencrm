-- 174_platform_budget_guardrails.sql
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Platform-level AI spend guardrails (2026-09-22, owner directive on
-- approving D1 "14-day AI trial at signup": "cap the # of trial participants
-- and AI costs, or at least alert me, using our own system").
--
--   platform_settings        — a tiny global key/value store (there was none:
--                              "platform-scope" feature flags are still stored
--                              per org). First key: ai_trials_enabled.
--   platform_budget_alerts   — once-per-(threshold, month) ledger so the
--                              budget worker fires each alert exactly once.
--   users.notification_preferences.platform_budget — the alert category,
--                              backfilled ON (email) for super-admins only so
--                              the owner gets it through the normal notification
--                              path (bell + daily digest / instant email with
--                              a one-click "Pause new trials" button).
--
-- Idempotent throughout.

BEGIN;

CREATE TABLE IF NOT EXISTS platform_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL DEFAULT 'null'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  INT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS platform_budget_alerts (
  key         TEXT PRIMARY KEY,
  fired_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Super-admins get platform budget alerts by email (and the bell) unless
-- they switch it off. Everyone else: key absent = off, same as the other
-- module-wave categories.
UPDATE users u
   SET notification_preferences = COALESCE(u.notification_preferences, '{}'::jsonb)
                                  || '{"platform_budget": {"email": true, "sms": false}}'::jsonb
  FROM admin_users au
 WHERE au.user_id = u.id
   AND au.role = 'super_admin'
   AND NOT (COALESCE(u.notification_preferences, '{}'::jsonb) ? 'platform_budget');

COMMIT;
