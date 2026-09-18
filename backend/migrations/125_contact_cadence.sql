-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Contact-level relationship cadence — migration 125.
--
-- Person-level relationship management: who owns each key relationship, how
-- often you intend to reconnect, and when you last actually touched them. The
-- read side (the "gone quiet" list) lives in services/contactCadence.js; the
-- write side is PATCH /api/contacts/:id/cadence + POST /api/contacts/:id/touch,
-- plus a best-effort hook in activityRoutes.js that stamps last_touch_at when
-- an activity is logged against the contact.
--
-- COLUMNS (all nullable — a contact with no cadence set simply never appears
-- in the gone-quiet list):
--   owner_user_id — the RELATIONSHIP owner (who is responsible for keeping this
--                   person warm). Deliberately distinct from contacts.owner_id,
--                   the record owner used by bulk-ops/assignment: you can own
--                   the CRM record without owning the human relationship.
--   cadence_days  — desired reconnect interval in days. NULL = no cadence.
--   last_touch_at — when we last meaningfully touched this person.
--
-- Index on (org_id, last_touch_at): the gone-quiet query filters by org and
-- compares last_touch_at, so the composite matches the access pattern.
--
-- BACKFILL: seed last_touch_at from the most recent related activity
-- (activities.contact_id is the FK — see activityRoutes.js). Guarded by
-- last_touch_at IS NULL so re-running the statement is a no-op.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS. The startup
-- runner hard-fails on 42P07 / 42710, so a bare ADD/CREATE without a guard would
-- crash-loop the deploy — do not remove the guards. `contacts` is one of the
-- duplicate-table migrations' targets (010/021), so NEVER use a bare
-- CREATE TABLE here.

BEGIN;

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS owner_user_id INTEGER;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS cadence_days INTEGER;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_touch_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_contacts_org_last_touch
  ON contacts(org_id, last_touch_at);

-- Best-effort backfill from the newest activity per contact. Only fills rows
-- that have never been touched, so the migration stays idempotent.
UPDATE contacts
   SET last_touch_at = sub.mx
  FROM (SELECT contact_id, MAX(created_at) AS mx
          FROM activities
         WHERE contact_id IS NOT NULL
         GROUP BY contact_id) sub
 WHERE contacts.id = sub.contact_id
   AND contacts.last_touch_at IS NULL;

COMMENT ON COLUMN contacts.owner_user_id IS
  'Relationship owner (who keeps this person warm) — distinct from owner_id, the record owner. See migration 125.';
COMMENT ON COLUMN contacts.cadence_days IS
  'Desired reconnect interval in days. NULL = no cadence set (contact never appears in gone-quiet). See migration 125.';
COMMENT ON COLUMN contacts.last_touch_at IS
  'Last meaningful touch. Stamped by POST /api/contacts/:id/touch and by activity creation against the contact. See migration 125.';

COMMIT;
