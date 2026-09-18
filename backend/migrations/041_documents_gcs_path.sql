-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS gcs_object_path VARCHAR(1024);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS gcs_bucket VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_documents_gcs_object_path ON documents(gcs_object_path);
