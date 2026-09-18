-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 120 — Generic sales quotes (light CPQ): a line-item quote builder for
-- generic / jcp / rin orgs. Backs routes/salesQuoteRoutes.js + the frontend
-- QuoteBuilder / Products pages.
--
-- NAMING: these tables are `sales_quotes` / `sales_quote_items` specifically to
-- avoid colliding with the bespoke Zang customer-quote workflow, which owns
-- `quotes` / `quote_line_items` / `quote_revisions`. The two surfaces are fully
-- independent (different routes, different feature flag, different PDF).
--
-- MONEY IS SERVER-AUTHORITATIVE: subtotal, discount, tax, and total are always
-- recomputed on the backend from the line items + the quote-level discount and
-- tax_rate inputs (services/salesQuotes.computeTotals). The client-sent totals
-- are never trusted; these columns are the persisted result of that recompute.
--   subtotal      = Σ line_total
--   line_total    = round(quantity × unit_price × (1 − discount_pct/100))
--   discount      = quote-level absolute discount amount (clamped to subtotal)
--   tax           = round((subtotal − discount) × tax_rate/100)
--   total         = subtotal − discount + tax
--
-- Scoping mirrors every other tenant table: org_id primary, user_id fallback.
-- deal_id / customer_id are OPTIONAL links (a quote can stand alone).
--
-- Idempotent (CREATE TABLE / INDEX IF NOT EXISTS) so the startup runner's
-- 42P07/42710 "already exists" swallow never trips and re-runs are no-ops.

BEGIN;

CREATE TABLE IF NOT EXISTS sales_quotes (
  id          SERIAL PRIMARY KEY,
  org_id      INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  deal_id     INTEGER REFERENCES deals(id) ON DELETE SET NULL,
  customer_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  title       VARCHAR(255),
  status      VARCHAR(32) NOT NULL DEFAULT 'draft',
  currency    VARCHAR(8) NOT NULL DEFAULT 'USD',
  notes       TEXT,
  subtotal    NUMERIC(15, 2) NOT NULL DEFAULT 0,
  discount    NUMERIC(15, 2) NOT NULL DEFAULT 0,
  tax_rate    NUMERIC(6, 3)  NOT NULL DEFAULT 0,
  tax         NUMERIC(15, 2) NOT NULL DEFAULT 0,
  total       NUMERIC(15, 2) NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sales_quotes_org_id   ON sales_quotes(org_id);
CREATE INDEX IF NOT EXISTS idx_sales_quotes_user_id  ON sales_quotes(user_id);
CREATE INDEX IF NOT EXISTS idx_sales_quotes_deal_id  ON sales_quotes(deal_id);

CREATE TABLE IF NOT EXISTS sales_quote_items (
  id           SERIAL PRIMARY KEY,
  quote_id     INTEGER NOT NULL REFERENCES sales_quotes(id) ON DELETE CASCADE,
  product_id   INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name         VARCHAR(255) NOT NULL,
  quantity     NUMERIC(15, 3) NOT NULL DEFAULT 1,
  unit_price   NUMERIC(15, 2) NOT NULL DEFAULT 0,
  discount_pct NUMERIC(6, 3)  NOT NULL DEFAULT 0,
  line_total   NUMERIC(15, 2) NOT NULL DEFAULT 0,
  position     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sales_quote_items_quote_id ON sales_quote_items(quote_id);

COMMIT;
