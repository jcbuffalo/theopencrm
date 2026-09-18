-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Phase 1.3 — RFQ as a first-class entity (with line items + versions)
--
-- WHY: the current schema embeds RFQ-like state in deals.stage and
-- vendor_quotes. The proposal correctly separates RFQ as its own lifecycle:
-- one deal can spawn multiple RFQs (different vendors, different revisions),
-- and an RFQ is the artifact you actually send to a vendor.
--
-- VERSIONING: line_items_snapshot JSONB is the FIX for the proposal's broken
-- versioning model. The proposal had RFQ_Version reference RFQ_Line_Items by
-- parent FK, meaning "v1's line items" and "v2's line items" both pointed to
-- the same current state — the version row didn't actually capture history.
-- Snapshot JSONB makes each version self-contained.

CREATE TABLE IF NOT EXISTS rfqs (
  id            BIGSERIAL PRIMARY KEY,
  org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id       INTEGER REFERENCES deals(id) ON DELETE CASCADE,
  -- The customer the RFQ is on behalf of (a Company with role='customer').
  customer_id   INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  -- The vendor the RFQ was sent to (a Company with role='vendor').
  vendor_id     INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  status        VARCHAR(30) NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','sent','responded','closed','cancelled')),
  title         VARCHAR(255),
  description   TEXT,
  external_ref  VARCHAR(100),
  current_version INTEGER NOT NULL DEFAULT 1,
  sent_at       TIMESTAMP,
  responded_at  TIMESTAMP,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  entity_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_rfqs_org_id      ON rfqs(org_id);
CREATE INDEX IF NOT EXISTS idx_rfqs_deal_id     ON rfqs(deal_id);
CREATE INDEX IF NOT EXISTS idx_rfqs_customer_id ON rfqs(customer_id);
CREATE INDEX IF NOT EXISTS idx_rfqs_vendor_id   ON rfqs(vendor_id);
CREATE INDEX IF NOT EXISTS idx_rfqs_status      ON rfqs(status);

CREATE TABLE IF NOT EXISTS rfq_line_items (
  id            BIGSERIAL PRIMARY KEY,
  org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rfq_id        INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  description   TEXT NOT NULL,
  quantity      INTEGER NOT NULL DEFAULT 1,
  notes         TEXT,
  position      INTEGER DEFAULT 0,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  entity_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_rfq_line_items_org_id ON rfq_line_items(org_id);
CREATE INDEX IF NOT EXISTS idx_rfq_line_items_rfq_id ON rfq_line_items(rfq_id);

CREATE TABLE IF NOT EXISTS rfq_versions (
  id            BIGSERIAL PRIMARY KEY,
  org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rfq_id        INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  notes         TEXT,
  -- Self-contained snapshot of the line items at this version. See FIX note
  -- at top of file.
  line_items_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata_snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(rfq_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_rfq_versions_org_id ON rfq_versions(org_id);
CREATE INDEX IF NOT EXISTS idx_rfq_versions_rfq_id ON rfq_versions(rfq_id);
