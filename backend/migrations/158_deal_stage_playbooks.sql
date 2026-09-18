-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Deal-stage-triggered playbooks — migration 158 (CMN_REQUIREMENTS.md §1.2).
--
-- Success playbooks (migration 123) fire when a COMPANY enters a lifecycle
-- stage. This migration lets a playbook fire when a DEAL enters a pipeline
-- stage instead:
--
--   playbooks.trigger_kind      — 'lifecycle_stage' (default, the historical
--                                 behavior) | 'deal_stage'. For deal_stage
--                                 playbooks trigger_stage holds a pipeline
--                                 stage id (validated in the API layer against
--                                 the org's effective pipeline, same choice as
--                                 lifecycle stages vs. LIFECYCLE_STAGES).
--   playbooks.trigger_deal_type — optional deal_type filter (migration 156):
--                                 NULL = fire for deals of any type; a slug =
--                                 fire only for deals of that type.
--
--   playbook_runs.deal_id       — the deal a deal_stage firing ran for.
--                                 Deal runs write company_id NULL (the
--                                 company linkage lives on the spawned tasks)
--                                 so two deals of the same company can each
--                                 get their own run without tripping the
--                                 lifecycle UNIQUE (playbook_id, company_id)
--                                 index. company_id therefore drops NOT NULL;
--                                 lifecycle runs keep writing it exactly as
--                                 before.
--
-- THE deal-run dedupe mirrors migration 123's design: at most one run per
-- (playbook, deal), ever — a partial UNIQUE index (deal_id IS NOT NULL) that
-- services/playbooks.js INSERTs against with ON CONFLICT DO NOTHING, so
-- concurrent stage changes race safely. playbook_id already implies the org
-- (and covers user-scoped callers, where org_id is NULL — see 123's header
-- for why a NULLable org_id must stay out of the key).
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
-- throughout; DROP NOT NULL is a no-op when already dropped. The startup
-- runner hard-fails on 42P07 / 42710, so nothing here may rely on error
-- swallowing.

BEGIN;

ALTER TABLE playbooks
  ADD COLUMN IF NOT EXISTS trigger_kind VARCHAR(20) NOT NULL DEFAULT 'lifecycle_stage';
ALTER TABLE playbooks
  ADD COLUMN IF NOT EXISTS trigger_deal_type VARCHAR(40);

ALTER TABLE playbook_runs
  ADD COLUMN IF NOT EXISTS deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE playbook_runs
  ALTER COLUMN company_id DROP NOT NULL;

-- THE deal-run dedupe (partial: lifecycle runs have deal_id NULL and stay
-- governed by uq_playbook_runs_playbook_company).
CREATE UNIQUE INDEX IF NOT EXISTS uq_playbook_runs_playbook_deal
  ON playbook_runs(playbook_id, deal_id) WHERE deal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_playbook_runs_deal_id
  ON playbook_runs(deal_id);

COMMENT ON COLUMN playbooks.trigger_kind IS
  'lifecycle_stage (fires on companies.lifecycle_stage changes, the migration-123 behavior) | deal_stage (fires when a deal enters trigger_stage on its pipeline). See migration 158.';
COMMENT ON COLUMN playbooks.trigger_deal_type IS
  'deal_stage playbooks only: NULL = any deal_type; a slug (migration 156) restricts firing to deals of that type.';
COMMENT ON COLUMN playbook_runs.deal_id IS
  'Set for deal_stage firings; the partial UNIQUE (playbook_id, deal_id) index is their idempotency guard. Lifecycle firings keep using company_id.';

COMMIT;
