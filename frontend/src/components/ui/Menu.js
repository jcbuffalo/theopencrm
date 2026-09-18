// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon';

// Menu — a dropdown of actions behind a "…" trigger. This is where a page's
// utilities (Import, Export, Find duplicates) live so the header keeps one
// visible CTA.
//
//   <Menu
//     label="More actions"
//     items={[
//       { label: 'Import CSV', icon: 'upload', onClick: ... },
//       { label: 'Export CSV', icon: 'download', onClick: ... },
//       { type: 'divider' },
//       { label: 'Delete', icon: 'trash', danger: true, onClick: ... },
//     ]}
//   />
//
// `trigger` replaces the default icon button (receives {open}). Closes on
// outside click, Escape, or after an item runs. Up/Down arrows move between
// items; Enter/Space activate.

export default function Menu({ items, label = 'More actions', trigger, align = 'right', size = 'md', className = '' }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const itemRefs = useRef([]);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const actionable = items.map((it, i) => (it.type === 'divider' || it.disabled ? -1 : i)).filter((i) => i >= 0);
  const focusItem = (i) => itemRefs.current[i]?.focus();

  const onListKey = (e) => {
    const current = itemRefs.current.findIndex((el) => el === document.activeElement);
    const pos = actionable.indexOf(current);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(actionable[(pos + 1) % actionable.length]); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(actionable[(pos - 1 + actionable.length) % actionable.length]); }
    else if (e.key === 'Home') { e.preventDefault(); focusItem(actionable[0]); }
    else if (e.key === 'End') { e.preventDefault(); focusItem(actionable[actionable.length - 1]); }
  };

  const toggle = () => {
    setOpen((o) => {
      if (!o) requestAnimationFrame(() => focusItem(actionable[0]));
      return !o;
    });
  };

  return (
    <div ref={rootRef} className={`relative inline-block ${className}`}>
      {trigger ? (
        <span onClick={toggle} aria-haspopup="menu" aria-expanded={open}>{trigger({ open })}</span>
      ) : (
        <button
          type="button"
          onClick={toggle}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          className={`inline-flex items-center justify-center border border-gray-300 bg-white text-gray-600 shadow-sm hover:bg-gray-50 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue focus-visible:ring-offset-2 ${size === 'sm' ? 'h-8 w-8 rounded-md' : 'h-10 w-10 rounded'}`}
        >
          <Icon name="more-horizontal" size={size === 'sm' ? 16 : 18} />
        </button>
      )}
      {open && (
        <div
          role="menu"
          aria-label={label}
          onKeyDown={onListKey}
          className={`absolute z-30 mt-1 min-w-[12rem] rounded border border-gray-200 bg-white py-1 shadow-overlay ${align === 'left' ? 'left-0' : 'right-0'}`}
        >
          {items.map((it, i) => (
            it.type === 'divider' ? (
              <div key={`d-${i}`} role="separator" className="my-1 border-t border-gray-100" />
            ) : (
              <button
                key={it.label}
                ref={(el) => { itemRefs.current[i] = el; }}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                onClick={() => { setOpen(false); it.onClick?.(); }}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm focus:outline-none focus:bg-gray-100 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed ${it.danger ? 'text-danger-600' : 'text-gray-700'}`}
              >
                {it.icon && <Icon name={it.icon} size={16} className={it.danger ? 'text-danger-500' : 'text-gray-400'} />}
                <span className="flex-1">{it.label}</span>
              </button>
            )
          ))}
        </div>
      )}
    </div>
  );
}
