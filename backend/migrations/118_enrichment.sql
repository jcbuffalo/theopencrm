-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 118 — Contact / company data enrichment cache.
--
-- Backs services/enrichment.js. A row is a cached provider response keyed by a
-- normalized lookup value (a contact's lower/trimmed email, or a company's bare
-- domain). Serving from cache lets us skip a paid provider call — and a request
-- credit — when the same email/domain was enriched recently.
--
-- Scoping mirrors every other tenant table: org_id is the primary scope, with a
-- NULL org_id for user_id-scoped (no-org) callers per the qs(req) convention.
-- We do NOT add columns to contacts/companies: accepted enrichment fields are
-- merged into their existing custom_fields JSONB under enrichment_* keys, so the
-- cache is the only new schema surface.
--
--   entity_type — 'contact' | 'company'
--   key         — the normalized email (contact) or domain (company) the lookup
--                 was keyed on
--   provider    — which provider produced the row (ENRICHMENT_PROVIDER)
--   data        — the raw, un-normalized provider payload (JSONB). The service
--                 normalizes it to a stable shape on read, so re-normalization
--                 improvements apply to already-cached rows.
--
-- Idempotent (CREATE TABLE / INDEX IF NOT EXISTS) so the startup runner's
-- 42P07/42710 "already exists" swallow never trips and re-runs are no-ops.

CREATE TABLE IF NOT EXISTS enrichment_cache (
  id          SERIAL PRIMARY KEY,
  org_id      INT,
  entity_type VARCHAR(32) NOT NULL,
  key         TEXT NOT NULL,
  provider    VARCHAR(64),
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_enrichment_cache_lookup
  ON enrichment_cache (org_id, entity_type, key);
