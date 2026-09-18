-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 John Coles - The Open CRM
-- This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
-- later. See the LICENSE file at the repository root, or
-- https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

-- First-party pageview analytics (POST /api/metrics/pageview → /admin/traffic).
--
-- WHY: the owner wants visible traffic data WITHOUT third-party analytics —
-- SUBPROCESSORS.md explicitly markets "no third-party analytics", and this
-- table is what keeps that claim true while still answering "is anyone
-- visiting?". Row-per-view, no visitor identifier of any kind.
--
-- PRIVACY BY SCHEMA — what this table can NEVER hold:
--   - no user_id, no session id, no cookie value, no fingerprint: daily
--     uniques are deliberately impossible (the /admin/traffic UI says so)
--   - no IP address (rate limiting sees the IP in-flight; it is not stored)
--   - no query strings, no fragments, no tokens: `path` is NORMALIZED before
--     insert by utils/pathNormalizer.js — numeric ids become ':id'
--     (/deals/123 → /deals/:id) and token-like segments become ':token'
--     (/portal/abc123… → /portal/:token); query strings are stripped
--   - referrer_host is the HOSTNAME ONLY of an external document.referrer
--     (never the full URL, never same-site referrers)
--
-- RETENTION: 180 days, swept daily by services/emailRetentionWorker.js
-- (the existing GDPR retention worker — pageviews piggyback on its tick).
--
-- IDEMPOTENCY: CREATE TABLE / CREATE INDEX use IF NOT EXISTS; safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS page_views (
  id               BIGSERIAL PRIMARY KEY,
  -- NULL for anonymous visitors (marketing pages, login, public portal).
  org_id           INT NULL,
  -- Normalized route pattern, e.g. '/deals/:id' — see privacy note above.
  path             VARCHAR(200) NOT NULL,
  -- Hostname of an external referrer, e.g. 'news.ycombinator.com'; NULL for
  -- direct traffic and internal navigation.
  referrer_host    VARCHAR(100) NULL,
  is_authenticated BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The /admin/traffic rollups are all time-windowed (last 30d) — views/day,
-- top paths, top referrers, auth split — so created_at leads both indexes.
CREATE INDEX IF NOT EXISTS idx_page_views_created_at
  ON page_views (created_at);

CREATE INDEX IF NOT EXISTS idx_page_views_created_path
  ON page_views (created_at, path);

COMMIT;
