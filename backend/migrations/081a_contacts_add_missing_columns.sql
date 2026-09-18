-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Reconcile contacts table to the schema migration 082 asserts.
--
-- Prod ran migration 010 first (the legacy contacts shape without ai_summary
-- / ai_next_action). Migration 021 was a no-op due to CREATE TABLE IF NOT
-- EXISTS. Later migrations (033, 068, 070) added org_id, owner_id,
-- custom_fields via ALTER but never added the AI columns from 021's
-- definition. So prod has a legitimate schema drift from the union schema
-- that 082 expects.
--
-- This migration adds the missing columns idempotently. After it runs, 082's
-- verification block will find all expected columns and proceed.
--
-- The 010↔021 dual-creation pattern was flagged as a footgun in
-- MIGRATIONS_PLAYBOOK.md and DATA_MODEL.md; this is the cleanup pass.

BEGIN;

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ai_summary     TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ai_next_action VARCHAR(255);

COMMIT;
