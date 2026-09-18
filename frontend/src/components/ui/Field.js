// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React from 'react';

// Field — the shared label / hint / error frame used by Input, Select and
// Textarea. Not usually rendered directly; import one of those instead.
//
// The control classes are exported so a one-off control (a date picker, a
// third-party widget) can borrow the exact same border / radius / focus
// treatment: `className={controlClasses({ size: 'sm' })}`.

export const CONTROL_BASE =
  'block w-full rounded border bg-white text-gray-900 placeholder:text-gray-400 shadow-sm ' +
  'transition-colors focus:outline-none focus:ring-2 ' +
  'disabled:bg-gray-50 disabled:text-gray-500 disabled:cursor-not-allowed';

const CONTROL_SIZE = {
  // Heights match Button sm/md so controls and buttons align on one row.
  sm: 'px-2.5 py-1.5 text-sm min-h-[32px]',
  md: 'px-3 py-2 text-sm min-h-[40px]',
};

export function controlClasses({ size = 'md', error = false, className = '' } = {}) {
  const tone = error
    ? 'border-danger-400 focus:border-danger-500 focus:ring-danger-500/20'
    : 'border-gray-300 focus:border-brand-blue focus:ring-brand-blue/20';
  return [CONTROL_BASE, CONTROL_SIZE[size] || CONTROL_SIZE.md, tone, className]
    .filter(Boolean)
    .join(' ');
}

export default function Field({ id, label, hint, error, required, className = '', children }) {
  return (
    <div className={className}>
      {label && (
        <label htmlFor={id} className="block text-sm font-medium text-gray-700 mb-1">
          {label}
          {required && <span className="text-danger-600 ml-0.5" aria-hidden="true">*</span>}
        </label>
      )}
      {children}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-xs text-danger-600" role="alert">{error}</p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-gray-500">{hint}</p>
      ) : null}
    </div>
  );
}

// Shared aria wiring for the three controls.
export function describedBy(id, { hint, error }) {
  if (error) return `${id}-error`;
  if (hint) return `${id}-hint`;
  return undefined;
}
