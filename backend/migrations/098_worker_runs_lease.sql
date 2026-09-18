-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 098_worker_runs_lease.sql
-- P1-5 from the 2026-07-04 review. Cross-instance coordination for periodic
-- workers whose "did this period already run?" dedupe was previously kept only
-- in process memory (weeklySummaryWorker.lastFiredISOWeekKey, aiBilling.lastRunYM).
-- With >1 Cloud Run instance — or a restart inside the fire window — that memory
-- reset and the run could fire twice (duplicate weekly digests / meter pushes).
--
-- The first instance to INSERT a (worker, period_key) row wins the run; everyone
-- else gets ON CONFLICT DO NOTHING and skips. See services/workerLease.js.

CREATE TABLE IF NOT EXISTS worker_runs (
  worker      VARCHAR(100) NOT NULL,
  period_key  VARCHAR(100) NOT NULL,
  claimed_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (worker, period_key)
);
