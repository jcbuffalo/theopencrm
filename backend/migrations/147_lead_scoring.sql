-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 147: Lead scoring + routing.
--
-- 1. leads.score — the computed score, recomputed on create and on every
--    update (services/leadScoring.js is the only writer of the value).
-- 2. lead_scoring_rules — org-authored {field, op, value} → points rules.
--    field/op are STRICT-allowlisted in services/leadScoring.js (mirroring
--    the segments.js compiler contract): field ∈ [source, title,
--    company_name, has_email, has_phone], op ∈ [eq, contains, exists].
--    Values are matched in JS against already-fetched lead fields — rule
--    text NEVER reaches SQL. A rule may optionally ROUTE: when
--    route_to_user_id is set, a matching rule (subject to min_score)
--    assigns the lead to that user instead of round-robin.
--
-- Idempotent: safe to re-run (IF NOT EXISTS throughout).

ALTER TABLE leads ADD COLUMN IF NOT EXISTS score INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS lead_scoring_rules (
  id SERIAL PRIMARY KEY,
  org_id INTEGER,                      -- tenancy (user_id fallback, same convention as leads)
  user_id INTEGER,
  field VARCHAR(32) NOT NULL,          -- allowlisted in services/leadScoring.js
  op VARCHAR(16) NOT NULL,             -- allowlisted in services/leadScoring.js
  value VARCHAR(255),                  -- matched as data, never as SQL
  points INTEGER NOT NULL DEFAULT 0,
  route_to_user_id INTEGER,            -- optional routing target (validated in-org at write AND at pick time)
  min_score INTEGER,                   -- optional routing threshold: route only when lead score >= min_score
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lead_scoring_rules_org_active
  ON lead_scoring_rules (org_id, is_active);
CREATE INDEX IF NOT EXISTS idx_lead_scoring_rules_user
  ON lead_scoring_rules (user_id);
