-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Communications surface — migration 121.
--
-- Adds the SMS message log plus a direction column on activities so call logs
-- (which reuse the activities table, type='call') carry inbound/outbound.
--
-- WHY NO SEPARATE call_logs TABLE
--   Call logging is just another timeline event. activities already carries
--   duration_minutes, outcome, notes/description, contact_id, and deal_id —
--   everything a logged call needs. The only gap was direction, which we add
--   below as an additive column (also used by the sms-logged activity rows).
--   A dedicated call_logs table would duplicate the activities timeline and
--   force every 360/timeline aggregator to learn a new source. So: reuse.
--
-- SMS is its own table because a message log has provider-specific fields
-- (provider_sid, status, to/from numbers) that don't map onto an activity, and
-- because the *activity* row is the timeline marker while sms_messages is the
-- system-of-record for the actual send. Every SMS send writes BOTH: one
-- sms_messages row and one activities(type='sms') row.
--
-- TENANCY
--   sms_messages mirrors the CRM-core tables (activities/contacts/deals):
--   user_id NOT NULL is the creator + the user_id-fallback scope column, org_id
--   is the primary scope column. qs(req) -> ['org_id', orgId] | ['user_id',
--   userId] works verbatim against this table for both org and org-less tenants.
--
-- IDEMPOTENT
--   Re-running this file is a no-op via IF NOT EXISTS guards on every table,
--   column, and index. The startup runner hard-fails on 42P07 / 42710, so a
--   bare CREATE / ALTER without a guard would crash-loop the deploy — do not
--   remove the guards.

BEGIN;

CREATE TABLE IF NOT EXISTS sms_messages (
  id            SERIAL       PRIMARY KEY,
  user_id       INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id        INTEGER      REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id    INTEGER      REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id       INTEGER      REFERENCES deals(id) ON DELETE SET NULL,
  direction     VARCHAR(20)  NOT NULL DEFAULT 'outbound',
  to_number     VARCHAR(32)  NOT NULL,
  from_number   VARCHAR(32),
  body          TEXT         NOT NULL,
  status        VARCHAR(20)  NOT NULL DEFAULT 'queued',
  provider_sid  VARCHAR(64),
  created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sms_messages_org_id     ON sms_messages(org_id);
CREATE INDEX IF NOT EXISTS idx_sms_messages_user_id    ON sms_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_sms_messages_contact_id ON sms_messages(contact_id);
CREATE INDEX IF NOT EXISTS idx_sms_messages_deal_id    ON sms_messages(deal_id);
CREATE INDEX IF NOT EXISTS idx_sms_messages_created_at ON sms_messages(created_at);

-- Call/SMS direction on the shared activities timeline. Nullable — existing
-- activity rows (emails, meetings, notes) have no direction and stay NULL.
ALTER TABLE activities ADD COLUMN IF NOT EXISTS direction VARCHAR(20);

COMMIT;
