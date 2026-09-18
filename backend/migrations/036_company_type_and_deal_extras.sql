-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'customer';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone VARCHAR(40);

ALTER TABLE deals ADD COLUMN IF NOT EXISTS vendor_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS salesman_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS vertical VARCHAR(100);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS lost_reason VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_companies_type ON companies(type);
CREATE INDEX IF NOT EXISTS idx_deals_vendor_id ON deals(vendor_id);
CREATE INDEX IF NOT EXISTS idx_deals_salesman_id ON deals(salesman_id);
