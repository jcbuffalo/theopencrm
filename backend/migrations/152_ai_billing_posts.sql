-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 152: Durable per-(org, month) AI-billing post-state.
--
-- The monthly push (services/aiBilling.js) relied on Stripe's idempotency key
-- (ai-billing-<org>-<YYYY-MM>) to avoid double-billing. That key only protects
-- within Stripe's ~24h window — a manual backfill or a retry a day later could
-- re-post and double-charge. And per-org failures were dropped: the worker
-- lease was kept for the month, so the 2 orgs that 5xx'd never got retried.
--
-- This table is the durable ledger of what has actually been posted. Before
-- posting an org for a period we check here; after a successful post we record
-- it (ON CONFLICT DO NOTHING). Result: a re-run at ANY later time re-posts only
-- the orgs that never succeeded — never the ones that did. Safe manual backfill.
--
-- period is the 'YYYY-MM' the usage belongs to. UNIQUE (org_id, period) is the
-- idempotency guard. No FK on org_id ON DELETE: keep the billing record even if
-- the org is later deleted (audit / dispute trail).
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS ai_billing_posts (
  id               BIGSERIAL   PRIMARY KEY,
  org_id           INTEGER     NOT NULL,
  period           VARCHAR(7)  NOT NULL,          -- 'YYYY-MM'
  stripe_event_id  TEXT,                          -- Stripe meter event identifier
  quantity_cents   INTEGER     NOT NULL,          -- what we billed (integer cents)
  posted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The idempotency guard: one successful post per org per period.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_billing_posts_org_period
  ON ai_billing_posts (org_id, period);

COMMENT ON TABLE ai_billing_posts IS
  'Durable ledger of AI-usage meter events posted to Stripe, one row per (org_id, period). UNIQUE(org_id, period) makes the monthly push safe to retry/backfill indefinitely — already-posted orgs are skipped regardless of Stripe''s idempotency window. See backend/services/aiBilling.js.';
