-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 168: AI Gateway keys for self-hosters (spec 202).
--
-- A self-hosted Open CRM instance that doesn't want to manage its own
-- Anthropic account can point its AI calls at the hosted platform's metered
-- proxy (POST /api/gateway/v1/messages). The credential for that proxy is a
-- gateway key minted from the hosted org's /settings#billing page. Usage is
-- billed to the minting org through the exact same ai_usage_events → Stripe
-- meter pipeline that hosted AI calls use (billing_mode='platform',
-- endpoint='gateway').
--
-- SECURITY — same posture as api_keys (migration 108):
--   * Only sha256(fullKey) is persisted (key_hash). The plaintext
--     (`ocrm_gw_` + 32 random bytes base64url) is shown to the minting
--     admin exactly once.
--   * key_prefix (ocrm_gw_ + first 8 chars of the secret) is the non-secret
--     display id for the management UI.
--   * Revocation is a soft flip to status='revoked' so last_used_at /
--     requests_count survive for the audit trail; the proxy's 30s key cache
--     is busted on revoke so a revoked key 401s within seconds.
--
-- SCOPING — org_id NOT NULL: minting requires an org with AI pay-as-you-go
-- active/comped, so there is no personal-workspace fallback here (nothing
-- to bill a gateway call to without an org).
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS ai_gateway_keys (
  id             BIGSERIAL    PRIMARY KEY,
  org_id         INTEGER      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  label          TEXT         NOT NULL,
  key_prefix     TEXT         NOT NULL,           -- non-secret display id, e.g. ocrm_gw_Ab12Cd34
  key_hash       TEXT         NOT NULL,           -- SHA-256 hex of the full plaintext key
  status         VARCHAR(16)  NOT NULL DEFAULT 'active',  -- 'active' | 'revoked'
  created_by     INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  last_used_at   TIMESTAMPTZ,
  requests_count BIGINT       NOT NULL DEFAULT 0,
  revoked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Proxy auth path: hash the presented bearer token, select on key_hash.
-- Unique so a hash collision can't shadow a key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_gateway_keys_key_hash ON ai_gateway_keys(key_hash);

-- Management UI lists keys per org.
CREATE INDEX IF NOT EXISTS idx_ai_gateway_keys_org_id ON ai_gateway_keys(org_id);

COMMENT ON TABLE ai_gateway_keys IS
  'AI Gateway keys (spec 202): a self-hosted instance presents ocrm_gw_* to POST /api/gateway/v1/messages; usage is metered to org_id via ai_usage_events (endpoint=gateway, billing_mode=platform). Only a SHA-256 hash is stored; the plaintext is shown once at mint.';
