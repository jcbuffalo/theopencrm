// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React from 'react';
import Icon from './Icon';

// Alert — inline message banner. One component for the error strips,
// success flashes and "module is off" notices that used to be ad-hoc divs.
//
//   <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>
//   <Alert tone="warning" title="Leads is switched off">An admin can enable it…</Alert>
//
// tone: info (default) · success · warning · danger. Danger/warning announce
// as role="alert"; info/success as a polite status. `action` renders on the
// right (a small Button, a link).

const TONES = {
  info:    { cls: 'bg-info-50 border-info-200 text-info-800',          icon: 'info',          iconCls: 'text-info-500' },
  success: { cls: 'bg-success-50 border-success-200 text-success-800', icon: 'check-circle',  iconCls: 'text-success-600' },
  warning: { cls: 'bg-warning-50 border-warning-200 text-warning-900', icon: 'alert',         iconCls: 'text-warning-600' },
  danger:  { cls: 'bg-danger-50 border-danger-200 text-danger-800',    icon: 'alert-circle',  iconCls: 'text-danger-600' },
};

export default function Alert({ tone = 'info', title, children, onDismiss, action, icon = true, className = '' }) {
  const t = TONES[tone] || TONES.info;
  const role = tone === 'danger' || tone === 'warning' ? 'alert' : 'status';
  return (
    <div role={role} className={`flex items-start gap-3 rounded border px-4 py-3 text-sm ${t.cls} ${className}`}>
      {icon && <Icon name={typeof icon === 'string' ? icon : t.icon} size={18} className={`mt-0.5 ${t.iconCls}`} />}
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? 'mt-0.5' : ''}>{children}</div>}
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mr-1 -mt-0.5 rounded-md p-1 opacity-60 hover:opacity-100 hover:bg-black/5"
        >
          <Icon name="x" size={16} />
        </button>
      )}
    </div>
  );
}
