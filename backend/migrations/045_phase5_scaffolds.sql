-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Email verification + 2FA scaffolding on users.
-- Verification is enforced only when EMAIL_VERIFICATION_REQUIRED=true is set
-- (default off for backward compatibility).
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_expires TIMESTAMP;

ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_secret VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_recovery_codes TEXT[];

CREATE INDEX IF NOT EXISTS idx_users_email_verification_token ON users(email_verification_token);

-- QuickBooks Online connection per organization. The actual access/refresh
-- tokens live here; OAuth state is short-lived and lives in `qb_oauth_state`.
CREATE TABLE IF NOT EXISTS quickbooks_connections (
  id SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  realm_id VARCHAR(100) NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  access_token_expires_at TIMESTAMP NOT NULL,
  environment VARCHAR(20) NOT NULL DEFAULT 'production',
  connected_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_sync_at TIMESTAMP,
  last_sync_status VARCHAR(50),
  last_sync_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_quickbooks_connections_org_id ON quickbooks_connections(org_id);

CREATE TABLE IF NOT EXISTS qb_oauth_state (
  id SERIAL PRIMARY KEY,
  state VARCHAR(64) UNIQUE NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_qb_oauth_state_state ON qb_oauth_state(state);

-- Track which deals have been invoiced through QuickBooks so we don't double-fire.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS qb_invoice_id VARCHAR(100);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS qb_invoiced_at TIMESTAMP;

-- Triggered automation runs. Each row is one execution of an automation rule.
-- Rules themselves are code-defined in services/automation.js — we store runs
-- here for observability, last-run tracking, and to dedupe per-deal triggers.
CREATE TABLE IF NOT EXISTS automation_runs (
  id BIGSERIAL PRIMARY KEY,
  org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  rule VARCHAR(100) NOT NULL,
  target_type VARCHAR(50),
  target_id INTEGER,
  fired_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(20) DEFAULT 'fired',
  meta JSONB
);

CREATE INDEX IF NOT EXISTS idx_automation_runs_rule_target ON automation_runs(rule, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_automation_runs_org_fired ON automation_runs(org_id, fired_at);

-- Customer surveys queued by automation; sent on a separate schedule.
CREATE TABLE IF NOT EXISTS survey_invitations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
  customer_email VARCHAR(255) NOT NULL,
  survey_token VARCHAR(64) UNIQUE NOT NULL,
  sent_at TIMESTAMP,
  responded_at TIMESTAMP,
  rating INTEGER,
  feedback TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_survey_invitations_org ON survey_invitations(org_id);
CREATE INDEX IF NOT EXISTS idx_survey_invitations_token ON survey_invitations(survey_token);

-- Meeting / call / message logs from external integrations (Teams, Zoom, etc.)
-- Webhook receivers under /api/webhooks insert here; UI displays them on the
-- linked deal/contact timeline.
CREATE TABLE IF NOT EXISTS meeting_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  related_type VARCHAR(20),
  related_id INTEGER,
  source VARCHAR(50) NOT NULL,
  external_id VARCHAR(255),
  title VARCHAR(500),
  participants TEXT,
  occurred_at TIMESTAMP,
  duration_minutes INTEGER,
  recording_url TEXT,
  transcript TEXT,
  summary TEXT,
  raw_payload JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_meeting_logs_org ON meeting_logs(org_id);
CREATE INDEX IF NOT EXISTS idx_meeting_logs_related ON meeting_logs(related_type, related_id);
CREATE INDEX IF NOT EXISTS idx_meeting_logs_source ON meeting_logs(source);
