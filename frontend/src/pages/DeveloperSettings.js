// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Settings → Developer — manage API keys and outbound webhooks.
//
// Two sections:
//   1. API keys      — create (copy-once), list, revoke. The full plaintext key
//                      is shown exactly ONCE in a copy box after creation; the
//                      backend only ever stores a SHA-256 hash.
//   2. Outbound webhooks — register a URL + event subscriptions, test-fire, and
//                      remove. The signing secret is shown once on create.
//
// Backed by /api/keys and /api/webhooks-out (both session-auth + org-admin
// gated on the backend). Org owner/admin only — the page renders an
// access-denied state for members, matching the AdminAiModel convention.

import React, { useEffect, useState } from 'react';
import api from '../api';
import Nav from '../components/Nav';
import DataTable from '../components/DataTable';
import { useAuth } from '../AuthContext';
import { Alert, Button, Card, Container, EmptyState, Input, PageHeader, Skeleton, StatusBadge } from '../components/ui';

const WEBHOOK_EVENTS = ['deal.created', 'deal.stage_changed'];

function CopyBox({ label, value }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the value is still selectable in the box */
    }
  };
  return (
    <Alert tone="warning" title={label} className="my-3">
      <div className="flex items-center gap-2 mt-1">
        <code className="flex-1 text-xs font-mono text-gray-900 break-all bg-white border border-warning-200 rounded px-2 py-1">
          {value}
        </code>
        <Button size="sm" variant="secondary" icon={copied ? 'check' : 'copy'} onClick={copy}>
          {copied ? 'Copied!' : 'Copy'}
        </Button>
      </div>
      <div className="text-[11px] mt-1">This value will not be shown again. Store it somewhere safe now.</div>
    </Alert>
  );
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

