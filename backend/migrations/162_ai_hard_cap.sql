-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 162: AI monthly HARD cap (auto-halt).
--
-- The soft threshold (ai_monthly_threshold_usd, migration 095) warns the
-- operator; this adds a hard ceiling at which aiThresholdWorker AUTO-HALTS
-- the org (ai_billing_status='halted', ai_halted_reason='auto_threshold').
-- Owner-directed change 2026-09-14 — supersedes the earlier warn-only
-- directive recorded in services/aiThresholdWorker.js.
--
--   ai_monthly_hard_cap_usd  NULL = use the code default ($200; env
--                            AI_MONTHLY_HARD_CAP_DEFAULT_USD). Explicit 0 is
--                            allowed (halt on any billed usage).
--   ai_auto_halted_period    'YYYY-MM' the auto-halt fired; the worker
--                            auto-resumes the org when the month rolls over
--                            (a fresh cap each month), then clears this.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS throughout.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS ai_monthly_hard_cap_usd NUMERIC(10,2);

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS ai_auto_halted_period VARCHAR(7);

COMMENT ON COLUMN organizations.ai_monthly_hard_cap_usd IS
  'Monthly AI spend (customer-charged USD) at which the org is auto-halted. NULL = code default ($200). 0 = halt on any billed usage.';
COMMENT ON COLUMN organizations.ai_auto_halted_period IS
  'YYYY-MM of the last auto-threshold halt; cleared when the worker auto-resumes on month rollover.';
