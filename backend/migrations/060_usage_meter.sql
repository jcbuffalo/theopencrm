-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Phase B foundation: per-org usage metering.
--
-- WHY: every plugin / campaign / AI call costs us real money. To enforce
-- per-tier quotas (Phase F billing) we need to count consumption per org
-- per period. This table is the canonical counter.
--
-- SHAPE: one row per (org_id, period, metric). period is a YYYY-MM string
-- so monthly aggregates are trivial; we can add daily rows later if
-- granularity becomes a constraint.
--
-- WRITE PATH: increment(orgId, metric, n) does an UPSERT. Concurrent
-- increments are safe because of the row-level UPSERT semantics.

CREATE TABLE IF NOT EXISTS usage_meter (
  id            BIGSERIAL PRIMARY KEY,
  org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period        VARCHAR(10) NOT NULL, -- e.g. '2026-05' for May 2026
  metric        VARCHAR(50) NOT NULL, -- 'ai_requests', 'ai_input_tokens', 'ai_output_tokens', 'plugin_runs', 'emails_sent', 'documents_uploaded_bytes'
  count         BIGINT NOT NULL DEFAULT 0,
  estimated_cost_usd_cents BIGINT NOT NULL DEFAULT 0, -- our cost, not what we charge
  first_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  last_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, period, metric)
);

CREATE INDEX IF NOT EXISTS idx_usage_meter_org_period ON usage_meter(org_id, period);
CREATE INDEX IF NOT EXISTS idx_usage_meter_period ON usage_meter(period);

COMMENT ON TABLE usage_meter IS
  'Per-org per-period consumption counters. See backend/services/usageMeter.js.';
