-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Drive Intel — Phase 1, migration 087.
--
-- Per-file metadata + extracted text for everything synced from a linked
-- Drive folder. One row per Drive file, scoped to the folder link (and
-- via the link, to org + deal).
--
-- WHY content_hash: the diff in driveSync.js short-circuits re-extraction
-- when (content_hash, drive_modified_at) match an existing row. Cheap
-- idempotent sync — Drive's `modified_time` alone changes on metadata
-- nudges that don't actually change the bytes, so we keep both.
--
-- WHY content_text is a TEXT column (not GCS object): for the MVP the
-- extracted text is small enough (capped at DRIVE_MAX_FILE_SIZE_BYTES =
-- 10MB raw → typically <500KB of text) to live inline. If we ever exceed
-- the Postgres TOAST sweet spot, swap to a `content_gcs_path` column —
-- the rest of the pipeline cares about a string, not where it came from.
--
-- IDEMPOTENT: re-running this file is a no-op.

BEGIN;

CREATE TABLE IF NOT EXISTS drive_files (
  id                  BIGSERIAL PRIMARY KEY,
  org_id              BIGINT      NOT NULL REFERENCES organizations(id)      ON DELETE CASCADE,
  folder_link_id      BIGINT      NOT NULL REFERENCES deal_drive_folders(id) ON DELETE CASCADE,
  drive_file_id       TEXT        NOT NULL,
  name                TEXT        NOT NULL,
  mime_type           TEXT        NOT NULL,
  size_bytes          BIGINT,
  drive_modified_at   TIMESTAMPTZ,
  content_text        TEXT,
  content_hash        TEXT,                        -- sha256 of content_text
  extraction_status   TEXT        NOT NULL DEFAULT 'pending',
                                                   -- 'pending' | 'done' | 'skipped' | 'failed'
  extraction_error    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_drive_files_folder_link
  ON drive_files(folder_link_id);

-- One row per Drive file id within an org. UNIQUE so sync's upsert can
-- target this index cleanly via ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS idx_drive_files_drive_file_org_unique
  ON drive_files(drive_file_id, org_id);

CREATE INDEX IF NOT EXISTS idx_drive_files_org_modified
  ON drive_files(org_id, drive_modified_at DESC);

COMMENT ON TABLE drive_files IS
  'Synced Google Drive file metadata + extracted plain text. One row per Drive file id within an org. See backend/services/driveSync.js and driveExtract.js.';

COMMIT;
