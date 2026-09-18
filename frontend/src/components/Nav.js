// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// The authenticated top bar.
//
//   [Logo] Chat · My Day · Pipeline ▾ · People ▾ · Customers ▾ · Reports ▾ (· Ops ▾)      [Search ⌘K] [bell] [avatar ▾]
//
// The grouped model (which entries exist, which flags hide what, which page
// key lights which group) lives in ./nav/navConfig.js; the dropdown a11y in
// ./nav/NavMenu.js; the < lg sheet in ./nav/MobileSheet.js. This file only
// lays them out. Compliance links moved to components/LegalFooter.js.

import React, { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import BrandLogo from './BrandLogo';
import { getStageConfig } from '../stages';
import { buildNavModel, resolveActive } from './nav/navConfig';
import NavMenu, { Chevron } from './nav/NavMenu';
import NotificationBell from './nav/NotificationBell';
import MobileSheet from './nav/MobileSheet';

// Opens the ⌘K command palette (mounted once in App.js). A custom event keeps
// the open logic centralised there instead of threading refs through the tree.
export const COMMAND_PALETTE_EVENT = 'ocrm:command-palette';
export function openCommandPalette() {
  window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_EVENT));
}

const BAR_ITEM = 'relative inline-flex items-center gap-1 h-9 px-3 rounded-md text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand-blue/40';
const BAR_IDLE = 'text-gray-600 hover:text-gray-900 hover:bg-gray-50';
const BAR_ON   = 'text-brand-blue font-semibold';

// Underline that marks the current group. Sits on the bar's bottom border so
// it reads as a tab, not a pill — pills are reserved for Chat.
function ActiveBar() {
  return <span aria-hidden="true" className="absolute left-3 right-3 -bottom-[10px] h-0.5 rounded-full bg-brand-blue" />;
}

function SearchButton({ compact = false }) {
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      title="Search or ask anything (⌘K / Ctrl+K)"
      aria-label="Search or ask anything"
      className={compact
        ? 'inline-flex items-center justify-center w-9 h-9 rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition'
        : 'inline-flex items-center gap-2 h-9 pl-2.5 pr-2 rounded-md border border-gray-200 hover:border-gray-300 text-sm text-gray-500 hover:text-gray-700 bg-white transition min-w-[10rem] xl:min-w-[13rem]'}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
      </svg>
      {!compact && (
        <>
          <span className="flex-1 text-left">Search or ask…</span>
          <kbd className="text-[10px] uppercase tracking-wider text-gray-400 border border-gray-200 rounded px-1 py-px">⌘K</kbd>
        </>
      )}
    </button>
  );
}

function initialsOf(user) {
  const src = (user?.name || user?.email || '?').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  const s = parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : src.slice(0, 2);
  return s.toUpperCase();
}

function UserMenu({ model, user, orgName, activeItemKey, active, onSignOut }) {
  const header = (
    <div className="px-4 pt-2 pb-2.5 border-b border-gray-100 mb-1.5">
      <div className="text-sm font-medium text-gray-900 truncate">{user?.name || user?.email}</div>
      {user?.name && <div className="text-xs text-gray-500 truncate">{user.email}</div>}
      {orgName && <div className="text-xs text-gray-400 truncate mt-0.5">{orgName}</div>}
    </div>
  );
  const adminIdx = model.account.findIndex((it) => it.key === 'admin');
  const main = adminIdx === -1 ? model.account : model.account.slice(0, adminIdx);
  const admin = adminIdx === -1 ? [] : model.account.slice(adminIdx);
  const sections = [main];
  if (admin.length) sections.push(admin);
  sections.push([{ key: 'signout', label: 'Sign out', onSelect: onSignOut }]);

  return (
    <NavMenu
      id="user-menu"
      label="Account menu"
      align="right"
      header={header}
      sections={sections}
      activeItemKey={activeItemKey}
      active={active}
      panelClassName="w-60"
      triggerClassName={`${BAR_ITEM} pl-1.5 pr-2 ${active ? BAR_ON : BAR_IDLE}`}
      renderTrigger={({ open }) => (
        <>
          <span className="w-7 h-7 rounded-full bg-brand-blue/10 text-brand-blue-dark text-[11px] font-semibold flex items-center justify-center" aria-hidden="true">
            {initialsOf(user)}
          </span>
          <span className="hidden xl:inline max-w-[9rem] truncate text-gray-700">{user?.name || user?.email}</span>
          <Chevron open={open} className="text-gray-400" />
        </>
      )}
    />
  );
}

