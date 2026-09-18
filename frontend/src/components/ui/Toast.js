// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React from 'react';
import Icon from './Icon';

// Toast — the one floating, bottom-right notice. Consolidates the look of
// TierLimitToast, DuplicateWarningToast and the BulkActionBar result toast,
// which each hand-rolled a `fixed bottom-4 right-4` card with its own
// border colour, emoji glyph and button styling.
//
//   <Toast tone="warning" title="Possible duplicate" onDismiss={close}
//          actions={<Button size="sm" variant="secondary" onClick={review}>Review</Button>}>
//     Saved — but it looks similar to an existing record.
//   </Toast>
//
// tone: info (default) · success · warning · danger — same vocabulary as
// Alert; drives the leading icon colour and the accent bar. `actions` render
// right-aligned under the body; `onDismiss` adds the × in the corner.
// Announces politely (role="status"). `position` defaults to bottom-right;
// 'bottom-center' for bulk-action results that belong to the selection bar.

const TONES = {
  info:    { icon: 'info',         iconCls: 'text-brand-blue',   bar: 'bg-brand-blue' },
  success: { icon: 'check-circle', iconCls: 'text-success-600',  bar: 'bg-success-500' },
  warning: { icon: 'alert',        iconCls: 'text-warning-600',  bar: 'bg-warning-500' },
  danger:  { icon: 'alert-circle', iconCls: 'text-danger-600',   bar: 'bg-danger-500' },
};

const POSITIONS = {
  'bottom-right': 'bottom-4 right-4',
  'bottom-center': 'bottom-4 left-1/2 -translate-x-1/2',
};

export default function Toast({
  tone = 'info',
  title,
  children,
  actions,
  onDismiss,
  dismissLabel = 'Dismiss',
  icon = true,
  position = 'bottom-right',
  className = '',
  ...rest
}) {
  const t = TONES[tone] || TONES.info;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed z-50 w-[calc(100%-2rem)] max-w-sm overflow-hidden rounded border border-gray-200 bg-white shadow-overlay ${POSITIONS[position] || POSITIONS['bottom-right']} ${className}`}
      {...rest}
    >
      <div className={`h-1 ${t.bar}`} aria-hidden="true" />
      <div className="p-4">
        <div className="flex items-start gap-3">
          {icon && (
            <Icon name={typeof icon === 'string' ? icon : t.icon} size={18} className={`mt-0.5 flex-shrink-0 ${t.iconCls}`} />
          )}
          <div className="min-w-0 flex-1">
            {title && <p className="text-sm font-semibold text-gray-900">{title}</p>}
            {children && <div className={`text-sm text-gray-600 ${title ? 'mt-0.5' : ''}`}>{children}</div>}
          </div>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label={dismissLabel}
              className="-mr-1.5 -mt-1 rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            >
              <Icon name="x" size={16} />
            </button>
          )}
        </div>
        {actions && <div className="mt-3 flex flex-wrap justify-end gap-2">{actions}</div>}
      </div>
    </div>
  );
}
