-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Move the CI test user off the owner's live workspace (organizations id 1).
--
-- WHY:
--   083_seed_test_user.sql seeded crm-tester@theopencrm.com as org_role='admin'
--   in the FIRST org (`ORDER BY id LIMIT 1`), which is the owner's real live
--   workspace (id 1). That gives an automation account admin rights over real
--   customer/dogfood data. This migration relocates the test user to its own
--   dedicated, empty 'CI Test Org' and demotes it to a plain member.
--
-- SAFETY / IDEMPOTENCY:
--   * Everything is guarded on the exact email 'crm-tester@theopencrm.com'
--     inside a DO block, so if the test user is absent this migration is a
--     total no-op and touches ZERO real data.
--   * The org is created only if this user doesn't already own a 'CI Test Org'
--     (organizations has no UNIQUE on name, so we guard with NOT EXISTS rather
--     than ON CONFLICT). Column names match 032_create_organizations.sql
--     (name, owner_user_id, plan, created_at, updated_at).
--   * Re-running finds the existing org and simply re-asserts the user's
--     org_id / org_role — no duplicate org, no data change.

DO $$
DECLARE
  v_user_id INTEGER;
  v_org_id  INTEGER;
BEGIN
  SELECT id INTO v_user_id
  FROM users
  WHERE LOWER(email) = 'crm-tester@theopencrm.com'
  LIMIT 1;

  -- No test user => nothing to do.
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  -- Find (or create) the dedicated test org owned by the test user.
  SELECT id INTO v_org_id
  FROM organizations
  WHERE name = 'CI Test Org' AND owner_user_id = v_user_id
  LIMIT 1;

  IF v_org_id IS NULL THEN
    INSERT INTO organizations (name, owner_user_id, plan, created_at, updated_at)
    VALUES ('CI Test Org', v_user_id, 'free', NOW(), NOW())
    RETURNING id INTO v_org_id;
  END IF;

  -- Relocate + demote the test user. Guarded on the same email so only this
  -- one row is ever touched.
  UPDATE users
  SET org_id = v_org_id,
      org_role = 'member',
      updated_at = NOW()
  WHERE id = v_user_id
    AND LOWER(email) = 'crm-tester@theopencrm.com';
END;
$$;
