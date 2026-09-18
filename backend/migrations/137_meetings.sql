-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- In-app Meetings — migration 137.
--
-- A first-class, internally-schedulable meetings object behind /api/meetings
-- and the merged agenda at GET /api/calendar/agenda. This is COMPLEMENTARY to
-- the Google-Calendar sync tables (org_calendar_connections / calendar_events,
-- migration 115): those mirror an EXTERNAL calendar via OAuth; this table is
-- the CRM's own scheduling surface — no OAuth, no sync worker, just rows a
-- user creates from the Calendar page. When an in-app meeting corresponds to
-- a Google-synced event, external_event_id carries the link (soft reference,
-- no FK — the synced row may be deleted/re-synced independently).
--
-- TENANCY: org_id with user_id fallback, the standard qs(req) pair. org_id is
-- ON DELETE CASCADE so the org-delete pipeline (accountDeletionWorker) cleans
-- meetings up for free; user_id / created_by are SET NULL so removing a user
-- never destroys the org's shared schedule.
--
-- LINKS: company_id / deal_id / contact_id are all nullable ON DELETE SET NULL
-- (deleting the linked record detaches the meeting, mirroring how
-- calendar_events.deal_id behaves in migration 115). All INTEGER — the linked
-- PKs are SERIAL.
--
-- INDEXES match the two access patterns: the agenda/week view reads
-- (org_id, starts_at) ranges; deal timelines read (org_id, deal_id).
--
-- IDEMPOTENT: CREATE TABLE / INDEX IF NOT EXISTS throughout. The startup
-- runner hard-fails on 42P07 / 42710, so a bare CREATE without a guard would
-- crash-loop the deploy — do not remove the guards.

BEGIN;

CREATE TABLE IF NOT EXISTS meetings (
  id                SERIAL       PRIMARY KEY,
  user_id           INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  org_id            INTEGER      REFERENCES organizations(id) ON DELETE CASCADE,
  title             VARCHAR(500) NOT NULL,
  starts_at         TIMESTAMP    NOT NULL,
  ends_at           TIMESTAMP,
  company_id        INTEGER      REFERENCES companies(id) ON DELETE SET NULL,
  deal_id           INTEGER      REFERENCES deals(id)     ON DELETE SET NULL,
  contact_id        INTEGER      REFERENCES contacts(id)  ON DELETE SET NULL,
  location          VARCHAR(255),
  notes             TEXT,
  external_event_id VARCHAR(255),                -- soft link to a Google-synced calendar_events.google_event_id
  created_by        INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

-- Agenda / week view: "everything in this org between FROM and TO".
CREATE INDEX IF NOT EXISTS idx_meetings_org_starts ON meetings(org_id, starts_at);

-- Deal timeline: "meetings on this deal".
CREATE INDEX IF NOT EXISTS idx_meetings_org_deal ON meetings(org_id, deal_id);

COMMENT ON TABLE meetings IS
  'In-app schedulable meetings (internal calendar, no external OAuth) behind /api/meetings + GET /api/calendar/agenda. Complementary to the Google-synced calendar_events (migration 115); external_event_id soft-links the two. See backend/routes/meetingRoutes.js.';

COMMIT;
