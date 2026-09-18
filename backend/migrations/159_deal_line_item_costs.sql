-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 159 — Cost lines on deal_line_items (CMN item 1.4): a deal becomes a small
-- P&L instead of a single number.
--
-- EXTENDS migration 145's table — NOT a new table. Every line now carries a
--   kind     — 'revenue' (default; what every pre-159 row is) or 'cost'.
--              App-validated in services/dealLineItems.js (normalizeLine);
--              VARCHAR rather than a CHECK constraint so the app layer stays
--              the single validator (matches plugins.source_kind precedent
--              only where the value set is closed at the DB; here we keep the
--              145 convention: routes validate, DB stores).
--   category — optional free-text bucket for reporting ('production',
--              'install', 'site_owner_fee', …). NULL = uncategorized.
--
-- ROLLUP CONTRACT CHANGE (services/dealLineItems.js rollupDealAmount):
-- deals.amount is derived from REVENUE lines only — cost lines NEVER touch
-- the deal's headline amount. Because every existing row defaults to
-- 'revenue', the rollup value for existing deals is bit-identical to the
-- pre-159 "sum of all lines" behavior. A deal whose only lines are cost
-- lines keeps its manually-set amount (manual-amount mode), exactly as a
-- deal with no lines does.
--
-- contribution = revenue − cost and margin_pct are computed live by the
-- line-item summary endpoint (GET /api/deals/:id/line-items) — nothing here
-- is a cache.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) — the startup runner hard-fails on
-- any error including 42701, so re-runs must be no-ops by construction.

BEGIN;

ALTER TABLE deal_line_items
  ADD COLUMN IF NOT EXISTS kind     VARCHAR(10) NOT NULL DEFAULT 'revenue',
  ADD COLUMN IF NOT EXISTS category VARCHAR(60);

COMMENT ON COLUMN deal_line_items.kind IS
  '''revenue'' (rolls into deals.amount) or ''cost'' (feeds contribution/margin only). App-validated; all pre-159 rows are revenue.';
COMMENT ON COLUMN deal_line_items.category IS
  'Optional cost/revenue bucket for margin reporting (e.g. production, install, site_owner_fee). NULL = uncategorized.';

COMMIT;
