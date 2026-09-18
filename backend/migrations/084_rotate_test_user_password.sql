-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Rotate the seeded automation-test account's password (see migration 083).
--
-- WHY: migration 083 committed the plaintext password directly to source
-- control. This rotates it to a randomly generated value that lives ONLY in
-- GCP Secret Manager (secret `crm-tester-password`, project `xfte-platform`)
-- and the `TEST_USER_PASSWORD` GitHub Actions secret — never in the repo.
--
-- The bcrypt hash below is safe to commit: it is one-way, and the plaintext is
-- a 48-char random hex string held in Secret Manager. After this migration
-- lands in production, update the `TEST_USER_PASSWORD` CI secret to the new
-- value (see .github/workflows/playwright-nightly.yml) or nightly @auth tests
-- will 401.
--
-- IDEMPOTENT: re-running simply re-applies the same hash.

UPDATE users
SET password_hash = '$2a$12$q1SPXCjHUThpxWDlzMNVY.mzUBv/MLOWKZbaotmHc1wpsawaFg39q',
    updated_at = NOW()
WHERE LOWER(email) = 'crm-tester@theopencrm.com';
