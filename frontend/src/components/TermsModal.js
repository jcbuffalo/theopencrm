// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Terms acceptance — a one-line, non-blocking bar at the top of the app.
//
// This used to be a full-screen modal (scroll-to-bottom + checkbox + a
// "Decline" that bounced the user to google.com) that fired on every new
// device. Owner feedback is standing: after login the user lands on VALUE,
// and required-but-non-blocking asks are dismissible bars, not modals. The
// full text lives at /terms; this bar just records the click.
//
// THE SERVER IS THE SOURCE OF TRUTH (migration 157): acceptance is recorded
// via POST /api/me/accept-terms and read via GET /api/me/accept-terms.
// localStorage is kept purely as a fast-path cache so the bar never flashes
// for a user who already accepted on this device; a legacy local acceptance
// (pre-server users) is honoured and backfilled to the server in the
// background. Filename / default export kept as `TermsModal` so App.js needs
// no import churn.

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';

// KEEP IN SYNC with CURRENT_TERMS_VERSION in backend/routes/meRoutes.js.
// Bumping both (same commit) re-prompts every user and records a fresh
// per-version server row.
export const TERMS_VERSION = '2026-09-14';

// VERSION-KEYED local cache — a boolean cache (the pre-2026-09-14 scheme)
// masked version bumps: the fast path said "accepted" and the old backfill
// then silently posted acceptance of a version the user never saw. Now the
// fast path hits only when the cached version matches TERMS_VERSION; on any
// mismatch (including the legacy boolean keys) we fall through to the server,
// which reports not-accepted for the new version → the bar shows for real.
const ACCEPTED_VERSION_KEY = 'theopencrm.terms.accepted_version';
const ACCEPTANCE_RECORD_KEY = 'theopencrm.terms.accepted_at.v1';

export function hasAcceptedTerms() {
  try {
    return localStorage.getItem(ACCEPTED_VERSION_KEY) === TERMS_VERSION;
  } catch {
    return false;
  }
}

function cacheAcceptanceLocally() {
  try {
    localStorage.setItem(ACCEPTED_VERSION_KEY, TERMS_VERSION);
    localStorage.setItem(ACCEPTANCE_RECORD_KEY, new Date().toISOString());
  } catch { /* ignore */ }
}

export default function TermsModal({ onAccept }) {
  // 'checking' → consulting cache/server; 'show' → render the bar;
  // 'accepted' → render nothing.
  const [state, setState] = useState(() => (hasAcceptedTerms() ? 'accepted' : 'checking'));

  useEffect(() => {
    if (state === 'accepted') {
      // Local fast-path hit for the CURRENT version — nothing to do. (The
      // old boolean-cache backfill is gone: it could record acceptance of a
      // version the user never saw after a bump.)
      onAccept?.();
      return undefined;
    }
    // No local cache: ask the server (source of truth). Accepted on another
    // device → cache locally and stay hidden; otherwise show the bar. On any
    // error, show the bar — worst case is a redundant (idempotent) accept.
    let cancelled = false;
    api.get('/me/accept-terms')
      .then((res) => {
        if (cancelled) return;
        if (res.data?.accepted) {
          cacheAcceptanceLocally();
          setState('accepted');
          onAccept?.();
        } else {
          setState('show');
        }
      })
      .catch(() => { if (!cancelled) setState('show'); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state !== 'show') return null;

  const accept = () => {
    cacheAcceptanceLocally();
    setState('accepted');
    onAccept?.();
    // Server record — the real one. Idempotent on the backend.
    api.post('/me/accept-terms').catch(() => { /* best-effort; cache covers UX */ });
  };

  return (
    <div
      role="region"
      aria-label="Terms of Service"
      className="bg-gray-900 text-gray-200 text-xs sm:text-sm"
    >
      <div className="max-w-7xl mx-auto px-4 py-1.5 flex items-center justify-between gap-3">
        <span className="min-w-0 truncate">
          By using The Open CRM you agree to the{' '}
          <Link to="/terms" className="underline decoration-gray-500 hover:decoration-white text-white">Terms of Service</Link>
          {' '}and{' '}
          <Link to="/privacy" className="underline decoration-gray-500 hover:decoration-white text-white">Privacy Policy</Link>.
          <span className="hidden sm:inline text-gray-400"> The software is provided as-is, without warranty.</span>
        </span>
        <button
          type="button"
          onClick={accept}
          className="flex-shrink-0 px-3 py-1 rounded-md bg-white text-gray-900 text-xs font-semibold hover:bg-gray-100 transition"
        >
          I agree
        </button>
      </div>
    </div>
  );
}
