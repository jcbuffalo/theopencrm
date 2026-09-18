// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useState, useEffect, useRef } from 'react';
import api from '../api';
import { Button, Icon, Select, Toast } from './ui';

// BulkActionBar — sticky bar at the bottom of the viewport that appears when
// the user has selected ≥1 row in a list view. Three actions: change owner,
// change status (where applicable), delete. Each opens a tiny inline picker.
// A successful call raises a short-lived success Toast (the bar itself
// unmounts once the page clears the selection).
//
// Props:
//   resource       — 'companies' | 'contacts' | 'tasks'  (used for endpoint paths)
//   selectedIds    — Set<number> or array of ids currently selected
//   onClear        — () → void
//   onComplete     — () → void  — called after a successful bulk call so the
//                    page can refresh its list and clear selection
//   ownerOptions   — [{ id, name|email }, ...]  (members for the "Change owner" picker)
//   statusOptions  — array of strings, OR null to hide the status action
//   statusLabel    — label for the status action ("Change status", "Change type", etc)
//   ownerField     — column name on the resource that holds the owner FK
//                    ('owner_id' for contacts/companies, 'assigned_to' for tasks)
//   totalCount?    — optional count of visible (filtered) rows; if provided
//                    the bar shows "X of N selected" instead of just "X selected".

const TOAST_MS = 4000;

