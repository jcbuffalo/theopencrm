// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState, useCallback, useRef } from 'react';
import api from '../api';
import { Button, Icon, Input, Menu, Modal } from './ui';

// SavedViewsTabs — horizontal tab strip rendered between the page header and
// the list/Kanban body. Each tab is a saved filter+sort preset for the
// resource ('companies' | 'contacts' | 'deals' | 'tasks').
//
// Visually it matches the ui/Tabs primitive (brand-blue underline on the
// active tab) but keeps its own markup: every tab carries a per-view "…"
// menu, inline rename, drag-to-reorder and an optional ↑/↓ reorder mode,
// which don't fit the primitive's { id, label } item shape.
//
// v2 (migration 073) capabilities:
//   * Shared views — a view's owner can publish it to the whole org by
//     flipping is_shared. Non-owners see those views with a small group icon
//     (people glyph) and a read-only ⋯ menu (only "Apply" / "Set as default"
//     for themselves; rename/delete/share are owner-only and produce 403s
//     from the server).
//   * Drag-to-reorder — desktop uses the HTML5 drag-and-drop API to rearrange
//     tabs in place; on drop we recompute display_order for the affected
//     range and batch PUT /api/saved-views/:id requests. Mobile (or anyone
//     who finds DnD awkward) gets an "Edit order" mode triggered from the
//     ⋯ menu that exposes ↑/↓ buttons inline.
//
// Props:
//   resource        — string, required
//   currentFilter   — opaque object the page is currently using to filter
//   currentSort     — opaque object the page is currently using to sort
//   onApplyView     — (filter, sort, view) → void  — called when a tab is clicked
//   activeViewId    — optional id of the currently-applied view, so we can
//                     visually highlight which tab is selected. The page is
//                     expected to clear this when the user mutates the filter.
//   className       — extra wrapper classes
//
// The component owns nothing but its own list + the "Save current as view"
// modal. Filter shape is whatever the page already uses; we save + replay
// it untouched.

const TAB_BASE =
  '-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue focus-visible:ring-offset-1 rounded-t';
const TAB_ACTIVE = 'border-brand-blue text-brand-blue';
const TAB_IDLE = 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700';

