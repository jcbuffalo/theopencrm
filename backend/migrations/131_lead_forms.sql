-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Lead capture forms — migration 131.
--
-- A lead_form is an org-owned, publicly submittable capture form. The public
-- surface is `POST /api/public/lead-forms/:token/submit` (and a matching GET
-- that returns just enough to render the form): UNAUTHENTICATED, CSRF-exempt,
-- and strictly rate-limited — the ONLY thing that scopes a submission to an
-- org is the token, so the token must be unguessable.
--
-- public_token: 48 hex chars from crypto.randomBytes(24) — 192 bits of
-- entropy. UNIQUE both as an integrity constraint and as the lookup index for
-- the public resolve path. Never sequential, never derived from org_id.
--
-- fields JSONB: which optional lead fields the public form collects, e.g.
-- {"email": true, "phone": true, "company_name": false, ...}. `name` is
-- always collected (leads.name is NOT NULL). The submit endpoint validates
-- against its OWN server-side allowlist regardless — `fields` drives
-- rendering, not security.
--
-- is_active: kill-switch. An inactive form 404s on the public path exactly
-- like an unknown token (generic, no existence oracle).
--
-- submit_count: denormalized counter incremented on successful submits so the
-- form manager can show traction without scanning leads.
--
-- TENANCY: org_id + user_id fallback, same as leads (migration 130).
--
-- IDEMPOTENT: CREATE TABLE/INDEX IF NOT EXISTS (startup runner hard-fails on
-- 42P07/42710 — do not remove the guards).

BEGIN;

CREATE TABLE IF NOT EXISTS lead_forms (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  public_token VARCHAR(64) NOT NULL UNIQUE,
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  redirect_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  submit_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- The UNIQUE constraint above already indexes public_token; this named index
-- is a guarded no-op on fresh DBs but keeps the lookup explicit if the UNIQUE
-- constraint ever changes shape.
CREATE INDEX IF NOT EXISTS idx_lead_forms_public_token ON lead_forms(public_token);
CREATE INDEX IF NOT EXISTS idx_lead_forms_org_id       ON lead_forms(org_id);

COMMENT ON TABLE lead_forms IS
  'Public lead-capture forms. public_token (192-bit random hex) is the sole org scoping on the public submit path — treat it as a credential. See migration 131.';

COMMIT;
