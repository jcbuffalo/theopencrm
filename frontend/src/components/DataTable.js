// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React from 'react';
import EmptyState from './ui/EmptyState';
import Skeleton from './ui/Skeleton';

// DataTable — the shared list table (design system, Aug 2026).
//  • md and up: table layout — 14px body, px-4 py-3 cells, sticky header
//  • below md: card-mode list — each row becomes a stacked card with
//    label/value pairs, so it's tappable + readable on a phone.
//
// columns: [{ key, label, width?, align?: 'left'|'right'|'center', className?, render?(row) }]
// The first column is the card title on mobile (usually the entity name).
//
// Props:
//   data, columns            — required
//   onEdit / onDelete        — optional; the Actions column appears only when
//                              at least one of these or `rowActions` is given
//   rowActions               — [{ label, onClick(row), disabled?, className?, mobileClassName? }]
//   selectedIds + onToggleRow + onToggleAll — opt-in bulk-select column
//                              (`selectedIds` is a Set or array; header
//                              checkbox is tri-state over the visible rows)
//   emptyState               — { icon, title, message, action } → <EmptyState>
//   loading                  — renders skeleton rows instead of data
//   density                  — 'default' (px-4 py-3) | 'compact' (px-3 py-2)
//   flush                    — drop the outer card (border/shadow/radius) when
//                              the table sits inside a <Card padding="none">
//   minWidth                 — CSS min-width for the desktop table (wide
//                              column sets scroll horizontally on tablets)
//   rowKey                   — property name or fn(row) for React keys (default 'id')

const DENSITY = { default: 'px-4 py-3', compact: 'px-3 py-2' };
const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' };

function cellValue(row, col) {
  const v = col.render ? col.render(row) : row[col.key];
  return v == null || v === '' ? '—' : v;
}

