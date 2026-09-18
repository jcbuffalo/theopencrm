// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Cookie notice. We use only strictly-necessary cookies/storage, so this is a
// transparency line, not a consent gate. It renders IN the page flow as a
// slim top strip — never `position: fixed` — so it can't sit on top of the
// chat composer (the old fixed z-50 card physically overlapped it). Sets a
// localStorage flag on dismissal; bump POLICY_VERSION to re-show it after a
// material policy change.

import React, { useEffect, useState } from 'react';

const STORAGE_KEY = 'cookieBannerDismissed';
const POLICY_VERSION = '2026-05-12';

export default function CookieBanner() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      const dismissed = localStorage.getItem(STORAGE_KEY);
      if (!dismissed || dismissed !== POLICY_VERSION) setShow(true);
    } catch {
      // localStorage may be unavailable (private mode, etc.). Default to
      // showing the notice — over-disclosure is safer than under-disclosure.
      setShow(true);
    }
  }, []);

  const dismiss = () => {
    try { localStorage.setItem(STORAGE_KEY, POLICY_VERSION); } catch { /* swallow */ }
    setShow(false);
  };

  if (!show) return null;

  return (
    <div role="region" aria-label="Cookie notice" className="bg-gray-100 border-b border-gray-200 text-gray-600 text-xs">
      <div className="max-w-7xl mx-auto px-4 py-1.5 flex items-center justify-between gap-3">
        <span className="min-w-0 truncate">
          Only strictly-necessary cookies and local storage, to keep you signed in. No analytics or tracking.{' '}
          <a href="/legal/cookies" className="underline hover:text-gray-900">Cookie policy</a>
        </span>
        <button
          type="button"
          onClick={dismiss}
          className="flex-shrink-0 px-2 py-0.5 rounded text-gray-700 hover:bg-gray-200 font-medium"
        >
          Got it
        </button>
      </div>
    </div>
  );
}
