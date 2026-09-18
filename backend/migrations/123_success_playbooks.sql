-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Success Playbooks — migration 123.
--
-- Operationalizes companies.lifecycle_stage (migration 122): when an account
-- ENTERS a lifecycle stage (prospect|onboarding|active|at_risk|renewed|churned),
-- any active playbook whose trigger_stage matches spawns its templated checklist
-- of tasks, so the CS motion actually runs instead of living in someone's head.
--
--   playbooks       — the template header: name + trigger_stage + is_active.
--   playbook_steps  — ordered checklist items; offset_days sets each spawned
--                     task's due_date = trigger date + offset_days.
--   playbook_runs   — one row per (playbook, company) firing. The UNIQUE index
--                     on (playbook_id, company_id) is the dedupe: a playbook
--                     fires AT MOST ONCE per company, ever, even across repeat
--                     transitions into the same stage (re-onboarding a churned
--                     account gets a human decision, not a duplicate blast).
--                     playbook_id already implies the org, so this two-column
--                     key dedupes correctly for BOTH org-scoped and
--                     user-scoped (no-org) callers — a three-column key
--                     including a NULLable org_id would silently never
--                     conflict for user-scoped rows (NULLs compare distinct).
--
-- tasks.company_id — spawned tasks link straight to the account they serve.
-- `tasks` predates the account motion and only linked contact/deal; playbook
-- tasks are account-level, so the column is added here (ADD COLUMN IF NOT
-- EXISTS — tasks is a duplicate-table-migration target, never bare DDL).
--
-- Allowed trigger_stage values are enforced in the API layer against
-- schemas/companies.LIFECYCLE_STAGES (same choice as migration 122 — the
-- allowlist can evolve without a migration).
--
-- IDEMPOTENT: every statement is IF-NOT-EXISTS-guarded; the startup runner
-- hard-fails on 42P07 / 42710, so an unguarded statement would crash-loop the
-- deploy.

BEGIN;

CREATE TABLE IF NOT EXISTS playbooks (
  id SERIAL PRIMARY KEY,
  org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  trigger_stage VARCHAR(32) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Trigger lookup happens on every lifecycle-stage change: "active playbooks in
-- this org for this stage" — the composite matches that access pattern.
CREATE INDEX IF NOT EXISTS idx_playbooks_org_trigger
  ON playbooks(org_id, trigger_stage);
CREATE INDEX IF NOT EXISTS idx_playbooks_user_id
  ON playbooks(user_id);

CREATE TABLE IF NOT EXISTS playbook_steps (
  id SERIAL PRIMARY KEY,
  playbook_id INTEGER NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
  org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  offset_days INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_playbook_steps_playbook_id
  ON playbook_steps(playbook_id);

CREATE TABLE IF NOT EXISTS playbook_runs (
  id SERIAL PRIMARY KEY,
  org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  playbook_id INTEGER NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  triggered_stage VARCHAR(32) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- THE dedupe: at most one run per (playbook, company). services/playbooks.js
-- INSERTs with ON CONFLICT DO NOTHING against this index, so concurrent stage
-- changes race safely.
CREATE UNIQUE INDEX IF NOT EXISTS uq_playbook_runs_playbook_company
  ON playbook_runs(playbook_id, company_id);
CREATE INDEX IF NOT EXISTS idx_playbook_runs_org_id
  ON playbook_runs(org_id);

-- Account-level task linkage (see header comment).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_company_id ON tasks(company_id);

COMMENT ON TABLE playbooks IS
  'Success Playbook templates: fire a task checklist when a company enters trigger_stage (companies.lifecycle_stage). Validated against schemas/companies.LIFECYCLE_STAGES in the API layer. See migration 123.';
COMMENT ON TABLE playbook_runs IS
  'One row per (playbook, company) firing; the UNIQUE (playbook_id, company_id) index is the idempotency guard for services/playbooks.js.';

COMMIT;
