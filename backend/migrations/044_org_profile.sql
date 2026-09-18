-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- White-label profile per organization. Drives stage set, terminology, and
-- which advanced panels (vendor quotes, submittals, change orders) are shown.
--
-- Values:
--   'generic' (default) — vanilla CRM with simple stages
--   'zang'              — manufacturer's-rep workflow with the full Zang lifecycle
--
-- Adding a new profile means: (a) new value here, (b) new stage set in the
-- frontend's stages config, (c) optional UI gating in DealPanel.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS profile VARCHAR(40) DEFAULT 'generic';

CREATE INDEX IF NOT EXISTS idx_organizations_profile ON organizations(profile);
