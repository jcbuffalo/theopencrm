-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- User account status: active, pending_approval, rejected, suspended.
-- Default 'active' so existing users continue to work; the register flow
-- explicitly inserts new self-registrations as 'pending_approval'.
ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';

-- Why this person is asking for access — captured on the public request form
-- so the admin has context before approving.
ALTER TABLE users ADD COLUMN IF NOT EXISTS request_company VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS request_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS requested_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rejected_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_requested_at ON users(requested_at);

-- Backfill: any existing user with no status gets 'active'. Belt-and-suspenders
-- alongside the column default.
UPDATE users SET status = 'active' WHERE status IS NULL;
