-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Create Contacts table
CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(20),
  job_title VARCHAR(100),
  status VARCHAR(50) DEFAULT 'prospect',
  ai_summary TEXT,
  ai_next_action VARCHAR(255),
  notes TEXT,
  tags VARCHAR(255)[],
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ADD COLUMN IF NOT EXISTS for every column 021 introduces over 010_create_contacts.sql.
-- On a fresh DB where 010 ran first (CI migration smoke), the CREATE TABLE IF NOT EXISTS
-- above is skipped and the table is missing these columns. Without these ALTERs, the
-- CREATE INDEX on company_id below fails "column does not exist" under
-- psql -v ON_ERROR_STOP=1. Prod escaped this because 021 ran before 010 historically.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ai_summary TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ai_next_action VARCHAR(255);

-- IF NOT EXISTS added 2026-05-16: on prod, migration 010 already created
-- this table + indexes, so 021's plain CREATE INDEX threw "already exists"
-- every container startup. The old behavior caught + logged + kept serving;
-- the new hard-fail migration runner (commit 13055b8) turned that silent
-- loop into a crash loop. With the IF NOT EXISTS guard, 021 finally runs
-- clean, records itself in the migrations table, and never retries.
CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_company_id ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
