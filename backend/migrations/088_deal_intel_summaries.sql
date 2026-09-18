-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Drive Intel — Phase 1, migration 088.
--
-- Cached Claude-generated "state of the deal" summary, persisted per
-- (deal, generation). We keep history (no UPDATE-in-place) so a user can
-- compare a Wednesday and Friday snapshot. The UI shows the most recent
-- row.
--
-- WHY prompt_version: snapshots compare meaningfully only when generated
-- from the same prompt. Bump 'intel-v1' to 'intel-v2' when the prompt
-- structure changes and the UI can hide cross-version rows from a diff
-- view.
--
-- WHY tokens_input / tokens_output as cached columns (in addition to the
-- ai_usage_events ledger): one row per summary lets the UI show a quick
-- "this cost ~$0.18 to generate" badge without joining the per-call
-- ledger. The ledger remains the source of truth for billing.
--
-- IDEMPOTENT: re-running is a no-op.

BEGIN;

CREATE TABLE IF NOT EXISTS deal_intel_summaries (
  id                    BIGSERIAL PRIMARY KEY,
  org_id                BIGINT      NOT NULL REFERENCES organizations(id)      ON DELETE CASCADE,
  deal_id               BIGINT      NOT NULL REFERENCES deals(id)              ON DELETE CASCADE,
  folder_link_id        BIGINT      NOT NULL REFERENCES deal_drive_folders(id) ON DELETE CASCADE,
  model                 TEXT        NOT NULL,
  prompt_version        TEXT        NOT NULL,
  summary_md            TEXT        NOT NULL,
  key_facts_json        JSONB       NOT NULL DEFAULT '[]'::jsonb,
  files_analyzed_count  INTEGER     NOT NULL DEFAULT 0,
  tokens_input          INTEGER,
  tokens_output         INTEGER,
  generated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id    BIGINT      REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_deal_intel_summaries_deal_recent
  ON deal_intel_summaries(deal_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_deal_intel_summaries_org
  ON deal_intel_summaries(org_id);

COMMENT ON TABLE deal_intel_summaries IS
  'Append-only cache of Claude-generated deal-intel summaries. Latest row per deal is what the UI displays. See backend/services/intelSummary.js.';

COMMIT;
