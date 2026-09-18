// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import api from '../api';
import { Button, Icon, Input, Select, StatusBadge } from './ui';

// Collapsible filter panel for the Deals board. `value` is the opaque filter
// object the board owns; `onChange` replaces it wholesale. Saved filters
// (scope=deals) are listed as chips and can be applied / removed inline.

const CHECKS = [
  { key: 'hot',                   label: 'Hot only', icon: 'flame' },
  { key: 'overdue',               label: 'Overdue only' },
  { key: 'new_customer_only',     label: 'New customer' },
  { key: 'dormant_customer_only', label: 'Dormant customer' },
];

export default function DealFilters({ value, onChange, onSavedFilterApply }) {
  const [options, setOptions] = useState(null);
  const [saved, setSaved] = useState([]);
  const [open, setOpen] = useState(false);
  const [savingName, setSavingName] = useState('');

  useEffect(() => {
    api.get('/filters/options').then(r => setOptions(r.data)).catch(() => {});
    api.get('/filters/saved?scope=deals').then(r => setSaved(r.data || [])).catch(() => {});
  }, []);

  const set = (k, v) => onChange({ ...value, [k]: v });

  const activeCount = Object.entries(value)
    .filter(([k, v]) => v !== '' && v !== null && v !== undefined && v !== false && k !== 'search')
    .length;

  const saveCurrent = async () => {
    if (!savingName.trim()) return;
    try {
      await api.post('/filters/saved', { scope: 'deals', name: savingName.trim(), filters: value });
      const r = await api.get('/filters/saved?scope=deals');
      setSaved(r.data || []);
      setSavingName('');
    } catch { /* ignore */ }
  };

  const applySaved = (s) => {
    onChange(s.filters || {});
    onSavedFilterApply?.(s);
  };

  const removeSaved = async (id) => {
    await api.delete(`/filters/saved/${id}`);
    setSaved(saved.filter(s => s.id !== id));
  };

  const reset = () => {
    onChange({ search: value.search || '' });
  };

  const selects = [
    { key: 'customer_id',     empty: 'Any customer', opts: (options?.customers || []).map(c => ({ value: c.id, label: c.name })) },
    { key: 'vendor_id',       empty: 'Any vendor',   opts: (options?.vendors || []).map(c => ({ value: c.id, label: c.name })) },
    { key: 'salesman_id',     empty: 'Any salesman', opts: (options?.salesmen || []).map(s => ({ value: s.id, label: s.name || s.email })) },
    { key: 'vertical',        empty: 'Any vertical', opts: (options?.verticals || []).map(v => ({ value: v, label: v })) },
    { key: 'product',         empty: 'Any product',  opts: (options?.products || []).map(v => ({ value: v, label: v })) },
    { key: 'deal_class',      empty: 'Any class',    opts: (options?.classes || []).map(v => ({ value: v, label: v })) },
    { key: 'deal_size',       empty: 'Any size',     opts: (options?.sizes || []).map(v => ({ value: v, label: v })) },
    { key: 'office_location', empty: 'Any office',   opts: (options?.offices || []).map(v => ({ value: v, label: v })) },
  ];

  return (
    <div className="bg-white border border-gray-200 rounded shadow-card">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full px-3 py-2 flex items-center justify-between text-sm hover:bg-gray-50 transition rounded-t"
      >
        <span className="inline-flex items-center gap-2 font-medium text-gray-700">
          <Icon name="filter" size={14} className="text-gray-400" />
          Filters
          {activeCount > 0 && <StatusBadge tone="info" label={activeCount} />}
        </span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} className="text-gray-400" />
      </button>

      {open && (
        <div className="p-3 border-t border-gray-200 space-y-3 text-sm">
          {saved.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1">Saved views</p>
              <div className="flex gap-1 flex-wrap">
                {saved.map(s => (
                  <span key={s.id} className="inline-flex items-center gap-1 bg-gray-100 rounded-full pl-2.5 pr-1 py-0.5 text-xs">
                    <button type="button" onClick={() => applySaved(s)} className="hover:underline">{s.name}</button>
                    <button
                      type="button"
                      onClick={() => removeSaved(s.id)}
                      aria-label={`Remove saved view ${s.name}`}
                      className="rounded-full p-0.5 text-gray-400 hover:text-danger-600 hover:bg-gray-200"
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            {selects.map(({ key, empty, opts }) => (
              <Select
                key={key}
                size="sm"
                aria-label={empty.replace('Any ', 'Filter by ')}
                value={value[key] || ''}
                onChange={(e) => set(key, e.target.value || null)}
              >
                <option value="">{empty}</option>
                {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            ))}
          </div>

          <Select
            size="sm"
            aria-label="Filter by last-activity window"
            value={value.last_activity_window || ''}
            onChange={(e) => set('last_activity_window', e.target.value || null)}
          >
            <option value="">Any last-activity window</option>
            {(options?.lastActivityWindows || []).map(w => <option key={w.id} value={w.id}>{w.label}</option>)}
          </Select>

          <div className="flex gap-3 flex-wrap">
            {CHECKS.map(({ key, label, icon }) => (
              <label key={key} className="inline-flex items-center gap-1.5 text-xs text-gray-700">
                <input
                  type="checkbox"
                  checked={!!value[key]}
                  onChange={(e) => set(key, e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-brand-blue focus:ring-brand-blue"
                />
                {icon && <Icon name={icon} size={12} className="text-warning-500" />}
                {label}
              </label>
            ))}
          </div>

          <div className="flex gap-2 pt-3 border-t border-gray-100">
            <Input
              size="sm"
              wrapperClassName="flex-1"
              aria-label="Save current filters as"
              placeholder="Save current as…"
              value={savingName}
              onChange={(e) => setSavingName(e.target.value)}
            />
            <Button size="sm" onClick={saveCurrent} disabled={!savingName.trim()}>Save</Button>
            <Button size="sm" variant="secondary" onClick={reset}>Reset</Button>
          </div>
        </div>
      )}
    </div>
  );
}
