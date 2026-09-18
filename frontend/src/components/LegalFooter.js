// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// The compliance strip that used to live inside <Nav /> on every page. It is
// now a footer a page opts into — intended home: the Legal tab of /settings
// (and any public/legal page that wants it). Keeping it out of the nav frees
// ~28px of chrome on every screen and stops the "AS IS" warning from being
// the second thing a new user reads.

import React from 'react';
import { Link } from 'react-router-dom';

const LINKS = [
  { to: '/privacy',       label: 'Privacy'     },
  { to: '/terms',         label: 'Terms'       },
  { to: '/data-deletion', label: 'Delete data' },
  { to: '/handoff',       label: 'Handoff'     },
];

export default function LegalFooter({ className = '' }) {
  return (
    <footer className={`text-xs text-gray-500 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 py-3 ${className}`}>
      <span>Software provided AS IS, without warranty.</span>
      {/* text-brand-blue-darker (#15497F) on light backgrounds measures ~8.8:1,
          clearing WCAG 1.4.3 AA for small text. */}
      {LINKS.map((l) => (
        <Link key={l.to} to={l.to} className="text-brand-blue-darker underline hover:no-underline inline-flex items-center min-h-[32px] px-1">
          {l.label}
        </Link>
      ))}
    </footer>
  );
}
