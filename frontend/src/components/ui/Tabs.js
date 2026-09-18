// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useRef } from 'react';

// Tabs — underline tabs on brand-blue. One style for every tab strip
// (the audit found 17 class strings and three underline colours).
//
//   <Tabs
//     items={[{ id: 'open', label: 'Open', count: 4 }, { id: 'done', label: 'Done' }]}
//     value={tab}
//     onChange={setTab}
//     aria-label="Task buckets"
//   />
//
// Keyboard: Left/Right/Home/End move AND select (automatic activation), so
// arrow keys behave like radio buttons. Only the active tab is in the tab
// order (roving tabindex).

export default function Tabs({ items, value, onChange, size = 'md', className = '', ...rest }) {
  const refs = useRef([]);
  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);

  const select = (i) => {
    const it = items[i];
    if (!it || it.disabled) return;
    onChange?.(it.id);
    refs.current[i]?.focus();
  };

  const onKeyDown = (e, i) => {
    const pos = enabled.indexOf(i);
    if (pos === -1) return;
    let next = null;
    if (e.key === 'ArrowRight') next = enabled[(pos + 1) % enabled.length];
    else if (e.key === 'ArrowLeft') next = enabled[(pos - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (next === null) return;
    e.preventDefault();
    select(next);
  };

  const pad = size === 'sm' ? 'px-3 py-2 text-sm' : 'px-4 py-2.5 text-sm';

  return (
    <div role="tablist" className={`flex gap-1 border-b border-gray-200 overflow-x-auto ${className}`} {...rest}>
      {items.map((it, i) => {
        const active = it.id === value;
        return (
          <button
            key={it.id}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={it.panelId}
            tabIndex={active ? 0 : -1}
            disabled={it.disabled}
            title={it.hint}
            onClick={() => select(i)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`-mb-px inline-flex items-center gap-2 whitespace-nowrap border-b-2 font-medium transition-colors ${pad} ${
              active
                ? 'border-brand-blue text-brand-blue'
                : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
            } disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue focus-visible:ring-offset-1 rounded-t`}
          >
            {it.label}
            {it.count != null && (
              <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold leading-none ${active ? 'bg-blue-100 text-brand-blue' : 'bg-gray-100 text-gray-500'}`}>
                {it.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
