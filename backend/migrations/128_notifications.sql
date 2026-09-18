-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- In-app notifications — migration 128.
--
-- Persistent store behind the Notification Center (bell in the nav +
-- /notifications page). Every row is addressed to exactly ONE recipient
-- (user_id NOT NULL); org_id carries the tenancy scope with the usual
-- user_id fallback for org-less users (org_id stays NULL for them).
--
-- Rows are written best-effort by services/notificationDispatcher.js —
-- the same choke point that fans out email/SMS — so the in-app channel
-- mirrors what the dispatcher already knows without a second policy layer.
-- `type` mirrors the dispatcher's category names (task_assigned,
-- task_overdue, deal_activity, weekly_summary) but is free-form VARCHAR(48)
-- so future producers don't need a migration.
--
-- `link` is an IN-APP route ("/tasks", "/deals/5") the bell navigates to on
-- click; `entity_type` + `entity_id` keep the structured reference for
-- future grouping/dedupe. `read_at` NULL = unread.
--
-- Indexes match the two access patterns:
--   (org_id, user_id, read_at)      — unread count + unread-only list
--   (user_id, created_at DESC)      — recent-first list for a recipient
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS. The
-- startup runner hard-fails a genuinely broken migration, so keep the guards.

BEGIN;

CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  org_id      INTEGER,
  user_id     INTEGER NOT NULL,
  type        VARCHAR(48) NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  link        VARCHAR(512),
  entity_type VARCHAR(48),
  entity_id   INTEGER,
  read_at     TIMESTAMP NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_org_user_read
  ON notifications(org_id, user_id, read_at);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications(user_id, created_at DESC);

COMMENT ON TABLE notifications IS
  'In-app notification center rows, one per recipient. Written best-effort by services/notificationDispatcher.js; read via /api/notifications. See migration 128.';

COMMIT;
