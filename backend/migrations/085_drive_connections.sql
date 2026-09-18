-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Drive Intel — Phase 1, table 1 of 4 (see DRIVE_INTEL_SPEC.md).
--
-- One row per organization with an active Google Drive connection. The
-- connection is org-scoped (UNIQUE on org_id) because Phase 1 intentionally
-- caps each tenant at a single shared Drive identity — adding per-user
-- connections is a Phase 2+ concern that would require a separate join
-- table.
--
-- TOKEN STORAGE
--   refresh_token_ciphertext / _iv / _tag — AES-256-GCM encrypted refresh
--     token. The encryption key is DRIVE_TOKEN_ENCRYPTION_KEY (32 raw bytes,
--     supplied as base64 in env). All three columns are bytea, written by
--     services/driveTokens.encrypt() and read by .decrypt(). NEVER store the
--     refresh token in plaintext — Google's refresh token does not rotate
--     on use, so a leak persists for the lifetime of the connection until
--     the user revokes it manually.
--   access_token / access_token_expires_at — short-lived (typically 1h)
--     access token. Stored in plaintext as a cache to avoid round-tripping
--     to Google's token endpoint on every Drive API call. Refreshed lazily
--     when expired (see services/driveOAuth.refreshAccessToken).
--
-- STATUS LIFECYCLE
--   'active'  — token exchange succeeded, last refresh ok
--   'revoked' — DELETE /api/drive/connection has been called, or Google has
--               revoked the token externally. The row is deleted on
--               disconnect rather than left in 'revoked' state, but the
--               column exists for completeness / Phase 2 soft-delete.
--   'error'   — last refresh attempt failed; see last_error column.
--
-- GDPR CASCADE
--   ON DELETE CASCADE on org_id ties cleanup to the existing org-delete
--   pipeline (accountDeletionWorker). When an org is deleted, this row goes
--   with it; subsequent migrations 086/087/088 will likewise CASCADE.
--
-- IDEMPOTENT
--   Re-running this file is a no-op via IF NOT EXISTS guards on the table
--   and the index. ALTER paths use ADD COLUMN IF NOT EXISTS in case a
--   future hotfix needs to extend the schema in-place.

BEGIN;

CREATE TABLE IF NOT EXISTS org_drive_connections (
  id                          BIGSERIAL    PRIMARY KEY,
  org_id                      INTEGER      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  google_user_email           TEXT         NOT NULL,
  refresh_token_ciphertext    BYTEA        NOT NULL,
  refresh_token_iv            BYTEA        NOT NULL,  -- 12 bytes (AES-GCM nonce)
  refresh_token_tag           BYTEA        NOT NULL,  -- 16 bytes (AES-GCM auth tag)
  access_token                TEXT,
  access_token_expires_at     TIMESTAMPTZ,
  scopes                      TEXT[]       NOT NULL DEFAULT '{}',
  status                      TEXT         NOT NULL DEFAULT 'active',
  last_error                  TEXT,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- One Drive connection per org (Phase 1 invariant).
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_drive_connections_org_id
  ON org_drive_connections(org_id);

-- Status column constraint (active / revoked / error). Done as a soft check
-- so a future status value (e.g. 'reauth_required') doesn't require a
-- migration to add.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_drive_connections_status_chk'
  ) THEN
    ALTER TABLE org_drive_connections
      ADD CONSTRAINT org_drive_connections_status_chk
      CHECK (status IN ('active', 'revoked', 'error'));
  END IF;
END $$;

COMMENT ON TABLE org_drive_connections IS
  'Per-org Google Drive OAuth connection. Refresh token AES-256-GCM encrypted at rest. See backend/services/driveOAuth.js and DRIVE_INTEL_SPEC.md.';

COMMIT;
