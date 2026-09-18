-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Platform Integrations — Phase 1, migration 089.
--
-- Single platform-level table that holds the OAuth-app credentials (client
-- id, client secret, redirect URI) and any other configuration the super-
-- admin previously had to plant as Cloud Run env vars. The credentials are
-- shared across every customer org (the OAuth app belongs to The Open CRM,
-- not to a tenant); per-org consent (org_drive_connections from 085) is
-- unchanged.
--
-- WHY a single row per integration: third-party OAuth apps are configured
-- one-per-provider. Modelling this as a list of credentials per integration
-- would invite ambiguity ("which client secret is live right now?") at no
-- benefit until we have a rotation flow, which Phase 2 will add via
-- secret_ciphertext_previous columns alongside the current ones.
--
-- ENCRYPTION
--   secret_ciphertext / _iv / _tag are written by services/driveTokens.encrypt
--   under DRIVE_TOKEN_ENCRYPTION_KEY (the master key — see driveTokens.js).
--   DRIVE_TOKEN_ENCRYPTION_KEY itself stays as an env var because storing
--   the master key in the table it unlocks would be a chicken-and-egg.
--   All other secrets (Drive client_secret today, future Gmail / Stripe /
--   Teams etc) live here at rest.
--
-- PLAINTEXT config JSONB
--   client_id and redirect_uri (for Drive) and their analogues for other
--   integrations are deliberately plaintext. They appear in user-facing
--   OAuth URLs anyway; encrypting them adds operational complexity for
--   zero security benefit.
--
-- has_secret GENERATED COLUMN
--   Lets the API expose "is this integration fully wired" without ever
--   touching the ciphertext or the master key (the GET routes never
--   decrypt). STORED so it's indexable / cheap to read.
--
-- IDEMPOTENT
--   Re-running is a no-op via IF NOT EXISTS guards.

BEGIN;

CREATE TABLE IF NOT EXISTS platform_integrations (
  integration         TEXT         PRIMARY KEY,
  config              JSONB        NOT NULL DEFAULT '{}'::jsonb,
  secret_ciphertext   BYTEA,
  secret_iv           BYTEA,
  secret_tag          BYTEA,
  has_secret          BOOLEAN      GENERATED ALWAYS AS (secret_ciphertext IS NOT NULL) STORED,
  updated_by_user_id  BIGINT       REFERENCES users(id) ON DELETE SET NULL,
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE platform_integrations IS
  'Platform-level (NOT org-scoped) third-party integration credentials. Configured via /api/admin/platform-integrations by super-admins. Secrets encrypted at rest with DRIVE_TOKEN_ENCRYPTION_KEY. See backend/services/platformIntegrations.js and PLATFORM_INTEGRATIONS_SPEC.md.';

COMMIT;
