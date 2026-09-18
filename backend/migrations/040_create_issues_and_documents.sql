-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

CREATE TABLE IF NOT EXISTS issues (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  related_type VARCHAR(20),
  related_id INTEGER,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(50),
  sub_category VARCHAR(100),
  urgency VARCHAR(20) DEFAULT 'green',
  financial_impact VARCHAR(50),
  blocks_workflow BOOLEAN DEFAULT FALSE,
  status VARCHAR(50) DEFAULT 'open',
  assigned_to_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolution_notes TEXT,
  resolved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_issues_org_id ON issues(org_id);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_urgency ON issues(urgency);
CREATE INDEX IF NOT EXISTS idx_issues_related ON issues(related_type, related_id);
CREATE INDEX IF NOT EXISTS idx_issues_assigned_to ON issues(assigned_to_user_id);

CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  related_type VARCHAR(20),
  related_id INTEGER,
  doc_type VARCHAR(50),
  filename VARCHAR(255) NOT NULL,
  url VARCHAR(1000),
  content BYTEA,
  size INTEGER,
  mime_type VARCHAR(100),
  notes TEXT,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_documents_org_id ON documents(org_id);
CREATE INDEX IF NOT EXISTS idx_documents_related ON documents(related_type, related_id);
CREATE INDEX IF NOT EXISTS idx_documents_doc_type ON documents(doc_type);
