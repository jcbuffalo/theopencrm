-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- §4.4 / §4.5 completeness: end-user tracking, buy-back, delivery checklist,
-- service contracts. Plus a few small fields used by the comprehensive
-- reporting endpoints.

-- End user (the person who will actually use the product) — separate from the
-- direct customer/POC since reps often sell through distributors.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS end_user_company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS end_user_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL;

-- Buy-back: a separate lifecycle status that lives outside the main stage.
-- 'none' (default), 'eligible', 'requested', 'approved', 'completed'
ALTER TABLE deals ADD COLUMN IF NOT EXISTS buy_back_status VARCHAR(20) DEFAULT 'none';
ALTER TABLE deals ADD COLUMN IF NOT EXISTS buy_back_amount DECIMAL(15, 2);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS buy_back_notes TEXT;

-- Delivery checklist: free-form JSON. Front-end provides a default template;
-- operators can extend per deal.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS delivery_checklist JSONB DEFAULT '[]'::jsonb;

-- Class / Size / Product (fielded for filters per Exhibit A)
ALTER TABLE deals ADD COLUMN IF NOT EXISTS deal_class VARCHAR(50);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS deal_size VARCHAR(50);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS product VARCHAR(255);

-- Office / location attribution per deal — for "BY OFFICE LOCATION" filter.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS office_location VARCHAR(100);

-- "Last activity" of a customer is derived from the latest deal/activity
-- timestamp; we don't denormalize it onto companies. But for filtering "new
-- customer" we want to know when the customer was first associated with a deal.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS first_deal_at TIMESTAMP;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_deal_at TIMESTAMP;

-- Backfill first/last deal dates so the "new" / "dormant" customer filters
-- work on existing data. This is a one-shot computation; future updates are
-- handled by the deal create/update routes.
UPDATE companies c SET
  first_deal_at = sub.first_at,
  last_deal_at  = sub.last_at
FROM (
  SELECT customer_id, MIN(created_at) AS first_at, MAX(updated_at) AS last_at
  FROM deals WHERE customer_id IS NOT NULL
  GROUP BY customer_id
) sub
WHERE c.id = sub.customer_id AND c.first_deal_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_companies_first_deal_at ON companies(first_deal_at);
CREATE INDEX IF NOT EXISTS idx_companies_last_deal_at ON companies(last_deal_at);
CREATE INDEX IF NOT EXISTS idx_deals_office_location ON deals(office_location);
CREATE INDEX IF NOT EXISTS idx_deals_buy_back_status ON deals(buy_back_status);

-- Service contracts. Linked to a customer org and (optionally) a deal that
-- generated the contract. Renewal cron flags contracts within
-- renewal_notice_days of end_date.
CREATE TABLE IF NOT EXISTS service_contracts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  customer_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  deal_id INTEGER REFERENCES deals(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  contract_type VARCHAR(50) DEFAULT 'service',
  start_date DATE,
  end_date DATE,
  renewal_notice_days INTEGER DEFAULT 30,
  status VARCHAR(20) DEFAULT 'active',
  monthly_amount DECIMAL(15, 2),
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_service_contracts_org_id ON service_contracts(org_id);
CREATE INDEX IF NOT EXISTS idx_service_contracts_customer_id ON service_contracts(customer_id);
CREATE INDEX IF NOT EXISTS idx_service_contracts_status ON service_contracts(status);
CREATE INDEX IF NOT EXISTS idx_service_contracts_end_date ON service_contracts(end_date);

-- Saved filters per user — each row is a named filter set the user can
-- one-click apply on Deals/Issues/etc.
CREATE TABLE IF NOT EXISTS saved_filters (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  scope VARCHAR(50) NOT NULL,
  name VARCHAR(255) NOT NULL,
  filters JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_saved_filters_user_scope ON saved_filters(user_id, scope);
