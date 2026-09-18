-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Index audit + backfill for the new entities.
--
-- Walked every WHERE / JOIN clause in the new entity routes and the
-- nightly reconciliation script. Most indexes were already created by
-- the original entity migrations; this catches the few that weren't.
--
-- Each CREATE INDEX is IF NOT EXISTS so re-running is safe.

-- ---- usage_meter ---------------------------------------------------------
-- Already has UNIQUE(org_id, period, metric) + idx_usage_meter_org_period
-- + idx_usage_meter_period. No additions needed.

-- ---- plugins -------------------------------------------------------------
-- Org-scoped listing + filter-by-trigger-event for the future automation
-- engine that fires plugins on stage transitions:
CREATE INDEX IF NOT EXISTS idx_plugins_org_status
  ON plugins(org_id, status)
  WHERE status IN ('active', 'draft');

-- ---- plugin_runs --------------------------------------------------------
-- For the "recent runs for this org across all plugins" admin view that
-- doesn't exist yet but will. Indexed by (org_id, started_at DESC) — the
-- existing idx_plugin_runs_started covers cross-org views; this one
-- speeds per-org slicing.
CREATE INDEX IF NOT EXISTS idx_plugin_runs_org_started
  ON plugin_runs(org_id, started_at DESC);

-- ---- account_deletions --------------------------------------------------
-- Partial index for the worker: only scans rows where status='scheduled'
-- AND scheduled_at < NOW(). Partial because the table never gets large
-- and scanning 'processed' or 'cancelled' rows wastes work.
CREATE INDEX IF NOT EXISTS idx_account_deletions_worker_lookup
  ON account_deletions(scheduled_at)
  WHERE status = 'scheduled';

-- ---- invoice_allocations ------------------------------------------------
-- The PO-line denormalized-totals recompute does SUM(allocated_quantity)
-- WHERE purchase_order_line_item_id = $1. Existing
-- idx_invoice_alloc_po_li covers it. No additions needed.

-- ---- rfqs / purchase_orders / invoices ----------------------------------
-- All have org_id + deal_id + customer/vendor indexes from their original
-- migrations. The nightly reconcile script's join patterns are covered.

-- ---- audit_log ----------------------------------------------------------
-- The shouldFireFailedLoginThreshold helper queries
--   WHERE event = 'auth.login.failed'
--     AND created_at > NOW() - INTERVAL ...
--     AND (meta->>'email' = X OR ip = Y)
-- Existing idx_audit_log_event + idx_audit_log_created_at cover most of
-- this; adding a partial index for the auth-fail path specifically:
CREATE INDEX IF NOT EXISTS idx_audit_log_auth_fail_lookup
  ON audit_log(event, created_at DESC)
  WHERE event = 'auth.login.failed';
