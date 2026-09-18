-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 119 — Product catalog: reusable priced line items for the generic light-CPQ
-- quote builder (routes/productRoutes.js + routes/salesQuoteRoutes.js).
--
-- This is the GENERIC quoting catalog for generic / jcp / rin orgs. It is
-- deliberately separate from the bespoke Zang quotes workflow (the `quotes`,
-- `quote_line_items`, `quote_revisions` tables) — no name collision.
--
-- Scoping mirrors every other tenant table: org_id is the primary scope with
-- user_id as the fallback for org-less personal workspaces (the qs(req)
-- convention). unit_price is NUMERIC (money) — the server is authoritative for
-- all totals; the catalog price is only the default a quote line starts from.
--
-- Idempotent (CREATE TABLE / INDEX IF NOT EXISTS) so the startup runner's
-- 42P07/42710 "already exists" swallow never trips and re-runs are no-ops.

BEGIN;

CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  org_id      INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  sku         VARCHAR(120),
  description TEXT,
  unit_price  NUMERIC(15, 2) NOT NULL DEFAULT 0,
  unit        VARCHAR(40) NOT NULL DEFAULT 'each',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Primary read path is "active catalog for this org".
CREATE INDEX IF NOT EXISTS idx_products_org_active ON products(org_id, active);
CREATE INDEX IF NOT EXISTS idx_products_user_id    ON products(user_id);

COMMIT;
