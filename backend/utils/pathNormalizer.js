// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Pageview path normalizer — the privacy rail for the page_views table
// (migration 165). Everything stored in page_views.path flows through
// normalizePath() first, on the SERVER, regardless of what the client sent.
//
// THE NORMALIZER, documented (referenced from migration 165 + PRIVACY_POLICY):
//   1. Query strings and fragments are DROPPED — '?token=…', '?q=…' never
//      reach the table.
//   2. Purely numeric path segments become ':id'   → /deals/123   → /deals/:id
//   3. Token-like segments become ':token':
//        - 16+ chars of hex                        → /portal/9f8e… → /portal/:token
//        - UUIDs                                   → /s/550e8400-… → /s/:token
//        - 16+ chars of base64url/token alphabet   → /f/AbC-12…    → /f/:token
//        - ANY segment under the known token routes (/f/, /s/, /portal/,
//          /accept-invite/) — belt and suspenders even for short tokens
//   4. Length is capped at 200 chars (column width), segment count at 10.
//   5. Anything that isn't a plausible SPA path ('' / non-string / no leading
//      slash / control chars) normalizes to null — the caller drops the view.
//
// The result is a route PATTERN, never a record locator: aggregate traffic
// shape with nothing to join back to a person, org, or credential.

const TOKEN_ROUTE_PREFIXES = ['f', 's', 'portal', 'accept-invite'];

const HEX_RE = /^[0-9a-f]{16,}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Long mixed-alphabet segments (base64url-ish). Requires at least one digit so
// long word-like slugs ('customer-success-overview') survive as themselves.
const TOKENISH_RE = /^(?=.*\d)[A-Za-z0-9_-]{16,}$/;

const MAX_LENGTH = 200;
const MAX_SEGMENTS = 10;

function normalizePath(rawPath) {
  if (typeof rawPath !== 'string') return null;
  // Strip query + fragment before anything else.
  let p = rawPath.split(/[?#]/)[0].trim();
  if (!p.startsWith('/')) return null;
  // Reject control characters / obvious garbage.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) return null;

  const segments = p.split('/').filter(Boolean);
  if (segments.length > MAX_SEGMENTS) return null;

  const out = [];
  for (let i = 0; i < segments.length; i++) {
    let seg;
    try {
      seg = decodeURIComponent(segments[i]);
    } catch {
      seg = segments[i];
    }
    const prevOriginal = i > 0 ? out[i - 1] : null;
    if (/^\d+$/.test(seg)) {
      out.push(':id');
    } else if (
      HEX_RE.test(seg)
      || UUID_RE.test(seg)
      || TOKENISH_RE.test(seg)
      || (i === 1 && TOKEN_ROUTE_PREFIXES.includes(String(prevOriginal)))
    ) {
      out.push(':token');
    } else {
      // Keep only a conservative slug alphabet; anything else is masked.
      out.push(/^[A-Za-z0-9._~-]{1,60}$/.test(seg) ? seg : ':seg');
    }
  }

  const normalized = '/' + out.join('/');
  return normalized.length > MAX_LENGTH ? null : (normalized === '/' ? '/' : normalized);
}

// Referrer HOST sanitizer — hostname only, lowercase, length-capped. Anything
// that doesn't look like a hostname is dropped.
function normalizeReferrerHost(raw) {
  if (typeof raw !== 'string') return null;
  const h = raw.trim().toLowerCase().slice(0, 100);
  if (!h) return null;
  if (!/^[a-z0-9]([a-z0-9.-]{0,98}[a-z0-9])?$/.test(h)) return null;
  return h;
}

module.exports = { normalizePath, normalizeReferrerHost };
