-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Per-call Claude token-usage ledger.
--
-- WHY: usage_meter (migration 060) aggregates per-org per-period counters,
-- which is fine for quota enforcement but loses the per-call breakdown we
-- need to (a) attribute cost to a specific user / endpoint / model, (b)
-- post metered overage line-items to Stripe, and (c) show salespeople a
-- by-endpoint and by-user cost split on /usage. This is the append-only
-- ledger that powers all three.
--
-- SHAPE: one row per Anthropic SDK call. The aggregator (services/
-- aiMetering.summarizeUsage) does the GROUP BY at read time; we keep the
-- raw rows so a future "show me the 10 most expensive calls last month"
-- query is trivial.
--
-- COST IN MICRO-DOLLARS: 1 USD = 1,000,000 micro-dollars, stored as BIGINT.
-- We deliberately avoid NUMERIC / floating-point: cost accumulation over
-- millions of rows compounds rounding errors, and Stripe's meter API
-- expects integer quantities. Micro-dollars give us 6 decimal places of
-- precision (one Anthropic input token at $3/1M tokens ≈ 3 micro-dollars).
--
-- TWO COST COLUMNS:
--   cost_usd_micro     — raw Anthropic pass-through cost (what WE pay)
--   charged_usd_micro  — customer-facing cost after CLAUDE_UPCHARGE_MULTIPLIER
-- We store both so a multiplier change later doesn't retroactively
-- rewrite history.
--
-- IDEMPOTENT: re-running this file is a no-op via IF NOT EXISTS guards
-- on both the table and every index. CASCADE on org_id keeps the ledger
-- consistent with organizations deletion; SET NULL on user_id preserves
-- the row when a user is deleted (we still need the cost line for billing).

BEGIN;

CREATE TABLE IF NOT EXISTS ai_usage_events (
  id                     BIGSERIAL PRIMARY KEY,
  org_id                 INTEGER     NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id                INTEGER              REFERENCES users(id)         ON DELETE SET NULL,
  endpoint               VARCHAR(64) NOT NULL,  -- e.g. 'summarize-deal', 'draft-followup', 'chat', 'search', 'propose-customization', 'plugin-spec-gen'
  model                  VARCHAR(64) NOT NULL,  -- e.g. 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'
  input_tokens           INTEGER     NOT NULL DEFAULT 0,
  output_tokens          INTEGER     NOT NULL DEFAULT 0,
  cache_creation_tokens  INTEGER     NOT NULL DEFAULT 0,
  cache_read_tokens      INTEGER     NOT NULL DEFAULT 0,
  cost_usd_micro         BIGINT      NOT NULL DEFAULT 0,  -- raw Anthropic cost in micro-dollars (1/1,000,000 USD)
  charged_usd_micro      BIGINT      NOT NULL DEFAULT 0,  -- customer-facing cost after upcharge multiplier
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_org_time
  ON ai_usage_events(org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_usage_user_time
  ON ai_usage_events(user_id, created_at DESC);

-- Note: the originally-planned third index `(org_id, date_trunc('month',
-- created_at))` was removed because Postgres rejects expression indexes
-- whose function isn't IMMUTABLE — date_trunc(text, timestamptz) is
-- mutable because the timestamptz→timestamp cast depends on the session
-- TimeZone setting. Workarounds (cast to timestamp, AT TIME ZONE 'UTC',
-- create an IMMUTABLE wrapper function) all add cost or operational
-- footguns. The `(org_id, created_at DESC)` index above already supports
-- monthly aggregation via range scans (WHERE created_at >= start AND <
-- end) which is what summarizeUsage() does, so the dropped index would
-- only have saved a function call per row in the aggregate path. Not
-- worth the immutability gymnastics.

COMMENT ON TABLE ai_usage_events IS
  'Per-Claude-call token + cost ledger. See backend/services/aiMetering.js. Aggregated by /api/usage and pushed to Stripe meters by aiBilling.pushMonthlyUsageToStripe().';

COMMIT;
