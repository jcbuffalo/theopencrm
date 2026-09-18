-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Phase 1.4 — Purchase Order as a first-class entity (with line items + versions)
--
-- A PO is what we issue to a vendor after a customer quote is accepted. One
-- customer Quote can result in multiple POs (split across vendors), and a PO
-- has line items that get consumed by Invoice_Allocations downstream.
--
-- Same versioning fix as RFQ: line_items_snapshot JSONB.
-- Same `quotes` table FK already exists — Quote → POs is 1:N.

CREATE TABLE IF NOT EXISTS purchase_orders (
  id            BIGSERIAL PRIMARY KEY,
  org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id       INTEGER REFERENCES deals(id) ON DELETE CASCADE,
  quote_id      INTEGER REFERENCES quotes(id) ON DELETE SET NULL,
  -- The vendor the PO is issued to.
  vendor_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  status        VARCHAR(30) NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','sent','acknowledged','released','received','cancelled')),
  po_number     VARCHAR(100),
  external_ref  VARCHAR(100),
  current_version INTEGER NOT NULL DEFAULT 1,
  sent_at       TIMESTAMP,
  acknowledged_at TIMESTAMP,
  released_at   TIMESTAMP,
  -- public_id for outbound integrations (vendor portal links, signed PDFs).
  public_id     UUID NOT NULL DEFAULT gen_random_uuid(),
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  entity_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_org_id    ON purchase_orders(org_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_deal_id   ON purchase_orders(deal_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_quote_id  ON purchase_orders(quote_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_vendor_id ON purchase_orders(vendor_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status    ON purchase_orders(status);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_purchase_orders_public_id ON purchase_orders(public_id);

CREATE TABLE IF NOT EXISTS purchase_order_line_items (
  id              BIGSERIAL PRIMARY KEY,
  org_id          INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  description     TEXT NOT NULL,
  quantity        INTEGER NOT NULL DEFAULT 1,
  unit_cost       DECIMAL(15, 2),
  sku             VARCHAR(100),
  position        INTEGER DEFAULT 0,
  -- Allocation tracking (denormalized for fast queries; canonical source is
  -- invoice_allocations rows summed for this line).
  quantity_invoiced  INTEGER NOT NULL DEFAULT 0,
  amount_invoiced    DECIMAL(15, 2) NOT NULL DEFAULT 0,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  entity_version  INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_po_line_items_org_id ON purchase_order_line_items(org_id);
CREATE INDEX IF NOT EXISTS idx_po_line_items_po_id  ON purchase_order_line_items(purchase_order_id);

CREATE TABLE IF NOT EXISTS purchase_order_versions (
  id            BIGSERIAL PRIMARY KEY,
  org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  notes         TEXT,
  line_items_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata_snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(purchase_order_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_po_versions_org_id ON purchase_order_versions(org_id);
CREATE INDEX IF NOT EXISTS idx_po_versions_po_id  ON purchase_order_versions(purchase_order_id);
