-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Google Calendar integration — migration 115.
--
-- Two tables, mirroring the Drive (085/086) and Gmail (091/092) foundations:
--
--   org_calendar_connections — one row per org with an active Google Calendar
--     OAuth connection. UNIQUE on org_id (Phase 1 caps each tenant at a single
--     shared calendar identity, same invariant as Drive/Gmail). The refresh
--     token is AES-256-GCM encrypted at rest via the shared master key
--     DRIVE_TOKEN_ENCRYPTION_KEY (see services/calendarTokens.js — it re-exports
--     driveTokens for exactly the same "don't double the rotation surface"
--     reason gmailTokens does).
--
--   calendar_events — synced (pulled) or created (pushed) Google Calendar events,
--     optionally matched to a deal by attendee email. google_event_id is UNIQUE
--     per org so re-syncing an event is a cheap idempotent UPSERT (the same
--     dedupe strategy email_thread_messages uses on (gmail_message_id, org_id)).
--
-- SCOPE GUARANTEE
--   We request https://www.googleapis.com/auth/calendar.events — read+write to
--   events on the user's calendars (needed for the "create event from a deal"
--   flow). The scopes[] column records what Google actually granted at consent
--   time so an audit can confirm no broader scope was ever held. calendar.events
--   is a "sensitive" (not "restricted") scope — see services/calendarOAuth.js.
--
-- STATUS LIFECYCLE
--   'active'  — token exchange succeeded, last refresh ok
--   'revoked' — DELETE /api/calendar/connection called, or Google revoked
--               externally. Row is deleted on disconnect; column kept for
--               completeness / Phase 2 soft-delete.
--   'error'   — last refresh attempt failed; see last_error column.
--
-- SYNC CURSOR
--   last_sync_at / sync_status / sync_error / last_synced_count mirror the
--   org_gmail_connections inbound-sync bookkeeping (migration 107). syncOrg only
--   pulls events touched since last_sync_at (Google's updatedMin), bounding each
--   run.
--
-- GDPR CASCADE
--   ON DELETE CASCADE on org_id ties cleanup to the org-delete pipeline
--   (accountDeletionWorker). deal_id is ON DELETE SET NULL so deleting a deal
--   detaches its events from the deal but leaves the calendar-event record
--   (still org-scoped, still cascades on org delete).
--
-- IDEMPOTENT
--   Re-running this file is a no-op via IF NOT EXISTS guards on every table,
--   index, and constraint. The startup runner hard-fails on 42P07 / 42710, so a
--   bare CREATE / ALTER without a guard would crash-loop the deploy — do not
--   remove the guards.

BEGIN;

CREATE TABLE IF NOT EXISTS org_calendar_connections (
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
  connected_by                INTEGER,                -- users.id of the admin who connected (nullable; callback has no session)
  -- Sync-cursor + bookkeeping (mirror of org_gmail_connections migration 107).
  last_sync_at                TIMESTAMPTZ,
  sync_status                 TEXT,                   -- 'ok' | 'in_progress' | 'failed'
  sync_error                  TEXT,
  last_synced_count           INTEGER      NOT NULL DEFAULT 0,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- One Calendar connection per org (Phase 1 invariant).
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_calendar_connections_org_id
  ON org_calendar_connections(org_id);

-- Status column constraint (active / revoked / error). Soft check so a future
-- status value (e.g. 'reauth_required') doesn't require a migration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_calendar_connections_status_chk'
  ) THEN
    ALTER TABLE org_calendar_connections
      ADD CONSTRAINT org_calendar_connections_status_chk
      CHECK (status IN ('active', 'revoked', 'error'));
  END IF;
END $$;

COMMENT ON TABLE org_calendar_connections IS
  'Per-org Google Calendar OAuth connection. Refresh token AES-256-GCM encrypted at rest using the shared DRIVE_TOKEN_ENCRYPTION_KEY master key. See backend/services/calendarOAuth.js.';

-- ---------------------------------------------------------------------------
-- calendar_events — synced/created events, optionally deal-linked.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_events (
  id                BIGSERIAL   PRIMARY KEY,
  org_id            INTEGER     NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id           BIGINT      REFERENCES deals(id) ON DELETE SET NULL,  -- nullable: unmatched events still stored
  google_event_id   TEXT        NOT NULL,
  calendar_id       TEXT        NOT NULL DEFAULT 'primary',
  title             TEXT,
  description       TEXT,
  start_at          TIMESTAMPTZ,
  end_at            TIMESTAMPTZ,
  attendees         TEXT[]      NOT NULL DEFAULT '{}',
  meeting_link      TEXT,
  html_link         TEXT,
  organizer_email   TEXT,
  status            TEXT,                              -- Google's event status: confirmed | tentative | cancelled
  source            TEXT        NOT NULL DEFAULT 'synced',  -- 'synced' (pulled) | 'created' (pushed from a deal)
  created_by        INTEGER,                           -- users.id when source='created'
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- google_event_id UNIQUE per org — the ON CONFLICT target for idempotent
-- upserts (re-syncing the same event touches the row rather than duplicating).
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_events_org_google_event
  ON calendar_events(org_id, google_event_id);

-- Timeline lookups: "events for this account's deals, most recent first".
CREATE INDEX IF NOT EXISTS idx_calendar_events_org_deal
  ON calendar_events(org_id, deal_id);

CREATE INDEX IF NOT EXISTS idx_calendar_events_deal_start
  ON calendar_events(deal_id, start_at);

COMMENT ON TABLE calendar_events IS
  'Google Calendar events synced to (or created from) the CRM, optionally matched to a deal by attendee email. UNIQUE (org_id, google_event_id) for idempotent upsert. See backend/services/calendarSync.js.';

COMMIT;
