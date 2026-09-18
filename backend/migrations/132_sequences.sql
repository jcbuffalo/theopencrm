-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Email sequences (multi-step drip) — migration 132 of 2 (see 133 for
-- enrollments).
--
-- A SEQUENCE is an ordered list of email STEPS. Each step carries a
-- delay_days offset (days after the PREVIOUS step — or after enrollment for
-- the first step), a subject, and a body_template using the same merge-field
-- syntax as email_templates ({{contact.name}}). Contacts are attached via
-- sequence_enrollments (migration 133); the leased sequenceWorker sends due
-- steps through services/email.js, recording every dispatch in email_sends
-- and honoring email_unsubscribes suppression (migration 067).
--
-- Tenancy: org_id with user_id fallback, per the qs(req) convention. Steps
-- denormalize org_id so the worker and org-scoped queries never need to hop
-- through the parent row.
--
-- is_active gates SENDING only (the worker skips enrollments whose sequence
-- is paused); CRUD on a paused sequence still works.
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS. The
-- startup runner hard-fails on 42P07 / 42710, so keep the guards.

BEGIN;

CREATE TABLE IF NOT EXISTS sequences (
  id          BIGSERIAL    PRIMARY KEY,
  org_id      INTEGER      REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     INTEGER      REFERENCES users(id) ON DELETE CASCADE,
  name        VARCHAR(160) NOT NULL,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by  INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  updated_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sequences_org  ON sequences(org_id);
CREATE INDEX IF NOT EXISTS idx_sequences_user ON sequences(user_id);

CREATE TABLE IF NOT EXISTS sequence_steps (
  id            BIGSERIAL   PRIMARY KEY,
  sequence_id   BIGINT      NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  org_id        INTEGER     REFERENCES organizations(id) ON DELETE CASCADE,
  step_order    INTEGER     NOT NULL DEFAULT 0,
  -- Days after the previous step (or after enrollment, for the first step)
  -- before this step becomes due. 0 = send on the next worker tick.
  delay_days    INTEGER     NOT NULL DEFAULT 0,
  subject       TEXT        NOT NULL,
  body_template TEXT        NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sequence_steps_org       ON sequence_steps(org_id);
CREATE INDEX IF NOT EXISTS idx_sequence_steps_seq_order ON sequence_steps(sequence_id, step_order);

COMMIT;
