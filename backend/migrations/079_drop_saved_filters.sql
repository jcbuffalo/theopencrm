-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- After ~2 weeks of saved_filters being unused in production code, drop the
-- table. Migration 073 already backfilled every row into saved_views and
-- rewired filterRoutes.js. This migration runs IF the table still exists.
--
-- Idempotent: re-running after the drop is a no-op.
--
-- Roll-forward only — if a regression appears, restore from a Cloud SQL
-- point-in-time backup. Don't keep a parallel table alive.
--
-- CASCADE rationale: migration 046 attached an index
-- (idx_saved_filters_user_scope) to this table, and downstream environments
-- may have accumulated additional dependent objects (triggers, FK references
-- from forked/experimental tables, views). CASCADE drops them in one shot
-- rather than failing the migration and leaving an inconsistent schema.

BEGIN;
DROP TABLE IF EXISTS saved_filters CASCADE;
COMMIT;
