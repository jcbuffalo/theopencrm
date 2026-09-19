-- 172_deal_next_step.sql
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- A real "next step" commitment on every deal (Wave 2 of the 2026-09-18
-- usability review). Until now the deal drawer's "Next:" line came from the
-- static per-stage hint map in frontend/src/nextSteps.js — canned text, not
-- something the rep actually promised to do. These two columns hold the
-- rep's own next action and the date it's due, so My Day can surface the
-- deals whose next step is today or overdue (routes/myDayRoutes.js
-- `nextSteps` section, most overdue first).
--
--   next_step       — free text, one line ("Send revised quote to Dana")
--   next_step_date  — the day it's due (DATE, not TIMESTAMP: a commitment is
--                     for a day, not a minute)
--
-- Exposed on GET/PUT /api/deals/:id (explicit-key semantics on PUT so a
-- rep can CLEAR a finished step — the COALESCE pattern the other columns
-- use can't write NULL), in the deals CSV export, and on the get_deal /
-- propose_update_deal chat tools.
--
-- Idempotent: the deals table has duplicate-migration history (011/023), so
-- every statement here is ADD COLUMN / CREATE INDEX IF NOT EXISTS.

ALTER TABLE deals ADD COLUMN IF NOT EXISTS next_step TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS next_step_date DATE;

-- My Day's query is "open deals in my org with a next_step_date <= today";
-- a partial index on the dated rows keeps it cheap as the deals table grows.
CREATE INDEX IF NOT EXISTS idx_deals_next_step_date
  ON deals(org_id, next_step_date)
  WHERE next_step_date IS NOT NULL;
