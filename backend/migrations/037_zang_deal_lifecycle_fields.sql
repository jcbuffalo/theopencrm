-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

ALTER TABLE deals ADD COLUMN IF NOT EXISTS phase VARCHAR(20) DEFAULT 'pre_sale';
ALTER TABLE deals ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS po_number VARCHAR(100);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS ship_to TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS poc_name VARCHAR(255);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS poc_email VARCHAR(255);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS poc_phone VARCHAR(40);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS target_ship_date DATE;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS actual_ship_date DATE;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS hot_flag BOOLEAN DEFAULT FALSE;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS release_status VARCHAR(20) DEFAULT 'released';
ALTER TABLE deals ADD COLUMN IF NOT EXISTS hold_reason TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_deals_phase ON deals(phase);
CREATE INDEX IF NOT EXISTS idx_deals_hot_flag ON deals(hot_flag);
CREATE INDEX IF NOT EXISTS idx_deals_last_activity_at ON deals(last_activity_at);
