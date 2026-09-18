-- 167: Autonomous run mode for extensions (owner-authorized reversal of the
-- "a plugin can never write directly" invariant, OPT-IN PER PLUGIN).
--
-- plugins.run_mode ('preview' | 'autonomous', app-validated):
--   'preview'    — DEFAULT, unchanged behavior: every run captures its writes
--                  as confirm-first proposals on the run row; an org
--                  owner/admin must Apply them (POST /api/plugins/:id/apply).
--   'autonomous' — a SUCCESSFUL run's proposals are auto-applied server-side
--                  through the exact same commit machinery the Apply endpoint
--                  uses (services/pluginActions.applyRunProposals): same
--                  allowlist re-validation, same org-scoped transaction, same
--                  applied_at / applied_result bookkeeping on the run row.
--                  Only settable by an org owner/admin
--                  (PATCH /api/plugins/:id/run-mode, audited as
--                  plugin.run_mode_changed).
--
-- plugin_runs.run_mode records which posture governed each run ('preview' |
-- 'autonomous' | legacy 'commit' for the test-only direct-write path). NULL
-- for pre-167 rows and runs rejected before the plugin row was loaded —
-- readers should treat NULL as 'preview'.
--
-- Idempotent by construction (ADD COLUMN IF NOT EXISTS); the startup runner
-- hard-fails on any error, so nothing here may assume a partial prior apply.

ALTER TABLE plugins
  ADD COLUMN IF NOT EXISTS run_mode VARCHAR(12) NOT NULL DEFAULT 'preview';

ALTER TABLE plugin_runs
  ADD COLUMN IF NOT EXISTS run_mode VARCHAR(12);
