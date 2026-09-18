-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Create security_checks table for security validation and vulnerability tracking
CREATE TABLE IF NOT EXISTS security_checks (
  id SERIAL PRIMARY KEY,
  check_type VARCHAR(100) NOT NULL,
  -- Types: 'password_strength', 'sql_injection', 'cors_validation', 'headers_validation', 'rate_limiting'
  status VARCHAR(50) NOT NULL,
  -- Status: 'pass', 'fail', 'warning'
  severity VARCHAR(50) NOT NULL,
  -- Severity: 'critical', 'high', 'medium', 'low'
  message TEXT NOT NULL,
  -- What was found (e.g., "CORS origin not validated")
  recommendation TEXT,
  -- How to fix it
  affected_resource VARCHAR(255),
  -- What was affected (e.g., "/api/users" or "password_hash_column")
  checked_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_security_checks_status ON security_checks(status);
CREATE INDEX IF NOT EXISTS idx_security_checks_severity ON security_checks(severity);
CREATE INDEX IF NOT EXISTS idx_security_checks_checked_at ON security_checks(checked_at DESC);
