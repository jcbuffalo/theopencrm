-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Per-org AI model + effort configuration.
--
-- Adds two nullable columns to `organizations` so org admins can choose the
-- Claude model and reasoning effort used by the in-app AI features (chat
-- copilot, Drive intel summarization, Gmail intel summarization).
--
-- FALLBACK ORDER (resolved by services/aiModel.js):
--   ai_model:
--     1. organizations.ai_model              (per-org column)   ← wins
--     2. process.env.ANTHROPIC_MODEL         (env fallback)
--     3. 'claude-sonnet-4-6'                 (hardcoded default)
--
--   ai_effort:
--     1. organizations.ai_effort             (per-org column)   ← wins
--     2. 'medium'                            (hardcoded default)
--
-- Both columns are nullable on purpose — NULL means "use env / fallback".
-- The resolver in services/aiModel.js also validates stored values against
-- VALID_MODELS / VALID_EFFORTS and silently falls back to the default if a
-- stored value isn't in the allowlist (so a typo or a model retirement
-- never breaks the AI surface).
--
-- VALID VALUES:
--   ai_model:  'claude-opus-4-7' | 'claude-sonnet-4-6' | 'claude-haiku-4-5'
--   ai_effort: 'low' | 'medium' | 'high'
--
-- effort → extended-thinking budget_tokens mapping (services/aiModel.js):
--   low    → null   (no extended thinking)
--   medium → 2048
--   high   → 8192

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS ai_model TEXT;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS ai_effort TEXT;
