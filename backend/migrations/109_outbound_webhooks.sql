-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- ============================================================================
-- Developer Platform — Outbound webhooks.
-- ============================================================================
-- The existing /api/webhooks surface is INBOUND-only (Teams / Zoom / generic
-- meeting logs post TO us). This adds the reverse: a customer registers a URL
-- and we POST domain events (deal.created, deal.stage_changed, ...) to it,
-- signed with an HMAC so the receiver can verify authenticity.
--
--   outbound_webhooks   — one row per registered endpoint (org-scoped).
--   webhook_deliveries  — an append-only log of every dispatch attempt, for the
--                         "recent deliveries" UI and debugging failing hooks.
--
-- SIGNING
--   `secret` is a per-webhook signing secret generated server-side at create
--   time. services/webhookDispatcher.js computes an HMAC-SHA256 over the exact
--   raw request body and sends it in the X-Signature header. This mirrors the
--   inbound Zoom/Teams shared-secret verification in routes/webhookRoutes.js,
--   just in the opposite direction. It is a signing secret (not an OAuth token),
--   so plaintext storage matches the env-var secrets (TEAMS_WEBHOOK_SECRET,
--   ZOOM_WEBHOOK_SECRET_TOKEN) it is analogous to.
--
-- BEST-EFFORT
--   Dispatch failures never block the originating request (deal create, etc.).
--   Every attempt — success or failure — writes a webhook_deliveries row so the
--   customer can see status_code / ok / response_ms without server log access.
--
-- IDEMPOTENT — re-running is a no-op via IF NOT EXISTS guards.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS outbound_webhooks (
  id         BIGSERIAL   PRIMARY KEY,
  org_id     INTEGER     REFERENCES organizations(id) ON DELETE CASCADE,
  url        TEXT        NOT NULL,
  events     TEXT[]      NOT NULL DEFAULT '{}',   -- event names this hook subscribes to
  secret     TEXT        NOT NULL,                -- per-hook HMAC signing secret (generated server-side)
  active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbound_webhooks_org_id ON outbound_webhooks(org_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id           BIGSERIAL   PRIMARY KEY,
  webhook_id   BIGINT      NOT NULL REFERENCES outbound_webhooks(id) ON DELETE CASCADE,
  event        TEXT        NOT NULL,
  status_code  INTEGER,                            -- HTTP status the receiver returned (NULL on network error)
  ok           BOOLEAN     NOT NULL DEFAULT FALSE,  -- true iff a 2xx came back
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  response_ms  INTEGER                             -- round-trip time in milliseconds
);

-- "Recent deliveries for this hook, newest first" is the only read pattern.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_id
  ON webhook_deliveries(webhook_id, attempted_at DESC);

COMMENT ON TABLE outbound_webhooks IS
  'Customer-registered outbound webhook endpoints. Payloads are HMAC-SHA256 signed with the per-row secret and dispatched best-effort by services/webhookDispatcher.js.';

COMMIT;
