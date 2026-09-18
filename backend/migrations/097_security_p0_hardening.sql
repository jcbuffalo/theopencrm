-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 097_security_p0_hardening.sql
-- Security P0 review (2026-07-04). Three independent hardening changes:
--
--   1. (P0-2) organizations.owner_user_id FK: ON DELETE CASCADE -> RESTRICT.
--      Previously, deleting an org owner cascaded into the whole tenant
--      (organizations -> every org-scoped row). RESTRICT makes the database
--      refuse the delete; the admin route also guards this now, but the FK is
--      the structural backstop.
--
--   2. (P0-4) Drop NOT NULL on user_id for the four "anonymize-but-keep" tables.
--      The account-deletion worker runs `SET user_id = NULL` on these during a
--      GDPR deletion; the NOT NULL constraint made every such deletion throw
--      and land in status='failed'. Catalog-only change, no table rewrite.
--
--   3. (P0-3) contact_submissions table so public /api/contact and the
--      /data-deletion page persist requests to the DB instead of only stdout
--      when no email transport is configured (prod runs without one).

-- 1. owner_user_id -> RESTRICT (drop whatever FK exists on the column, re-add named).
DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'organizations'::regclass
    AND contype = 'f'
    AND conkey = ARRAY[(
      SELECT attnum FROM pg_attribute
      WHERE attrelid = 'organizations'::regclass AND attname = 'owner_user_id'
    )];
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE organizations DROP CONSTRAINT %I', cname);
  END IF;
  ALTER TABLE organizations
    ADD CONSTRAINT organizations_owner_user_id_fkey
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT;
END $$;

-- 2. Allow user_id to be nulled during GDPR anonymization. Idempotent.
ALTER TABLE companies ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE contacts  ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE deals     ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE quotes    ALTER COLUMN user_id DROP NOT NULL;

-- 3. Durable store for public contact / data-deletion submissions.
CREATE TABLE IF NOT EXISTS contact_submissions (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  company VARCHAR(255),
  interest VARCHAR(100),
  message TEXT NOT NULL,
  email_delivered BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_contact_submissions_interest ON contact_submissions(interest);
CREATE INDEX IF NOT EXISTS idx_contact_submissions_created ON contact_submissions(created_at DESC);
