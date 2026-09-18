-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Customer appreciation queue (SOW §4.5c.ii — "Criteria-based task for sending
-- customer appreciation gift/thank you note. Should also allow for human
-- intervention to push something into the customer appreciation queue.")
--
-- Each row is one queued appreciation item: a thank-you note, gift, or
-- mailer aimed at a specific customer/contact, optionally linked to a deal.

CREATE TABLE IF NOT EXISTS appreciation_queue (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  customer_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id INTEGER REFERENCES deals(id) ON DELETE SET NULL,
  reason VARCHAR(100),
  -- Examples: 'project_completed', 'big_milestone', 'long_dormant_recovered', 'birthday', 'manual'
  gift_type VARCHAR(50),
  -- Examples: 'thank_you_note', 'gift_card', 'merchandise', 'flowers', 'phone_call', 'other'
  status VARCHAR(20) DEFAULT 'queued',
  -- Status: 'queued' | 'in_progress' | 'sent' | 'skipped'
  notes TEXT,
  scheduled_for DATE,
  completed_at TIMESTAMP,
  completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_appreciation_queue_org_id ON appreciation_queue(org_id);
CREATE INDEX IF NOT EXISTS idx_appreciation_queue_status ON appreciation_queue(status);
CREATE INDEX IF NOT EXISTS idx_appreciation_queue_customer ON appreciation_queue(customer_id);
