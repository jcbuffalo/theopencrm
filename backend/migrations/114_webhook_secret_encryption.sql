-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 114_webhook_secret_encryption.sql
-- Encrypt the outbound-webhook signing secret at rest.
--
-- Migration 109 shipped outbound_webhooks with the per-hook `whsec_…` HMAC
-- signing secret stored in PLAINTEXT. Any read-access to the DB (a backup, a
-- leaked dump, a replica) would hand an attacker the ability to forge signed
-- payloads to every customer's receiver. The platform convention is to
-- AES-256-GCM encrypt stored secrets with DRIVE_TOKEN_ENCRYPTION_KEY (see
-- services/driveTokens.js), exactly as migration 099 retrofitted the
-- QuickBooks OAuth tokens.
--
-- Add ciphertext/iv/tag columns (matching services/driveTokens.js's
-- {ciphertext, iv, tag} buffer tuple) and relax the plaintext `secret` column
-- to nullable so new webhooks store only ciphertext. Any existing plaintext
-- row keeps working via a read-time fallback in services/webhookDispatcher.js.
--
-- IDEMPOTENT — the startup runner HARD-FAILS on 42P07/42710, so every add uses
-- ADD COLUMN IF NOT EXISTS and the NOT NULL relax is a no-op if already nullable.

ALTER TABLE outbound_webhooks
  ADD COLUMN IF NOT EXISTS secret_ct  BYTEA,
  ADD COLUMN IF NOT EXISTS secret_iv  BYTEA,
  ADD COLUMN IF NOT EXISTS secret_tag BYTEA;

ALTER TABLE outbound_webhooks ALTER COLUMN secret DROP NOT NULL;