export default function Nav({ active }) {
  const { signOut, isAdmin, orgProfile, orgBranding, orgName, orgFeatures, user } = useAuth();
  const cfg = getStageConfig(orgProfile);

  const model = useMemo(
    () => buildNavModel({ cfg, orgFeatures, isAdmin }),
    // cfg is rebuilt from orgProfile each render; key on the inputs instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orgProfile, orgFeatures, isAdmin],
  );
  const { groupKey: activeGroup, itemKey: activeItem } = useMemo(() => resolveActive(model, active), [model, active]);

  // Subtitle comes from the org's branding override (/admin/branding); never
  // a hardcoded vertical string — that would be a white-label leak.
  const subtitle = orgBranding?.displayName && orgBranding.displayName !== orgName
    ? orgBranding.displayName
    : null;

  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => { setMobileOpen(false); }, [active]);
  useEffect(() => {
    if (!mobileOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setMobileOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  return (
    <header className="bg-white border-b border-gray-200 flex-shrink-0 relative z-40">
      <div className="px-3 sm:px-5 h-14 flex items-center gap-1">
        {/* Logo → `/`, which is the Chat front door for authenticated users. */}
        <Link to="/" className="flex items-center gap-2 flex-shrink-0 h-9 pr-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-brand-blue/40">
          <BrandLogo size={26} showWordmark={true} />
          {subtitle && (
            <span className="hidden xl:inline text-[10px] uppercase tracking-wider text-brand-mint-dark font-semibold border-l border-gray-300 pl-2 truncate max-w-[160px]">
              {subtitle}
            </span>
          )}
        </Link>

        {/* Primary entries — lg and up. */}
        <nav aria-label="Main" className="hidden lg:flex items-center gap-0.5 ml-3">
          {model.primary.map((entry) => {
            const isOn = activeGroup === (entry.groupKey || entry.key);
            if (entry.type === 'link') {
              if (entry.primary) {
                return (
                  <Link
                    key={entry.key}
                    to={entry.to}
                    aria-current={isOn ? 'page' : undefined}
                    className={`${BAR_ITEM} font-semibold ${isOn ? 'bg-brand-blue text-white hover:bg-brand-blue-dark' : 'text-brand-blue bg-blue-50 hover:bg-blue-100'}`}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.4A8 8 0 1 1 21 12z" />
                    </svg>
                    {entry.label}
                  </Link>
                );
              }
              return (
                <Link
                  key={entry.key}
                  to={entry.to}
                  aria-current={isOn ? 'page' : undefined}
                  className={`${BAR_ITEM} ${isOn ? BAR_ON : BAR_IDLE}`}
                >
                  {entry.label}
                  {isOn && <ActiveBar />}
                </Link>
              );
            }
            return (
              <NavMenu
                key={entry.key}
                id={`nav-${entry.key}`}
                label={`${entry.label} menu`}
                sections={[entry.items]}
                activeItemKey={activeItem}
                active={isOn}
                triggerClassName={`${BAR_ITEM} pr-2 ${isOn ? BAR_ON : BAR_IDLE}`}
                renderTrigger={({ open }) => (
                  <>
                    {entry.label}
                    <Chevron open={open} className={isOn ? 'text-brand-blue/70' : 'text-gray-400'} />
                    {isOn && <ActiveBar />}
                  </>
                )}
              />
            );
          })}
        </nav>

        {/* Right rail: one search, the bell, the avatar menu. */}
        <div className="ml-auto flex items-center gap-1">
          <div className="hidden lg:block"><SearchButton /></div>
          <div className="lg:hidden"><SearchButton compact /></div>
          <NotificationBell />
          <div className="hidden lg:block">
            <UserMenu
              model={model}
              user={user}
              orgName={orgName}
              activeItemKey={activeItem}
              active={activeGroup === 'account'}
              onSignOut={signOut}
            />
          </div>
          <button
            type="button"
            onClick={() => setMobileOpen((o) => !o)}
            aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={mobileOpen}
            aria-controls="mobile-nav-sheet"
            className="lg:hidden inline-flex items-center justify-center w-9 h-9 rounded-md text-gray-600 hover:text-gray-900 hover:bg-gray-100"
          >
            {mobileOpen ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M6 18L18 6" /></svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
            )}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <MobileSheet
          model={model}
          activeGroup={activeGroup}
          activeItem={activeItem}
          user={user}
          onSearch={openCommandPalette}
          onSignOut={signOut}
          onClose={() => setMobileOpen(false)}
        />
      )}
    </header>
  );
}
