-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 154: Bring-your-own Anthropic key per org (BYO key).
--
-- The business model (PRICING_AND_FEATURES.md) promises that a hosted org can
-- plug in its own Anthropic key and be billed by Anthropic directly, with no
-- 2x platform upcharge. Until now the only key was the deployment-wide
-- ANTHROPIC_API_KEY env var. This table holds one key per org.
--
-- STORAGE — same tuple as every other in-app secret (org_msgraph_connections,
-- platform_integrations, quickbooks tokens): AES-256-GCM ciphertext + 12-byte
-- IV + 16-byte auth tag, encrypted with the DRIVE_TOKEN_ENCRYPTION_KEY master
-- key via services/driveTokens.js. The plaintext key is never persisted and
-- never logged; key_last4 is the only fragment that is ever returned to the UI.
--
-- ONE ROW PER ORG — org_id is the primary key. Rotating a key is an upsert;
-- removing it is a DELETE (there is nothing to keep once the customer opts
-- back to pay-as-you-go). ON DELETE CASCADE ties cleanup to org deletion
-- (GDPR erase path).
--
-- METERING — ai_usage_events gains billing_mode so a BYO org's calls are still
-- recorded (tokens + raw Anthropic cost for visibility) but with
-- charged_usd_micro = 0 and billing_mode = 'byo_key'. Existing rows default to
-- 'platform', which is what they were.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS org_ai_keys (
  org_id              INTEGER      PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  provider            VARCHAR(32)  NOT NULL DEFAULT 'anthropic',
  key_ciphertext      BYTEA        NOT NULL,
  key_iv              BYTEA        NOT NULL,   -- 12 bytes (AES-GCM nonce)
  key_tag             BYTEA        NOT NULL,   -- 16 bytes (AES-GCM auth tag)
  key_last4           VARCHAR(8)   NOT NULL,   -- display fragment only; never the key
  created_by_user_id  INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_validated_at   TIMESTAMPTZ,             -- set when the 1-token probe call succeeded
  last_error          TEXT                      -- set when the probe failed for a non-auth reason
);

COMMENT ON TABLE org_ai_keys IS
  'Per-org bring-your-own Anthropic API key, AES-256-GCM encrypted under DRIVE_TOKEN_ENCRYPTION_KEY (services/orgAiKeys.js). One row per org. Calls made with this key are metered with billing_mode=byo_key and charged_usd_micro=0.';

ALTER TABLE ai_usage_events
  ADD COLUMN IF NOT EXISTS billing_mode VARCHAR(16) NOT NULL DEFAULT 'platform';

COMMENT ON COLUMN ai_usage_events.billing_mode IS
  'platform = deployment ANTHROPIC_API_KEY, charged at cost x upcharge; byo_key = the org''s own key (org_ai_keys), charged_usd_micro is 0 because Anthropic bills the customer directly.';
