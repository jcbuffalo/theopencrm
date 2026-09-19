-- 169_company_touch.sql
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Explicit "I just touched this account" stamp for companies, mirroring
-- contacts.last_touch_at (migration 125). The My Day "gone quiet" query
-- (routes/myDayRoutes.js) derives an account's last touch dynamically from
-- its deals'/contacts' activities; this column is an override so a one-tap
-- "Log a touch" on a quiet account (no matching activity yet, e.g. a phone
-- call not logged as an Activity) removes it from the list immediately.
-- myDayRoutes.js takes GREATEST(activity-derived last_touch, this column).
--
-- Idempotent: safe to re-run (CREATE TABLE/INDEX IF NOT EXISTS pattern).

ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_touch_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_companies_last_touch_at
  ON companies(org_id, last_touch_at);
