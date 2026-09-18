-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Create playstore_compliance table for app store and legal compliance tracking
CREATE TABLE IF NOT EXISTS playstore_compliance (
  id SERIAL PRIMARY KEY,
  compliance_category VARCHAR(100) NOT NULL,
  -- Categories: 'data_privacy', 'policy', 'content_rating', 'permissions', 'gdpr', 'data_deletion'
  requirement_id VARCHAR(50) NOT NULL UNIQUE,
  -- Unique ID for tracking (e.g., 'PS-001', 'GDPR-001', 'CCPA-002')
  requirement_text TEXT NOT NULL,
  -- Full text of the requirement
  status VARCHAR(50) NOT NULL DEFAULT 'unchecked',
  -- Status: 'pass', 'fail', 'warning', 'unchecked'
  evidence TEXT,
  -- Documentation/link/file proving compliance (e.g., URL to privacy policy, evidence of feature implementation)
  notes TEXT,
  -- Additional notes or context
  reviewed_by_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  -- Which admin last reviewed this
  reviewed_at TIMESTAMP,
  -- When was it last reviewed
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_playstore_compliance_category ON playstore_compliance(compliance_category);
CREATE INDEX IF NOT EXISTS idx_playstore_compliance_status ON playstore_compliance(status);
CREATE INDEX IF NOT EXISTS idx_playstore_compliance_requirement_id ON playstore_compliance(requirement_id);
CREATE INDEX IF NOT EXISTS idx_playstore_compliance_reviewed_at ON playstore_compliance(reviewed_at DESC);
