// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// First-party pageview beacon. Renders nothing; on every route change it
// fires one POST /api/metrics/pageview with { path, referrer_host } and
// nothing else. Feeds the super-admin /admin/traffic page.
//
// PRIVACY CONTRACT (mirrors the server's — utils/pathNormalizer.js is the
// authoritative rail; this client-side pass just avoids putting tokens on
// the wire at all):
//   - path is normalized BEFORE sending: numeric ids → ':id', token-like
//     segments and the known token routes (/f/, /s/, /portal/,
//     /accept-invite/) → ':token'; query strings and fragments never leave
//     the browser.
//   - referrer_host is the HOSTNAME of document.referrer, sent only on the
//     first beacon of the page load and only when it's a different site —
//     internal navigation never produces a referrer.
//   - No visitor id, no cookie, no fingerprint. Unique visitors are
//     deliberately uncountable.
//   - Fire-and-forget: sendBeacon when available, else fetch keepalive;
//     failures (offline, rate-limited, blocked) are silently ignored.
//
// Must be mounted INSIDE <Router> (uses useLocation).

import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5001/api';

const TOKEN_ROUTE_PREFIXES = ['f', 's', 'portal', 'accept-invite'];
const HEX_RE = /^[0-9a-f]{16,}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKENISH_RE = /^(?=.*\d)[A-Za-z0-9_-]{16,}$/;

export function normalizeClientPath(pathname) {
  try {
    const p = String(pathname || '/').split(/[?#]/)[0];
    if (!p.startsWith('/')) return null;
    const segments = p.split('/').filter(Boolean);
    if (segments.length === 0) return '/';
    if (segments.length > 10) return null;
    const out = segments.map((seg, i) => {
      if (/^\d+$/.test(seg)) return ':id';
      if (
        HEX_RE.test(seg) || UUID_RE.test(seg) || TOKENISH_RE.test(seg)
        || (i === 1 && TOKEN_ROUTE_PREFIXES.includes(segments[0]))
      ) return ':token';
      return seg.slice(0, 60);
    });
    const normalized = `/${out.join('/')}`;
    return normalized.length > 200 ? null : normalized;
  } catch {
    return null;
  }
}

function send(body) {
  const url = `${API_URL}/metrics/pageview`;
  const json = JSON.stringify(body);
  try {
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      // Blob with an explicit JSON type so express.json parses it. Browsers
      // CORS-preflight this cross-origin; the backend's cors() handles it.
      const ok = navigator.sendBeacon(url, new Blob([json], { type: 'application/json' }));
      if (ok) return;
    }
  } catch {
    /* fall through to fetch */
  }
  try {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json,
      keepalive: true,
      credentials: 'include', // lets the server stamp is_authenticated/org
    }).catch(() => {});
  } catch {
    /* silent by design */
  }
}

export default function PageviewBeacon() {
  const location = useLocation();
  const firstBeacon = useRef(true);
  const lastPath = useRef(null);

  useEffect(() => {
    try {
      const path = normalizeClientPath(location.pathname);
      if (!path || path === lastPath.current) return;
      lastPath.current = path;

      let referrerHost = null;
      if (firstBeacon.current) {
        firstBeacon.current = false;
        try {
          const ref = document.referrer && new URL(document.referrer);
          if (ref && ref.hostname && ref.hostname !== window.location.hostname) {
            referrerHost = ref.hostname.toLowerCase().slice(0, 100);
          }
        } catch {
          /* unparseable referrer — skip */
        }
      }

      send({ path, referrer_host: referrerHost });
    } catch {
      /* analytics must never break navigation */
    }
  }, [location.pathname]);

  return null;
}
