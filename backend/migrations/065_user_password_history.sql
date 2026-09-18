-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Per-user password history for "no-reuse-of-last-N" policy enforcement.
--
-- WHY: validatePasswordAsync() in backend/auth.js needs to reject a new
-- password that bcrypt-matches any of the user's recent hashes. Storing the
-- full hash (not the plaintext) lets us compare without ever holding the
-- prior password in memory or persistent storage. Cost factor on these hashes
-- matches the live login hash (bcrypt cost 12) — the comparison is the same
-- bcrypt.compare() call we already pay for on sign-in.
--
-- RETENTION: the route layer only ever queries the most-recent N rows (today
-- N = 5). We don't prune older rows here — the audit-friendly choice is to
-- keep the full chain so a forensic investigator can see every rotation.
-- A separate retention job can prune to N if storage becomes a concern.
--
-- IDEMPOTENCY: CREATE TABLE / CREATE INDEX both use IF NOT EXISTS, so this
-- migration is safe to re-run by the auto-migration runner in index.js.

BEGIN;

CREATE TABLE IF NOT EXISTS user_password_history (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  set_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot-path lookup is "last N hashes for this user, newest first" — a
-- composite index with set_at DESC lets Postgres serve that as an
-- index-only-ish scan without an extra Sort node.
CREATE INDEX IF NOT EXISTS idx_user_password_history_user_set_at
  ON user_password_history (user_id, set_at DESC);

COMMIT;
