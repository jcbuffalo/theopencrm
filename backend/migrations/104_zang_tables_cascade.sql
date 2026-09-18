-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 104_zang_tables_cascade.sql
-- DB-integrity debt: the Zang workflow tables declare their org_id FK as
-- `ON DELETE SET NULL` (see migrations 038/039/040/046/047). When an org is
-- deleted this ORPHANS the rows out of tenant scope — org_id goes NULL while
-- the rest of the row (and its user_id, deal_id, etc.) lingers. Newer tables
-- (drive_connections 085, org_gmail_connections 091, quickbooks_connections
-- 045, automation_runs / survey_invitations / meeting_logs 045) correctly use
-- ON DELETE CASCADE so org deletion cleans up everything it owns.
--
-- This migration re-points each Zang table's org_id FK to ON DELETE CASCADE so
-- deleting an org removes its workflow rows instead of orphaning them.
--
-- Idempotency: each table gets a DO $$ block that looks up the CURRENT FK
-- constraint on the org_id column by name (via pg_constraint / pg_attribute),
-- drops whatever it finds, then re-adds a canonically-named CASCADE FK. Because
-- it always drops the existing org_id FK first (name-agnostic) before adding,
-- re-running is a clean no-op and never trips 42710 (duplicate_object).
--
-- Catalog-only: DROP/ADD FOREIGN KEY validates existing data but does NOT
-- rewrite the table. On these small workflow tables this is fast. (ADD FOREIGN
-- KEY does scan the child table to validate; all existing rows already satisfy
-- the constraint, so this is a quick index-assisted check, not a rewrite.)
--
-- Tables covered (all confirmed to have an org_id column with ON DELETE SET
-- NULL): quotes, vendor_quotes, submittals, change_orders, issues, documents,
-- service_contracts, appreciation_queue.

-- quotes (migration 038)
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
  WHERE conrelid = 'quotes'::regclass AND contype = 'f'
    AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
      WHERE attrelid = 'quotes'::regclass AND attname = 'org_id')];
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE quotes DROP CONSTRAINT %I', cname);
  END IF;
  ALTER TABLE quotes ADD CONSTRAINT quotes_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
END $$;

-- vendor_quotes (migration 038)
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
  WHERE conrelid = 'vendor_quotes'::regclass AND contype = 'f'
    AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
      WHERE attrelid = 'vendor_quotes'::regclass AND attname = 'org_id')];
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE vendor_quotes DROP CONSTRAINT %I', cname);
  END IF;
  ALTER TABLE vendor_quotes ADD CONSTRAINT vendor_quotes_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
END $$;

-- submittals (migration 039)
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
  WHERE conrelid = 'submittals'::regclass AND contype = 'f'
    AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
      WHERE attrelid = 'submittals'::regclass AND attname = 'org_id')];
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE submittals DROP CONSTRAINT %I', cname);
  END IF;
  ALTER TABLE submittals ADD CONSTRAINT submittals_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
END $$;

-- change_orders (migration 039)
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
  WHERE conrelid = 'change_orders'::regclass AND contype = 'f'
    AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
      WHERE attrelid = 'change_orders'::regclass AND attname = 'org_id')];
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE change_orders DROP CONSTRAINT %I', cname);
  END IF;
  ALTER TABLE change_orders ADD CONSTRAINT change_orders_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
END $$;

-- issues (migration 040)
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
  WHERE conrelid = 'issues'::regclass AND contype = 'f'
    AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
      WHERE attrelid = 'issues'::regclass AND attname = 'org_id')];
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE issues DROP CONSTRAINT %I', cname);
  END IF;
  ALTER TABLE issues ADD CONSTRAINT issues_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
END $$;

-- documents (migration 040)
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
  WHERE conrelid = 'documents'::regclass AND contype = 'f'
    AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
      WHERE attrelid = 'documents'::regclass AND attname = 'org_id')];
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE documents DROP CONSTRAINT %I', cname);
  END IF;
  ALTER TABLE documents ADD CONSTRAINT documents_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
END $$;

-- service_contracts (migration 046)
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
  WHERE conrelid = 'service_contracts'::regclass AND contype = 'f'
    AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
      WHERE attrelid = 'service_contracts'::regclass AND attname = 'org_id')];
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE service_contracts DROP CONSTRAINT %I', cname);
  END IF;
  ALTER TABLE service_contracts ADD CONSTRAINT service_contracts_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
END $$;

-- appreciation_queue (migration 047)
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
  WHERE conrelid = 'appreciation_queue'::regclass AND contype = 'f'
    AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
      WHERE attrelid = 'appreciation_queue'::regclass AND attname = 'org_id')];
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE appreciation_queue DROP CONSTRAINT %I', cname);
  END IF;
  ALTER TABLE appreciation_queue ADD CONSTRAINT appreciation_queue_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
END $$;
