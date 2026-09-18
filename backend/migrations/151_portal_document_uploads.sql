-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- 151: Customer Portal v5 — document uploads through the portal link (the
-- LAST CS-10 collaboration slice; follows the 148/149/150 write pattern).
--
-- A portal viewer can now send files to their account team. Uploaded rows
-- are ordinary `documents` rows attached to the token's company
-- (related_type='company'), tagged source='portal' so both sides can filter
-- on origin — the portal's own document list shows the customer their
-- uploads, and the internal Documents surface can badge external files.
-- uploaded_by stays NULL for portal rows (the uploader is an external
-- customer, not a user).
--
-- Hardening lives in the route/service layer (routes/portalRoutes.js +
-- services/portal.js): 10MB cap, extension + MIME allowlist (no HTML/SVG —
-- stored-XSS vectors when served inline), filename sanitization, a
-- per-company upload quota, the shared strict write limiter, and token
-- resolution BEFORE the multipart stream is buffered.
--
-- Nullable column, no backfill. Idempotent via ADD COLUMN IF NOT EXISTS.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS source VARCHAR(24);

-- Backfill an explicit wire-channel pref key for the new
-- 'portal_document_uploaded' notification category (pattern of 144/148-150).
UPDATE users
   SET notification_preferences =
       '{ "portal_document_uploaded": { "email": false, "sms": false } }'::jsonb
       || COALESCE(notification_preferences, '{}'::jsonb)
 WHERE notification_preferences IS NULL
    OR NOT (notification_preferences ? 'portal_document_uploaded');
