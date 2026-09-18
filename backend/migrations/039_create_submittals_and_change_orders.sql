-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

CREATE TABLE IF NOT EXISTS submittals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  version INTEGER DEFAULT 1,
  type VARCHAR(50) DEFAULT 'drawing',
  status VARCHAR(50) DEFAULT 'pending_vendor',
  notes TEXT,
  approved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_submittals_deal_id ON submittals(deal_id);
CREATE INDEX IF NOT EXISTS idx_submittals_status ON submittals(status);

CREATE TABLE IF NOT EXISTS change_orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  number INTEGER DEFAULT 1,
  description TEXT,
  amount_delta DECIMAL(15, 2),
  status VARCHAR(50) DEFAULT 'pending',
  approved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_change_orders_deal_id ON change_orders(deal_id);
