-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Phase B + C foundations:
--   • organizations.tier — which pricing tier the org is on (drives quotas)
--   • plugins / plugin_runs / plugin_quota_usage — Phase C plugin runtime
--
-- See PLUGIN_PLATFORM_VISION.md for the tier→quota mapping and the plugin
-- model. Tables created here so the schema is in place before the runtime
-- code lands; the runtime itself is gated by the plugins_enabled feature flag
-- (default off) until isolated-vm sandboxing is wired (Phase C build-out).

-- ---- TIER --------------------------------------------------------------------

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS tier VARCHAR(20) NOT NULL DEFAULT 'free'
    CHECK (tier IN ('free', 'starter', 'pro', 'enterprise'));

CREATE INDEX IF NOT EXISTS idx_organizations_tier ON organizations(tier);

-- Seed any pre-existing org with a sensible default. Existing orgs default
-- to 'pro' because they pre-date the tier concept; we'd rather not surprise
-- them with quotas. New signups default to 'free'.
UPDATE organizations SET tier = 'pro' WHERE tier = 'free' AND created_at < NOW() - INTERVAL '1 day';

-- ---- PLUGINS ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS plugins (
  id            BIGSERIAL PRIMARY KEY,
  org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          VARCHAR(120) NOT NULL,
  description   TEXT,
  -- "spec" is the structured representation (JSON), "source_code" is the
  -- compiled / hand-written JS that the runner executes.
  spec_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_code   TEXT,
  -- Where this plugin came from: conversational (Claude-generated from a
  -- prompt), library (one-click install from the marketplace), or code
  -- (user wrote JS directly).
  source_kind   VARCHAR(20) NOT NULL DEFAULT 'conversational'
                  CHECK (source_kind IN ('conversational', 'library', 'code')),
  status        VARCHAR(20) NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'active', 'suspended', 'errored')),
  -- Event the plugin listens to (e.g. 'deal.stage_changed'). NULL for
  -- on-demand-only plugins.
  trigger_event VARCHAR(120),
  trigger_filter_json JSONB,
  -- public_id for outbound references.
  public_id     UUID NOT NULL DEFAULT gen_random_uuid(),
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  entity_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(org_id, name)
);

CREATE INDEX IF NOT EXISTS idx_plugins_org_id        ON plugins(org_id);
CREATE INDEX IF NOT EXISTS idx_plugins_status        ON plugins(status);
CREATE INDEX IF NOT EXISTS idx_plugins_trigger_event ON plugins(trigger_event);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_plugins_public_id ON plugins(public_id);

-- ---- PLUGIN RUNS (audit + billing) ----------------------------------------

CREATE TABLE IF NOT EXISTS plugin_runs (
  id             BIGSERIAL PRIMARY KEY,
  plugin_id      INTEGER NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  org_id         INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  started_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  ended_at       TIMESTAMP,
  status         VARCHAR(20) NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running', 'success', 'error', 'timeout', 'quota_exceeded', 'rejected')),
  trigger_kind   VARCHAR(40),     -- 'event' | 'schedule' | 'manual' | 'test_run'
  trigger_data   JSONB,
  result_summary TEXT,
  error_message  TEXT,
  -- Resource usage. Used by both the kill-switch logic (was this run
  -- abusive?) and the billing layer (does the org owe overage?).
  cpu_ms              INTEGER NOT NULL DEFAULT 0,
  memory_peak_bytes   BIGINT  NOT NULL DEFAULT 0,
  db_queries          INTEGER NOT NULL DEFAULT 0,
  egress_bytes        BIGINT  NOT NULL DEFAULT 0,
  ai_input_tokens     INTEGER NOT NULL DEFAULT 0,
  ai_output_tokens    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_plugin_runs_plugin_id ON plugin_runs(plugin_id);
CREATE INDEX IF NOT EXISTS idx_plugin_runs_org_id    ON plugin_runs(org_id);
CREATE INDEX IF NOT EXISTS idx_plugin_runs_started   ON plugin_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_plugin_runs_status    ON plugin_runs(status);

-- ---- ROLLING-WINDOW QUOTA USAGE -------------------------------------------
-- Per-org rolling counters used by the runner to short-circuit before
-- doing the expensive sandbox spin-up. usage_meter is the canonical
-- monthly counter; this is the fast-path rolling window.

CREATE TABLE IF NOT EXISTS plugin_quota_usage (
  id          BIGSERIAL PRIMARY KEY,
  org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  window_kind VARCHAR(20) NOT NULL CHECK (window_kind IN ('minute', 'hour', 'day')),
  window_start TIMESTAMP NOT NULL,
  runs_count  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(org_id, window_kind, window_start)
);

CREATE INDEX IF NOT EXISTS idx_plugin_quota_usage_lookup
  ON plugin_quota_usage(org_id, window_kind, window_start DESC);
