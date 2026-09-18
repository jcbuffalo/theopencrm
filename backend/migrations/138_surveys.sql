-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- NPS/CSAT Surveys (CS-7) — migration 138.
--
-- Two tables:
--   surveys           — an org's survey definitions (an NPS or CSAT question).
--   survey_responses  — one row PER ISSUED RESPONSE LINK. A row is created in
--                       a PENDING state (responded_at NULL) when links are
--                       generated, and completed exactly once by the public
--                       respond endpoint (responded_at stamped). The
--                       response_token is a 192-bit random hex credential —
--                       the ONLY public handle; org ids never leave the API.
--
-- SCORES ARE STORED RAW on the scale the respondent was asked (`surveys.kind`
-- decides: nps = 0–10, csat = 1–5). All rollup math normalizes to the 0–10
-- scale on read via services/relationshipPulse.normalizeScore, so survey NPS
-- banding is consistent with the existing Relationship Pulse feature.
--
-- NO AUTO-SEND: nothing in the schema or workers enrolls contacts or sends
-- email on its own. Link generation and the optional email send are explicit,
-- manual, per-survey actions in routes/surveyRoutes.js.
--
-- Indexes match the access patterns: org-scoped listing per survey, the public
-- token lookup, and the Account-360 per-company feed.
--
-- IDEMPOTENT: CREATE TABLE/INDEX IF NOT EXISTS throughout. The startup runner
-- hard-fails on 42P07 / 42710, so a bare CREATE would crash-loop the deploy —
-- do not remove the guards.

BEGIN;

CREATE TABLE IF NOT EXISTS surveys (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,                          -- personal-workspace fallback scope
  org_id INTEGER,                           -- tenant scope (qs(req) pattern)
  name VARCHAR(255) NOT NULL,
  kind VARCHAR(8) NOT NULL DEFAULT 'nps',   -- 'nps' | 'csat' (validated in the API layer)
  question TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS survey_responses (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,                          -- personal-workspace fallback scope
  org_id INTEGER,
  survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  contact_id INTEGER,                       -- nullable: anonymous links have no contact
  company_id INTEGER,                       -- nullable: feeds the Account 360 when set
  response_token VARCHAR(64) UNIQUE NOT NULL, -- 48-hex-char (192-bit) credential
  score INTEGER,                            -- RAW scale per surveys.kind; NULL until responded
  comment TEXT,
  responded_at TIMESTAMP NULL,              -- NULL = pending; stamped exactly once
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_surveys_org ON surveys(org_id);
CREATE INDEX IF NOT EXISTS idx_survey_responses_org_survey ON survey_responses(org_id, survey_id);
CREATE INDEX IF NOT EXISTS idx_survey_responses_token ON survey_responses(response_token);
CREATE INDEX IF NOT EXISTS idx_survey_responses_org_company ON survey_responses(org_id, company_id);

COMMENT ON TABLE surveys IS
  'NPS/CSAT survey definitions (CS-7). kind decides the response scale (nps 0-10, csat 1-5). See migration 138.';
COMMENT ON TABLE survey_responses IS
  'One row per issued response link. Pending until responded_at is stamped by the public token endpoint (once). Scores stored raw per surveys.kind; rollups normalize via relationshipPulse.normalizeScore.';

COMMIT;
