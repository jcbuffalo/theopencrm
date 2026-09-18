-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 105_updated_at_triggers.sql
-- DB-integrity debt: no table in the schema currently has an updated_at
-- auto-touch trigger (only audit_log has triggers, and those are the
-- immutability guards from 048). Every route that wants a fresh updated_at has
-- to remember to set it by hand — so any writer that forgets (bulk updates,
-- automation workers, chat write-actions, ad-hoc SQL) leaves updated_at stale.
--
-- This migration installs ONE shared touch_updated_at() trigger function and
-- attaches a BEFORE UPDATE trigger to the mutable business tables. The trigger
-- unconditionally stamps NEW.updated_at = NOW() on every UPDATE, so updated_at
-- becomes a reliable "row last changed" signal regardless of the caller.
--
-- Idempotency:
--   * CREATE OR REPLACE FUNCTION — safe to re-run.
--   * Each trigger uses DROP TRIGGER IF EXISTS ...; CREATE TRIGGER ... so a
--     re-run never trips 42710 (duplicate_object).
--   * The three column adds use ADD COLUMN IF NOT EXISTS.
-- Catalog-only: creating triggers/functions and adding a nullable column with
-- a default (Postgres 11+ stores the default in catalog metadata, no rewrite)
-- are all fast metadata operations.

-- Shared trigger function.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- --- Tables that ALREADY have an updated_at column (verified in migrations) ---
-- Core CRM: companies(020) contacts(021) deals(023) activities(024)
--           tasks(025) pipelines(026)
-- Zang:     quotes(038) vendor_quotes(038) submittals(039) change_orders(039)
--           issues(040) service_contracts(046) appreciation_queue(047)

DROP TRIGGER IF EXISTS trg_touch_updated_at ON companies;
CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_updated_at ON contacts;
CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_updated_at ON deals;
CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_updated_at ON activities;
CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON activities
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_updated_at ON tasks;
CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_updated_at ON pipelines;
CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON pipelines
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_updated_at ON quotes;
CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_updated_at ON vendor_quotes;
CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON vendor_quotes
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_updated_at ON submittals;
CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON submittals
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_updated_at ON change_orders;
CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON change_orders
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_updated_at ON issues;
CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON issues
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_updated_at ON service_contracts;
CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON service_contracts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_updated_at ON appreciation_queue;
CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON appreciation_queue
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- --- Mutable tables that LACK updated_at entirely (review-flagged) ---
-- Add the column first, then attach the trigger.
--   documents(040)               — mutable via /api/documents PATCH (notes/type)
--   quickbooks_connections(045)  — mutated on every token refresh / sync
--   quote_line_items(038)        — edited whenever a quote's lines change

ALTER TABLE documents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
DROP TRIGGER IF EXISTS trg_touch_updated_at ON documents;
CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE quickbooks_connections ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
DROP TRIGGER IF EXISTS trg_touch_updated_at ON quickbooks_connections;
CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON quickbooks_connections
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE quote_line_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
DROP TRIGGER IF EXISTS trg_touch_updated_at ON quote_line_items;
CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON quote_line_items
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
