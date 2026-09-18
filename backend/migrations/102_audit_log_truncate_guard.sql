-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Harden audit-trail immutability beyond migration 048.
--
-- WHY:
--   Migration 048 made `audit_log` append-only for row-level UPDATE/DELETE,
--   but a BEFORE ROW trigger does NOT fire on TRUNCATE — TRUNCATE is a
--   statement-level, table-scoped operation. So `TRUNCATE audit_log` would
--   still wipe the entire tamper-"resistant" trail. This migration closes
--   that gap with a BEFORE TRUNCATE statement-level trigger.
--
--   Separately, the LEGACY `audit_logs` table (migration 003 — written by
--   middleware/auditLog.js for admin actions like user-delete / role-change)
--   had NO immutability protection at all. A codebase grep found NO legitimate
--   DELETE / TRUNCATE path against `audit_logs` (only INSERT + SELECT in
--   middleware/auditLog.js), so it is safe to apply the FULL immutability set
--   (UPDATE/DELETE row guard + TRUNCATE statement guard), matching what 048
--   gave `audit_log`.
--
-- Compliance note: NIST SP 800-53 AU-9 and SOC 2 CC7.2 expect a tamper-
-- resistant audit trail. TRUNCATE protection is the missing leg of that.
--
-- IDEMPOTENT: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS throughout,
-- and the table-existence guards make re-runs and fresh DBs both safe. No bare
-- CREATE TRIGGER / CREATE FUNCTION.

-- ---------------------------------------------------------------------------
-- 1. TRUNCATE guard for `audit_log` (the append-only platform table from 048).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_log_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only — TRUNCATE is not permitted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_no_truncate();

-- ---------------------------------------------------------------------------
-- 2. Full immutability for the legacy `audit_logs` table (migration 003).
--    Guarded on table existence so a DB that never created it stays a no-op.
--    No legitimate delete/retention path exists, so UPDATE/DELETE + TRUNCATE
--    are all blocked.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only — % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION audit_logs_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only — TRUNCATE is not permitted';
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'audit_logs' AND table_schema = current_schema()
  ) THEN
    DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
    CREATE TRIGGER audit_logs_no_update
      BEFORE UPDATE ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

    DROP TRIGGER IF EXISTS audit_logs_no_delete ON audit_logs;
    CREATE TRIGGER audit_logs_no_delete
      BEFORE DELETE ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

    DROP TRIGGER IF EXISTS audit_logs_no_truncate ON audit_logs;
    CREATE TRIGGER audit_logs_no_truncate
      BEFORE TRUNCATE ON audit_logs
      FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_no_truncate();
  END IF;
END;
$$;
