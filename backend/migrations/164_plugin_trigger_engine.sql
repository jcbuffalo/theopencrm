-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 164 — plugin trigger engine (services/pluginEvents.js +
-- services/pluginScheduleWorker.js).
--
-- Until now plugins carried trigger_event / trigger_filter_json but NOTHING
-- dispatched events — pluginRunner.run was only reachable from the manual
-- routes and the chat run_plugin tool. This migration adds the schema the
-- dispatch seam needs:
--
--   plugins.last_triggered_at
--     Stamped every time the trigger engine attempts a run for the plugin
--     (event or schedule). Lets the UI show "last fired 2h ago" liveness.
--
--   plugins.consecutive_trigger_failures
--     Failure streak across TRIGGERED runs only (manual/test runs don't
--     count). Reset to 0 on a successful triggered run; when it reaches 5
--     the engine auto-pauses the plugin (status -> 'errored', an existing
--     value in the plugins status CHECK) and notifies org owners/admins via
--     the notification center.
--
--   plugin_trigger_dedupe
--     Per-(plugin, dedupe_key) atomic claim table — the workerLease pattern
--     (INSERT ... ON CONFLICT DO NOTHING) applied per trigger delivery so a
--     retried/double-fired write can never run the same plugin twice for the
--     same logical event. Keys are built by the emit call sites, e.g.
--       'deal.created:123'
--       'deal.stage_changed:123:LEAD->QUALIFIED'
--       'task.overdue:55:2026-09-17'
--       'schedule.daily:2026-09-17'
--     Rows are swept after 30 days by pluginScheduleWorker's tick (the keys
--     embed enough context that a re-fire 30+ days later is either
--     impossible — creations happen once — or legitimate).
--
-- Idempotent throughout (ADD COLUMN IF NOT EXISTS / CREATE ... IF NOT
-- EXISTS) — the startup runner hard-fails on 42P07/42710.

BEGIN;

ALTER TABLE plugins
  ADD COLUMN IF NOT EXISTS last_triggered_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS consecutive_trigger_failures INTEGER NOT NULL DEFAULT 0;

-- Dispatch hot path: "active plugins in this org listening to this event".
CREATE INDEX IF NOT EXISTS idx_plugins_org_trigger_active
  ON plugins(org_id, trigger_event)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS plugin_trigger_dedupe (
  plugin_id  BIGINT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  dedupe_key VARCHAR(200) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (plugin_id, dedupe_key)
);

-- For the 30-day retention sweep in pluginScheduleWorker.
CREATE INDEX IF NOT EXISTS idx_plugin_trigger_dedupe_created
  ON plugin_trigger_dedupe(created_at);

COMMIT;
