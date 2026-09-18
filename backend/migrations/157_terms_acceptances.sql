-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Terms-of-Service acceptance ledger — migration 157.
--
-- Until now Terms acceptance lived ONLY in the browser's localStorage
-- (frontend/src/components/TermsModal.js) — fine as a UX fast-path, useless
-- as a legal record. This table is the server-side source of truth:
--   POST /api/me/accept-terms   records (user, version) once
--   GET  /api/me/accept-terms   returns the caller's acceptance state
-- The current version string is a single constant (CURRENT_TERMS_VERSION in
-- routes/meRoutes.js); bump it when the legal docs materially change and
-- every user will be re-prompted (one row per user per version).
--
-- org_id is nullable context (personal workspaces have none) — acceptance is
-- fundamentally per-USER, hence the (user_id, version) uniqueness.
--
-- IDEMPOTENT: CREATE TABLE/INDEX IF NOT EXISTS throughout. The startup runner
-- hard-fails on 42P07 / 42710, so a bare CREATE would crash-loop the deploy —
-- do not remove the guards.

BEGIN;

CREATE TABLE IF NOT EXISTS terms_acceptances (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  org_id INTEGER NULL,                    -- caller's org at acceptance time (context, nullable)
  version VARCHAR(32) NOT NULL,           -- e.g. '2026-05-01'
  accepted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT terms_acceptances_user_version_uniq UNIQUE (user_id, version)
);

CREATE INDEX IF NOT EXISTS idx_terms_acceptances_user ON terms_acceptances (user_id);

COMMIT;
