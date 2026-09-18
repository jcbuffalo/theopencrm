-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 077 — plugin runtime: widen plugin_runs.status CHECK to allow the new
-- 'task_budget_exceeded' terminal state introduced by the v3 sandbox polish.
--
-- pluginSdk.js now caps createTask invocations at MAX_TASKS_CREATED_PER_RUN
-- (currently 10) independent of the per-run query budget. The 11th
-- createTask synchronously throws PluginTaskBudgetExceeded; pluginRunner.js
-- classifies the catch as status='task_budget_exceeded'. Without this
-- migration the INSERT into plugin_runs would violate the CHECK constraint
-- last touched by migration 075.
--
-- Follows the same drop-and-recreate shape as migration 075 (this column is
-- a VARCHAR with a CHECK constraint, not an enum; ALTER TYPE ... ADD VALUE
-- doesn't apply). DO block guards the drop in case the constraint name
-- drifts across environments.

BEGIN;

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
      'running',
      'success', 'ok',
      'error',
      'timeout',
      'memory_exceeded',
      'killed',
      'quota_exceeded',
      'rejected',
      'query_budget_exceeded',
      'concurrent_limit_exceeded',
      'task_budget_exceeded'
    ));
END $$;

COMMIT;
