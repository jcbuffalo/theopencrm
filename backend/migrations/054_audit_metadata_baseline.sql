-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Phase 1.6 — Backfill audit metadata on existing entities
--
-- Coding standards §3 mandates createdBy/updatedBy/entityVersion on every
-- business record. New tables in 049-053 already have them. This migration
-- adds them to existing tables that pre-date the standard.
--
-- We backfill `created_by` from `user_id` where it exists (current
-- convention: `user_id` is the row's creator). `updated_by` defaults to
-- the same value; will be set correctly going forward by route handlers.

-- companies
ALTER TABLE companies ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS entity_version INTEGER NOT NULL DEFAULT 1;
UPDATE companies SET created_by = user_id WHERE created_by IS NULL AND user_id IS NOT NULL;
UPDATE companies SET updated_by = user_id WHERE updated_by IS NULL AND user_id IS NOT NULL;

-- contacts
ALTER TABLE contacts  ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE contacts  ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE contacts  ADD COLUMN IF NOT EXISTS entity_version INTEGER NOT NULL DEFAULT 1;
UPDATE contacts SET created_by = user_id WHERE created_by IS NULL AND user_id IS NOT NULL;
UPDATE contacts SET updated_by = user_id WHERE updated_by IS NULL AND user_id IS NOT NULL;

-- deals
ALTER TABLE deals     ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE deals     ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE deals     ADD COLUMN IF NOT EXISTS entity_version INTEGER NOT NULL DEFAULT 1;
UPDATE deals SET created_by = user_id WHERE created_by IS NULL AND user_id IS NOT NULL;
UPDATE deals SET updated_by = user_id WHERE updated_by IS NULL AND user_id IS NOT NULL;

-- quotes
ALTER TABLE quotes    ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE quotes    ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE quotes    ADD COLUMN IF NOT EXISTS entity_version INTEGER NOT NULL DEFAULT 1;
UPDATE quotes SET created_by = user_id WHERE created_by IS NULL AND user_id IS NOT NULL;
UPDATE quotes SET updated_by = user_id WHERE updated_by IS NULL AND user_id IS NOT NULL;

-- activities
ALTER TABLE activities ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS entity_version INTEGER NOT NULL DEFAULT 1;
UPDATE activities SET created_by = user_id WHERE created_by IS NULL AND user_id IS NOT NULL;
UPDATE activities SET updated_by = user_id WHERE updated_by IS NULL AND user_id IS NOT NULL;

-- tasks
ALTER TABLE tasks     ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE tasks     ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE tasks     ADD COLUMN IF NOT EXISTS entity_version INTEGER NOT NULL DEFAULT 1;
UPDATE tasks SET created_by = user_id WHERE created_by IS NULL AND user_id IS NOT NULL;
UPDATE tasks SET updated_by = user_id WHERE updated_by IS NULL AND user_id IS NOT NULL;
