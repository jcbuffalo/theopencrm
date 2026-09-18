-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 081 — drop plugin_runs.memory_peak_bytes.
--
-- The column was added in migration 061 expecting we'd record the
-- isolated-vm sandbox's peak heap. In practice isolated-vm does not expose
-- peak-memory stats after the isolate is disposed (and probing
-- getHeapStatisticsSync() mid-run adds cost without yielding a peak — only
-- the instantaneous value at probe time). Every plugin_runs row written
-- since 061 stores 0 here. The docs sweep flagged this as dead weight:
--   * it gives a false signal to anyone reading the table directly
--   * it shows up in DATA_MODEL.md / OBSERVABILITY.md / CHAT_TOOLS_REFERENCE.md
--     as if it were live
--   * SELECT pr.*, ... queries pay a few bytes per row to drag it along
--
-- Option (a) — drop the column — is cleaner than option (b) replacing it
-- with a useless mid-run estimate. If we later wire a real memory budget
-- (probably via isolated-vm's per-isolate memory-limit + a watch loop),
-- we'll add a new, accurately-named column then.
--
-- IF EXISTS guard means re-running on an environment that already dropped
-- it (or fresh installs that never had it) is a no-op.

BEGIN;

ALTER TABLE plugin_runs DROP COLUMN IF EXISTS memory_peak_bytes;

COMMIT;
