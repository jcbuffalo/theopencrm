-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 074 — Wire up the notification dispatcher.
--
-- Adds a single bookkeeping column on `tasks` so the overdue-task cron worker
-- can be idempotent: instead of re-notifying the assignee every hour about
-- the same overdue task, the worker stamps `last_overdue_notified_at` after
-- a successful dispatch and the next tick skips any task that was already
-- notified within the last 24 hours.
--
-- The column is nullable (NULL == "never notified about this being overdue")
-- and is reset to NULL on no schedule — by design. If a task slips back to
-- on-time (due_date pushed out) and then becomes overdue again, the worker's
-- 24-hour window naturally re-fires.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS so re-running is a no-op.

BEGIN;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS last_overdue_notified_at TIMESTAMPTZ;

-- Partial index: only the rows that have actually been notified take up
-- index space. Helps the worker's "skip recently notified" filter without
-- bloating an index over millions of never-notified rows.
CREATE INDEX IF NOT EXISTS idx_tasks_last_overdue_notified_at
  ON tasks(last_overdue_notified_at)
  WHERE last_overdue_notified_at IS NOT NULL;

COMMIT;
