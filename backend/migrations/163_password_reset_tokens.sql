-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Password-reset tokens for the forgot-password flow
-- (POST /api/security/password-reset/request + /confirm).
--
-- WHY: with OPEN_SIGNUP live and password sign-ups real, a forgotten password
-- was a permanent lockout — no reset flow existed anywhere. This table backs
-- the email-a-link flow modeled on the email-verification tokens in
-- routes/securityFlowRoutes.js.
--
-- SECURITY: we store the SHA-256 of the token, never the plaintext. The raw
-- 32-byte token only ever exists inside the reset email; a DB leak therefore
-- exposes nothing usable (unlike users.email_verification_token, which
-- predates this convention). Tokens live 30 minutes, are single-use
-- (used_at), and every outstanding token for a user is invalidated the
-- moment one of them is successfully consumed.
--
-- RETENTION: rows are kept after use/expiry as a forensic trail of reset
-- attempts (requested_ip + created_at). A retention sweep can prune old rows
-- later if volume ever warrants it.
--
-- IDEMPOTENCY: CREATE TABLE / CREATE INDEX both use IF NOT EXISTS, so this
-- migration is safe to re-run by the auto-migration runner in index.js.

BEGIN;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  requested_ip TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot-path lookup on confirm is "find the row for this hash".
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token_hash
  ON password_reset_tokens (token_hash);

-- Per-account request throttle ("how many tokens were minted for this user
-- in the last 15 minutes?") and the invalidate-all-outstanding sweep both
-- filter by user_id + recency.
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_created
  ON password_reset_tokens (user_id, created_at DESC);

COMMIT;
