-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 161 — Record one-pager templates (CMN_REQUIREMENTS.md §1.7)
--
-- Org-branded, shareable one-page PDF "spec sheets" for a record. CMN uses
-- these for media-kit site sheets; generic orgs get property sheets,
-- candidate profiles, product specs. The template controls WHICH fields
-- appear (and in what order), whether a photo strip is included, and an
-- optional footer line. Rendering lives in services/pdfOnePager.js; an org
-- with no template rows gets a sensible built-in default per entity, so
-- nothing is required before the download button works.
--
-- config JSONB shape (kept deliberately small — same philosophy as the
-- organizations.branding blob in migration 055):
--
--   {
--     "fields": [                       -- ordered; standard field keys OR
--       { "key": "stage" },             --   org custom-field names
--       { "key": "amount", "label": "Contract value" }   -- optional override
--     ],
--     "include_photos": true,           -- photo strip of image documents
--     "photo_count": 2,                 -- how many images (default 2)
--     "include_notes": true,            -- notes paragraph under the grid
--     "footer_text": "Call us at …"     -- optional footer line
--   }
--
-- Scoping follows the qs(req) convention: org rows carry org_id, personal
-- workspaces fall back to user_id. Idempotent by construction.

CREATE TABLE IF NOT EXISTS one_pager_templates (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id      INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  entity      VARCHAR(20) NOT NULL CHECK (entity IN ('deal', 'company', 'contact')),
  name        VARCHAR(120) NOT NULL,
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_one_pager_templates_org_entity
  ON one_pager_templates(org_id, entity);
CREATE INDEX IF NOT EXISTS idx_one_pager_templates_user
  ON one_pager_templates(user_id);

-- One default template per (org, entity). Partial-unique so non-default rows
-- are unconstrained. Org-less personal rows get the same guarantee via the
-- user_id twin below (NULL org_id rows never collide in the first index).
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_pager_templates_org_default
  ON one_pager_templates(org_id, entity) WHERE is_default AND org_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_pager_templates_user_default
  ON one_pager_templates(user_id, entity) WHERE is_default AND org_id IS NULL;
