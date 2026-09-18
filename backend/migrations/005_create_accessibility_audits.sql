-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- Create accessibility_audits table for WCAG 2.1 AA compliance tracking
CREATE TABLE IF NOT EXISTS accessibility_audits (
  id SERIAL PRIMARY KEY,
  check_type VARCHAR(100) NOT NULL,
  -- Types: 'wcag_2.1_aa', 'keyboard_navigation', 'screen_reader', 'color_contrast', 'aria_labels'
  page_path VARCHAR(255) NOT NULL,
  -- Which page was audited (e.g., "/login", "/admin/users")
  status VARCHAR(50) NOT NULL,
  -- Status: 'pass', 'fail', 'needs_review'
  wcag_criterion VARCHAR(100),
  -- WCAG criterion (e.g., 'WCAG2AA.Principle1.Guideline1_1.1_1_1.H37')
  element_selector VARCHAR(255),
  -- CSS selector of problematic element (e.g., '.button-primary' or 'input[type="email"]')
  message TEXT NOT NULL,
  -- What accessibility issue was found
  recommendation TEXT,
  -- How to fix it (e.g., "Add aria-label to button")
  severity VARCHAR(50),
  -- Severity: 'critical', 'high', 'medium', 'low'
  audited_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accessibility_audits_page ON accessibility_audits(page_path);
CREATE INDEX IF NOT EXISTS idx_accessibility_audits_status ON accessibility_audits(status);
CREATE INDEX IF NOT EXISTS idx_accessibility_audits_wcag_criterion ON accessibility_audits(wcag_criterion);
CREATE INDEX IF NOT EXISTS idx_accessibility_audits_audited_at ON accessibility_audits(audited_at DESC);
