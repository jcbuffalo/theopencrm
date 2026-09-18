-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Relationship Pulse — migration 124.
--
-- Lightweight NPS / CSAT survey capture per account (company). A "pulse" is a
-- single satisfaction reading a user records after a call / QBR / renewal
-- conversation: a score, an optional contact + comment, and a timestamp. The
-- history trends relationship sentiment over time; the LATEST pulse per company
-- feeds the Accounts rollup as a health SIGNAL alongside (never replacing) the
-- rules-based account_health_snapshots band (migration 095).
--
-- SCORE SCALE: always stored 0–10 (the NPS scale). CSAT responses (1–5) are
-- normalized to 0–10 by the API layer on write (see
-- services/relationshipPulse.js) so banding math has exactly one scale:
--   9–10 promoter/green · 7–8 passive/amber · 0–6 detractor/red.
-- `kind` records what the respondent was actually asked (nps|csat) so the UI
-- can label honestly. Allowed kinds are enforced in the API layer (not a CHECK)
-- so the allowlist can evolve without a migration — the score range IS checked
-- here because the stored 0–10 scale is a permanent invariant.
--
-- Append-only by design (like account_health_snapshots): pulses are readings,
-- not mutable state, so the trend can't be rewritten.
--
-- Index on (org_id, company_id, created_at): every read path is "latest/history
-- for a company within an org, newest first" — this composite matches it.
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS. The
-- startup runner hard-fails on 42P07 / 42710, so do not remove the guards.

BEGIN;

CREATE TABLE IF NOT EXISTS relationship_pulses (
  id           SERIAL       PRIMARY KEY,
  org_id       INTEGER      REFERENCES organizations(id) ON DELETE CASCADE,
  user_id      INTEGER      REFERENCES users(id)         ON DELETE SET NULL,
  company_id   INTEGER      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id   INTEGER      REFERENCES contacts(id)      ON DELETE SET NULL,
  score        INTEGER      NOT NULL CHECK (score >= 0 AND score <= 10),
  kind         VARCHAR(16)  DEFAULT 'nps',
  comment      TEXT,
  recorded_by  INTEGER      REFERENCES users(id)         ON DELETE SET NULL,
  created_at   TIMESTAMP    DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_relationship_pulses_org_company_created
  ON relationship_pulses(org_id, company_id, created_at);

COMMENT ON TABLE relationship_pulses IS
  'Append-only NPS/CSAT pulses per account. Score always stored on the 0-10 scale (CSAT 1-5 normalized on write); kind records the question asked. Latest pulse per company feeds the Accounts rollup as a health signal. See services/relationshipPulse.js and migration 124.';

COMMIT;
