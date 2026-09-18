-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Recurring tasks / cadences — migration 129.
--
-- A task with a non-NULL recurrence_rule is a recurring task: completing it
-- spawns the next occurrence (title/description/assignee/priority copied,
-- due_date = previous due_date + interval). NULL = ordinary one-off task, so
-- every existing row is untouched.
--
-- ALLOWED VALUES (enforced in the API layer via schemas/tasks.RECURRENCE_RULES,
-- not a CHECK constraint, so the allowlist can evolve without a migration):
-- daily | weekly | biweekly | monthly.
--
-- recurrence_parent_id points at the ROOT task of the series (the first
-- occurrence ever created); it is NULL on the root itself. Keeping every
-- occurrence pointed at the root (rather than a linked list) makes "does this
-- series already have an active occurrence?" a single indexed lookup — that
-- query is the duplicate-spawn guard in services/recurringTasks.js.
-- No FK constraint: tasks is one of the legacy duplicate-migration tables and
-- deleting the root must not cascade or block; orphaned parents are harmless.
--
-- recurrence_active lets a user stop a series without deleting history:
-- FALSE means "completed occurrences stay, but never spawn a successor".
--
-- Partial index matches the two hot paths (route spawn guard + the
-- recurringTaskWorker sweep), both of which filter recurrence_rule IS NOT NULL
-- within an org.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS. The
-- startup runner hard-fails on 42P07 / 42710, so bare ADD/CREATE would
-- crash-loop the deploy — do not remove the guards.

BEGIN;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence_rule VARCHAR(16);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence_parent_id INTEGER;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence_active BOOLEAN DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_tasks_recurrence
  ON tasks(org_id, recurrence_rule)
  WHERE recurrence_rule IS NOT NULL;

COMMENT ON COLUMN tasks.recurrence_rule IS
  'Recurrence cadence (daily|weekly|biweekly|monthly), NULL = one-off. Validated in the API layer against schemas/tasks.RECURRENCE_RULES. See migration 129.';
COMMENT ON COLUMN tasks.recurrence_parent_id IS
  'Root task id of the recurring series; NULL on the root occurrence itself. See migration 129.';
COMMENT ON COLUMN tasks.recurrence_active IS
  'FALSE stops a recurring series from spawning successors without deleting history. See migration 129.';

COMMIT;
