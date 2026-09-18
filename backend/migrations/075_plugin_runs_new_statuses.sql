-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 075 — plugin runtime: widen plugin_runs.status CHECK to cover new terminal
-- states introduced by the runtime hardening pass.
--
-- pluginRunner.js now emits two additional statuses that the existing CHECK
-- (last touched in migration 069) does not allow:
--
--   'query_budget_exceeded'      — plugin tried to make a 51st DB-bound SDK
--                                  call. Synchronous throw inside the
--                                  isolate; the runner classifies the catch
--                                  with this status.
--   'concurrent_limit_exceeded'  — org already has 5 plugin runs in-flight
--                                  on this process. Short-circuits BEFORE
--                                  the isolate is spun. HTTP 429.
--
-- We drop and re-create the constraint with the widened set rather than
-- using ALTER ... ADD VALUE (that's enum-only; this column is a VARCHAR with
-- a CHECK constraint, see migration 061 + 069). The DO block guards against
-- running on a DB where the constraint name has already drifted.

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
      'concurrent_limit_exceeded'
    ));
END $$;

COMMIT;
