// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../api';

// Relative "how long ago" for the bell dropdown — deliberately coarse.
function timeAgo(ts) {
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return '';
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

// Notification bell — unread badge + recent-items dropdown. One request on
// mount and a 60s poll keep the badge honest without a websocket; opening
// the dropdown fetches the recent list (and refreshes the count for free,
// since GET /notifications returns both).
export default function NotificationBell() {
  const navigate = useNavigate();
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null); // null = not yet loaded
  const wrapRef = useRef(null);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      api.get('/notifications?unread=1&limit=1')
        .then((r) => { if (alive) setUnread(r?.data?.unread_count || 0); })
        .catch(() => { /* transient/signed-out — keep the last known badge */ });
    };
    refresh();
    const t = setInterval(refresh, 60000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      api.get('/notifications?limit=8')
        .then((r) => {
          setItems(r?.data?.notifications || []);
          setUnread(r?.data?.unread_count || 0);
        })
        .catch(() => setItems([]));
    }
  };

  const openItem = (n) => {
    setOpen(false);
    if (!n.read_at) {
      setUnread((u) => Math.max(0, u - 1));
      setItems((list) => (list || []).map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)));
      api.patch(`/notifications/${n.id}/read`).catch(() => {});
    }
    navigate(n.link || '/notifications');
  };

  const markAllRead = () => {
    api.post('/notifications/read-all').catch(() => {});
    setUnread(0);
    setItems((list) => (list || []).map((n) => ({ ...n, read_at: n.read_at || new Date().toISOString() })));
  };

  return (
    <div ref={wrapRef} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={toggle}
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Notifications"
        className="relative inline-flex items-center justify-center w-9 h-9 rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition outline-none focus-visible:ring-2 focus-visible:ring-brand-blue/40"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 bg-red-500 text-white text-[10px] font-semibold rounded-full flex items-center justify-center leading-none">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-80 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
          <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Notifications</span>
            {unread > 0 && (
              <button onClick={markAllRead} className="text-xs text-brand-blue hover:underline">
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items === null ? (
              <div className="px-3 py-4 text-sm text-gray-400">Loading…</div>
            ) : items.length === 0 ? (
              <div className="px-3 py-6 text-sm text-gray-500 text-center">You're all caught up.</div>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  onClick={() => openItem(n)}
                  className={`w-full text-left px-3 py-2.5 hover:bg-gray-50 transition flex gap-2 border-b border-gray-50 ${n.read_at ? '' : 'bg-blue-50/50'}`}
                >
                  {!n.read_at && <span className="mt-1.5 w-2 h-2 rounded-full bg-brand-blue flex-shrink-0" aria-hidden="true" />}
                  <span className="min-w-0">
                    <span className={`block text-sm truncate ${n.read_at ? 'text-gray-600' : 'font-medium text-gray-900'}`}>{n.title}</span>
                    <span className="block text-xs text-gray-400 mt-0.5">{timeAgo(n.created_at)}</span>
                  </span>
                </button>
              ))
            )}
          </div>
          <Link
            to="/notifications"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-xs font-medium text-brand-blue hover:bg-blue-50 border-t border-gray-100 rounded-b-lg text-center"
          >
            See all notifications
          </Link>
        </div>
      )}
    </div>
  );
}
