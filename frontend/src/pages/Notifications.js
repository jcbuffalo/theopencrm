// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import Nav from '../components/Nav';
import { Alert, Button, Card, Container, EmptyState, Icon, PageHeader, Skeleton, Tabs } from '../components/ui';

// Notifications — the full in-app Notification Center at /notifications.
//
// The nav bell shows the last few; this page is the complete recent history
// (GET /api/notifications, newest first). Unread rows render emphasized with
// a dot; clicking any row marks it read and follows its in-app link. Backed
// by the same org+recipient-scoped API the bell uses — you only ever see
// your own notifications.

const TYPE_ICONS = {
  task_assigned: 'check-circle',
  task_overdue: 'clock',
  deal_activity: 'briefcase',
  weekly_summary: 'trending-up',
};

function fmtWhen(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function Notifications() {
  const navigate = useNavigate();
  const [items, setItems] = useState(null); // null = loading
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all'); // 'all' | 'unread'

  const load = (which = filter) => {
    const q = which === 'unread' ? '?unread=1&limit=100' : '?limit=100';
    api.get(`/notifications${q}`)
      .then((r) => {
        setItems(r.data.notifications || []);
        setUnread(r.data.unread_count || 0);
        setError('');
      })
      .catch((err) => {
        setItems([]);
        setError(err.response?.data?.error || 'Failed to load notifications');
      });
  };

  useEffect(() => { load(filter); }, [filter]); // eslint-disable-line react-hooks/exhaustive-deps

  const openItem = (n) => {
    if (!n.read_at) {
      setUnread((u) => Math.max(0, u - 1));
      setItems((list) => (list || []).map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)));
      api.patch(`/notifications/${n.id}/read`).catch(() => {});
    }
    if (n.link) navigate(n.link);
  };

  const markRead = (e, n) => {
    e.stopPropagation();
    setUnread((u) => Math.max(0, u - 1));
    setItems((list) => (list || []).map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)));
    api.patch(`/notifications/${n.id}/read`).catch(() => {});
  };

  const markAllRead = () => {
    api.post('/notifications/read-all').catch(() => {});
    setUnread(0);
    setItems((list) => (list || []).map((n) => ({ ...n, read_at: n.read_at || new Date().toISOString() })));
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Nav active="notifications" />
      <Container size="narrow" className="flex-1">
        <PageHeader
          title="Notifications"
          subtitle={unread > 0 ? `${unread} unread` : 'All caught up'}
          className="mb-4"
          primaryAction={unread > 0 ? (
            <Button variant="secondary" icon="check" onClick={markAllRead}>Mark all read</Button>
          ) : null}
        />

        <Tabs
          items={[{ id: 'all', label: 'All' }, { id: 'unread', label: 'Unread', count: unread || undefined }]}
          value={filter}
          onChange={(f) => { setItems(null); setFilter(f); }}
          aria-label="Notification filter"
          className="mb-6"
        />

        <div className="space-y-6">
          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          <Card padding="none" className="overflow-hidden">
            {items === null ? (
              <div className="p-4" role="status" aria-label="Loading notifications"><Skeleton lines={6} /></div>
            ) : items.length === 0 ? (
              <EmptyState
                icon="bell"
                title={filter === 'unread' ? 'No unread notifications' : 'No notifications yet'}
                message="Task assignments, overdue reminders, and deal activity will show up here."
              />
            ) : (
              <ul className="divide-y divide-gray-100">
                {items.map((n) => (
                  <li key={n.id}>
                    <button
                      onClick={() => openItem(n)}
                      className={`w-full text-left px-4 py-3 transition flex items-start gap-3 hover:bg-gray-50 ${n.read_at ? '' : 'bg-info-50/50'}`}
                    >
                      <span className={`mt-0.5 flex-shrink-0 flex h-8 w-8 items-center justify-center rounded-full ${n.read_at ? 'bg-gray-100 text-gray-400' : 'bg-info-100 text-brand-blue'}`} aria-hidden="true">
                        <Icon name={TYPE_ICONS[n.type] || 'bell'} size={16} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block text-sm truncate ${n.read_at ? 'text-gray-600' : 'font-semibold text-gray-900'}`}>
                          {n.title}
                        </span>
                        {n.body && (
                          <span className="block text-xs text-gray-500 mt-0.5 line-clamp-2 whitespace-pre-line">{n.body}</span>
                        )}
                        <span className="block text-xs text-gray-400 mt-1">{fmtWhen(n.created_at)}</span>
                      </span>
                      <span className="flex-shrink-0 flex items-center gap-2 mt-0.5">
                        {!n.read_at && (
                          <>
                            <span className="w-2 h-2 rounded-full bg-brand-blue" aria-hidden="true" />
                            <span
                              role="button"
                              tabIndex={0}
                              onClick={(e) => markRead(e, n)}
                              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') markRead(e, n); }}
                              className="text-xs text-brand-blue hover:underline"
                            >
                              Mark read
                            </span>
                          </>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </Container>
    </div>
  );
}
