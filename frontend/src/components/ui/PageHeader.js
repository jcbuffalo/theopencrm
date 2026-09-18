// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React from 'react';
import { Link } from 'react-router-dom';
import Button from './Button';
import Menu from './Menu';
import Icon from './Icon';

// PageHeader — the one page title treatment. h1 at text-2xl semibold, an
// optional subtitle, ONE primary CTA, and everything else demoted into a
// "…" menu (or inline ghost buttons when a secondary is marked inline).
//
//   <PageHeader
//     title="Companies"
//     subtitle="Accounts, vendors and partners you work with."
//     primaryAction={{ label: 'New company', icon: 'plus', onClick: openForm }}
//     secondaryActions={[
//       { label: 'Import CSV', icon: 'upload', onClick: ... },
//       { label: 'Export CSV', icon: 'download', onClick: ... },
//     ]}
//   />
//
// primaryAction — { label, icon?, ...buttonProps } or a ready-made node.
// secondaryActions — [{ label, icon?, onClick, inline?, danger? }]; those
//   with inline:true render as ghost buttons, the rest go into the Menu.
// actions — free-form node placed before the primary (filters, toggles).
// actionSize — 'md' (default) or 'sm' for compact toolbars (Deals board).
// breadcrumb — [{ label, to? }] rendered above the title.

export default function PageHeader({
  title,
  subtitle,
  breadcrumb,
  primaryAction,
  secondaryActions = [],
  actions,
  actionSize = 'md',
  className = 'mb-6',
}) {
  const inline = secondaryActions.filter((a) => a.inline);
  const overflow = secondaryActions.filter((a) => !a.inline);

  const primary = !primaryAction ? null
    : React.isValidElement(primaryAction) ? primaryAction
    : (() => {
        const { label, icon = 'plus', ...rest } = primaryAction;
        return <Button variant="primary" size={actionSize} icon={icon} {...rest}>{label}</Button>;
      })();

  return (
    <div className={`flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between ${className}`}>
      <div className="min-w-0">
        {Array.isArray(breadcrumb) && breadcrumb.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-1 flex items-center gap-1 text-xs text-gray-500">
            {breadcrumb.map((b, i) => (
              <React.Fragment key={i}>
                {i > 0 && <Icon name="chevron-right" size={12} className="text-gray-300" />}
                {b.to ? <Link to={b.to} className="hover:text-gray-700 hover:underline">{b.label}</Link> : <span>{b.label}</span>}
              </React.Fragment>
            ))}
          </nav>
        )}
        {!Array.isArray(breadcrumb) && breadcrumb}
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-gray-500">{subtitle}</p>}
      </div>
      {(actions || primary || secondaryActions.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 sm:flex-shrink-0">
          {actions}
          {inline.map(({ label, icon, inline: _i, ...rest }) => (
            <Button key={label} variant="ghost" size={actionSize} icon={icon} {...rest}>{label}</Button>
          ))}
          {primary}
          {overflow.length > 0 && <Menu items={overflow} label="More actions" size={actionSize} />}
        </div>
      )}
    </div>
  );
}
