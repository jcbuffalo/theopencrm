-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Customer Success — CS-2, migration 095.
--
-- Append-only snapshots of a rules-based (NOT AI) account-health score,
-- computed per company by the accountHealthWorker. We append rather than
-- update-in-place so the score can be trended over time (a company that
-- drifts green → yellow → red tells a story a single mutable row can't).
-- The UI shows the most recent row per (org, company); a chart can read
-- the history.
--
-- WHY signals JSONB: the worker records the individual signal inputs that
-- produced the score (recency, open red-urgency issues, upcoming renewals,
-- at-risk post-sale deals, email engagement) so the UI can explain WHY an
-- account is yellow/red without re-deriving the math. Defaults to '{}'.
--
-- band is the coarse traffic-light bucket ('green'|'yellow'|'red') derived
-- from score, denormalized so list views don't have to re-band on read.
--
-- NOTE on numbering: 091–094 are the Gmail-intel migrations; this is the
-- next free prefix. (The CS spec referred to it as the account-health
-- table; the file number follows the on-disk sequence.)
--
-- IDEMPOTENT: re-running this file is a no-op.

BEGIN;

CREATE TABLE IF NOT EXISTS account_health_snapshots (
  id           SERIAL       PRIMARY KEY,
  org_id       INTEGER      REFERENCES organizations(id) ON DELETE CASCADE,
  user_id      INTEGER      REFERENCES users(id)         ON DELETE SET NULL,
  company_id   INTEGER      REFERENCES companies(id)     ON DELETE CASCADE,
  score        INTEGER,
  band         VARCHAR(10),
  signals      JSONB        DEFAULT '{}'::jsonb,
  computed_at  TIMESTAMP    DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_health_snapshots_org_company
  ON account_health_snapshots(org_id, company_id);

COMMENT ON TABLE account_health_snapshots IS
  'Append-only rules-based account-health snapshots (CS-2). Latest row per (org, company) is what the UI displays; history powers the trend chart. See backend/services/accountHealthWorker.js.';

COMMIT;
