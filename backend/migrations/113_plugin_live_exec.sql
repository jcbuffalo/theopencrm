-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 113 — plugin live execution: confirm-first writes.
--
-- User-triggered plugin runs execute in the isolated-vm sandbox but NO LONGER
-- commit writes directly. Instead, a preview (dry-run) run captures every
-- proposed mutation and stores it here; the write only happens after the user
-- explicitly Applies it through POST /api/plugins/:id/apply (which re-validates
-- against the plugin write allowlist and executes in an org-scoped transaction).
--
-- Columns added to plugin_runs:
--   proposed_actions  the JSON array of proposed writes captured during a
--                     preview run (each { entity, op, table, target_id, fields,
--                     before, summary }). NULL for read-only runs / legacy rows.
--   applied_at        when the operator applied the proposed actions (NULL until
--                     applied). Also the idempotency guard — a run can only be
--                     applied once.
--   applied_by        the user who clicked Apply.
--   applied_result    JSON summary of what the apply did (per-action ok/error +
--                     affected row ids) for the audit trail + UI.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS). Deliberately does NOT touch the
-- plugin_runs.status CHECK constraint — the execution outcome status is
-- unchanged; apply state is tracked by applied_at. The startup migration runner
-- hard-fails on 42P07/42710, so no bare CREATE / duplicate-object statements
-- here.

BEGIN;

ALTER TABLE plugin_runs
  ADD COLUMN IF NOT EXISTS proposed_actions JSONB,
  ADD COLUMN IF NOT EXISTS applied_at       TIMESTAMP,
  ADD COLUMN IF NOT EXISTS applied_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS applied_result   JSONB;

-- Partial index for "which of this plugin's recent runs have unapplied
-- proposals?" — the UI badge query. Small partial index; cheap to maintain.
CREATE INDEX IF NOT EXISTS idx_plugin_runs_unapplied
  ON plugin_runs(plugin_id)
  WHERE proposed_actions IS NOT NULL AND applied_at IS NULL;

COMMIT;