export default function BulkActionBar({
  resource,
  selectedIds,
  onClear,
  onComplete,
  ownerOptions = [],
  statusOptions = null,
  statusLabel = 'Change status',
  ownerField = 'owner_id',
  totalCount = null,
}) {
  // Normalize to array
  const ids = Array.from(selectedIds || []);
  const [popover, setPopover] = useState(null);     // 'owner' | 'status' | 'delete' | null
  const [pendingOwner, setPendingOwner] = useState('');
  const [pendingStatus, setPendingStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);         // { tone, title } | null
  const barRef = useRef(null);

  useEffect(() => { setError(''); }, [popover]);

  // Auto-dismiss the result toast.
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  // Esc closes the active popover (NOT the bar itself — selection should
  // persist so the user can correct a typo without losing their checkboxes).
  // Click outside the bar also closes any open popover.
  useEffect(() => {
    if (!popover) return;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setPopover(null); } };
    const onClick = (e) => {
      if (barRef.current && !barRef.current.contains(e.target)) setPopover(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [popover]);

  const toastNode = toast ? (
    <Toast tone={toast.tone} title={toast.title} onDismiss={() => setToast(null)}>{toast.body}</Toast>
  ) : null;

  if (ids.length === 0) return toastNode;

  // "3 of 47 selected" when the page can tell us the visible total, plain
  // "3 selected" otherwise. Keeps the bar honest about which rows the next
  // action will hit.
  const countLabel = (typeof totalCount === 'number' && totalCount >= ids.length)
    ? `${ids.length} of ${totalCount} selected`
    : `${ids.length} selected`;

  const noun = `${ids.length} ${ids.length === 1 ? resource.replace(/ies$/, 'y').replace(/s$/, '') : resource}`;

  const callBulkUpdate = async (patch) => {
    setBusy(true);
    setError('');
    try {
      await api.patch(`/${resource}/bulk`, { ids, patch });
      setPopover(null);
      setToast({ tone: 'success', title: `Updated ${noun}` });
      onComplete?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Bulk update failed');
    } finally {
      setBusy(false);
    }
  };

  const callBulkDelete = async () => {
    setBusy(true);
    setError('');
    try {
      await api.delete(`/${resource}/bulk`, { data: { ids } });
      setPopover(null);
      setToast({ tone: 'success', title: `Deleted ${noun}` });
      onComplete?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Bulk delete failed');
    } finally {
      setBusy(false);
    }
  };

  const popoverCls = 'absolute bottom-full mb-2 left-0 rounded border border-gray-200 bg-white p-3 text-xs text-gray-900 shadow-overlay';
  const barBtn = 'rounded-md px-2.5 py-1.5 text-sm font-medium transition hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70';

  const popoverFooter = (confirm) => (
    <div className="flex justify-end gap-2">
      <Button size="sm" variant="secondary" onClick={() => setPopover(null)}>Cancel</Button>
      {confirm}
    </div>
  );

  return (
    <>
      {toastNode}
      <div
        ref={barRef}
        role="toolbar"
        aria-label={`Bulk actions: ${countLabel}`}
        className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 max-w-[95vw]"
      >
        <div className="flex items-center gap-1 rounded bg-brand-blue px-3 py-2 text-sm text-white shadow-overlay">
          <span className="mr-2 whitespace-nowrap font-semibold">{countLabel}</span>
          <span className="text-white/50" aria-hidden="true">·</span>

          <div className="relative">
            <button
              type="button"
              onClick={() => setPopover(popover === 'owner' ? null : 'owner')}
              aria-expanded={popover === 'owner'}
              className={barBtn}
            >
              Change owner
            </button>
            {popover === 'owner' && (
              <div className={`${popoverCls} w-64`}>
                <Select
                  label="New owner"
                  size="sm"
                  wrapperClassName="mb-2"
                  value={pendingOwner}
                  onChange={(e) => setPendingOwner(e.target.value)}
                >
                  <option value="">Select…</option>
                  <option value="__unassigned__">— Unassigned —</option>
                  {ownerOptions.map(u => (
                    <option key={u.id} value={u.id}>{u.name || u.email}</option>
                  ))}
                </Select>
                {error && <div className="mb-2 text-danger-600" role="alert">{error}</div>}
                {popoverFooter(
                  <Button
                    size="sm"
                    disabled={!pendingOwner}
                    loading={busy}
                    loadingLabel="Applying…"
                    onClick={() => callBulkUpdate({ [ownerField]: pendingOwner === '__unassigned__' ? null : Number(pendingOwner) })}
                  >
                    Apply
                  </Button>
                )}
              </div>
            )}
          </div>

          {statusOptions && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setPopover(popover === 'status' ? null : 'status')}
                aria-expanded={popover === 'status'}
                className={barBtn}
              >
                {statusLabel}
              </button>
              {popover === 'status' && (
                <div className={`${popoverCls} w-56`}>
                  <Select
                    label="New value"
                    size="sm"
                    wrapperClassName="mb-2"
                    value={pendingStatus}
                    onChange={(e) => setPendingStatus(e.target.value)}
                  >
                    <option value="">Select…</option>
                    {statusOptions.map(s => (
                      <option key={s.value || s} value={s.value || s}>{s.label || s}</option>
                    ))}
                  </Select>
                  {error && <div className="mb-2 text-danger-600" role="alert">{error}</div>}
                  {popoverFooter(
                    <Button
                      size="sm"
                      disabled={!pendingStatus}
                      loading={busy}
                      loadingLabel="Applying…"
                      onClick={() => callBulkUpdate(statusPatchFor(resource, pendingStatus, statusLabel))}
                    >
                      Apply
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="relative">
            <button
              type="button"
              onClick={() => setPopover(popover === 'delete' ? null : 'delete')}
              aria-expanded={popover === 'delete'}
              className={`${barBtn} hover:bg-danger-600`}
            >
              Delete
            </button>
            {popover === 'delete' && (
              <div className={`${popoverCls} w-64`}>
                <p className="mb-3 text-sm">Delete <strong>{ids.length}</strong> {resource}? This cannot be undone.</p>
                {error && <div className="mb-2 text-danger-600" role="alert">{error}</div>}
                {popoverFooter(
                  <Button size="sm" variant="danger" loading={busy} loadingLabel="Deleting…" onClick={callBulkDelete}>
                    Delete all
                  </Button>
                )}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={onClear}
            className="ml-2 rounded-md p-1 text-white/80 hover:bg-white/15 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            title="Clear selection"
            aria-label="Clear selection"
          >
            <Icon name="x" size={16} />
          </button>
        </div>
      </div>
    </>
  );
}

// Map the picker value to the resource-specific column. For companies the
// status dropdown is shared between two action buttons ("Change status" and
// "Change type"), differentiated by statusLabel. Tasks use 'status' too.
function statusPatchFor(resource, value, statusLabel) {
  if (resource === 'companies' && statusLabel === 'Change type') {
    return { type: value };
  }
  return { status: value };
}
