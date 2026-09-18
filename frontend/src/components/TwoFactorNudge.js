// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

// A gentle, dismissible top bar nudging admins to enable 2FA. There is no
// server-side block — the flag is set in Login.finalizeLogin when the server
// reports `requires_2fa_enrollment`.
//
// Deferred on purpose: the FIRST session is for value, so the nudge waits
// until the user's second visit (a per-browser session counter, below) and
// never shows on the chat front door (/ and /chat) — it appears once they
// move to any other page. Dismissal lasts for the tab session.

const SESSION_COUNT_KEY = 'theopencrm.sessions.count';
const SESSION_COUNTED_KEY = 'theopencrm.session.counted';

// Count one "session" per browser tab lifetime (sessionStorage) into a
// persistent per-browser counter (localStorage). Idempotent within a tab.
export function bumpSessionCount() {
  try {
    if (sessionStorage.getItem(SESSION_COUNTED_KEY) === '1') {
      return Number(localStorage.getItem(SESSION_COUNT_KEY) || 0);
    }
    const next = Number(localStorage.getItem(SESSION_COUNT_KEY) || 0) + 1;
    localStorage.setItem(SESSION_COUNT_KEY, String(next));
    sessionStorage.setItem(SESSION_COUNTED_KEY, '1');
    return next;
  } catch {
    return 0;
  }
}

export default function TwoFactorNudge() {
  const location = useLocation();
  const [show, setShow] = useState(() => {
    try {
      const wanted = sessionStorage.getItem('promptEnroll2fa') === '1'
        && sessionStorage.getItem('dismissed2faNudge') !== '1';
      if (!wanted) return false;
      return bumpSessionCount() >= 2;
    } catch {
      return false;
    }
  });

  const onFrontDoor = location.pathname === '/' || location.pathname === '/chat';
  if (!show || onFrontDoor) return null;

  const dismiss = () => {
    try { sessionStorage.setItem('dismissed2faNudge', '1'); } catch { /* ignore */ }
    setShow(false);
  };

  return (
    <div className="bg-amber-50 border-b border-amber-200 text-amber-900 text-xs sm:text-sm">
      <div className="max-w-7xl mx-auto px-4 py-1.5 flex items-center justify-between gap-3">
        <span className="min-w-0 truncate inline-flex items-center gap-1.5">
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span><span className="font-medium">Secure your admin account</span> — turn on two-factor authentication. About a minute.</span>
        </span>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Link
            to="/security"
            onClick={dismiss}
            className="font-semibold underline hover:no-underline whitespace-nowrap"
          >
            Set up 2FA
          </Link>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss"
            className="text-amber-700 hover:text-amber-900 px-1.5 py-0.5 rounded hover:bg-amber-100"
          >
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
      </div>
    </div>
  );
}
