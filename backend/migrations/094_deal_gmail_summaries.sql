-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Gmail Intel — Phase 2, migration 094.
--
-- Cached Claude-generated "state of the conversation" summary, persisted
-- per (deal, thread_link, generation). Append-only — we keep history
-- (no UPDATE-in-place) so a user can compare a Monday and Friday snapshot
-- of the same thread. The UI shows the most recent row per thread.
--
-- WHY scoped to thread_link_id (not deal_id alone):
--   The deal_email_threads link table is N:1 — a deal can have multiple
--   threads attached (initial RFQ, separate quote thread, contract
--   negotiation, etc.). A summary is meaningful PER conversation; we don't
--   try to merge "everything Gmail knows about this deal" into a single
--   row because the prompts get unwieldy and the per-thread mental model
--   matches how users actually think about email correspondence.
--
-- WHY prompt_version: snapshots compare meaningfully only when generated
-- from the same prompt. Bump 'gmail-intel-v1' to 'gmail-intel-v2' when
-- the prompt structure changes and the UI can hide cross-version rows
-- from a diff view.
--
-- WHY ai_input_tokens / ai_output_tokens / ai_model as cached columns
-- (in addition to the ai_usage_events ledger): one row per summary lets
-- the UI show a quick "this cost ~$X to generate" badge without joining
-- the per-call ledger. The ledger remains the source of truth for
-- billing.
--
-- WHY next_step as a dedicated column (not just inside summary_md):
--   The model is asked to surface a single most-important next action.
--   Storing it as a first-class column keeps that callout queryable for
--   dashboards / chat-tool integration later without re-parsing markdown.
--   Nullable because not every thread produces an actionable next step.
--
-- IDEMPOTENT: re-running is a no-op.

BEGIN;

CREATE TABLE IF NOT EXISTS deal_gmail_summaries (
  id                    BIGSERIAL   PRIMARY KEY,
  org_id                BIGINT      NOT NULL REFERENCES organizations(id)      ON DELETE CASCADE,
  deal_id               BIGINT      NOT NULL REFERENCES deals(id)              ON DELETE CASCADE,
  thread_link_id        BIGINT      NOT NULL REFERENCES deal_email_threads(id) ON DELETE CASCADE,
  summary_md            TEXT        NOT NULL,
  key_facts             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  next_step             TEXT,
  prompt_version        VARCHAR(40) NOT NULL DEFAULT 'gmail-intel-v1',
  generated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generated_by_user_id  BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  ai_input_tokens       INTEGER,
  ai_output_tokens      INTEGER,
  ai_model              VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_deal_gmail_summaries_deal_recent
  ON deal_gmail_summaries(deal_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_deal_gmail_summaries_thread_recent
  ON deal_gmail_summaries(thread_link_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_deal_gmail_summaries_org
  ON deal_gmail_summaries(org_id);

COMMENT ON TABLE deal_gmail_summaries IS
  'Append-only cache of Claude-generated Gmail-thread intel summaries. Latest row per (deal, thread) is what the UI displays. See backend/services/gmailSummary.js.';

COMMIT;
