// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import api from '../api';
import Nav from '../components/Nav';
import { KNOWN_PROFILES } from '../stages';
import DataTable from '../components/DataTable';
import { Alert, Button, Card, Container, PageHeader, Spinner, Tabs } from '../components/ui';

const FILTERS = ['pending_approval', 'rejected', 'suspended', 'active'];

export default function AdminAccessRequests() {
  const [filter, setFilter] = useState('pending_approval');
  const [requests, setRequests] = useState([]);
  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionId, setActionId] = useState(null);
  const [tab, setTab] = useState('requests');

  const load = async () => {
    setLoading(true);
    try {
      const [r, o] = await Promise.all([
        api.get(`/admin/access-requests?status=${filter}`),
        api.get('/admin/organizations'),
      ]);
      setRequests(r.data?.data || []);
      setOrgs(o.data?.data || []);
      setError('');
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load — admin access required.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [filter]);

  const approve = async (id) => {
    if (!window.confirm('Approve this access request? The user will receive an approval email.')) return;
    setActionId(id);
    try {
      await api.post(`/admin/access-requests/${id}/approve`);
      load();
    } catch (err) {
      alert(err.response?.data?.message || 'Approval failed.');
    } finally {
      setActionId(null);
    }
  };

  const reject = async (id) => {
    const reason = window.prompt('Optional reason for rejection (visible to admin only):', '');
    if (reason === null) return; // cancelled
    setActionId(id);
    try {
      await api.post(`/admin/access-requests/${id}/reject`, { reason });
      load();
    } catch (err) {
      alert(err.response?.data?.message || 'Rejection failed.');
    } finally {
      setActionId(null);
    }
  };

  const changeOrgProfile = async (orgId, profile) => {
    setActionId(`org-${orgId}`);
    try {
      await api.put(`/admin/organizations/${orgId}/profile`, { profile });
      load();
    } catch (err) {
      alert(err.response?.data?.message || 'Profile change failed.');
    } finally {
      setActionId(null);
    }
  };

  const seed = async (profile, confirmMsg) => {
    if (!window.confirm(confirmMsg)) return;
    try {
      const r = await api.post('/admin/demo/seed', { profile });
      alert(`Seeded: ${JSON.stringify(r.data.summary)}`);
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)); }
  };

  const wipe = async () => {
    if (!window.confirm('Wipe all demo data for this org? Records tagged [demo] will be permanently deleted.')) return;
    try {
      await api.post('/admin/demo/wipe');
      alert('Demo data wiped.');
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)); }
  };

  const requestColumns = [
    {
      key: 'name',
      label: 'User',
      render: (r) => (
        <div>
          <div className="font-medium text-gray-900">{r.name}</div>
          <div className="text-xs text-gray-500 font-normal">{r.email}</div>
        </div>
      ),
    },
    { key: 'request_company', label: 'Company' },
    {
      key: 'request_reason',
      label: 'Reason',
      className: 'max-w-xs',
      render: (r) => <span className="block truncate text-xs" title={r.request_reason}>{r.request_reason || '—'}</span>,
    },
    {
      key: 'requested_at',
      label: 'Requested',
      render: (r) => <span className="text-xs text-gray-500">{r.requested_at ? new Date(r.requested_at).toLocaleString() : '—'}</span>,
    },
    {
      key: 'actions',
      label: 'Actions',
      align: 'right',
      render: (r) => (
        <div className="inline-flex items-center justify-end gap-2 whitespace-nowrap">
          {filter === 'pending_approval' && (
            <>
              <Button size="sm" disabled={actionId === r.id} onClick={() => approve(r.id)} icon="check">Approve</Button>
              <Button size="sm" variant="danger" disabled={actionId === r.id} onClick={() => reject(r.id)}>Reject</Button>
            </>
          )}
          {filter === 'rejected' && (
            <Button size="sm" disabled={actionId === r.id} onClick={() => approve(r.id)}>Reconsider &amp; approve</Button>
          )}
          {filter === 'suspended' && (
            <Button size="sm" disabled={actionId === r.id} onClick={async () => { await api.post(`/admin/users/${r.id}/reactivate`); load(); }}>Reactivate</Button>
          )}
          {filter === 'active' && (
            <Button
              size="sm"
              variant="secondary"
              disabled={actionId === r.id}
              onClick={async () => {
                const reason = window.prompt('Reason for suspension (optional):', '');
                if (reason === null) return;
                await api.post(`/admin/users/${r.id}/suspend`, { reason });
                load();
              }}
            >
              Suspend
            </Button>
          )}
        </div>
      ),
    },
  ];

  const orgColumns = [
    { key: 'name', label: 'Organization' },
    {
      key: 'owner_name',
      label: 'Owner',
      render: (o) => (
        <div>
          <div>{o.owner_name || '—'}</div>
          <div className="text-xs text-gray-500">{o.owner_email}</div>
        </div>
      ),
    },
    { key: 'member_count', label: 'Members', align: 'right' },
    {
      key: 'profile',
      label: 'Profile',
      // Inline cell editor — a compact native select on purpose.
      render: (o) => (
        <select
          value={o.profile || 'generic'}
          disabled={actionId === `org-${o.id}`}
          onChange={(e) => changeOrgProfile(o.id, e.target.value)}
          aria-label={`Profile for ${o.name}`}
          className="text-xs border border-gray-300 rounded-md px-2 py-1 focus:outline-none focus:border-brand-blue focus:ring-2 focus:ring-brand-blue/20"
        >
          {KNOWN_PROFILES.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      ),
    },
    {
      key: 'created_at',
      label: 'Created',
      render: (o) => <span className="text-xs text-gray-500">{new Date(o.created_at).toLocaleDateString()}</span>,
    },
  ];

  const pendingCount = filter === 'pending_approval' ? requests.length : undefined;

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="admin" />
      <Container>
        <PageHeader
          title="Access & organizations"
          subtitle="Approve access requests · manage org profiles · suspend / reactivate users."
        />

        <div className="space-y-6">
          <Tabs
            aria-label="Admin sections"
            items={[
              { id: 'requests', label: 'Access requests', count: pendingCount || undefined },
              { id: 'orgs', label: 'Organizations' },
              { id: 'demo', label: 'Demo data' },
            ]}
            value={tab}
            onChange={setTab}
          />

          {tab === 'demo' && (
            <Card
              title="Pitch / demo data"
              subtitle={
                <>
                  Generate a realistic dataset for your current org so charts, leaderboards, and dashboards aren't empty during demos. All demo records are tagged <code className="text-xs bg-gray-100 px-1 rounded">[demo]</code> so they can be wiped cleanly later.
                </>
              }
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => seed('zang', 'Seed Zang-profile demo data? Adds ~15 deals across all 28 stages, vendor RFQs, quotes with line items, submittals, change orders, issues, activities, service contracts.')}
                  className="border border-gray-300 hover:border-brand-blue hover:bg-info-50 rounded p-4 text-left transition"
                >
                  <p className="font-semibold text-gray-900">Seed Zang demo</p>
                  <p className="text-xs text-gray-500 mt-1">Manufacturer's-rep workflow: 8 customers + 5 vendors, ~15 deals across the 28-stage lifecycle, vendor RFQ comparison, quotes with line items, submittals, change orders, service contracts, issues, activities, simulated meeting logs.</p>
                </button>
                <button
                  type="button"
                  onClick={() => seed('generic', 'Seed Generic-profile demo data? Adds ~12 deals across the simpler 6-stage pipeline.')}
                  className="border border-gray-300 hover:border-brand-blue hover:bg-info-50 rounded p-4 text-left transition"
                >
                  <p className="font-semibold text-gray-900">Seed Generic demo</p>
                  <p className="text-xs text-gray-500 mt-1">Vanilla CRM: 8 companies, ~15 contacts, ~12 deals across LEAD → CLOSED_WON, quotes, activities, tasks.</p>
                </button>
              </div>
              <div className="border-t border-gray-200 pt-4 mt-4">
                <Button variant="danger" size="sm" icon="trash" onClick={wipe}>Wipe demo data</Button>
                <p className="text-[11px] text-gray-500 mt-1">Removes anything tagged with <code className="text-[10px] bg-gray-100 px-1 rounded">[demo]</code> from this org. Real records are untouched.</p>
              </div>
            </Card>
          )}

          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

          {tab === 'requests' && (
            <>
              <div className="flex flex-wrap gap-2">
                {FILTERS.map(s => (
                  <Button
                    key={s}
                    size="sm"
                    variant={filter === s ? 'primary' : 'secondary'}
                    aria-pressed={filter === s}
                    onClick={() => setFilter(s)}
                    className="capitalize"
                  >
                    {s.replace('_', ' ')}
                  </Button>
                ))}
              </div>

              <DataTable
                columns={requestColumns}
                data={requests}
                loading={loading}
                minWidth={720}
                emptyState={{ icon: 'users', title: `No users with status "${filter.replace('_', ' ')}".`, message: 'Requests appear here as people ask for access.' }}
              />
            </>
          )}

          {tab === 'orgs' && (
            loading ? (
              <Spinner size="lg" label="Loading organizations…" />
            ) : (
              <DataTable
                columns={orgColumns}
                data={orgs}
                minWidth={720}
                emptyState={{ icon: 'building', title: 'No organizations yet', message: 'Organizations appear here once they are provisioned.' }}
              />
            )
          )}
        </div>
      </Container>
    </div>
  );
}
