-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Inbound email sync — sync-cursor / state columns (migration 107).
--
-- The Gmail foundation (migrations 091-094) gave us a per-thread PULL that a
-- user drives by manually LINKING a thread to a deal. This migration adds the
-- state a PUSH-style (org-wide, auto-discovery) inbound sync needs: a
-- per-connection cursor so each sync only fetches messages newer than the last
-- run, plus operator-visibility bookkeeping columns.
--
-- WHY A TIMESTAMP CURSOR (not Gmail historyId as the primary key):
--   Gmail's history.list is the "proper" incremental primitive, but it is
--   fragile for our use case: historyIds expire after a few days of inactivity
--   (Google returns 404 and you must fall back to a full sync anyway), and a
--   thread can be matched to a deal LONG after its last message (a rep links a
--   company today whose emails arrived last month). A "messages newer than
--   last_inbound_sync_at" query (Gmail `q=after:<epoch>`) is simpler, survives
--   gaps, and re-discovering an already-synced message is a cheap idempotent
--   UPSERT (email_thread_messages is keyed UNIQUE on (gmail_message_id,
--   org_id)). We still persist last_inbound_history_id so a future optimization
--   can use it as a fast-path when it is still valid, falling back to the
--   timestamp cursor when it is not.
--
-- ON deal_email_threads.link_source:
--   Distinguishes auto-discovered links (the inbound sync matched a thread to a
--   deal by a participant email) from manually-linked ones (a user picked the
--   thread in the picker). Lets the UI badge "auto-linked" threads and lets a
--   future "unlink + don't re-link" suppression list target only the auto ones.
--   Defaults to 'manual' so every pre-existing row keeps its historical meaning
--   (they were all created by the manual picker before this migration).
--
-- IDEMPOTENT: re-running this file is a no-op. Every statement uses
--   ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS. The startup runner
--   hard-fails on 42P07 / 42710, so a bare CREATE / ALTER without a guard would
--   crash-loop the deploy — do not remove the guards.

BEGIN;

-- Per-connection inbound-sync cursor + bookkeeping.
ALTER TABLE org_gmail_connections
  ADD COLUMN IF NOT EXISTS last_inbound_sync_at        TIMESTAMPTZ;
ALTER TABLE org_gmail_connections
  ADD COLUMN IF NOT EXISTS last_inbound_history_id     TEXT;
ALTER TABLE org_gmail_connections
  ADD COLUMN IF NOT EXISTS inbound_sync_status         TEXT;      -- 'ok' | 'in_progress' | 'failed'
ALTER TABLE org_gmail_connections
  ADD COLUMN IF NOT EXISTS inbound_sync_error          TEXT;
ALTER TABLE org_gmail_connections
  ADD COLUMN IF NOT EXISTS last_inbound_synced_count   INTEGER    NOT NULL DEFAULT 0;

-- Provenance of a deal<->thread link so the UI can tell auto-discovered
-- links apart from user-picked ones.
ALTER TABLE deal_email_threads
  ADD COLUMN IF NOT EXISTS link_source TEXT NOT NULL DEFAULT 'manual';  -- 'manual' | 'auto_sync'

-- Cheap lookup for the worker: "which orgs have a connection to sync, and
-- when were they last synced?" — a partial index on active connections keeps
-- the scan small.
CREATE INDEX IF NOT EXISTS idx_org_gmail_connections_inbound_cursor
  ON org_gmail_connections(last_inbound_sync_at)
  WHERE status = 'active';

COMMENT ON COLUMN org_gmail_connections.last_inbound_sync_at IS
  'High-water mark for the org-wide inbound sync. Each run fetches Gmail messages newer than this. See backend/services/gmailSync.syncOrg.';
COMMENT ON COLUMN deal_email_threads.link_source IS
  'How the deal<->thread link was created: manual (user picked it in the thread picker) or auto_sync (inbound sync matched a participant email to a deal). See migration 107.';

COMMIT;
