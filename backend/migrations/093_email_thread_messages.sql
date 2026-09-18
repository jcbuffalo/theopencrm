-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Gmail integration foundation — migration 3 of 3.
--
-- Per-message cache for every Gmail message in a linked thread. One row per
-- Gmail message id, scoped to the thread link (and via the link, to org +
-- deal). Mirrors drive_files (migration 087) — the same idempotent-upsert +
-- extracted-text pattern, adapted for email payloads.
--
-- WHY cache the message:
--   1. Summarization is going to run repeatedly across the same conversation
--      (every time a user clicks "regenerate summary"); fetching from Gmail
--      on every call would be slow AND would burn through the 250 quota
--      units/user/sec limit. Caching the plaintext bounds the API hit to a
--      diff-based incremental sync.
--   2. Forensics: if a user ever disputes "did the summarizer see message
--      X", we need an audit-friendly copy of what we actually fed Claude.
--      Without this row, the only record is whatever Gmail still has at
--      query time, and the user could have deleted it.
--   3. Offline-friendly: deal-level intel can render without a live Gmail
--      call, which matters when Google rate-limits us or the token has
--      gone stale.
--
-- WHY body_text is inline TEXT (not GCS):
--   Per-message bodies cap around the Gmail 25MB attachment size limit but
--   plaintext bodies are far smaller — almost always <100KB. Postgres TOAST
--   handles that range well. If we ever exceed the TOAST sweet spot (e.g.
--   storing attachment text inline), swap to a content_gcs_path column —
--   the rest of the pipeline cares about a string, not where it came from.
--
-- ATTACHMENT HANDLING:
--   attachment_names captures the filenames Gmail reports for the
--   attachments on the message. The bytes themselves are NOT downloaded in
--   this PR — that would balloon storage requirements and trigger CASA
--   verification concerns (attachments commonly carry PII). A follow-up
--   PR may add an attachments table if a customer needs that surface.
--
-- IDEMPOTENT: re-running this file is a no-op.

BEGIN;

CREATE TABLE IF NOT EXISTS email_thread_messages (
  id                  BIGSERIAL PRIMARY KEY,
  org_id              BIGINT      NOT NULL REFERENCES organizations(id)       ON DELETE CASCADE,
  thread_link_id      BIGINT      NOT NULL REFERENCES deal_email_threads(id)  ON DELETE CASCADE,
  gmail_message_id    TEXT        NOT NULL,
  internal_date       TIMESTAMPTZ,
  from_addr           TEXT,
  to_addrs            TEXT[]      NOT NULL DEFAULT '{}',
  subject             TEXT,
  snippet             TEXT,
  body_text           TEXT,
  body_hash           TEXT,                        -- sha256 of body_text
  attachment_names    TEXT[]      NOT NULL DEFAULT '{}',
  extraction_status   TEXT        NOT NULL DEFAULT 'pending',
                                                   -- 'pending' | 'done' | 'skipped' | 'failed'
  extraction_error    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_thread_messages_thread_link
  ON email_thread_messages(thread_link_id);

-- One row per Gmail message id within an org. UNIQUE so the sync upsert can
-- target this index cleanly via ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_thread_messages_msg_org_unique
  ON email_thread_messages(gmail_message_id, org_id);

CREATE INDEX IF NOT EXISTS idx_email_thread_messages_org_date
  ON email_thread_messages(org_id, internal_date DESC);

COMMENT ON TABLE email_thread_messages IS
  'Per-Gmail-message cache: from/to/subject/snippet/plaintext-body. One row per Gmail message id within an org. See backend/services/gmailSync.js and gmailExtract.js.';

COMMIT;
