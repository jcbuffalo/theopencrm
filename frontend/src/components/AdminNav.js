// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Admin sub-navigation: the normal app top bar (with Admin lit) plus a slim
// tab strip of the most-used admin pages. Every tab here is a real route in
// App.js — the old Security / Accessibility / Compliance tabs pointed at
// pages that never existed and 404'd.

import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import Nav from './Nav';

const TABS = [
  { to: '/admin',                 label: 'Overview',        exact: true },
  { to: '/admin/users',           label: 'Users' },
  { to: '/admin/access-requests', label: 'Access requests' },
  { to: '/admin/feature-flags',   label: 'Feature flags' },
  { to: '/admin/branding',        label: 'Branding' },
  { to: '/admin/integrations',    label: 'Integrations' },
  { to: '/admin/automation',      label: 'Automation' },
  { to: '/admin/activity',        label: 'Activity' },
];

export default function AdminNav() {
  const { pathname } = useLocation();
  const isOn = (t) => (t.exact ? pathname === t.to || pathname === `${t.to}/` : pathname.startsWith(t.to));

  return (
    <>
      <Nav active="admin" />
      <div className="bg-white border-b border-gray-200">
        <nav aria-label="Admin" className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center gap-1 overflow-x-auto">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 pr-3 whitespace-nowrap">Admin</span>
          {TABS.map((t) => {
            const on = isOn(t);
            return (
              <Link
                key={t.to}
                to={t.to}
                aria-current={on ? 'page' : undefined}
                className={`relative inline-flex items-center h-11 px-3 text-sm whitespace-nowrap transition-colors ${on ? 'text-brand-blue font-semibold' : 'text-gray-600 hover:text-gray-900'}`}
              >
                {t.label}
                {on && <span aria-hidden="true" className="absolute left-3 right-3 bottom-0 h-0.5 rounded-full bg-brand-blue" />}
              </Link>
            );
          })}
        </nav>
      </div>
    </>
  );
}
