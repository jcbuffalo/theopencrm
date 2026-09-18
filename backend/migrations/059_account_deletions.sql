-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Self-service account deletion with grace period.
--
-- WHY: GDPR/CCPA "right to delete." User schedules; system honors after
-- a 7-day grace period unless the user (or an admin) cancels. The actual
-- deletion job is run by a future background worker; this table records
-- the intent.

CREATE TABLE IF NOT EXISTS account_deletions (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  scheduled_at  TIMESTAMP NOT NULL,
  processed_at  TIMESTAMP,
  cancelled_at  TIMESTAMP,
  status        VARCHAR(20) NOT NULL DEFAULT 'scheduled'
                  CHECK (status IN ('scheduled','cancelled','processed','failed')),
  reason        TEXT,
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_account_deletions_user_id ON account_deletions(user_id);
CREATE INDEX IF NOT EXISTS idx_account_deletions_status_scheduled_at
  ON account_deletions(status, scheduled_at)
  WHERE status = 'scheduled';

-- Add 'pending_deletion' to the users.status convention. The column is
-- already VARCHAR with no enum constraint, so this is documentation rather
-- than a schema change.
COMMENT ON COLUMN users.status IS
  'active | pending_approval | rejected | suspended | pending_deletion';
