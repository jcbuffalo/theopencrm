// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// The live starter-template gallery on a public marketing page.
//
// /crm-for/:slug pages are static-data driven (marketing/verticals.js) so
// they render with zero API calls and never depend on the backend for SEO.
// This hook layers the REAL platform template on top: the 12 starters seeded
// from backend/data/platformWorkspaceTemplates.json are public
// (GET /api/public/workspace-templates, summaries only, cached 5 min) and
// their `slug` equals the vertical's `id`. When the fetch succeeds the page
// shows the actual stages / fields / rule count the visitor will get, and the
// CTA carries the template id so /setup opens pre-loaded after signup.
// When it fails (offline, rate-limited, self-host with no gallery) the page
// is exactly what it was before — the static copy.

import { useEffect, useState } from 'react';
import api from '../api';

let cache = null; // { templates: [...] } — one fetch per page load, shared across pages
let inflight = null;

export function fetchPublicTemplates() {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = api.get('/public/workspace-templates')
      .then((r) => {
        const list = Array.isArray(r?.data?.templates) ? r.data.templates : [];
        cache = { templates: list };
        return cache;
      })
      .catch(() => ({ templates: [] }))
      .finally(() => { inflight = null; });
  }
  return inflight;
}

// Returns the platform template whose slug matches `verticalId`, or null
// while loading / when none exists.
export function usePlatformTemplate(verticalId) {
  const [tpl, setTpl] = useState(null);
  useEffect(() => {
    let alive = true;
    fetchPublicTemplates().then(({ templates }) => {
      if (!alive) return;
      const hit = templates.find((t) => t.is_platform && t.slug === verticalId) || null;
      setTpl(hit);
    });
    return () => { alive = false; };
  }, [verticalId]);
  return tpl;
}

// Test-only.
export function _resetPublicTemplatesCache() {
  cache = null;
  inflight = null;
}