export default function SavedViewsTabs({
  resource,
  currentFilter,
  currentSort,
  onApplyView,
  activeViewId = null,
  className = '',
}) {
  const [views, setViews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  // Mobile-friendly explicit reorder mode — when on, every tab grows ↑/↓
  // buttons next to the ⋯ button, and HTML5 drag is suppressed (because the
  // ↑/↓ buttons are the actual reorder affordance in this mode).
  const [reorderMode, setReorderMode] = useState(false);
  // Index where the dragged tab will be inserted on drop. -1 = no insert
  // marker visible. We render a 2px vertical blue bar at this position to
  // give the user a clear drop target — without it the strip flickers as
  // the OS-native drop cursor moves and users can't tell where the tab will
  // actually land.
  const [dropIndex, setDropIndex] = useState(-1);
  const dragSrcIndex = useRef(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const r = await api.get('/saved-views', { params: { resource } });
      setViews(r.data || []);
    } catch {
      setViews([]);
    } finally {
      setLoading(false);
    }
  }, [resource]);

  useEffect(() => { load(); }, [load]);

  const applyView = (v) => {
    onApplyView?.(v.filter_spec || {}, v.sort_spec || {}, v);
  };

  const saveCurrent = async (name, is_default, is_shared) => {
    try {
      const r = await api.post('/saved-views', {
        resource,
        name,
        filter_spec: currentFilter || {},
        sort_spec: currentSort || {},
        is_default: !!is_default,
        is_shared: !!is_shared,
      });
      // Refresh the tab strip BEFORE closing the modal so the new tab is
      // already visible (and active) the moment the modal disappears —
      // otherwise the user briefly sees the strip without their new view.
      await load();
      setShowSaveModal(false);
      // Immediately mark the new view as active so the user sees the tab
      // highlighted right away.
      onApplyView?.(r.data.filter_spec || {}, r.data.sort_spec || {}, r.data);
    } catch (err) {
      // Best-effort surface; the page itself doesn't show toasts so we just
      // alert. Replace with a proper toast system later. The modal awaits
      // this fn, so its `saving` state resets via the finally block there.
      alert(err.response?.data?.error || 'Failed to save view');
    }
  };

  const deleteView = async (id) => {
    if (!window.confirm('Delete this view?')) return;
    try {
      await api.delete(`/saved-views/${id}`);
      await load();
    } catch (err) {
      // 403 here means the caller doesn't own the view (it's just shared
      // with them). Surface that distinctly so they don't think it's a bug.
      if (err.response?.status === 403) alert('Only the owner can delete this view.');
      else alert('Failed to delete view');
    }
  };

  const setDefault = async (id) => {
    try {
      await api.put(`/saved-views/${id}`, { is_default: true });
      await load();
    } catch {
      alert('Failed to set default');
    }
  };

  const toggleShare = async (v) => {
    try {
      await api.put(`/saved-views/${v.id}`, { is_shared: !v.is_shared });
      await load();
    } catch (err) {
      if (err.response?.status === 403) alert('Only the owner can share this view.');
      else alert('Failed to update sharing');
    }
  };

  const startRename = (v) => {
    setRenamingId(v.id);
    setRenameValue(v.name);
  };

  const submitRename = async () => {
    if (!renameValue.trim()) { setRenamingId(null); return; }
    try {
      await api.put(`/saved-views/${renamingId}`, { name: renameValue.trim() });
      setRenamingId(null);
      await load();
    } catch (err) {
      if (err.response?.status === 403) alert('Only the owner can rename this view.');
      else alert('Failed to rename view');
    }
  };

  // Persist a new ordering. Takes the full ordered list of view IDs and
  // assigns display_order = (index * 10) so future inserts have headroom.
  // Updates are PUT'd in parallel; we optimistically reflect the new order
  // locally first so the strip doesn't visibly snap back if the network is
  // slow. On failure we reload to get the server's truth.
  const persistOrder = async (orderedIds) => {
    const next = orderedIds
      .map((id, i) => {
        const v = views.find(x => x.id === id);
        return v ? { ...v, display_order: i * 10 } : null;
      })
      .filter(Boolean);
    setViews(prev => {
      // Re-merge: keep is_default-first ordering deterministic with the
      // server, which sorts defaults first.
      const defaults = next.filter(v => v.is_default);
      const rest     = next.filter(v => !v.is_default);
      return [...defaults, ...rest];
    });
    try {
      await Promise.all(
        next.map(v =>
          api.put(`/saved-views/${v.id}`, { display_order: v.display_order })
            .catch(err => {
              // 403 means it's a shared view from another user — we never
              // try to reorder those (they're not draggable in the UI), so
              // this only fires on a genuine permission issue. Swallow and
              // let the reload below pull truth.
              if (err.response?.status !== 403) throw err;
            })
        )
      );
    } catch {
      alert('Failed to save new order');
      await load();
    }
  };

  // Move a view up or down one slot in the (filtered, owned-only) reorder
  // sequence. Used by the mobile "Edit order" mode. Only owned views are
  // reorderable because the server rejects display_order changes from
  // non-owners.
  const moveBy = async (id, delta) => {
    const ownedOrdered = views
      .filter(v => !v.shared)
      .map(v => v.id);
    const idx = ownedOrdered.indexOf(id);
    if (idx < 0) return;
    const next = idx + delta;
    if (next < 0 || next >= ownedOrdered.length) return;
    const swapped = ownedOrdered.slice();
    [swapped[idx], swapped[next]] = [swapped[next], swapped[idx]];
    await persistOrder(swapped);
  };

  // ---- HTML5 drag-and-drop wiring ----
  // We track the source index in a ref (faster than state and doesn't
  // re-render mid-drag) and compute dropIndex per-tab via dragOver. On drop
  // we splice the source out and back in at dropIndex, then persist.
  const onDragStart = (e, idx) => {
    if (reorderMode) return;            // mobile mode owns reordering
    if (views[idx]?.shared) return;     // can't drag a view you don't own
    dragSrcIndex.current = idx;
    // Required for Firefox to fire drag events at all.
    try { e.dataTransfer.setData('text/plain', String(idx)); } catch (_) {}
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragOverTab = (e, idx) => {
    if (dragSrcIndex.current === null) return;
    e.preventDefault();
    // Decide whether the drop target is the left or right half of the tab
    // — split at the horizontal midpoint, like every native list reorder UI.
    const rect = e.currentTarget.getBoundingClientRect();
    const before = (e.clientX - rect.left) < rect.width / 2;
    setDropIndex(before ? idx : idx + 1);
    e.dataTransfer.dropEffect = 'move';
  };
  const onDragEnd = () => {
    dragSrcIndex.current = null;
    setDropIndex(-1);
  };
  const onDropTab = async (e) => {
    e.preventDefault();
    const src = dragSrcIndex.current;
    const dst = dropIndex;
    dragSrcIndex.current = null;
    setDropIndex(-1);
    if (src === null || dst < 0 || src === dst || src + 1 === dst) return;
    const reordered = views.map(v => v.id);
    const [moved] = reordered.splice(src, 1);
    // After removing src, indices to the right shift left by one — adjust
    // dst accordingly so the tab lands where the user's cursor pointed.
    const insertAt = dst > src ? dst - 1 : dst;
    reordered.splice(insertAt, 0, moved);
    await persistOrder(reordered);
  };

  // Per-view "…" menu items — owner-only entries are simply omitted for
  // shared views so the menu never offers something the server will 403.
  const menuItemsFor = (v) => {
    const ownedByMe = !v.shared;
    const items = [{ label: 'Apply', icon: 'check', onClick: () => applyView(v) }];
    if (ownedByMe) items.push({ label: 'Rename', icon: 'edit', onClick: () => startRename(v) });
    if (ownedByMe && !v.is_default) items.push({ label: 'Set as default', icon: 'star', onClick: () => setDefault(v.id) });
    if (ownedByMe) items.push({ label: v.is_shared ? 'Stop sharing' : 'Share with org', icon: 'users', onClick: () => toggleShare(v) });
    items.push({ label: 'Edit order', icon: 'more-horizontal', onClick: () => setReorderMode(true) });
    if (ownedByMe) {
      items.push({ type: 'divider' });
      items.push({ label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteView(v.id) });
    }
    if (v.shared) {
      items.push({ type: 'divider' });
      items.push({ label: 'Shared with you — read only', disabled: true });
    }
    return items;
  };

  return (
    <div className={`flex items-center gap-1 flex-wrap border-b border-gray-200 mb-3 ${className}`}>
      {loading ? (
        <span className="px-1 py-2 text-xs text-gray-400">Loading views…</span>
      ) : views.length === 0 ? (
        // Empty-state hint — without this the page just shows a lone "Save
        // current as view" button which leaves new users unsure what saved
        // views even are. One short sentence is enough.
        <span className="px-1 py-2 text-xs text-gray-400 italic mr-1">
          No saved views yet — save your current filters as a tab below.
        </span>
      ) : (
        views.map((v, idx) => {
          const isActive = activeViewId === v.id;
          const isRenaming = renamingId === v.id;
          const ownedByMe = !v.shared;
          const draggable = ownedByMe && !reorderMode && !isRenaming;
          // The blue insertion bar sits to the LEFT of a tab when dropIndex
          // equals its index. Rendering it as a sibling (rather than a
          // pseudo-element) keeps the bar from shifting layout.
          const showBarBefore = dropIndex === idx && dragSrcIndex.current !== null;
          return (
            <React.Fragment key={v.id}>
              {showBarBefore && <span className="w-0.5 h-6 bg-brand-blue rounded-full" aria-hidden="true" />}
              <div
                className={`relative inline-flex items-center ${draggable ? 'cursor-grab active:cursor-grabbing' : ''}`}
                draggable={draggable}
                onDragStart={(e) => onDragStart(e, idx)}
                onDragOver={(e) => onDragOverTab(e, idx)}
                onDrop={onDropTab}
                onDragEnd={onDragEnd}
                style={draggable && dragSrcIndex.current === idx ? { opacity: 0.5 } : undefined}
              >
                {isRenaming ? (
                  <Input
                    autoFocus
                    size="sm"
                    aria-label="Rename view"
                    wrapperClassName="w-36 py-1"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={submitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitRename();
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => applyView(v)}
                    aria-current={isActive ? 'true' : undefined}
                    className={`${TAB_BASE} ${isActive ? TAB_ACTIVE : TAB_IDLE}`}
                    title={v.is_default ? 'Default view' : (v.shared ? 'Shared with you by another teammate' : undefined)}
                  >
                    {v.is_default && (
                      <Icon name="star" size={12} className={isActive ? 'text-brand-blue' : 'text-gray-400'} />
                    )}
                    <span>{v.name}</span>
                    {(v.is_shared || v.shared) && (
                      <Icon name="users" size={12} className={isActive ? 'text-brand-blue' : 'text-gray-400'} />
                    )}
                  </button>
                )}
                {reorderMode && ownedByMe && (
                  <>
                    <button
                      type="button"
                      onClick={() => moveBy(v.id, -1)}
                      disabled={idx === 0}
                      className="rounded-md p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-30"
                      title="Move left"
                      aria-label={`Move ${v.name} left`}
                    ><Icon name="arrow-left" size={14} /></button>
                    <button
                      type="button"
                      onClick={() => moveBy(v.id, 1)}
                      className="rounded-md p-1 text-gray-500 hover:bg-gray-100"
                      title="Move right"
                      aria-label={`Move ${v.name} right`}
                    ><Icon name="arrow-right" size={14} /></button>
                  </>
                )}
                <Menu
                  label={`Options for ${v.name}`}
                  align="left"
                  size="sm"
                  items={menuItemsFor(v)}
                  trigger={({ open }) => (
                    <button
                      type="button"
                      title="View options"
                      aria-label={`Options for ${v.name}`}
                      className={`rounded-md p-1 transition-colors hover:bg-gray-100 ${open || isActive ? 'text-brand-blue' : 'text-gray-400 hover:text-gray-600'}`}
                    >
                      <Icon name="more-horizontal" size={14} />
                    </button>
                  )}
                />
              </div>
              {/* If the drop target is past the last tab, render the bar
                  after that tab so users can drop at the end. */}
              {dropIndex === views.length && idx === views.length - 1 && dragSrcIndex.current !== null && (
                <span className="w-0.5 h-6 bg-brand-blue rounded-full" aria-hidden="true" />
              )}
            </React.Fragment>
          );
        })
      )}
      <Button size="sm" variant="ghost" icon="plus" className="my-1 text-gray-600" onClick={() => setShowSaveModal(true)}>
        Save current as view
      </Button>
      {reorderMode && (
        <Button size="sm" variant="secondary" icon="check" className="my-1" onClick={() => setReorderMode(false)}>
          Done reordering
        </Button>
      )}

      <SaveViewModal
        open={showSaveModal}
        onCancel={() => setShowSaveModal(false)}
        onSave={saveCurrent}
      />
    </div>
  );
}

