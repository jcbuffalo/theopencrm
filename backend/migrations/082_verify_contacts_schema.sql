-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 082 — defensive: verify the contacts table has the columns + types we
-- expect after all prior migrations have run.
--
-- Why this exists. There are two contacts-creating migrations on disk:
--   * 010_create_contacts.sql  — early shape: user_id, company VARCHAR, no
--                                ai_*, no company_id FK, plus a UNIQUE
--                                (user_id, email).
--   * 021_create_contacts.sql  — later shape: company_id FK, ai_summary,
--                                ai_next_action, no UNIQUE on email.
--
-- On prod, 010 ran first and created the table; 021's CREATE TABLE IF NOT
-- EXISTS made it a no-op for the table itself, but later migrations
-- (033 added org_id, 068 added owner_id, 070 added custom_fields, plus
-- shape-fixing ALTERs) brought the final state into line with the union
-- of both. A FRESH deploy from scratch runs 021 first (because of the
-- sorted file scan), and 010's CREATE TABLE IF NOT EXISTS is then the
-- no-op. Either path ends up with the same superset of columns.
--
-- This migration asserts that's actually true. It runs every startup;
-- if any expected column is missing OR its type doesn't match the
-- single canonical shape, the migration fails and Cloud Run holds the
-- prior healthy revision. If everything is present, it's a quiet no-op
-- (idempotent — safe to re-run).
--
-- Columns checked (the superset both paths must converge on):
--   * id              INTEGER  (PK, auto-incrementing — declared SERIAL in both)
--   * user_id         INTEGER  (FK to users)
--   * org_id          INTEGER  (added by 033)
--   * company_id      INTEGER  (added by 021; 010 had VARCHAR company instead, so on the 010-first path this came in via a later ALTER)
--   * first_name      VARCHAR / TEXT
--   * last_name       VARCHAR / TEXT
--   * email           VARCHAR / TEXT
--   * phone           VARCHAR / TEXT
--   * job_title       VARCHAR / TEXT
--   * status          VARCHAR / TEXT
--   * ai_summary      TEXT
--   * ai_next_action  VARCHAR / TEXT
--   * notes           TEXT
--   * tags            ARRAY (text[])
--   * owner_id        INTEGER  (added by 068)
--   * custom_fields   JSONB    (added by 070)
--   * created_at      TIMESTAMP / TIMESTAMPTZ
--   * updated_at      TIMESTAMP / TIMESTAMPTZ
--
-- Type names use information_schema's `data_type` strings, which lower-case
-- the names (`character varying`, `integer`, `timestamp without time zone`,
-- etc.). We use IN-clauses that accept the small set of variants that
-- production has been seen in.

BEGIN;

DO $$
DECLARE
  missing  TEXT := '';
  expected RECORD;
  found    TEXT;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('id',             ARRAY['integer','bigint']),
      ('user_id',        ARRAY['integer']),
      ('org_id',         ARRAY['integer']),
      ('company_id',     ARRAY['integer']),
      ('first_name',     ARRAY['character varying','text']),
      ('last_name',      ARRAY['character varying','text']),
      ('email',          ARRAY['character varying','text']),
      ('phone',          ARRAY['character varying','text']),
      ('job_title',      ARRAY['character varying','text']),
      ('status',         ARRAY['character varying','text']),
      ('ai_summary',     ARRAY['text','character varying']),
      ('ai_next_action', ARRAY['character varying','text']),
      ('notes',          ARRAY['text','character varying']),
      ('tags',           ARRAY['ARRAY']),
      ('owner_id',       ARRAY['integer']),
      ('custom_fields',  ARRAY['jsonb']),
      ('created_at',     ARRAY['timestamp without time zone','timestamp with time zone']),
      ('updated_at',     ARRAY['timestamp without time zone','timestamp with time zone'])
    ) AS t(col_name, accepted_types)
  LOOP
    SELECT data_type INTO found
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'contacts'
       AND column_name  = expected.col_name;

    IF found IS NULL THEN
      missing := missing || E'\n  - missing column: ' || expected.col_name;
    ELSIF NOT (found = ANY(expected.accepted_types)) THEN
      missing := missing
        || E'\n  - column ' || expected.col_name
        || ' has type ' || found
        || ' (expected one of: ' || array_to_string(expected.accepted_types, ', ') || ')';
    END IF;
  END LOOP;

  IF missing <> '' THEN
    RAISE EXCEPTION 'contacts schema drift detected:%', missing;
  END IF;
END $$;

COMMIT;
