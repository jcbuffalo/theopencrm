-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Customer Portal (read-mostly external account view) — migration 141.
--
-- One table: portal_tokens. Each row is a shareable credential that grants an
-- EXTERNAL viewer (a customer contact) a read-only window onto EXACTLY ONE
-- company's whitelisted data inside one tenant. The token is a 192-bit random
-- hex string (crypto.randomBytes(24)) — the ONLY public handle; org and
-- company ids never leave the API on the public surface.
--
-- Lifecycle: minted by an org admin (routes/portalRoutes.js, gated by the
-- portal_enabled module flag — DEFAULT FALSE, ships inert), revoked by
-- flipping is_active, optionally auto-expired via expires_at. The public read
-- endpoints stamp last_accessed_at (the only mutation the public surface can
-- cause) so admins can see whether a customer ever opened their portal.
--
-- Scoping mirrors every other tenant table: org_id with a user_id fallback
-- for personal (org-less) workspaces. services/portal.js resolves the token
-- to {scope, company_id} and EVERY read filters by both.
--
-- IDEMPOTENT: CREATE TABLE/INDEX IF NOT EXISTS throughout. The startup runner
-- hard-fails on 42P07 / 42710, so a bare CREATE would crash-loop the deploy —
-- do not remove the guards.

BEGIN;

CREATE TABLE IF NOT EXISTS portal_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,                            -- personal-workspace fallback scope
  org_id INTEGER,                             -- tenant scope (qs(req) pattern)
  company_id INTEGER NOT NULL,                -- the ONE account this token can view
  contact_id INTEGER,                         -- nullable: which contact it was issued to
  token VARCHAR(64) UNIQUE NOT NULL,          -- 48-hex-char (192-bit) credential
  label VARCHAR(255),                         -- admin-facing note ("sent to Jane, Q3 review")
  is_active BOOLEAN DEFAULT TRUE,             -- revoke = set FALSE (soft, auditable)
  expires_at TIMESTAMP NULL,                  -- NULL = no expiry
  last_accessed_at TIMESTAMP NULL,            -- stamped by the public surface (best-effort)
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_portal_tokens_token ON portal_tokens(token);
CREATE INDEX IF NOT EXISTS idx_portal_tokens_org_company ON portal_tokens(org_id, company_id);

COMMENT ON TABLE portal_tokens IS
  'Customer-portal access tokens (migration 141). One row = one shareable 192-bit credential granting read-only access to exactly one company''s whitelisted data. Gated by the portal_enabled flag (default OFF).';

COMMIT;
