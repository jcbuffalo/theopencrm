-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 101_stripe_webhook_events.sql
-- Idempotency ledger for inbound Stripe webhooks.
--
-- Stripe delivers webhooks at-least-once: the same event id can arrive multiple
-- times (network hiccups, our handler being slow, manual re-sends). Without a
-- dedupe guard each retry re-runs the handler, producing duplicate admin
-- notification emails and duplicate audit_log rows.
--
-- The billing webhook handler claims each event id here with
--   INSERT ... ON CONFLICT DO NOTHING RETURNING event_id
-- before doing any work. If no row comes back, the event was already processed
-- and we ack with 200 without reprocessing.
--
-- Idempotent per the startup migration runner's hard-fail-on-non-idempotent
-- rule: IF NOT EXISTS throughout.
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id VARCHAR(255) PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
