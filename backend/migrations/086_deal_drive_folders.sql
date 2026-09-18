-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Drive Intel — Phase 1, migration 086.
--
-- Links a CRM deal to a single Google Drive folder (1:1 for MVP). The
-- companion org-level OAuth connection lives in `org_drive_connections`
-- (migration 085, owned by Agent 1).
--
-- WHY 1:1 IN PHASE 1: simplifies the linker UI ("pick a folder for this
-- deal") and the sync orchestrator (no fan-out by folder). Phase 2 may
-- relax this to many folders per deal via a new column or a join table —
-- but the UNIQUE on deal_id keeps Phase 1 strict.
--
-- ON DELETE CASCADE on the deal FK so removing a deal cleans up the link
-- and (via the child cascade on drive_files) the synced metadata. The
-- raw OAuth tokens live on the org connection row, so a deal delete
-- never touches credentials.
--
-- IDEMPOTENT: re-running this file is a no-op. Every CREATE / ALTER /
-- CREATE INDEX uses IF NOT EXISTS.

BEGIN;

CREATE TABLE IF NOT EXISTS deal_drive_folders (
  id                BIGSERIAL PRIMARY KEY,
  org_id            BIGINT      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id           BIGINT      NOT NULL REFERENCES deals(id)         ON DELETE CASCADE,
  drive_folder_id   TEXT        NOT NULL,
  folder_name       TEXT        NOT NULL,
  folder_url        TEXT        NOT NULL,
  last_sync_at      TIMESTAMPTZ,
  last_sync_status  TEXT,                       -- 'ok' | 'in_progress' | 'failed'
  last_sync_error   TEXT,
  files_synced_count INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One folder link per deal. Enforces the Phase-1 1:1 contract at the DB.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_drive_folders_deal_unique
  ON deal_drive_folders(deal_id);

CREATE INDEX IF NOT EXISTS idx_deal_drive_folders_org_deal
  ON deal_drive_folders(org_id, deal_id);

CREATE INDEX IF NOT EXISTS idx_deal_drive_folders_folder_org
  ON deal_drive_folders(drive_folder_id, org_id);

COMMENT ON TABLE deal_drive_folders IS
  'Deal ↔ Google Drive folder link (1:1, MVP). See DRIVE_INTEL_SPEC.md §Data model. The org_drive_connections row (migration 085) supplies the OAuth credential.';

COMMIT;
