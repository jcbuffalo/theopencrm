-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Phase 1.5 — Invoice as a first-class entity + Invoice Allocation (the
-- single most valuable pattern from the proposal)
--
-- An Invoice represents a customer-facing bill. It has line items, versions
-- (with snapshot — same versioning fix), and crucially: each invoice line
-- "consumes" some quantity/amount from a Purchase_Order_Line_Item via the
-- Invoice_Allocation join table.
--
-- This lets us model partial fulfillment: a single PO line for 100 widgets
-- can result in three invoices (40 + 30 + 30 widgets), each allocating a
-- portion of the PO line. Sum of allocations against a PO line cannot exceed
-- the PO line's quantity (enforced in app layer + a CHECK we'll add later
-- once data shape is verified).

CREATE TABLE IF NOT EXISTS invoices (
  id            BIGSERIAL PRIMARY KEY,
  org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id       INTEGER REFERENCES deals(id) ON DELETE CASCADE,
  customer_id   INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  status        VARCHAR(30) NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','sent','partial','paid','void','overdue')),
  invoice_number VARCHAR(100),
  external_ref  VARCHAR(100),
  -- Total amount on the invoice itself; canonical source for allocation
  -- consistency is sum of allocation amounts.
  total_amount  DECIMAL(15, 2),
  due_date      DATE,
  paid_at       TIMESTAMP,
  current_version INTEGER NOT NULL DEFAULT 1,
  -- public_id for outbound (signed PDF, customer payment portal links).
  public_id     UUID NOT NULL DEFAULT gen_random_uuid(),
  -- QuickBooks linkage when the invoice has been pushed.
  quickbooks_id VARCHAR(100),
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  entity_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_invoices_org_id      ON invoices(org_id);
CREATE INDEX IF NOT EXISTS idx_invoices_deal_id     ON invoices(deal_id);
CREATE INDEX IF NOT EXISTS idx_invoices_customer_id ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status      ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date    ON invoices(due_date);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_invoices_public_id ON invoices(public_id);

CREATE TABLE IF NOT EXISTS invoice_line_items (
  id            BIGSERIAL PRIMARY KEY,
  org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id    INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description   TEXT NOT NULL,
  quantity      INTEGER NOT NULL DEFAULT 1,
  unit_price    DECIMAL(15, 2),
  amount        DECIMAL(15, 2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  position      INTEGER DEFAULT 0,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  entity_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_invoice_line_items_org_id     ON invoice_line_items(org_id);
CREATE INDEX IF NOT EXISTS idx_invoice_line_items_invoice_id ON invoice_line_items(invoice_id);

CREATE TABLE IF NOT EXISTS invoice_versions (
  id            BIGSERIAL PRIMARY KEY,
  org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id    INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  notes         TEXT,
  line_items_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata_snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(invoice_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_invoice_versions_org_id     ON invoice_versions(org_id);
CREATE INDEX IF NOT EXISTS idx_invoice_versions_invoice_id ON invoice_versions(invoice_id);

-- The pattern that makes this all worthwhile: one invoice line consumes
-- (allocates against) one PO line. Many-to-many because an invoice line can
-- pull from multiple POs (rare but possible) and a PO line can be split
-- across multiple invoices (common — partial shipments).
CREATE TABLE IF NOT EXISTS invoice_allocations (
  id            BIGSERIAL PRIMARY KEY,
  org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id    INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  invoice_line_item_id INTEGER REFERENCES invoice_line_items(id) ON DELETE CASCADE,
  purchase_order_line_item_id INTEGER NOT NULL REFERENCES purchase_order_line_items(id) ON DELETE RESTRICT,
  allocated_quantity DECIMAL(15, 4) NOT NULL DEFAULT 0,
  allocated_amount   DECIMAL(15, 2) NOT NULL DEFAULT 0,
  notes         TEXT,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  entity_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_invoice_alloc_org_id     ON invoice_allocations(org_id);
CREATE INDEX IF NOT EXISTS idx_invoice_alloc_invoice    ON invoice_allocations(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_alloc_invoice_li ON invoice_allocations(invoice_line_item_id);
CREATE INDEX IF NOT EXISTS idx_invoice_alloc_po_li      ON invoice_allocations(purchase_order_line_item_id);
