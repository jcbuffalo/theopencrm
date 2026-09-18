-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Drive Intel — Phase 2, migration 090.
--
-- Write-back-to-CRM-fields suggestions and audit trail.
--
-- After services/intelSummary.generate() produces a `deal_intel_summaries`
-- row, a follow-on pass (services/intelWriteback.proposeUpdates) asks
-- Claude to suggest concrete CRM updates against a tight allowlist of
-- writeable deal fields (stage / notes / expected_close_date). The user
-- sees the suggestions in a panel and clicks Apply/Reject per-row. Each
-- successful Apply writes a corresponding `deal_intel_writebacks` row so
-- the action is auditable and undoable for 7 days.
--
-- WHY two tables: a suggestion's lifecycle (proposed → accepted/rejected
-- → applied/stale) is distinct from the immutable record of "we wrote
-- field X from Y to Z at time T". Suggestions get superseded as the deal
-- evolves; writebacks are forensic history that NEVER mutates after the
-- initial INSERT (except for undone_at / undone_by_user_id on undo).
--
-- WHY current_value snapshot on the suggestion row: enables the
-- stale-data check at apply-time. If the live deal field no longer
-- matches the snapshot, the suggestion is marked 'stale' and the apply
-- fails with STALE_DATA. Prevents racing two users on the same deal.
--
-- WHY field CHECK constraint: belt-and-braces — the application layer
-- in services/intelWriteback.js already enforces an allowlist, but the
-- DB-level CHECK guarantees no rogue write path can shoehorn a non-
-- allowlisted field into the suggestions table.
--
-- IDEMPOTENT: re-running is a no-op.

BEGIN;

CREATE TABLE IF NOT EXISTS deal_intel_suggestions (
  id                    BIGSERIAL PRIMARY KEY,
  org_id                BIGINT      NOT NULL REFERENCES organizations(id)         ON DELETE CASCADE,
  deal_id               BIGINT      NOT NULL REFERENCES deals(id)                 ON DELETE CASCADE,
  summary_id            BIGINT      NOT NULL REFERENCES deal_intel_summaries(id)  ON DELETE CASCADE,
  field                 TEXT        NOT NULL
    CHECK (field IN ('stage', 'notes', 'expected_close_date')),
  current_value         JSONB,
  proposed_value        JSONB       NOT NULL,
  confidence            NUMERIC(4,3)
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  reason                TEXT,
  status                TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'applied', 'stale')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at            TIMESTAMPTZ,
  decided_by_user_id    BIGINT      REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_deal_intel_suggestions_deal_status
  ON deal_intel_suggestions(deal_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_deal_intel_suggestions_org
  ON deal_intel_suggestions(org_id);

COMMENT ON TABLE deal_intel_suggestions IS
  'Per-field CRM-update suggestions derived from a deal_intel_summaries row. Status moves pending → accepted/rejected → applied (or stale on live-data mismatch). See backend/services/intelWriteback.js.';

CREATE TABLE IF NOT EXISTS deal_intel_writebacks (
  id                    BIGSERIAL PRIMARY KEY,
  org_id                BIGINT      NOT NULL REFERENCES organizations(id)            ON DELETE CASCADE,
  deal_id               BIGINT      NOT NULL REFERENCES deals(id)                    ON DELETE CASCADE,
  suggestion_id         BIGINT      NOT NULL REFERENCES deal_intel_suggestions(id)   ON DELETE CASCADE,
  field                 TEXT        NOT NULL
    CHECK (field IN ('stage', 'notes', 'expected_close_date')),
  prior_value           JSONB,
  new_value             JSONB,
  applied_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_by_user_id    BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  undone_at             TIMESTAMPTZ,
  undone_by_user_id     BIGINT      REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_deal_intel_writebacks_deal_applied
  ON deal_intel_writebacks(deal_id, applied_at DESC);

CREATE INDEX IF NOT EXISTS idx_deal_intel_writebacks_org
  ON deal_intel_writebacks(org_id);

COMMENT ON TABLE deal_intel_writebacks IS
  'Immutable forensic log of applied CRM writebacks driven by an intel suggestion. Undo within UNDO_WINDOW_DAYS (7) flips undone_at/undone_by_user_id and restores prior_value onto the deal.';

COMMIT;
