// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Small building blocks shared by the deal drawer modules (components/deal/*).
// Presentation helpers only — no network calls live here.

import React, { useEffect, useId, useState } from 'react';
import { Alert, Icon, StatusBadge } from '../ui';

// -- Shared write-action helper. Wraps an async write so a 4xx/5xx (validation,
// CSRF, feature-flag 403, …) surfaces inline instead of vanishing into an
// unhandled rejection. `run(fn)` resolves to true on success / false on
// failure so callers can gate follow-up UI (close a form, refresh a list…).
export function useAsyncAction() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      return true;
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Something went wrong. Please try again.');
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { run, error, busy, setError };
}

// -- Inline error banner shared by the drawer's write surfaces.
export function ActionError({ error, onDismiss, className = 'mt-2' }) {
  if (!error) return null;
  return (
    <Alert tone="danger" onDismiss={onDismiss} className={`py-2 text-xs ${className}`}>
      {error}
    </Alert>
  );
}

export function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '—';
  return `$${Number(n).toLocaleString()}`;
}

// Date-only strings (YYYY-MM-DD) are parsed as local dates so a close date
// never renders a day early in western time zones.
export function fmtDate(value) {
  if (!value) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString();
}

// Compact native control for inline row editors (a select in a table row).
// The primitives' 32px minimum would double row height — see DESIGN_SYSTEM.md.
export const rowControlClass =
  'text-[11px] border border-gray-300 rounded-md px-1 py-0.5 bg-white text-gray-800 ' +
  'focus:outline-none focus:border-brand-blue focus:ring-1 focus:ring-brand-blue/20';

// -- Click-to-call: a plain tel: link. No live telephony this pass — the OS
// dialer / softphone handles the call; logging it is a separate action.
export function PhoneLink({ number, className }) {
  if (!number) return <span className={className}>—</span>;
  const href = `tel:${String(number).replace(/[^+0-9]/g, '')}`;
  return <a href={href} className={className || 'text-brand-blue hover:underline'}>{number}</a>;
}

// -- Text-style button for low-emphasis row actions ("Select", "Resolve", …).
const LINK_TONE = {
  brand: 'text-brand-blue hover:underline',
  danger: 'text-danger-600 hover:underline',
  success: 'text-success-700 hover:underline',
  muted: 'text-gray-500 hover:text-gray-800 hover:underline',
};
export function LinkButton({ tone = 'brand', className = '', children, ...rest }) {
  return (
    <button
      type="button"
      className={`text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue rounded-sm disabled:opacity-50 ${LINK_TONE[tone] || LINK_TONE.brand} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

// -- Icon-only remove button used in list rows.
export function RemoveButton({ label = 'Remove', className = '', ...rest }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`rounded-md p-0.5 text-gray-400 hover:text-danger-600 hover:bg-danger-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue ${className}`}
      {...rest}
    >
      <Icon name="x" size={14} />
    </button>
  );
}

// -- Collapsible section. Collapsed by default; children mount on first open
// and stay mounted (hidden) afterwards so re-opening doesn't refetch.
// `summary` is the one-line description shown while collapsed; `openSignal`
// is a counter the parent bumps to force the section open (jump links).
export function Section({ id, title, summary, count, action, defaultOpen = false, openSignal = 0, children, className = '' }) {
  const [open, setOpen] = useState(defaultOpen);
  const [mounted, setMounted] = useState(defaultOpen);
  const panelId = useId();

  useEffect(() => {
    if (openSignal > 0) { setOpen(true); setMounted(true); }
  }, [openSignal]);

  const toggle = () => { setOpen((o) => !o); setMounted(true); };

  return (
    <div id={id} className={`border-b border-gray-100 last:border-b-0 ${className}`}>
      <div className="flex items-center gap-2 py-2.5">
        <h3 className="min-w-0 flex-1">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-controls={panelId}
            className="flex w-full min-w-0 items-center gap-2 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
          >
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={16} className="flex-shrink-0 text-gray-400" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-900">{title}</span>
                {count != null && <StatusBadge tone="neutral" label={count} />}
              </span>
              {summary && !open && <span className="block truncate text-xs text-gray-500">{summary}</span>}
            </span>
          </button>
        </h3>
        {action && <div className="flex-shrink-0">{action}</div>}
      </div>
      {mounted && (
        <div id={panelId} hidden={!open} className="pb-4 pl-6">
          {children}
        </div>
      )}
    </div>
  );
}

// -- Read-only key/value rows (Details, Order details).
export function FactList({ items, className = '' }) {
  return (
    <dl className={`space-y-1.5 text-sm ${className}`}>
      {items.filter(Boolean).map(([label, value, valueClass]) => (
        <div key={label} className="flex gap-3">
          <dt className="w-28 flex-shrink-0 text-gray-500">{label}</dt>
          <dd className={`min-w-0 flex-1 text-gray-900 ${valueClass || ''}`}>{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
