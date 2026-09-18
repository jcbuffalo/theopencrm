-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- User-defined automation rules.
--
-- WHY: services/automation.js ships a fixed set of code-defined RULES[]. Org
-- admins want to build their OWN simple "when X happens, do Y" rules from the
-- UI without a code deploy. This table stores those user-authored rules; the
-- automation engine loads each org's enabled rows on the same tick it runs the
-- built-ins, and evaluates them through a small, org-scoped, zod-validated
-- evaluator (see services/automation.js -> evaluateUserRule / runUserRules).
--
-- SHAPE
--   trigger     — one of a small allowlisted set: 'deal_stage_is',
--                 'deal_idle_days', 'task_overdue'. The evaluator switch()es on
--                 this; unknown triggers are ignored (no-op) rather than erroring.
--   conditions  — JSONB payload the trigger reads, e.g.
--                   deal_stage_is  -> { "stage": "CLOSED_WON" }
--                   deal_idle_days -> { "days": 14 }
--                   task_overdue   -> {}   (no extra params)
--   action      — JSONB { "type": <'create_task'|'notify'|'set_hot_flag'>, ... }
--                   create_task   -> { "type":"create_task", "title":"…", "priority":"high" }
--                   notify        -> { "type":"notify", "category":"deal_activity" }
--                   set_hot_flag  -> { "type":"set_hot_flag" }
--
-- Dedupe is via the existing automation_runs ledger: each firing records a
-- run keyed rule='user_rule:<id>', so the same target only fires once per
-- window (defence against re-firing on every tick).
--
-- IDEMPOTENT: CREATE TABLE / CREATE INDEX IF NOT EXISTS throughout so a re-run
-- (or the production startup runner replaying an already-applied file) is a
-- clean no-op and never raises 42P07 (duplicate_table) / 42710 (duplicate_object).

BEGIN;

CREATE TABLE IF NOT EXISTS automation_rules (
  id          SERIAL PRIMARY KEY,
  org_id      INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  name        VARCHAR(200) NOT NULL,
  trigger     VARCHAR(50)  NOT NULL,
  conditions  JSONB NOT NULL DEFAULT '{}'::jsonb,
  action      JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The engine's per-tick scan filters on (org_id, enabled); index it so loading
-- each org's enabled rules stays cheap as rule counts grow.
CREATE INDEX IF NOT EXISTS idx_automation_rules_org_enabled
  ON automation_rules(org_id, enabled);

COMMIT;
