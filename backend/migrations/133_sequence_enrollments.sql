-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Email-sequence enrollments — migration 133 of 2 (tables in 132).
--
-- One row per (sequence, contact). current_step is the 0-based index of the
-- NEXT step to send; next_send_at is when it becomes due. The leased
-- sequenceWorker (services/sequenceWorker.js) advances current_step +
-- last_sent_at ATOMICALLY (UPDATE ... WHERE status='active' AND
-- current_step = <expected> RETURNING) before dispatching, so two concurrent
-- ticks can never double-send a step.
--
-- status lifecycle: active → completed (all steps sent) | stopped (manual)
--                   | unsubscribed (recipient is in email_unsubscribes —
--                     detected at send time, before any transport call).
--
-- UNIQUE (sequence_id, contact_id): a contact can't be double-enrolled in
-- the same sequence — enroll uses ON CONFLICT DO NOTHING and reports skips.
--
-- Index (org_id, status, next_send_at) matches the worker's due-scan and the
-- enrollments-list access patterns.
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.

BEGIN;

CREATE TABLE IF NOT EXISTS sequence_enrollments (
  id            BIGSERIAL   PRIMARY KEY,
  org_id        INTEGER     REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       INTEGER     REFERENCES users(id) ON DELETE CASCADE,
  sequence_id   BIGINT      NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  contact_id    INTEGER     NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  current_step  INTEGER     NOT NULL DEFAULT 0,
  status        VARCHAR(16) NOT NULL DEFAULT 'active',
  enrolled_at   TIMESTAMPTZ DEFAULT NOW(),
  next_send_at  TIMESTAMPTZ,
  last_sent_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_sequence_enrollment UNIQUE (sequence_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_due
  ON sequence_enrollments(org_id, status, next_send_at);
CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_seq
  ON sequence_enrollments(sequence_id);

COMMIT;
