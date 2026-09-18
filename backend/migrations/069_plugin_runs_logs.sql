-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 069 — plugin runtime: extend plugin_runs for the sandbox build-out
--
-- Migration 061 created plugin_runs with the resource-usage columns we need
-- for billing (cpu_ms, memory_peak_bytes, db_queries, egress_bytes, ai_*).
-- This migration adds the columns the isolated-vm sandbox uses to record what
-- the plugin actually did:
--
--   triggered_by      who fired the run (NULL for system/cron triggers)
--   trigger_source    'manual' | 'webhook' | 'cron' | 'event' | 'test_run'
--                     (additive: original `trigger_kind` column is preserved
--                     for backward compat; new code writes both for now and
--                     reads from trigger_source).
--   input_payload     the JSON object the caller passed in (request body)
--   output_payload    the JSON object the plugin's run() returned
--   log_lines         crm.log() output captured during the run, in order
--
-- Also widens the status check constraint to include the new sandbox-specific
-- terminal states ('memory_exceeded', 'killed', 'ok') the runner can produce.
-- ('ok' is an alias for the existing 'success' — we keep both so existing
-- queries that filter status = 'success' don't break and new runs can use
-- either label.)
--
-- Indexes target the "show me this plugin's last 50 runs" hot path and the
-- per-org quota count.

BEGIN;

ALTER TABLE plugin_runs
  ADD COLUMN IF NOT EXISTS triggered_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS trigger_source VARCHAR(40),
  ADD COLUMN IF NOT EXISTS input_payload  JSONB,
  ADD COLUMN IF NOT EXISTS output_payload JSONB,
  ADD COLUMN IF NOT EXISTS log_lines      TEXT[];

-- Widen the status enum. Existing constraint allowed:
--   'running' | 'success' | 'error' | 'timeout' | 'quota_exceeded' | 'rejected'
-- We add: 'ok' (synonym for 'success'), 'memory_exceeded', 'killed'.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'plugin_runs_status_check'
  ) THEN
    ALTER TABLE plugin_runs DROP CONSTRAINT plugin_runs_status_check;
  END IF;
  ALTER TABLE plugin_runs
    ADD CONSTRAINT plugin_runs_status_check
    CHECK (status IN (
      'running', 'success', 'ok', 'error', 'timeout',
      'memory_exceeded', 'killed', 'quota_exceeded', 'rejected'
    ));
END $$;

-- The "last 50 runs for this plugin" query is the dominant read pattern from
-- the UI Runs tab. (plugin_id, started_at DESC) is a covering index for it.
CREATE INDEX IF NOT EXISTS idx_plugin_runs_plugin_started
  ON plugin_runs(plugin_id, started_at DESC);

-- Per-org-per-month quota count: "how many runs has this org used this period?"
-- Helps quotaEnforcer short-circuit before the sandbox spin-up.
CREATE INDEX IF NOT EXISTS idx_plugin_runs_org_started
  ON plugin_runs(org_id, started_at DESC);

COMMIT;
