// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React from 'react';

// Card — the white surface every page section sits on (bg-gray-50 page,
// white card, soft shadow). Title + optional subtitle + optional actions
// slot in a header row; children fill the body.
//
//   <Card title="Members" subtitle="3 people" actions={<Button size="sm">Invite</Button>}>
//     …
//   </Card>
//   <Card padding="none"><DataTable flush … /></Card>
//
// padding: md (p-5, default) · sm (p-4) · none (tables / lists that draw
// their own dividers).
//
// CardSection — a divided block inside a Card body (settings-style pages):
//   <Card padding="none"><CardSection title="Profile">…</CardSection><CardSection>…</CardSection></Card>

const PAD = { none: '', sm: 'p-4', md: 'p-5' };

export default function Card({
  title,
  subtitle,
  actions,
  padding = 'md',
  as: Tag = 'section',
  className = '',
  bodyClassName = '',
  children,
  ...rest
}) {
  const hasHeader = title || subtitle || actions;
  return (
    <Tag className={`bg-white rounded border border-gray-200 shadow-card ${className}`} {...rest}>
      {hasHeader && (
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-gray-100">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold text-gray-900 leading-6">{title}</h2>}
            {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
        </div>
      )}
      <div className={`${PAD[padding] ?? PAD.md} ${bodyClassName}`}>{children}</div>
    </Tag>
  );
}

export function CardSection({ title, description, actions, className = '', children }) {
  return (
    <div className={`px-5 py-4 border-t border-gray-100 first:border-t-0 ${className}`}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-4 mb-3">
          <div>
            {title && <h3 className="text-sm font-semibold text-gray-900">{title}</h3>}
            {description && <p className="text-sm text-gray-500 mt-0.5">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}
