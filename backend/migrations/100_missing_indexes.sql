-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 100 — Backfill missing indexes on foreign-key columns.
--
-- Several FK columns are filtered/joined on in hot paths (deal detail views,
-- task lists, quote lookups, appreciation queue) but were never indexed, so
-- Postgres falls back to sequential scans. Each column below was confirmed to
-- exist in an earlier migration; the matching index was missing.
--
--   deals.customer_id            (migration 037)
--   deals.end_user_company_id    (migration 046)
--   deals.end_user_contact_id    (migration 046)
--   tasks.deal_id                (migration 025)
--   tasks.contact_id             (migration 025)
--   quotes.customer_id           (migration 038)
--   service_contracts.deal_id    (migration 046)
--   appreciation_queue.deal_id   (migration 047)
--   appreciation_queue.contact_id(migration 047)
--
-- Index-only, idempotent (CREATE INDEX IF NOT EXISTS), safe to re-run.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_deals_customer_id
  ON deals(customer_id);
CREATE INDEX IF NOT EXISTS idx_deals_end_user_company_id
  ON deals(end_user_company_id);
CREATE INDEX IF NOT EXISTS idx_deals_end_user_contact_id
  ON deals(end_user_contact_id);

CREATE INDEX IF NOT EXISTS idx_tasks_deal_id
  ON tasks(deal_id);
CREATE INDEX IF NOT EXISTS idx_tasks_contact_id
  ON tasks(contact_id);

CREATE INDEX IF NOT EXISTS idx_quotes_customer_id
  ON quotes(customer_id);

CREATE INDEX IF NOT EXISTS idx_service_contracts_deal_id
  ON service_contracts(deal_id);

CREATE INDEX IF NOT EXISTS idx_appreciation_queue_deal_id
  ON appreciation_queue(deal_id);
CREATE INDEX IF NOT EXISTS idx_appreciation_queue_contact_id
  ON appreciation_queue(contact_id);

COMMIT;
