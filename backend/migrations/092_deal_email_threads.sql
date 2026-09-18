-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Gmail integration foundation — migration 2 of 3.
--
-- Links a CRM deal to one or more Gmail threads (N:1 — multiple threads per
-- deal). Unlike the Drive analog (migration 086, 1:1 deal↔folder), email
-- conversations naturally fragment across threads: the initial RFQ, a
-- separate quote thread, a contract negotiation thread, etc. A deal needs
-- to be able to attach each of them.
--
-- WHY N:1 (not 1:1):
--   The Drive mental model is "this deal has a folder of artifacts". The
--   Gmail mental model is "this deal has a collection of conversations".
--   Forcing 1:1 here would force users to pick one canonical thread, which
--   doesn't match how anyone actually corresponds about a deal. UNIQUE on
--   (deal_id, gmail_thread_id) prevents accidental double-link of the same
--   thread to the same deal but allows the same thread on multiple deals
--   (a vendor reply that mentions two opportunities, etc.).
--
-- ON DELETE CASCADE on the deal FK so removing a deal cleans up its links
-- and (via the child cascade on email_thread_messages) the cached message
-- metadata. The raw OAuth tokens live on the org connection row, so a deal
-- delete never touches credentials.
--
-- IDEMPOTENT: re-running this file is a no-op. Every CREATE / ALTER /
-- CREATE INDEX uses IF NOT EXISTS.

BEGIN;

CREATE TABLE IF NOT EXISTS deal_email_threads (
  id                BIGSERIAL PRIMARY KEY,
  org_id            BIGINT      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id           BIGINT      NOT NULL REFERENCES deals(id)         ON DELETE CASCADE,
  gmail_thread_id   TEXT        NOT NULL,
  subject           TEXT,
  participants      TEXT[]      NOT NULL DEFAULT '{}',
  last_message_at   TIMESTAMPTZ,
  message_count     INTEGER     NOT NULL DEFAULT 0,
  last_sync_at      TIMESTAMPTZ,
  last_sync_status  TEXT,                       -- 'ok' | 'in_progress' | 'failed'
  last_sync_error   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One link per (deal, gmail_thread_id) pair. Lets the sync upsert via
-- ON CONFLICT cleanly when a user clicks "link" twice on the same thread.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_email_threads_deal_thread_unique
  ON deal_email_threads(deal_id, gmail_thread_id);

CREATE INDEX IF NOT EXISTS idx_deal_email_threads_org_deal
  ON deal_email_threads(org_id, deal_id);

CREATE INDEX IF NOT EXISTS idx_deal_email_threads_thread_org
  ON deal_email_threads(gmail_thread_id, org_id);

COMMENT ON TABLE deal_email_threads IS
  'Deal ↔ Gmail thread link (N:1 — multiple threads per deal). One row per (deal, gmail_thread_id) pair. See backend/services/gmailSync.js.';

COMMIT;
