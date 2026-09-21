-- 173_notification_digest_email_actions.sql
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Consolidated notification email + one-click actions from the email
-- (spec 204, 2026-09-21). Owner dogfood feedback: "I get six meh emails;
-- consolidate them, and put a CTA in the email that does the task so I can
-- get work done from the reminder link."
--
-- Two tables:
--
--   notification_email_queue — every email the dispatcher WOULD have sent
--     to a user whose delivery mode is not 'instant' lands here instead.
--     services/notificationDigestWorker.js flushes a user's pending rows
--     into ONE email (batched: every 15 min; daily: once at the user's
--     chosen hour) and stamps flushed_at. Rows are the audit trail of what
--     went into which digest (digest_id groups them) and are swept after
--     30 days.
--
--   email_action_tokens — single-use, hashed, expiring tokens behind the
--     "Mark done" / "Snooze" / "Log a touch" buttons in those emails.
--     GET /act/<token> (frontend) → POST /api/email-actions/<token>/apply
--     (session-less; the token IS the credential; org/user scope comes from
--     the row, never the request). Same shape as password_reset_tokens.
--
-- Per-user delivery preference lives in the existing
-- users.notification_preferences JSONB under the key "email_delivery":
--   { "mode": "instant" | "batched" | "daily", "hour": 7 }
-- so no users column is added. users.digest_last_sent_at tracks the daily
-- cadence (one column, cheap, indexed by the worker's scan).
--
-- Idempotent: every statement guards with IF NOT EXISTS.

BEGIN;

CREATE TABLE IF NOT EXISTS notification_email_queue (
  id           BIGSERIAL PRIMARY KEY,
  org_id       INT REFERENCES organizations(id) ON DELETE CASCADE,
  user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category     TEXT NOT NULL,
  subject      TEXT NOT NULL,
  text         TEXT,
  html         TEXT,
  link         TEXT,
  entity_type  TEXT,
  entity_id    BIGINT,
  -- Optional one-click actions the digest renders for this item:
  --   [{ "action": "task.complete", "entity_id": 12, "label": "Mark done" }, ...]
  actions      JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  flushed_at   TIMESTAMPTZ,
  digest_id    TEXT
);

-- The worker's hot path: "pending rows per user, oldest first".
CREATE INDEX IF NOT EXISTS idx_notification_email_queue_pending
  ON notification_email_queue (user_id, created_at)
  WHERE flushed_at IS NULL;

CREATE TABLE IF NOT EXISTS email_action_tokens (
  id           BIGSERIAL PRIMARY KEY,
  org_id       INT REFERENCES organizations(id) ON DELETE CASCADE,
  user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    BIGINT NOT NULL,
  params       JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_action_tokens_hash
  ON email_action_tokens (token_hash);

-- Retention sweep: "expired or used, older than N days".
CREATE INDEX IF NOT EXISTS idx_email_action_tokens_expires
  ON email_action_tokens (expires_at);

ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_last_sent_at TIMESTAMPTZ;

COMMIT;
