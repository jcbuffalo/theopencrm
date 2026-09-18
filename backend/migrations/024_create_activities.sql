-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Create Activities table
CREATE TABLE IF NOT EXISTS activities (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id INTEGER REFERENCES deals(id) ON DELETE SET NULL,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  activity_date TIMESTAMP NOT NULL,
  duration_minutes INTEGER,
  outcome VARCHAR(100),
  ai_summary TEXT,
  ai_action_items TEXT,
  ai_next_steps TEXT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ADD COLUMN IF NOT EXISTS for every column 024 introduces over 012_create_activities.sql.
-- See sibling note in 021_create_contacts.sql for why.
ALTER TABLE activities ADD COLUMN IF NOT EXISTS ai_summary TEXT;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS ai_action_items TEXT;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS ai_next_steps TEXT;

-- IF NOT EXISTS on every index — 012 created idx_activities_user_id / _contact_id /
-- _deal_id / _type / _date (without IF NOT EXISTS) so plain CREATE INDEX would throw
-- "already exists" on a DB that already ran 012.
CREATE INDEX IF NOT EXISTS idx_activities_user_id ON activities(user_id);
CREATE INDEX IF NOT EXISTS idx_activities_contact_id ON activities(contact_id);
CREATE INDEX IF NOT EXISTS idx_activities_deal_id ON activities(deal_id);
CREATE INDEX IF NOT EXISTS idx_activities_type ON activities(type);
CREATE INDEX IF NOT EXISTS idx_activities_activity_date ON activities(activity_date);
