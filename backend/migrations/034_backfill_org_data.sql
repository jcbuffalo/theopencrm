-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

INSERT INTO organizations (name, owner_user_id, plan)
SELECT email || '''s Workspace', id, 'free' FROM users
WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.owner_user_id = users.id);

UPDATE users SET org_id = o.id, org_role = 'owner'
FROM organizations o
WHERE o.owner_user_id = users.id AND users.org_id IS NULL;

UPDATE companies SET org_id = u.org_id
FROM users u WHERE companies.user_id = u.id AND companies.org_id IS NULL AND u.org_id IS NOT NULL;

UPDATE contacts SET org_id = u.org_id
FROM users u WHERE contacts.user_id = u.id AND contacts.org_id IS NULL AND u.org_id IS NOT NULL;

UPDATE deals SET org_id = u.org_id
FROM users u WHERE deals.user_id = u.id AND deals.org_id IS NULL AND u.org_id IS NOT NULL;

UPDATE activities SET org_id = u.org_id
FROM users u WHERE activities.user_id = u.id AND activities.org_id IS NULL AND u.org_id IS NOT NULL;

UPDATE tasks SET org_id = u.org_id
FROM users u WHERE tasks.user_id = u.id AND tasks.org_id IS NULL AND u.org_id IS NOT NULL;

UPDATE pipelines SET org_id = u.org_id
FROM users u WHERE pipelines.user_id = u.id AND pipelines.org_id IS NULL AND u.org_id IS NOT NULL;
