-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Create Deals table
CREATE TABLE IF NOT EXISTS deals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  amount DECIMAL(15, 2),
  stage VARCHAR(50) DEFAULT 'lead',
  expected_close_date DATE,
  closed_date DATE,
  closed_amount DECIMAL(15, 2),
  ai_health_score INTEGER,
  ai_win_probability INTEGER,
  ai_risk_factors TEXT,
  notes TEXT,
  tags VARCHAR(255)[],
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ADD COLUMN IF NOT EXISTS for every column 023 introduces over 011_create_deals.sql.
-- See sibling note in 021_create_contacts.sql for why this is required for the strict
-- CI migration smoke (psql -v ON_ERROR_STOP=1).
ALTER TABLE deals ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS closed_amount DECIMAL(15, 2);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS ai_health_score INTEGER;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS ai_win_probability INTEGER;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS ai_risk_factors TEXT;

-- IF NOT EXISTS on every index — 011 created idx_deals_user_id / _stage / _expected_close
-- (without IF NOT EXISTS) so plain CREATE INDEX would throw "already exists" on a DB that
-- already ran 011. Idempotent now.
CREATE INDEX IF NOT EXISTS idx_deals_user_id ON deals(user_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);
CREATE INDEX IF NOT EXISTS idx_deals_company_id ON deals(company_id);
CREATE INDEX IF NOT EXISTS idx_deals_contact_id ON deals(contact_id);
CREATE INDEX IF NOT EXISTS idx_deals_expected_close ON deals(expected_close_date);
