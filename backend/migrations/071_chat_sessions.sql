-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 071 — Chat-First copilot: sessions + messages
--
-- The "Chat-First CRM" differentiation play (see Landing.js rework). A
-- dedicated /chat surface keeps an ongoing, multi-turn conversational copilot
-- around — every message is persisted so the user can review history and so we
-- have an audit trail of what the model recommended.
--
-- Two tables:
--   chat_sessions — one row per chat thread. Started fresh on each visit by
--                   default (auto-resume is roadmap). Owned by a user inside an
--                   org. Cascade-delete with the user.
--   chat_messages — one row per turn (user or assistant). tool_calls is the
--                   raw JSONB array of Claude tool_use blocks emitted for that
--                   turn, kept around for forensics + future replay.
--
-- Idempotent: every block uses IF NOT EXISTS, wrapped in a transaction.

BEGIN;

-- ---------------------------------------------------------------------------
-- chat_sessions — one row per conversation thread
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id          INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  message_count   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_started
  ON chat_sessions(user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_org
  ON chat_sessions(org_id);

-- ---------------------------------------------------------------------------
-- chat_messages — one row per turn (user or assistant)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_messages (
  id          BIGSERIAL PRIMARY KEY,
  session_id  UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role        VARCHAR(16) NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  tool_calls  JSONB NOT NULL DEFAULT '[]'::jsonb,
  actions     JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created
  ON chat_messages(session_id, created_at);

COMMIT;
