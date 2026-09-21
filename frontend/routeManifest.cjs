// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// The SPA's route table, mirrored for the Express shell server so an unknown
// path gets a REAL 404 status (+ noindex) instead of a 200 with the app shell
// (the "soft 404" the 2026-09-17 basics audit flagged). The React app still
// renders its NotFound page — we only change the status/meta, not the body.
//
// Kept in sync with `src/App.js` by `backend/test/spaRouteManifest.test.js`,
// which parses every `<Route path="…">` there and fails if one is missing
// here. Patterns use react-router syntax: `:param` matches one segment,
// a trailing `/*` matches any depth.
const KNOWN_ROUTES = [
  '/',
  // Public / pre-auth
  '/login', '/request-access', '/forgot-password', '/reset-password', '/verify-email', '/act/:token',
  '/accept-invite/:token', '/pending', '/sso/handoff',
  '/terms', '/privacy', '/your-rights', '/data-deletion', '/legal/:doc',
  '/launch', '/pitch', '/pitch/zang', '/handoff', '/checklist',
  '/hubspot-alternative', '/salesforce-alternative', '/pipedrive-alternative',
  '/zoho-alternative', '/spreadsheet-crm', '/custom-crm-alternative', '/crm-for/:slug',
  // Public token surfaces (embeddable)
  '/f/:token', '/s/:token', '/portal/:token',
  // Authenticated app
  '/chat', '/today', '/setup', '/templates',
  '/deals', '/leads', '/tasks', '/activities', '/quotes', '/quote-builder', '/forecast',
  '/products', '/sequences',
  '/contacts', '/contacts/:id', '/companies', '/accounts', '/accounts/:id', '/import', '/duplicates',
  '/renewals', '/service-contracts', '/cases', '/playbooks', '/surveys', '/segments',
  '/dashboard', '/reports', '/reports/builder', '/lifecycle-funnel', '/retention', '/winback',
  '/issues', '/appreciation', '/calendar', '/notifications',
  '/settings', '/settings/developer', '/settings/pipeline', '/security', '/team', '/usage',
  '/plugins', '/plugins/new', '/plugins/library', '/plugins/:id', '/plugins/:id/runs',
  '/admin/*',
];

function toRegex(pattern) {
  if (pattern === '/') return /^\/$/;
  const body = pattern
    .split('/')
    .map((seg) => {
      if (seg === '*') return '.*';
      if (seg.startsWith(':')) return '[^/]+';
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${body}/?$`);
}

const MATCHERS = KNOWN_ROUTES.map(toRegex);

function isKnownRoute(reqPath) {
  const p = String(reqPath || '/').split('?')[0];
  return MATCHERS.some((re) => re.test(p));
}

module.exports = { KNOWN_ROUTES, isKnownRoute };
