-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 072 — Email composer polish: recently-used templates + retention prep
--
-- Adds two small things on top of migration 067:
--
--   1) email_templates.last_used_at TIMESTAMPTZ (nullable)
--      Stamped by POST /api/emails/send when a template_id is supplied.
--      Powers the "Recently used" section of the composer's template picker
--      (GET /api/emails/templates?recently_used=true). NULL means "never
--      used", which sorts last via "ORDER BY last_used_at DESC NULLS LAST".
--
--   2) Index on email_sends.sent_at (no org scope) — supports the daily
--      retention sweep (services/emailRetentionWorker.js) which deletes
--      rows older than 2 years in 1000-row batches. The pre-existing
--      067 index is composite on (org_id, sent_at DESC); a sweep that
--      ignores org needs a column-only index to scan efficiently across
--      tenants without a sort.
--
-- Rationale for retention: GDPR Art. 5(1)(e) "storage limitation" —
-- personal data must not be kept in identifiable form longer than is
-- necessary. Two years matches the audit-log retention pattern used
-- elsewhere in the platform; the actual delete sweep lives in the
-- worker file, this migration just makes that sweep fast.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.

BEGIN;

-- 1) Recently-used templates
ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

-- Composite index so the recently_used query (org-scoped, ordered by
-- last_used_at DESC NULLS LAST, LIMIT 5) is an index scan, not a sort.
CREATE INDEX IF NOT EXISTS idx_email_templates_org_last_used
  ON email_templates(org_id, last_used_at DESC NULLS LAST);

-- 2) Retention sweep index. The cleanup query is:
--      DELETE FROM email_sends
--       WHERE id IN (
--         SELECT id FROM email_sends WHERE sent_at < NOW() - INTERVAL '2 years'
--          ORDER BY sent_at ASC LIMIT 1000
--       )
--    Without this index the planner falls back to a seq scan on the whole
--    table. The 067 index is (org_id, sent_at DESC) so it doesn't help a
--    cross-tenant ascending scan.
CREATE INDEX IF NOT EXISTS idx_email_sends_sent_at
  ON email_sends(sent_at);

COMMIT;
