-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 146: Record comments with @mentions.
--
-- A single polymorphic comment table shared by deals, companies, contacts,
-- cases, and leads (entity_type + entity_id). The route layer verifies the
-- target entity is inside the caller's tenancy (an ENTITY_TABLES allowlist,
-- see routes/commentRoutes.js) BEFORE any insert, so a comment can never be
-- attached to a cross-org record. Rows carry the standard org_id (+ user_id
-- fallback) tenancy columns like every other tenant table.
--
-- @mentions are not persisted as their own table this pass: the frontend
-- sends an explicit mentioned_user_ids array, each id is validated in-org,
-- and the dispatcher's 'mention' category fans out (in-app always on).
-- Idempotent: safe to re-run (IF NOT EXISTS everywhere).

CREATE TABLE IF NOT EXISTS record_comments (
  id             SERIAL PRIMARY KEY,
  org_id         INTEGER,
  user_id        INTEGER,             -- tenancy fallback for org-less workspaces
  entity_type    VARCHAR(16) NOT NULL, -- deal | company | contact | case | lead
  entity_id      INTEGER NOT NULL,
  author_user_id INTEGER NOT NULL,
  body           TEXT NOT NULL,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- The one read path: "comments for this record, oldest first".
CREATE INDEX IF NOT EXISTS idx_record_comments_entity
  ON record_comments (org_id, entity_type, entity_id, created_at);

-- Org-less fallback lookups (personal workspaces scope on user_id).
CREATE INDEX IF NOT EXISTS idx_record_comments_user_entity
  ON record_comments (user_id, entity_type, entity_id, created_at);
