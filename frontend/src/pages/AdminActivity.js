// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Admin → Activity. Per-org "what's happening in my workspace" view of the
// last 24h. Aggregates audit_log, ai_usage_events, plugin_runs,
// deal_intel_summaries, deal_gmail_summaries, and email_sends — all
// org-scoped on the backend (routes/orgActivityRoutes.js).
//
// Org-admin only: backend returns 403 to members. The frontend additionally
// short-circuits with a friendly access-denied banner before issuing the
// request so members don't get a confusing 403 toast on entry.

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import Nav from '../components/Nav';
import { useAuth } from '../AuthContext';
import { Alert, Button, Card, Container, Icon, PageHeader, Skeleton, StatusBadge } from '../components/ui';

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function StatCard({ label, value, hint, accent }) {
  // accent: 'blue' | 'purple' | 'green' | 'amber'
  const accentRing = {
    blue:   'bg-info-50 text-info-700',
    purple: 'bg-purple-50 text-purple-700',
    green:  'bg-success-50 text-success-700',
    amber:  'bg-warning-50 text-warning-700',
  }[accent] || 'bg-gray-50 text-gray-700';

  return (
    <div className="bg-white rounded border border-gray-200 shadow-card p-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-sm text-gray-500">{label}</div>
          <div className="text-3xl font-semibold tracking-tight text-gray-900 mt-1">{value}</div>
        </div>
        <div className={`text-xs font-medium px-2 py-0.5 rounded-full ${accentRing}`}>last 24h</div>
      </div>
      {hint && <div className="mt-2 text-xs text-gray-500">{hint}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// "X ago" formatter — small no-deps relative time.
// ---------------------------------------------------------------------------
function timeAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const sec = Math.floor(ms / 1000);
  if (sec < 60)   return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60)   return `${min}m ago`;
  const hr  = Math.floor(min / 60);
  if (hr  < 24)   return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function fmtCost(usd) {
  if (!usd || usd < 0.0001) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Per-kind row renderers. Each returns { icon, title, subtitle, link }.
// ---------------------------------------------------------------------------
const STATUS_TONE = {
  success: 'success',
  ok:      'success',
  running: 'info',
  error:   'error',
  timeout: 'error',
  memory_exceeded: 'error',
  killed:  'error',
  quota_exceeded: 'warning',
  rejected: 'warning',
};

function renderItem(item) {
  switch (item.kind) {
    case 'audit_event':
      return {
        icon: 'edit',
        title: <span><code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">{item.event}</code>{item.success === false && <span className="ml-2 text-xs text-danger-600">failed</span>}</span>,
        subtitle: (
          <span className="text-gray-600">
            {item.actor_email || 'system'}
            {item.target_type && <> · <span className="text-gray-500">{item.target_type}#{item.target_id}</span></>}
            {item.meta_summary && <> · <span className="text-gray-400 truncate inline-block max-w-md align-bottom">{item.meta_summary}</span></>}
          </span>
        ),
        link: null,
      };
    case 'ai_call':
      return {
        icon: 'sparkles',
        title: <span>AI call · <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">{item.endpoint}</code></span>,
        subtitle: (
          <span className="text-gray-600">
            {item.user_email || 'system'} · {item.model} · {item.tokens.toLocaleString()} tokens · {fmtCost(item.cost_usd)}
          </span>
        ),
        link: null,
      };
    case 'plugin_run': {
      const tone = STATUS_TONE[item.status] || 'neutral';
      return {
        icon: 'settings',
        title: (
          <span>
            Plugin run · <span className="font-medium">{item.plugin_name}</span>{' '}
            <StatusBadge tone={tone} label={item.status} className="ml-1" />
          </span>
        ),
        subtitle: (
          <span className="text-gray-600">
            {item.duration_ms != null ? `${item.duration_ms}ms` : 'no end time'}
            {item.ai_tokens > 0 && <> · {item.ai_tokens.toLocaleString()} AI tokens</>}
          </span>
        ),
        link: item.plugin_id ? `/plugins/${item.plugin_id}` : null,
      };
    }
    case 'drive_intel':
      return {
        icon: 'briefcase',
        title: <span>Drive intel generated · <span className="font-medium">{item.deal_title || `Deal #${item.deal_id}`}</span></span>,
        subtitle: (
          <span className="text-gray-600">
            {item.files_analyzed} files analyzed · {(item.tokens || 0).toLocaleString()} tokens
          </span>
        ),
        link: item.deal_id ? `/deals?open=${item.deal_id}` : null,
      };
    case 'gmail_intel':
      return {
        icon: 'mail',
        title: <span>Gmail intel generated · <span className="font-medium">{item.deal_title || `Deal #${item.deal_id}`}</span></span>,
        subtitle: (
          <span className="text-gray-600">
            {(item.tokens || 0).toLocaleString()} tokens
            {item.next_step && <> · next: <span className="italic">{item.next_step}</span></>}
          </span>
        ),
        link: item.deal_id ? `/deals?open=${item.deal_id}` : null,
      };
    case 'email_send':
      return {
        icon: 'mail',
        title: <span>Email sent · {item.subject || '(no subject)'}</span>,
        subtitle: (
          <span className="text-gray-600">
            to {item.to}{item.sender_email && <> · from {item.sender_email}</>}
            {item.opened && <> · <span className="text-success-700">opened</span></>}
          </span>
        ),
        link: null,
      };
    default:
      return { icon: 'info', title: <code>{item.kind}</code>, subtitle: null, link: null };
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function AdminActivity() {
  const { user } = useAuth();
  const isOrgAdmin = user?.org_role === 'owner' || user?.org_role === 'admin' || user?.is_admin === true;

  const [summary, setSummary]   = useState(null);
  const [items, setItems]       = useState([]);
  const [cursor, setCursor]     = useState(null);
  const [loading, setLoading]   = useState(true);
  const [loadingMore, setMore]  = useState(false);
  const [error, setError]       = useState('');

  const fetchSummary = async () => {
    try {
      const r = await api.get('/admin/org-activity/summary?since=24h');
      setSummary(r.data?.data || null);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load summary');
    }
  };

  const fetchFirstPage = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await api.get('/admin/org-activity/feed?since=24h&limit=50');
      setItems(r.data?.data?.items || []);
      setCursor(r.data?.data?.next_cursor || null);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load feed');
    } finally {
      setLoading(false);
    }
  };

  const fetchMore = async () => {
    if (!cursor) return;
    setMore(true);
    try {
      const r = await api.get(`/admin/org-activity/feed?since=24h&limit=50&cursor=${encodeURIComponent(cursor)}`);
      const newItems = r.data?.data?.items || [];
      setItems(prev => prev.concat(newItems));
      setCursor(r.data?.data?.next_cursor || null);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load more');
    } finally {
      setMore(false);
    }
  };

  useEffect(() => {
    if (!isOrgAdmin) {
      setLoading(false);
      return;
    }
    fetchSummary();
    fetchFirstPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOrgAdmin]);

  if (!isOrgAdmin) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Nav active="admin" />
        <Container size="narrow">
          <Alert tone="danger" icon="lock">
            Org admin access required. Ask an owner or admin in your organization to grant you access.
          </Alert>
        </Container>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="admin" />
      <Container>
        <PageHeader
          title="Activity"
          subtitle="What's happened in your workspace in the last 24 hours."
          primaryAction={{ label: 'Refresh', icon: 'refresh', variant: 'secondary', onClick: () => { fetchSummary(); fetchFirstPage(); } }}
          secondaryActions={[{ label: 'Back to admin', icon: 'arrow-left', inline: true, as: Link, to: '/admin' }]}
        />

        <div className="space-y-6">
          {/* Stat cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="AI calls"
              value={summary?.counts?.ai_calls ?? '—'}
              hint={summary?.ai_cost_usd != null ? `${fmtCost(summary.ai_cost_usd)} spend${summary?.top_endpoint ? ` · top: ${summary.top_endpoint}` : ''}` : null}
              accent="blue"
            />
            <StatCard
              label="Plugin runs"
              value={summary?.counts?.plugin_runs ?? '—'}
              hint={summary?.plugin_failures > 0 ? `${summary.plugin_failures} failed` : 'no failures'}
              accent="purple"
            />
            <StatCard
              label="Drive intels"
              value={summary?.counts?.drive_intels ?? '—'}
              hint="Per-deal Drive summaries"
              accent="green"
            />
            <StatCard
              label="Gmail intels"
              value={summary?.counts?.gmail_intels ?? '—'}
              hint="Per-thread Gmail summaries"
              accent="amber"
            />
          </div>

          {/* Secondary counts (smaller row) */}
          {summary && (
            <div className="text-xs text-gray-500 flex flex-wrap gap-4">
              <span>{summary.counts?.audit_events ?? 0} audit events</span>
              <span>{summary.counts?.emails_sent ?? 0} emails sent</span>
              <span>window: last 24h</span>
            </div>
          )}

          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          {/* Feed */}
          <Card title="Recent activity" padding="none">
            {loading ? (
              <div className="p-5"><Skeleton lines={6} /></div>
            ) : items.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-500">
                Nothing has happened in the last 24h. Try again after some work flows through.
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {items.map((item, idx) => {
                  const rendered = renderItem(item);
                  return (
                    <li key={`${item.kind}-${item.at}-${idx}`} className="px-5 py-3 hover:bg-gray-50">
                      <div className="flex items-start gap-3">
                        <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-500" aria-hidden="true">
                          <Icon name={rendered.icon} size={14} />
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-gray-900">{rendered.title}</div>
                          {rendered.subtitle && (
                            <div className="text-xs mt-0.5 truncate">{rendered.subtitle}</div>
                          )}
                        </div>
                        <div className="text-xs text-gray-400 whitespace-nowrap">{timeAgo(item.at)}</div>
                        {rendered.link && (
                          <Link to={rendered.link} className="text-xs text-brand-blue hover:underline whitespace-nowrap inline-flex items-center gap-1">
                            open <Icon name="arrow-right" size={12} />
                          </Link>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {cursor && !loading && (
              <div className="p-3 border-t border-gray-100 text-center">
                <Button variant="secondary" size="sm" onClick={fetchMore} disabled={loadingMore} loading={loadingMore} loadingLabel="Loading…">
                  Load more
                </Button>
              </div>
            )}
          </Card>

          <p className="text-xs text-gray-500">
            Read-only. Only org owners and admins can see this view. Per-request noise (chat messages, AI metering side-effects) is filtered out so the feed stays scannable.
          </p>
        </div>
      </Container>
    </div>
  );
}
