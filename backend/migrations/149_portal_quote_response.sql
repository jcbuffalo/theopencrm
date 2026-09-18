-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 149: Customer Portal v3 — quote approval / request-changes from the portal
-- (the CS-10 "approvals" slice; follows the portal-case pattern of 148).
--
-- A portal viewer can now respond to a quote their vendor shared:
-- APPROVE it or REQUEST CHANGES (with an optional note). The response is
-- recorded on the quote in DEDICATED columns — the public surface never
-- mutates the internal `status` lifecycle (that stays a team decision,
-- confirm-first, especially for the Zang stage machine). The account team is
-- notified via the new 'portal_quote_response' category and acts in-app.
--
-- portal_response: 'approved' | 'changes_requested' (allowlisted in
-- services/portal.js). Latest response wins; portal_response_at stamps each.
-- Nullable, no backfill — quotes with no response simply have NULL.
-- Idempotent via ADD COLUMN IF NOT EXISTS.

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS portal_response VARCHAR(24);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS portal_response_note TEXT;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS portal_response_at TIMESTAMP NULL;

-- Backfill an explicit wire-channel pref key for the new
-- 'portal_quote_response' notification category (same pattern as 144/148:
-- email/SMS strictly opt-in; the in-app bell has no per-type opt-out).
UPDATE users
   SET notification_preferences =
       '{ "portal_quote_response": { "email": false, "sms": false } }'::jsonb
       || COALESCE(notification_preferences, '{}'::jsonb)
 WHERE notification_preferences IS NULL
    OR NOT (notification_preferences ? 'portal_quote_response');