export default function DataTable({
  columns,
  data = [],
  onEdit,
  onDelete,
  rowActions = [],
  selectedIds = null,
  onToggleRow,
  onToggleAll,
  emptyState = null,
  loading = false,
  density = 'default',
  flush = false,
  minWidth,
  rowKey = 'id',
  stickyHeader = true,
  className = '',
}) {
  const selectable = !!selectedIds && typeof onToggleRow === 'function';
  const hasActions = !!onEdit || !!onDelete || rowActions.length > 0;
  const has = selectable
    ? (id) => (selectedIds.has ? selectedIds.has(id) : selectedIds.includes(id))
    : () => false;
  const allChecked = selectable && data.length > 0 && data.every(r => has(r.id));
  const someChecked = selectable && !allChecked && data.some(r => has(r.id));
  const keyOf = (row, i) => (typeof rowKey === 'function' ? rowKey(row) : row[rowKey]) ?? i;
  const pad = DENSITY[density] || DENSITY.default;
  const colSpan = columns.length + (hasActions ? 1 : 0) + (selectable ? 1 : 0);

  const th = `${pad} ${stickyHeader ? 'sticky top-0 z-10' : ''} bg-gray-50 border-b border-gray-200 text-xs font-semibold uppercase tracking-wider text-gray-500 whitespace-nowrap`;
  const checkboxCls = 'h-4 w-4 rounded border-gray-300 text-brand-blue focus:ring-brand-blue cursor-pointer';

  const renderEmpty = () => (
    emptyState ? (
      <EmptyState icon={emptyState.icon} title={emptyState.title} message={emptyState.message} action={emptyState.action} />
    ) : (
      <div className="px-6 py-10 text-center text-sm text-gray-500">No records found</div>
    )
  );

  const renderActions = (row, mobile) => {
    const base = mobile
      ? 'px-3 py-1.5 text-sm rounded-md font-medium'
      : 'text-sm font-medium hover:underline';
    const blue = mobile ? 'bg-info-50 text-brand-blue active:bg-info-100' : 'text-brand-blue';
    const red = mobile ? 'bg-danger-50 text-danger-700 active:bg-danger-100' : 'text-danger-600';
    const off = mobile ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'text-gray-300 cursor-not-allowed';
    return (
      <>
        {rowActions.map((action, i) => {
          const isDisabled = typeof action.disabled === 'function' ? action.disabled(row) : !!action.disabled;
          const custom = mobile ? action.mobileClassName : action.className;
          return (
            <button
              key={`action-${i}`}
              type="button"
              onClick={() => !isDisabled && action.onClick(row)}
              disabled={isDisabled}
              className={isDisabled ? `${base} ${off}` : (custom || `${base} ${blue}`)}
            >
              {action.label}
            </button>
          );
        })}
        {onEdit && <button type="button" onClick={() => onEdit(row)} className={`${base} ${blue}`}>Edit</button>}
        {onDelete && <button type="button" onClick={() => onDelete(row.id)} className={`${base} ${red}`}>Delete</button>}
      </>
    );
  };

  return (
    <div className={`${flush ? '' : 'bg-white rounded border border-gray-200 shadow-card overflow-hidden'} ${className}`}>
      {/* ----- Desktop table (md+) --------------------------------------- */}
      {/* overflow-x-auto guards the tablet range; at xl+ the container is
          the page's own width so we let overflow be visible — that is what
          allows the sticky header to stick against the page scroll. */}
      <div className="hidden md:block overflow-x-auto xl:overflow-x-visible">
        <table className="w-full text-sm" style={minWidth ? { minWidth } : undefined}>
          <thead>
            <tr>
              {selectable && (
                <th className={`${th} w-10`}>
                  <input
                    type="checkbox"
                    checked={allChecked}
                    ref={(el) => { if (el) el.indeterminate = someChecked; }}
                    onChange={(e) => onToggleAll?.(e.target.checked)}
                    aria-label="Select all rows"
                    className={checkboxCls}
                  />
                </th>
              )}
              {columns.map(col => (
                <th key={col.key} scope="col" style={{ width: col.width }} className={`${th} ${ALIGN[col.align] || ALIGN.left}`}>
                  {col.label}
                </th>
              ))}
              {hasActions && <th scope="col" className={`${th} text-right`}>Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              Array.from({ length: 5 }, (_, r) => (
                <tr key={`sk-${r}`}>
                  {selectable && <td className={pad} />}
                  {columns.map(col => (
                    <td key={`sk-${r}-${col.key}`} className={pad}>
                      <Skeleton lines={1} barClassName="h-3.5" className={col.align === 'right' ? 'ml-auto w-16' : 'w-3/4'} />
                    </td>
                  ))}
                  {hasActions && <td className={pad} />}
                </tr>
              ))
            ) : data.length === 0 ? (
              <tr><td colSpan={colSpan} className="p-0">{renderEmpty()}</td></tr>
            ) : (
              data.map((row, i) => {
                const checked = has(row.id);
                return (
                  <tr key={keyOf(row, i)} className={`transition-colors hover:bg-gray-50 ${checked ? 'bg-info-50' : ''}`}>
                    {selectable && (
                      <td className={`${pad} w-10`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => onToggleRow(row.id)}
                          aria-label={`Select row ${row.id}`}
                          className={checkboxCls}
                        />
                      </td>
                    )}
                    {columns.map((col, ci) => (
                      <td
                        key={`${keyOf(row, i)}-${col.key}`}
                        style={{ width: col.width }}
                        className={`${pad} ${ci === 0 ? 'font-medium text-gray-900' : 'text-gray-700'} ${ALIGN[col.align] || ALIGN.left} ${col.className || ''}`}
                      >
                        {cellValue(row, col)}
                      </td>
                    ))}
                    {hasActions && (
                      <td className={`${pad} text-right whitespace-nowrap`}>
                        <div className="inline-flex items-center justify-end gap-3">{renderActions(row, false)}</div>
                      </td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* ----- Mobile cards (below md) ---------------------------------- */}
      <div className="md:hidden divide-y divide-gray-100">
        {loading ? (
          <div className="p-4"><Skeleton lines={6} /></div>
        ) : data.length === 0 ? (
          renderEmpty()
        ) : (
          data.map((row, i) => {
            const [titleCol, ...rest] = columns;
            const checked = has(row.id);
            return (
              <div key={keyOf(row, i)} className={`p-4 ${checked ? 'bg-info-50' : ''}`}>
                <div className="flex items-start gap-3">
                  {selectable && (
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggleRow(row.id)}
                      aria-label={`Select row ${row.id}`}
                      className={`mt-1 ${checkboxCls} flex-shrink-0`}
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-base font-semibold text-gray-900 break-words">
                      {cellValue(row, titleCol)}
                    </div>
                    {rest.length > 0 && (
                      <dl className="mt-2 grid grid-cols-1 gap-y-1">
                        {rest.map(col => {
                          const v = col.render ? col.render(row) : row[col.key];
                          if (v == null || v === '') return null;
                          return (
                            <div key={`${keyOf(row, i)}-${col.key}`} className="flex items-baseline justify-between gap-2">
                              <dt className="text-xs uppercase tracking-wider text-gray-500 font-semibold flex-shrink-0">
                                {col.label}
                              </dt>
                              <dd className="text-sm text-gray-900 text-right break-words min-w-0">{v}</dd>
                            </div>
                          );
                        })}
                      </dl>
                    )}
                    {hasActions && (
                      <div className="mt-3 flex gap-2 justify-end flex-wrap">{renderActions(row, true)}</div>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
