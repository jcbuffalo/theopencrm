-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 145 — Deal line items: products/quantities attached directly to a deal that
-- roll up into deals.amount (routes/dealLineItemRoutes.js).
--
-- RELATIONSHIP TO THE CPQ QUOTE ITEMS (migration 120): deliberately a SEPARATE
-- model. `sales_quote_items` belong to a quote document (a point-in-time offer
-- with quote-level discount + tax); `deal_line_items` are the deal's OWN
-- current composition and drive the deal's headline amount. A deal may carry
-- both (e.g. several quote revisions plus its final agreed line-up). We are NOT
-- unifying them now — both reference the same `products` catalog (119), and a
-- future pass could add a "copy quote items → deal" action.
--
-- MONEY IS INTEGER CENTS, SERVER-AUTHORITATIVE (services/dealLineItems.js):
--   line_total_cents = round(quantity × unit_price_cents)
-- and on every line-item mutation the backend recomputes
--   deals.amount = Σ line_total_cents / 100   (deals.amount is NUMERIC dollars)
-- Client-sent line totals are never trusted. Deals with NO line items keep
-- their manually-set amount — the rollup only fires while line items exist.
--
-- Scoping mirrors every other tenant table: org_id primary, user_id fallback
-- (the qs(req) convention). deal_id cascades so deleting a deal removes its
-- lines; product_id is a soft link (SET NULL) because the description/price
-- are snapshotted onto the line.
--
-- Idempotent (CREATE TABLE / INDEX IF NOT EXISTS) so the startup runner's
-- 42P07/42710 "already exists" swallow never trips and re-runs are no-ops.

BEGIN;

CREATE TABLE IF NOT EXISTS deal_line_items (
  id               SERIAL PRIMARY KEY,
  org_id           INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          INTEGER REFERENCES users(id) ON DELETE CASCADE,
  deal_id          INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  product_id       INTEGER REFERENCES products(id) ON DELETE SET NULL,
  description      VARCHAR(500) NOT NULL,
  quantity         NUMERIC(15, 3) NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  line_total_cents INTEGER NOT NULL DEFAULT 0,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Primary read path is "this org's lines for this deal".
CREATE INDEX IF NOT EXISTS idx_deal_line_items_org_deal ON deal_line_items(org_id, deal_id);
CREATE INDEX IF NOT EXISTS idx_deal_line_items_deal_id  ON deal_line_items(deal_id);
CREATE INDEX IF NOT EXISTS idx_deal_line_items_user_id  ON deal_line_items(user_id);

COMMIT;
