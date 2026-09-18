-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 150: Customer Portal v4 — the message thread (the CS-10 "comments" slice).
--
-- A per-company conversation between the EXTERNAL portal viewer and the
-- account team. Deliberately its OWN table, not record_comments (146):
-- internal comments carry @mentions and internal discussion that must never
-- be exposed on the public surface, and a visibility flag on a shared table
-- is one WHERE-clause bug away from a leak. A dedicated table makes the
-- boundary structural — everything in portal_messages is, by definition,
-- customer-visible.
--
-- author_type: 'customer' (written through the token link; author_user_id
-- NULL) | 'team' (written in-app; author_user_id = the member). Allowlisted
-- in services/portal.js / routes/portalRoutes.js — never caller-supplied on
-- the public surface.
--
-- TENANCY: org_id (+ user_id fallback) like every tenant table; company_id
-- scopes the thread. ON DELETE CASCADE: a deleted company takes its portal
-- thread with it (the thread is meaningless without the company).
--
-- Idempotent: IF NOT EXISTS everywhere.

CREATE TABLE IF NOT EXISTS portal_messages (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER,             -- tenancy fallback attribution
  org_id         INTEGER,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  author_type    VARCHAR(8) NOT NULL, -- 'customer' | 'team'
  author_user_id INTEGER,             -- team messages only; no FK (a removed
                                      -- member must not break thread history)
  body           TEXT NOT NULL,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- The one read path: "this company's thread, in order".
CREATE INDEX IF NOT EXISTS idx_portal_messages_org_company
  ON portal_messages (org_id, company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_portal_messages_user_company
  ON portal_messages (user_id, company_id, created_at);

-- Backfill an explicit wire-channel pref key for the new
-- 'portal_message_received' notification category (pattern of 144/148/149:
-- email/SMS strictly opt-in; the in-app bell has no per-type opt-out).
UPDATE users
   SET notification_preferences =
       '{ "portal_message_received": { "email": false, "sms": false } }'::jsonb
       || COALESCE(notification_preferences, '{}'::jsonb)
 WHERE notification_preferences IS NULL
    OR NOT (notification_preferences ? 'portal_message_received');