function ApiKeysSection() {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [freshKey, setFreshKey] = useState(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await api.get('/keys');
      setKeys(r.data.keys || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load API keys');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const create = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError('');
    setFreshKey(null);
    try {
      const r = await api.post('/keys', { name: name.trim() });
      setFreshKey(r.data.key);
      setName('');
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to create key');
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id) => {
    if (!window.confirm('Revoke this API key? Any integration using it will immediately stop working.')) return;
    try {
      await api.delete(`/keys/${id}`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to revoke key');
    }
  };

  const columns = [
    { key: 'name', label: 'Name' },
    { key: 'key_prefix', label: 'Prefix', render: (k) => <span className="font-mono text-xs">{k.key_prefix}…</span> },
    { key: 'last_used_at', label: 'Last used', render: (k) => (k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never') },
    {
      key: 'status', label: 'Status',
      render: (k) => (k.revoked_at ? <StatusBadge tone="error" label="Revoked" /> : <StatusBadge tone="success" label="Active" />),
    },
  ];

  return (
    <Card
      title="API keys"
      subtitle={
        <>
          Personal Access Tokens for calling the API from scripts and integrations. Send the key as
          <code className="mx-1 font-mono text-xs bg-gray-100 px-1 rounded">Authorization: Bearer tocrm_…</code>
          or <code className="mx-1 font-mono text-xs bg-gray-100 px-1 rounded">X-API-Key: tocrm_…</code>
          against the <code className="font-mono text-xs bg-gray-100 px-1 rounded">/api/v1</code> endpoints.
        </>
      }
    >
      <form onSubmit={create} className="flex items-end gap-2 mb-4">
        <Input
          label="Key name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Zapier integration"
          wrapperClassName="flex-1"
        />
        <Button type="submit" icon="plus" disabled={!name.trim()} loading={creating} loadingLabel="Creating…">
          Create key
        </Button>
      </form>

      {freshKey && <CopyBox label="Your new API key" value={freshKey} />}
      {error && <Alert tone="danger" className="mb-3" onDismiss={() => setError('')}>{error}</Alert>}

      {loading ? (
        <div role="status" aria-label="Loading API keys"><Skeleton lines={3} /></div>
      ) : (
        <DataTable
          columns={columns}
          data={keys}
          density="compact"
          stickyHeader={false}
          rowActions={[{ label: 'Revoke', onClick: (k) => revoke(k.id), disabled: (k) => !!k.revoked_at, className: 'text-sm font-medium text-danger-600 hover:underline' }]}
          emptyState={{
            icon: 'lock',
            title: 'No API keys yet',
            message: 'Create one to connect The Open CRM to Zapier, a script, or your own tooling.',
          }}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Outbound webhooks
// ---------------------------------------------------------------------------

function WebhooksSection() {
  const [hooks, setHooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState(['deal.created']);
  const [creating, setCreating] = useState(false);
  const [freshSecret, setFreshSecret] = useState(null);
  const [testResult, setTestResult] = useState({}); // webhookId → status text

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await api.get('/webhooks-out');
      setHooks(r.data.webhooks || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load webhooks');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const toggleEvent = (ev) => {
    setEvents((cur) => (cur.includes(ev) ? cur.filter((e) => e !== ev) : [...cur, ev]));
  };

  const create = async (e) => {
    e.preventDefault();
    if (!url.trim() || events.length === 0) return;
    setCreating(true);
    setError('');
    setFreshSecret(null);
    try {
      const r = await api.post('/webhooks-out', { url: url.trim(), events });
      setFreshSecret(r.data.secret);
      setUrl('');
      setEvents(['deal.created']);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to create webhook');
    } finally {
      setCreating(false);
    }
  };

  const remove = async (id) => {
    if (!window.confirm('Remove this webhook? Events will stop being delivered to it.')) return;
    try {
      await api.delete(`/webhooks-out/${id}`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to remove webhook');
    }
  };

  const test = async (id) => {
    setTestResult((r) => ({ ...r, [id]: 'sending…' }));
    try {
      const r = await api.post(`/webhooks-out/${id}/test`);
      const d = r.data.delivery;
      const txt = d ? (d.ok ? `delivered (${d.status_code}, ${d.response_ms}ms)` : `failed (${d.status_code ?? 'no response'})`) : 'sent';
      setTestResult((cur) => ({ ...cur, [id]: txt }));
    } catch (err) {
      setTestResult((cur) => ({ ...cur, [id]: err.response?.data?.error || 'error' }));
    }
  };

  return (
    <Card
      title="Outbound webhooks"
      subtitle={
        <>
          Register an HTTPS endpoint to receive events. Each delivery is signed with an
          <code className="mx-1 font-mono text-xs bg-gray-100 px-1 rounded">X-Signature: sha256=…</code>
          HMAC over the raw body using the webhook's signing secret.
        </>
      }
    >
      <form onSubmit={create} className="space-y-3 mb-4">
        <Input
          label="Endpoint URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/hooks/crm"
        />
        <div>
          <span className="block text-sm font-medium text-gray-700 mb-1">Events</span>
          <div className="flex flex-wrap gap-3">
            {WEBHOOK_EVENTS.map((ev) => (
              <label key={ev} className="inline-flex items-center gap-1.5 text-sm text-gray-700">
                <input type="checkbox" className="h-4 w-4 rounded border-gray-300 text-brand-blue focus:ring-brand-blue" checked={events.includes(ev)} onChange={() => toggleEvent(ev)} />
                <code className="font-mono text-xs">{ev}</code>
              </label>
            ))}
          </div>
        </div>
        <Button type="submit" icon="plus" disabled={!url.trim() || events.length === 0} loading={creating} loadingLabel="Adding…">
          Add webhook
        </Button>
      </form>

      {freshSecret && <CopyBox label="Webhook signing secret" value={freshSecret} />}
      {error && <Alert tone="danger" className="mb-3" onDismiss={() => setError('')}>{error}</Alert>}

      {loading ? (
        <div role="status" aria-label="Loading webhooks"><Skeleton lines={3} /></div>
      ) : hooks.length === 0 ? (
        <EmptyState
          icon="external"
          title="No outbound webhooks yet"
          message="Add one to get a signed POST the moment a deal is created or changes stage."
        />
      ) : (
        <ul className="divide-y divide-gray-100">
          {hooks.map((h) => (
            <li key={h.id} className="py-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-900 break-all">{h.url}</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {(h.events || []).map((e) => <code key={e} className="font-mono mr-2">{e}</code>)}
                </div>
                {testResult[h.id] && <div className="text-xs text-gray-600 mt-1">Test: {testResult[h.id]}</div>}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <Button variant="ghost" size="sm" onClick={() => test(h.id)}>Test</Button>
                <Button variant="ghost" size="sm" className="!text-danger-600" onClick={() => remove(h.id)}>Remove</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function DeveloperSettings() {
  const { user, isAdmin } = useAuth();
  const isOrgAdmin = isAdmin || user?.org_role === 'owner' || user?.org_role === 'admin' || !user?.org_id;

  if (!isOrgAdmin) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Nav active="settings" />
        <Container size="narrow">
          <Alert tone="warning" icon="lock" title="Owner or admin access required">
            Org owner or admin access required to manage API keys and webhooks.
          </Alert>
        </Container>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="settings" />
      <Container size="narrow">
        <PageHeader
          title="Developer"
          subtitle="API keys and outbound webhooks for building integrations on top of The Open CRM."
          breadcrumb={[{ label: 'Settings', to: '/settings' }, { label: 'Developer' }]}
        />
        <div className="space-y-6">
          <ApiKeysSection />
          <WebhooksSection />
        </div>
      </Container>
    </div>
  );
}
