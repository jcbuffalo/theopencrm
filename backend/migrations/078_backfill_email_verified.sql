-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Backfill email_verified=TRUE for every user that exists at the moment the
-- EMAIL_VERIFICATION_REQUIRED gate is being enabled. Otherwise flipping the
-- env var would lock out every pre-existing user (the column defaulted to
-- FALSE in migration 045).
--
-- New users created AFTER this migration runs must verify their email before
-- the login gate lets them through (when EMAIL_VERIFICATION_REQUIRED=true).
-- Google-signin users get marked verified at signup since Google has already
-- confirmed the email belongs to them.

BEGIN;

UPDATE users
   SET email_verified = TRUE
 WHERE email_verified IS NOT TRUE
   AND created_at <= NOW();

COMMIT;
