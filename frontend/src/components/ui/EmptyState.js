// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React from 'react';
import Icon, { ICONS } from './Icon';

// Friendly empty state for list/table views. Replaces the "No records found"
// dead-ends scattered across DataTable, Companies, Contacts, Tasks, and
// Activities — those phrases told the user "the system is empty" without
// pointing at the next action.
//
// The contract is intentionally narrow:
//   title    — the headline ("No deals yet")
//   message  — one short sentence explaining what the user is looking at
//   action   — optional React node (usually a <Button>) pointing at the
//              recommended next step (e.g. "Create your first deal")
//   icon     — an Icon name ("building", "users", "inbox" …) rendered in a
//              soft grey disc. Any other string/node is rendered as-is for
//              back-compat, but new call sites should use an Icon name —
//              emoji reads as unfinished in product chrome.
//
// Sized to drop into a card / table body / panel without forcing layout
// changes. Padding scales with viewport so the surface doesn't feel cramped
// on mobile.

export default function EmptyState({ title, message, action, icon, className = '' }) {
  const isIconName = typeof icon === 'string' && !!ICONS[icon];
  return (
    <div
      className={`flex flex-col items-center justify-center text-center px-6 py-12 sm:py-16 ${className}`}
      role="status"
      aria-live="polite"
    >
      {icon && (
        isIconName ? (
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gray-100 text-gray-400" aria-hidden="true">
            <Icon name={icon} size={24} strokeWidth={1.75} />
          </div>
        ) : (
          <div className="text-4xl sm:text-5xl mb-3" aria-hidden="true">{icon}</div>
        )
      )}
      {title && (
        <h3 className="text-base sm:text-lg font-semibold text-gray-900 mb-1">
          {title}
        </h3>
      )}
      {message && (
        <p className="text-sm text-gray-600 max-w-md mb-4 leading-relaxed">
          {message}
        </p>
      )}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
