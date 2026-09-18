-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Phase 1.1 — Address as a first-class entity, Company_Role for multi-role support
--
-- WHY: the proposal models Address as a separate entity so a company can have
-- billing/shipping/warehouse addresses cleanly. The current schema has inline
-- city/state on contacts only. This migration adds the table without dropping
-- existing inline fields (back-compat).
--
-- Company_Role lets one company act as both customer AND vendor — common in
-- B2B (a vendor that also buys finished goods from us). The existing
-- `companies.type` column ('customer' | 'vendor') stays as the primary role
-- for back-compat; this table layers multi-role on top when needed.
--
-- White-label note: enum value 'internal' (not 'zang') represents the
-- operating org's own legal entity. Each org's branding profile labels it
-- ("Zang Inc.", "Acme Corp", etc.).

CREATE TABLE IF NOT EXISTS addresses (
  id            BIGSERIAL PRIMARY KEY,
  org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id    INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  contact_id    INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  type          VARCHAR(20) NOT NULL DEFAULT 'primary'
                  CHECK (type IN ('primary','billing','shipping','warehouse','other')),
  street1       VARCHAR(200) NOT NULL,
  street2       VARCHAR(200),
  city          VARCHAR(100) NOT NULL,
  state         VARCHAR(100),
  postal_code   VARCHAR(36),
  country       VARCHAR(36),
  is_default    BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  entity_version INTEGER NOT NULL DEFAULT 1,
  -- One of company_id or contact_id must be set; both can be set if this is a
  -- contact's address that also belongs to their company (rare but legal).
  CONSTRAINT addresses_owner_required CHECK (company_id IS NOT NULL OR contact_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_addresses_org_id     ON addresses(org_id);
CREATE INDEX IF NOT EXISTS idx_addresses_company_id ON addresses(company_id);
CREATE INDEX IF NOT EXISTS idx_addresses_contact_id ON addresses(contact_id);

CREATE TABLE IF NOT EXISTS company_roles (
  id            BIGSERIAL PRIMARY KEY,
  org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role          VARCHAR(20) NOT NULL
                  CHECK (role IN ('customer','vendor','internal','partner','prospect')),
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  entity_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(company_id, role)
);

CREATE INDEX IF NOT EXISTS idx_company_roles_org_id     ON company_roles(org_id);
CREATE INDEX IF NOT EXISTS idx_company_roles_company_id ON company_roles(company_id);
CREATE INDEX IF NOT EXISTS idx_company_roles_role       ON company_roles(role);
