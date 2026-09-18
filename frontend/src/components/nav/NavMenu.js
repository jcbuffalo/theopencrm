// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Accessible top-bar dropdown. One primitive serves both the grouped primary
// entries (Pipeline ▾ …) and the avatar menu:
//
//   • trigger is a real <button> with aria-haspopup / aria-expanded
//   • hover-opens on pointer devices that can hover, click toggles everywhere
//   • Escape closes and returns focus to the trigger; click-outside closes
//   • ArrowDown / ArrowUp on the trigger open + focus first / last item;
//     arrows cycle inside, Home / End jump; Tab walks through items and the
//     menu closes once focus leaves it
//   • the panel is absolutely positioned, so opening never shifts layout

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';

export function Chevron({ open, className = '' }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      className={`transition-transform duration-150 ${open ? 'rotate-180' : ''} ${className}`}
    >
      <path d="M6 8l4 4 4-4" />
    </svg>
  );
}

function useCanHover() {
  const [can, setCan] = useState(false);
  useEffect(() => {
    try { setCan(!!window.matchMedia?.('(hover: hover)')?.matches); } catch { setCan(false); }
  }, []);
  return can;
}

const ITEM_BASE = 'flex items-center gap-2 min-h-[36px] mx-1.5 px-2.5 rounded-md text-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-brand-blue/40';
const ITEM_IDLE = 'text-gray-700 hover:bg-gray-50 hover:text-gray-900';
const ITEM_ON   = 'text-brand-blue bg-blue-50 font-medium';

/**
 * @param {object}   props
 * @param {string}   props.id            unique id (aria wiring)
 * @param {Array}    props.sections      [[{ key, label, to | onSelect, danger? }], …] — arrays render with a divider between them
 * @param {string}   props.activeItemKey highlighted item
 * @param {boolean}  props.active        highlight the trigger (a child is the current page)
 * @param {'left'|'right'} props.align   panel alignment
 * @param {React.ReactNode} props.header optional panel header (avatar menu identity block)
 * @param {function} props.renderTrigger ({ open, active }) => trigger contents
 * @param {string}   props.triggerClassName
 * @param {string}   props.label         accessible name for the menu
 */
export default function NavMenu({
  id, sections, activeItemKey, active, align = 'left', header, renderTrigger, triggerClassName = '', label, panelClassName = '',
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  const leaveTimer = useRef(null);
  const canHover = useCanHover();

  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  }, []);

  // Click-outside.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown, { passive: true });
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open]);

  useEffect(() => () => clearTimeout(leaveTimer.current), []);

  const menuItems = () => Array.from(panelRef.current?.querySelectorAll('[role="menuitem"]') || []);
  const focusIndex = (idx) => {
    const els = menuItems();
    if (!els.length) return;
    els[((idx % els.length) + els.length) % els.length].focus();
  };
  const openAndFocus = (idx) => {
    setOpen(true);
    setTimeout(() => focusIndex(idx), 0);
  };

  const onTriggerKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); openAndFocus(0); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); openAndFocus(-1); }
    else if (e.key === 'Escape' && open) { e.preventDefault(); close(true); }
  };

  const onPanelKeyDown = (e) => {
    const els = menuItems();
    const i = els.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusIndex(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusIndex(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusIndex(0); }
    else if (e.key === 'End') { e.preventDefault(); focusIndex(-1); }
    else if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'Tab') {
      // Let focus move naturally; close once it lands outside the menu.
      const last = e.shiftKey ? 0 : els.length - 1;
      if (i === last) setOpen(false);
    }
  };

  const onBlur = (e) => {
    if (wrapRef.current && e.relatedTarget && !wrapRef.current.contains(e.relatedTarget)) setOpen(false);
  };

  const onMouseEnter = () => {
    if (!canHover) return;
    clearTimeout(leaveTimer.current);
    setOpen(true);
  };
  const onMouseLeave = () => {
    if (!canHover) return;
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setOpen(false), 140);
  };

  const panelId = `${id}-menu`;

  return (
    <div
      ref={wrapRef}
      className="relative"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onBlur={onBlur}
    >
      <button
        ref={btnRef}
        type="button"
        id={`${id}-trigger`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        data-active={active ? 'true' : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        className={triggerClassName}
      >
        {renderTrigger({ open, active })}
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="menu"
          aria-labelledby={`${id}-trigger`}
          onKeyDown={onPanelKeyDown}
          className={`absolute top-full mt-1.5 ${align === 'right' ? 'right-0' : 'left-0'} min-w-[13rem] bg-white border border-gray-200 rounded-lg shadow-lg py-1.5 z-50 ${panelClassName}`}
        >
          {header}
          {sections.map((items, si) => (
            <React.Fragment key={si}>
              {si > 0 && <div role="separator" className="my-1.5 border-t border-gray-100" />}
              {items.map((it) => {
                const cls = `${ITEM_BASE} ${it.danger ? 'text-red-600 hover:bg-red-50' : (activeItemKey === it.key ? ITEM_ON : ITEM_IDLE)}`;
                if (it.to) {
                  return (
                    <Link
                      key={it.key}
                      to={it.to}
                      role="menuitem"
                      aria-current={activeItemKey === it.key ? 'page' : undefined}
                      onClick={() => setOpen(false)}
                      className={cls}
                    >
                      {it.icon}
                      <span className="truncate">{it.label}</span>
                    </Link>
                  );
                }
                return (
                  <button
                    key={it.key}
                    type="button"
                    role="menuitem"
                    onClick={() => { setOpen(false); it.onSelect?.(); }}
                    className={`${cls} w-[calc(100%-0.75rem)] text-left`}
                  >
                    {it.icon}
                    <span className="truncate">{it.label}</span>
                  </button>
                );
              })}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
