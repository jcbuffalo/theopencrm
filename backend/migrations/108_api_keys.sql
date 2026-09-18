-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- ============================================================================
-- Developer Platform — Personal Access Tokens (API keys).
-- ============================================================================
-- Opens the integration ecosystem: today auth is session/JWT-cookie only, so
-- there's no way for an external script or a partner integration to call the
-- API. This table backs a DISTINCT auth scheme (see middleware/apiKeyAuth.js):
-- callers present a `tocrm_...` bearer token / X-API-Key header that is hashed
-- and looked up here. It never touches the JWT cookie path.
--
-- SECURITY
--   * We store ONLY a SHA-256 hash of the key (key_hash). The plaintext key is
--     shown to the creating admin exactly once (POST /api/keys response) and is
--     unrecoverable afterward — a DB leak yields hashes, not usable keys.
--   * key_prefix is the human-readable, non-secret identifier (`tocrm_ab12cd34`)
--     rendered in the management UI so an admin can tell keys apart and revoke
--     the right one. It is NOT sufficient to authenticate.
--   * Revocation is a soft delete (revoked_at) so the audit trail + last_used_at
--     survive; apiKeyAuth rejects any row with revoked_at IS NOT NULL.
--
-- SCOPING
--   org_id is the primary tenant scope (mirrors every other table). It is
--   nullable to support org-less personal workspaces — in that case created_by
--   is the user_id scope, exactly like qs(req)'s user_id fallback. apiKeyAuth
--   sets req.orgId AND req.userId from the row so downstream qs(req) works
--   either way.
--
-- IDEMPOTENT — re-running is a no-op via IF NOT EXISTS guards.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS api_keys (
  id           BIGSERIAL   PRIMARY KEY,
  org_id       INTEGER     REFERENCES organizations(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  key_prefix   TEXT        NOT NULL,           -- non-secret display id, e.g. tocrm_ab12cd34
  key_hash     TEXT        NOT NULL,           -- SHA-256 hex of the full plaintext key
  scopes       TEXT[]      NOT NULL DEFAULT '{read}',
  created_by   INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Lookup path: apiKeyAuth hashes the presented key and selects on key_hash.
-- Unique so a (astronomically unlikely) hash collision can't shadow a key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key_hash  ON api_keys(key_hash);

-- Management UI lists keys per org; revoke targets a specific prefix.
CREATE INDEX IF NOT EXISTS idx_api_keys_org_id      ON api_keys(org_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix  ON api_keys(key_prefix);

COMMENT ON TABLE api_keys IS
  'Developer-platform Personal Access Tokens. Only a SHA-256 hash of each key is stored (key_hash); the plaintext is shown once at creation. Auth via middleware/apiKeyAuth.js — a scheme distinct from the JWT session cookie.';

COMMIT;
