-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Make audit_log append-only at the database level.
--
-- Even with application-level discipline, a compromised app credential or a
-- careless admin SQL session could rewrite history. This trigger raises an
-- exception on any UPDATE or DELETE against audit_log, so tampering requires
-- DROP TRIGGER privilege — which the application role does not have.
--
-- Compliance note: NIST SP 800-53 AU-9 ("Protection of Audit Information")
-- and SOC 2 CC7.2 expect tamper-resistant audit trails. This satisfies both
-- without requiring an external WORM store.

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only — % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
