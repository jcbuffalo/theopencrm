-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- ============================================================================
-- Enterprise SSO (OIDC) + SCIM 2.0 user provisioning — migration 117.
-- ============================================================================
-- Adds two tables that back the upmarket auth surface. BOTH are inert until an
-- org admin configures a connection AND the `sso_enabled` feature flag is on
-- for that org — nothing here changes behavior for existing tenants.
--
-- sso_connections
--   One row per org (org_id UNIQUE) describing that org's OIDC identity
--   provider. The OAuth client_secret is stored AES-256-GCM encrypted as a
--   three-column tuple (ciphertext / iv / tag) via services/driveTokens under
--   the master key DRIVE_TOKEN_ENCRYPTION_KEY — identical to the pattern used
--   by platform_integrations (089) and org QuickBooks token storage (099).
--   The `slug` is a public, unguessable-enough short id used only to route the
--   pre-auth login start URL (/api/auth/sso/:slug/start); it is NOT a secret.
--
-- scim_tokens
--   Bearer tokens an external IdP presents to /scim/v2/* to provision or
--   deprovision users into the org. Only a SHA-256 hash is persisted
--   (token_hash) — the plaintext is shown to the admin exactly once at
--   creation and is unrecoverable afterward, mirroring api_keys (108).
--   Revocation is a soft delete (revoked_at) so the row + audit trail survive.
--
-- IDEMPOTENT
--   Every statement uses IF NOT EXISTS so a re-run is a clean no-op and never
--   raises 42P07 (duplicate_table) / 42710 (duplicate_object), which the
--   startup migration runner treats as fatal.
-- ============================================================================

BEGIN;

-- --- SSO (OIDC) connections -------------------------------------------------
CREATE TABLE IF NOT EXISTS sso_connections (
  id                  BIGSERIAL    PRIMARY KEY,
  org_id              INTEGER      NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  slug                TEXT         UNIQUE,               -- public login-route id, e.g. "acme"; NOT a secret
  protocol            TEXT         NOT NULL DEFAULT 'oidc' CHECK (protocol IN ('oidc')),
  issuer              TEXT,                              -- OIDC issuer, e.g. https://login.microsoftonline.com/<tid>/v2.0
  client_id           TEXT,
  client_secret_ct    BYTEA,                             -- AES-256-GCM ciphertext (driveTokens)
  client_secret_iv    BYTEA,                             -- 12-byte GCM nonce
  client_secret_tag   BYTEA,                             -- 16-byte GCM auth tag
  allowed_domain      TEXT,                              -- e.g. "acme.com"; SSO email MUST match or login rejects
  enabled             BOOLEAN      NOT NULL DEFAULT FALSE,
  created_by          INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sso_connections_slug           ON sso_connections(slug);
CREATE INDEX IF NOT EXISTS idx_sso_connections_allowed_domain ON sso_connections(allowed_domain);

COMMENT ON TABLE sso_connections IS
  'Per-org OIDC identity-provider config. client_secret encrypted at rest with DRIVE_TOKEN_ENCRYPTION_KEY. Inert unless enabled=TRUE AND the org has the sso_enabled feature flag. See services/ssoOidc.js.';

-- --- SCIM 2.0 provisioning bearer tokens ------------------------------------
CREATE TABLE IF NOT EXISTS scim_tokens (
  id           BIGSERIAL    PRIMARY KEY,
  org_id       INTEGER      NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         TEXT,                                     -- optional human label ("Okta prod")
  token_prefix TEXT,                                     -- non-secret display id, e.g. "scim_ab12cd34"
  token_hash   TEXT         NOT NULL,                    -- SHA-256 hex of the full plaintext bearer
  created_by   INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  revoked_at   TIMESTAMPTZ
);

-- Auth lookup hashes the presented bearer and selects on token_hash. Unique so
-- a hash collision can't shadow another org's token.
CREATE UNIQUE INDEX IF NOT EXISTS idx_scim_tokens_token_hash ON scim_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_scim_tokens_org_id           ON scim_tokens(org_id);

COMMENT ON TABLE scim_tokens IS
  'SCIM 2.0 provisioning bearer tokens (SHA-256 hashed; plaintext shown once). Org-scoped, token-authenticated via middleware/scimAuth.js — a scheme distinct from the JWT session cookie. Revocation is a soft delete (revoked_at).';

COMMIT;
