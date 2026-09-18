-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Sequence send attribution (analytics for email sequences).
--
-- email_sends (migration 067) predates sequences (132/133) and has no way to
-- say WHICH sequence/step produced a row — the worker's dispatches were
-- indistinguishable from one-off CRM mail. GET /api/sequences/:id/stats needs
-- per-step rollups (sent / opened / open-rate), so every sequence dispatch now
-- tags its email_sends row:
--
--   sequence_id          — FK to the owning sequence. ON DELETE SET NULL: the
--                          send row is history and must survive sequence
--                          deletion (the stats endpoint 404s then anyway).
--   sequence_step_order  — the step's ORDER (0-based), not its id. The builder
--                          replaces the whole step list on edit (DELETE +
--                          re-INSERT in updateSequence), so step ids are
--                          unstable; step_order is the stable coordinate the
--                          send loop indexes by.
--
-- Both columns are NULL for every non-sequence send — one-off composer mail is
-- untouched. Historical sequence sends (pre-143) stay NULL and simply don't
-- appear in stats; no backfill is attempted (there is nothing to join them on).
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS — the
-- startup runner hard-fails on genuine errors, so keep the guards.

BEGIN;

ALTER TABLE email_sends
  ADD COLUMN IF NOT EXISTS sequence_id BIGINT REFERENCES sequences(id) ON DELETE SET NULL;

ALTER TABLE email_sends
  ADD COLUMN IF NOT EXISTS sequence_step_order INTEGER;

-- Partial: the overwhelming majority of email_sends rows are one-off mail
-- with sequence_id NULL; stats queries only ever filter sequence rows.
CREATE INDEX IF NOT EXISTS idx_email_sends_sequence
  ON email_sends(sequence_id, sequence_step_order)
  WHERE sequence_id IS NOT NULL;

COMMIT;
