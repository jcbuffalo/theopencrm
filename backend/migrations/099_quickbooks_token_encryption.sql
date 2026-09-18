-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 099_quickbooks_token_encryption.sql
-- P1-3 from the 2026-07-04 review. QuickBooks OAuth tokens were stored in
-- plaintext in quickbooks_connections, unlike Drive/Gmail which AES-256-GCM
-- encrypt equivalent long-lived credentials with DRIVE_TOKEN_ENCRYPTION_KEY.
-- A QB refresh token grants full accounting-write access to a customer's books,
-- so this is the more sensitive of the two.
--
-- Add ciphertext/iv/tag columns (matching services/driveTokens.js) and relax
-- the plaintext columns to nullable so new connections store only ciphertext.
-- Any existing plaintext row keeps working via a read-time fallback in
-- services/quickbooks.js and is re-encrypted (plaintext nulled) on the next
-- saveConnection (i.e. the next token refresh).

ALTER TABLE quickbooks_connections
  ADD COLUMN IF NOT EXISTS access_token_ct   BYTEA,
  ADD COLUMN IF NOT EXISTS access_token_iv   BYTEA,
  ADD COLUMN IF NOT EXISTS access_token_tag  BYTEA,
  ADD COLUMN IF NOT EXISTS refresh_token_ct  BYTEA,
  ADD COLUMN IF NOT EXISTS refresh_token_iv  BYTEA,
  ADD COLUMN IF NOT EXISTS refresh_token_tag BYTEA;

ALTER TABLE quickbooks_connections ALTER COLUMN access_token  DROP NOT NULL;
ALTER TABLE quickbooks_connections ALTER COLUMN refresh_token DROP NOT NULL;