function SaveViewModal({ open, onCancel, onSave }) {
  const [name, setName] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [isShared, setIsShared] = useState(false);
  const [saving, setSaving] = useState(false);

  // Reset the form each time the dialog opens so a previous name doesn't
  // linger.
  useEffect(() => {
    if (!open) return;
    setName('');
    setIsDefault(false);
    setIsShared(false);
    setSaving(false);
  }, [open]);

  const submit = async (e) => {
    e?.preventDefault?.();
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      // onSave may be async (it round-trips to the backend) — await so we
      // can keep the button disabled until the request settles, otherwise
      // a slow network shows the modal still open with no feedback.
      await onSave(name.trim(), isDefault, isShared);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { if (!saving) onCancel?.(); }}
      title="Save current view"
      description="Saves the current filters + sort as a tab you can switch back to."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button type="submit" form="save-view-form" disabled={!name.trim()} loading={saving} loadingLabel="Saving…">
            Save view
          </Button>
        </>
      }
    >
      <form id="save-view-form" onSubmit={submit} className="space-y-3">
        <Input
          autoFocus
          label="View name"
          type="text"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. My open · high priority"
        />
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-brand-blue focus:ring-brand-blue"
          />
          Make this my default view
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={isShared}
            onChange={(e) => setIsShared(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-brand-blue focus:ring-brand-blue"
          />
          Share with team
        </label>
      </form>
    </Modal>
  );
}
