-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Microsoft (Outlook / Microsoft 365) integration — migration 140.
--
-- Three tables, mirroring the Drive (085) / Gmail (091/107) / Calendar (115)
-- foundations:
--
--   org_msgraph_connections — one row per org with an active Microsoft 365
--     OAuth connection. UNIQUE on org_id (Phase 1 caps each tenant at a
--     single shared Microsoft identity, same invariant as Drive/Gmail/
--     Calendar). ONE consent covers BOTH the Outlook-mail and Outlook-
--     calendar surfaces (scopes Mail.Read + Calendars.ReadWrite +
--     offline_access), so this single row carries two independent sync
--     cursors — mail and calendar — each gated by its own feature flag
--     (outlook_mail_enabled / outlook_calendar_enabled).
--
--   outlook_messages — inbound Outlook messages matched to a deal by a
--     participant email. (org_id, msgraph_message_id) is UNIQUE so
--     re-syncing is a cheap idempotent UPSERT (the dedupe strategy
--     email_thread_messages uses on (gmail_message_id, org_id)). Only
--     deal-matched messages are persisted — the sync skips the rest so the
--     timeline stays signal, not the user's whole mailbox. body_preview is
--     Graph's ~255-char snippet; full bodies are NOT stored in Phase 1.
--
--   outlook_calendar_events — synced (pulled) or created (pushed) Outlook
--     events, matched to a deal by attendee email. Mirrors calendar_events
--     (migration 115) column-for-column with Microsoft ids.
--
-- TOKEN STORAGE
--   refresh_token_ciphertext / _iv / _tag — AES-256-GCM encrypted refresh
--     token, written by services/msgraphTokens (the driveTokens seam; same
--     master key DRIVE_TOKEN_ENCRYPTION_KEY — see gmailTokens.js for why
--     doubling keys doubles rotation burden without a security gain).
--     MICROSOFT DIVERGENCE: unlike Google, Microsoft refresh tokens ROTATE
--     on use, so these three columns are rewritten by the token-refresh
--     path (services/msgraphClient.getAccessToken), not only at connect
--     time. NEVER store the refresh token in plaintext.
--   access_token / access_token_expires_at — short-lived (~1h) access token
--     cached in plaintext to avoid a token-endpoint round-trip per Graph
--     call. Refreshed lazily when expired.
--
-- STATUS LIFECYCLE — 'active' | 'revoked' | 'error', same as the Google
--   family. Microsoft has no public revocation endpoint, so disconnect
--   deletes the row (strongest available action) and the UI points users at
--   https://myaccount.microsoft.com/ to revoke the grant itself.
--
-- SCOPE GUARANTEE — the scopes[] column records what Microsoft actually
--   granted at consent time so an audit can confirm no broader scope was
--   ever held. See services/msgraphOAuth.js REQUESTED_SCOPE.
--
-- GDPR CASCADE — ON DELETE CASCADE on org_id ties cleanup to the org-delete
--   pipeline (accountDeletionWorker). deal_id is ON DELETE SET NULL so
--   deleting a deal detaches its rows without losing the org-scoped record.
--
-- IDEMPOTENT — re-running this file is a no-op via IF NOT EXISTS guards on
--   every table, index, and constraint. The startup runner hard-fails on
--   42P07 / 42710, so a bare CREATE without a guard would crash-loop the
--   deploy — do not remove the guards.

BEGIN;

CREATE TABLE IF NOT EXISTS org_msgraph_connections (
  id                          BIGSERIAL    PRIMARY KEY,
  org_id                      INTEGER      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ms_user_email               TEXT         NOT NULL,
  refresh_token_ciphertext    BYTEA        NOT NULL,
  refresh_token_iv            BYTEA        NOT NULL,  -- 12 bytes (AES-GCM nonce)
  refresh_token_tag           BYTEA        NOT NULL,  -- 16 bytes (AES-GCM auth tag)
  access_token                TEXT,
  access_token_expires_at     TIMESTAMPTZ,
  scopes                      TEXT[]       NOT NULL DEFAULT '{}',
  status                      TEXT         NOT NULL DEFAULT 'active',
  last_error                  TEXT,
  connected_by                INTEGER,                -- users.id of the admin who connected (nullable; callback has no session)
  -- Mail sync cursor + bookkeeping (mirror of org_gmail_connections, migration 107).
  last_mail_sync_at           TIMESTAMPTZ,
  mail_sync_status            TEXT,                   -- 'ok' | 'in_progress' | 'failed'
  mail_sync_error             TEXT,
  last_mail_synced_count      INTEGER      NOT NULL DEFAULT 0,
  -- Calendar sync cursor + bookkeeping (mirror of org_calendar_connections, migration 115).
  last_calendar_sync_at       TIMESTAMPTZ,
  calendar_sync_status        TEXT,                   -- 'ok' | 'in_progress' | 'failed'
  calendar_sync_error         TEXT,
  last_calendar_synced_count  INTEGER      NOT NULL DEFAULT 0,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- One Microsoft connection per org (Phase 1 invariant).
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_msgraph_connections_org_id
  ON org_msgraph_connections(org_id);

-- Status column constraint (active / revoked / error). Soft check so a future
-- status value (e.g. 'reauth_required') doesn't require a migration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_msgraph_connections_status_chk'
  ) THEN
    ALTER TABLE org_msgraph_connections
      ADD CONSTRAINT org_msgraph_connections_status_chk
      CHECK (status IN ('active', 'revoked', 'error'));
  END IF;
