// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Below lg the top bar collapses into this sheet: the same grouped model as
// the desktop dropdowns (headings + items), search on top, the account items
// at the bottom. It replaces the old 29-link flat list.

import React from 'react';
import { Link } from 'react-router-dom';
import { CREATE_COMMANDS } from './navConfig';

const LINK = 'flex items-center min-h-[40px] px-3 rounded-md text-sm';
const IDLE = 'text-gray-700 hover:bg-gray-50';
const ON   = 'text-brand-blue bg-blue-50 font-medium';

function Heading({ children }) {
  return <div className="px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{children}</div>;
}

export default function MobileSheet({ model, activeGroup, activeItem, user, onSearch, onSignOut, onClose }) {
  const link = (it) => (
    <Link
      key={it.key}
      to={it.to}
      onClick={onClose}
      aria-current={activeItem === it.key ? 'page' : undefined}
      className={`${LINK} ${activeItem === it.key ? ON : IDLE}`}
    >
      {it.label}
    </Link>
  );

  const groups = model.primary.filter((e) => e.type === 'group');
  const singles = model.primary.filter((e) => e.type === 'link');

  return (
    <div id="mobile-nav-sheet" className="lg:hidden border-t border-gray-200 bg-white max-h-[calc(100vh-3.5rem)] overflow-y-auto" data-testid="mobile-sheet">
      <div className="px-3 pt-3">
        <button
          type="button"
          onClick={() => { onClose(); onSearch(); }}
          className="w-full flex items-center gap-2 min-h-[40px] px-3 rounded-lg border border-gray-200 text-sm text-gray-500 hover:border-gray-300 hover:text-gray-700 bg-gray-50"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
          </svg>
          Search or ask anything
        </button>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {CREATE_COMMANDS.map((c) => (
            <Link
              key={c.key}
              to={c.to}
              onClick={onClose}
              className="inline-flex items-center min-h-[32px] px-2.5 rounded-md text-xs font-medium bg-gray-50 text-gray-700 hover:bg-gray-100 border border-gray-200"
            >
              {c.label}
            </Link>
          ))}
        </div>
      </div>

      <nav aria-label="Main" className="px-2 pb-2">
        <div className="pt-2 grid grid-cols-2 gap-1">
          {singles.map((it) => (
            <Link
              key={it.key}
              to={it.to}
              onClick={onClose}
              aria-current={activeItem === it.key ? 'page' : undefined}
              className={`${LINK} ${activeItem === it.key ? ON : (it.primary ? 'text-brand-blue font-semibold bg-blue-50/60' : IDLE)}`}
            >
              {it.label}
            </Link>
          ))}
        </div>
        <div className="sm:grid sm:grid-cols-2 sm:gap-x-4">
          {groups.map((g) => (
            <section key={g.key} aria-labelledby={`sheet-${g.key}`}>
              <Heading><span id={`sheet-${g.key}`} className={activeGroup === g.key ? 'text-brand-blue' : ''}>{g.label}</span></Heading>
              <div className="flex flex-col gap-0.5">{g.items.map(link)}</div>
            </section>
          ))}
          <section aria-labelledby="sheet-account">
            <Heading><span id="sheet-account" className={activeGroup === 'account' ? 'text-brand-blue' : ''}>Account</span></Heading>
            <div className="flex flex-col gap-0.5">{model.account.map(link)}</div>
          </section>
        </div>
      </nav>

      <div className="border-t border-gray-100 px-4 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-gray-900 truncate">{user?.name || user?.email}</div>
          {user?.name && <div className="text-xs text-gray-500 truncate">{user.email}</div>}
        </div>
        <button
          type="button"
          onClick={onSignOut}
          className="flex-shrink-0 px-3 min-h-[36px] bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md text-sm"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
