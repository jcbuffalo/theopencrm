-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Email-send-from-CRM (parity gap #1, COMPETITIVE_REVIEW.md).
--
-- Three tables back the feature:
--
--   email_templates    — org-shared template library (name + subject + body
--                        with {{contact.name}} / {{deal.title}} merge fields).
--   email_sends        — one row per dispatched message; provider_message_id
--                        is the SendGrid/Gmail return id (null when the email
--                        service falls back to console-only mode). opened_at
--                        is stamped by the 1×1 tracking-pixel route on first
--                        open (idempotent — only nulls are updated).
--   email_unsubscribes — per-email opt-out keyed by token. The token is
--                        embedded in the footer link of every outbound
--                        message; visiting the unsub URL inserts a row. The
--                        /send route checks this table before transmitting.
--
-- Scope discipline (per spec): one-off sends only, no drip sequences, no
-- click tracking, no A/B testing. Future iterations can layer those on
-- without touching this schema.

BEGIN;

-- --------------------------------------------------------------------------
-- 1) Templates. Org-shared (any org member can pick from the library), but
--    created_by is tracked for audit. Soft uniqueness is provided by an
--    index on (org_id, name) — not a constraint because two orgs naming a
--    template "Welcome" is fine and historical renames must not collide.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_templates (
  id          BIGSERIAL    PRIMARY KEY,
  org_id      INTEGER      REFERENCES organizations(id) ON DELETE CASCADE,
  name        VARCHAR(120) NOT NULL,
  subject     TEXT         NOT NULL,
  body        TEXT         NOT NULL,
  created_by  INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  updated_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_email_templates_org_name
  ON email_templates(org_id, name);

-- --------------------------------------------------------------------------
-- 2) Sends. to_contact_id and to_deal_id are both nullable because a user
--    may compose ad-hoc to an arbitrary address (no CRM record). The
--    surface that opened the composer determines which fk gets filled in.
--    template_id is informational only — copying subject/body into the row
--    on send means we keep the historical message intact even if the
--    template is edited or deleted later.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_sends (
  id                  BIGSERIAL    PRIMARY KEY,
  org_id              INTEGER      REFERENCES organizations(id) ON DELETE CASCADE,
  sent_by             INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  to_contact_id       INTEGER      REFERENCES contacts(id) ON DELETE SET NULL,
  to_deal_id          INTEGER      REFERENCES deals(id) ON DELETE SET NULL,
  to_email            VARCHAR(254) NOT NULL,
  subject             TEXT,
  body                TEXT,
  template_id         INTEGER      REFERENCES email_templates(id) ON DELETE SET NULL,
  opened_at           TIMESTAMPTZ,
  sent_at             TIMESTAMPTZ  DEFAULT NOW(),
  provider_message_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_sends_org_sent_at
  ON email_sends(org_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_sends_contact
  ON email_sends(to_contact_id) WHERE to_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_sends_deal
  ON email_sends(to_deal_id) WHERE to_deal_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- 3) Unsubscribes. One row per (send, recipient) — token issued at send
--    time with unsubscribed_at = NULL. When the recipient clicks the
--    footer link, /unsubscribe stamps unsubscribed_at = NOW(). The
--    /send gate checks for any row in this table with non-null
--    unsubscribed_at for the (org_id, email) tuple before transmitting.
--    Tokens are UNIQUE 48-char hex strings (24 bytes) — well within the
--    64-char column.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_unsubscribes (
  id               BIGSERIAL    PRIMARY KEY,
  org_id           INTEGER      REFERENCES organizations(id) ON DELETE CASCADE,
  email            VARCHAR(254) NOT NULL,
  contact_id       INTEGER      REFERENCES contacts(id) ON DELETE SET NULL,
  unsubscribed_at  TIMESTAMPTZ,
  token            VARCHAR(64)  NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_unsubscribes_org_email
  ON email_unsubscribes(org_id, email)
  WHERE unsubscribed_at IS NOT NULL;

COMMIT;