END $$;

COMMENT ON TABLE org_msgraph_connections IS
  'Per-org Microsoft 365 (Outlook mail + calendar) OAuth connection. Refresh token AES-256-GCM encrypted at rest using the shared DRIVE_TOKEN_ENCRYPTION_KEY master key; Microsoft rotates refresh tokens on use, so the ciphertext columns are rewritten by the refresh path. See backend/services/msgraphOAuth.js.';

-- ---------------------------------------------------------------------------
-- outlook_messages — deal-matched inbound Outlook mail.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outlook_messages (
  id                  BIGSERIAL   PRIMARY KEY,
  org_id              INTEGER     NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id             BIGINT      REFERENCES deals(id) ON DELETE SET NULL,
  msgraph_message_id  TEXT        NOT NULL,
  conversation_id     TEXT,
  subject             TEXT,
  body_preview        TEXT,                             -- Graph bodyPreview (~255 chars); full bodies NOT stored in Phase 1
  from_addr           TEXT,
  to_addrs            TEXT[]      NOT NULL DEFAULT '{}',
  received_at         TIMESTAMPTZ,
  web_link            TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The ON CONFLICT target for idempotent upserts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_outlook_messages_org_message
  ON outlook_messages(org_id, msgraph_message_id);

-- Timeline lookups: "mail for this deal, most recent first".
CREATE INDEX IF NOT EXISTS idx_outlook_messages_org_deal
  ON outlook_messages(org_id, deal_id);

CREATE INDEX IF NOT EXISTS idx_outlook_messages_deal_received
  ON outlook_messages(deal_id, received_at);

COMMENT ON TABLE outlook_messages IS
  'Inbound Outlook / Microsoft 365 messages matched to a deal by participant email. UNIQUE (org_id, msgraph_message_id) for idempotent upsert. See backend/services/msgraphSync.js.';

-- ---------------------------------------------------------------------------
-- outlook_calendar_events — synced/created Outlook events, deal-linked.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outlook_calendar_events (
  id                BIGSERIAL   PRIMARY KEY,
  org_id            INTEGER     NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id           BIGINT      REFERENCES deals(id) ON DELETE SET NULL,
  msgraph_event_id  TEXT        NOT NULL,
  title             TEXT,
  description       TEXT,
  start_at          TIMESTAMPTZ,
  end_at            TIMESTAMPTZ,
  attendees         TEXT[]      NOT NULL DEFAULT '{}',
  meeting_link      TEXT,                               -- Teams join URL when present
  web_link          TEXT,
  organizer_email   TEXT,
  status            TEXT,                               -- 'confirmed' | 'cancelled'
  source            TEXT        NOT NULL DEFAULT 'synced',  -- 'synced' (pulled) | 'created' (pushed from a deal)
  created_by        INTEGER,                            -- users.id when source='created'
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outlook_calendar_events_org_event
  ON outlook_calendar_events(org_id, msgraph_event_id);

CREATE INDEX IF NOT EXISTS idx_outlook_calendar_events_org_deal
  ON outlook_calendar_events(org_id, deal_id);

CREATE INDEX IF NOT EXISTS idx_outlook_calendar_events_deal_start
  ON outlook_calendar_events(deal_id, start_at);

COMMENT ON TABLE outlook_calendar_events IS
  'Outlook / Microsoft 365 calendar events synced to (or created from) the CRM, matched to a deal by attendee email. UNIQUE (org_id, msgraph_event_id) for idempotent upsert. See backend/services/msgraphSync.js.';

COMMIT;
