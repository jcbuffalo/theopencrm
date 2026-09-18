// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api';
import Nav from '../components/Nav';
import { Alert, Button, Card, Container, PageHeader, Skeleton, StatusBadge } from '../components/ui';

function QuickBooksSection() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get('/quickbooks/status');
      setStatus(r.data);
      setError('');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load QB status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    if (searchParams.get('qb') === 'connected') {
      setSuccess('QuickBooks connected successfully.');
      setSearchParams({});
    } else if (searchParams.get('qb') === 'error') {
      setError(`QuickBooks connection error: ${searchParams.get('reason') || 'unknown'}`);
      setSearchParams({});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async () => {
    setError('');
    try {
      const r = await api.post('/quickbooks/connect');
      if (r.data.authUrl) window.location.href = r.data.authUrl;
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to start QB OAuth');
    }
  };

  const disconnect = async () => {
    if (!window.confirm('Disconnect QuickBooks? You can reconnect later.')) return;
    try {
      await api.post('/quickbooks/disconnect');
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Disconnect failed');
    }
  };

  return (
    <Card
      title="QuickBooks Online"
      subtitle="Auto-create invoices when a deal hits the INVOICED stage."
      actions={
        <>
          <StatusBadge tone={status?.configured ? 'success' : 'neutral'} label={status?.configured ? 'Configured' : 'Not configured'} />
          <StatusBadge tone={status?.connected ? 'success' : 'neutral'} label={status?.connected ? 'Connected' : 'Disconnected'} />
        </>
      }
    >
      <div className="space-y-3">
        {success && <Alert tone="success" onDismiss={() => setSuccess('')}>{success}</Alert>}
        {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

        {loading ? (
          <Skeleton lines={3} />
        ) : !status?.configured ? (
          <div className="text-sm text-gray-700 space-y-2">
            <p>Set the following env vars on the backend Cloud Run service to enable:</p>
            <ul className="list-disc list-inside text-xs text-gray-600">
              <li><code className="bg-gray-100 px-1 rounded">QB_CLIENT_ID</code> — from your Intuit Developer dashboard</li>
              <li><code className="bg-gray-100 px-1 rounded">QB_CLIENT_SECRET</code></li>
              <li><code className="bg-gray-100 px-1 rounded">QB_REDIRECT_URI</code> — must match what you registered with Intuit, e.g. <code>https://&lt;backend&gt;/api/quickbooks/callback</code></li>
              <li><code className="bg-gray-100 px-1 rounded">QB_ENVIRONMENT</code> — <code>sandbox</code> or <code>production</code></li>
            </ul>
            <p className="text-xs text-gray-500">Restart the backend after adding the variables.</p>
          </div>
        ) : status.connected ? (
          <div className="text-sm text-gray-700 space-y-2">
            <dl className="grid grid-cols-2 gap-1 text-xs">
              <dt className="text-gray-500">Environment</dt><dd>{status.environment}</dd>
              <dt className="text-gray-500">Realm ID</dt><dd className="font-mono">{status.realmId}</dd>
              <dt className="text-gray-500">Connected at</dt><dd>{status.connectedAt && new Date(status.connectedAt).toLocaleString()}</dd>
              <dt className="text-gray-500">Last sync</dt><dd>{status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : '—'}</dd>
              {status.lastSyncStatus && <><dt className="text-gray-500">Last status</dt><dd>{status.lastSyncStatus}</dd></>}
              {status.lastSyncError && <><dt className="text-gray-500">Last error</dt><dd className="text-danger-600">{status.lastSyncError}</dd></>}
            </dl>
            <Button variant="danger" size="sm" onClick={disconnect} className="mt-2">Disconnect</Button>
          </div>
        ) : (
          <Button onClick={connect} icon="external">Connect QuickBooks</Button>
        )}
      </div>
    </Card>
  );
}

function AutomationSection() {
  const [rules, setRules] = useState([]);
  const [runs, setRuns] = useState([]);
  const [running, setRunning] = useState(false);
  const [lastSummary, setLastSummary] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [r, runsRes] = await Promise.all([
        api.get('/automation/rules'),
        api.get('/automation/runs?limit=20'),
      ]);
      setRules(r.data.rules || []);
      setRuns(runsRes.data.runs || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load automation');
    }
  };
  useEffect(() => { load(); }, []);

  const runNow = async () => {
    setRunning(true);
    setError('');
    try {
      const r = await api.post('/automation/run');
      setLastSummary(r.data.summary);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Run failed');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card
      title="Triggered Automation"
      subtitle="Background rules run hourly. They flag stale RFQs, hot deals going cold, expiring quotes, and queue customer surveys when deals invoice."
      actions={
        <Button size="sm" icon="refresh" onClick={runNow} disabled={running} loading={running} loadingLabel="Running…">
          Run now
        </Button>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Rules</p>
          <ul className="text-xs space-y-1">
            {rules.map(r => (
              <li key={r.id} className="border border-gray-200 rounded px-2 py-1.5">
                <code className="text-gray-700">{r.id}</code> — <span className="text-gray-600">{r.description}</span>
              </li>
            ))}
          </ul>
        </div>

        {lastSummary && (
          <div className="bg-gray-50 border border-gray-200 rounded p-2 text-xs">
            <p className="font-semibold mb-1">Last run · {new Date(lastSummary.startedAt).toLocaleTimeString()}</p>
            <ul className="space-y-0.5">
              {lastSummary.rules.map(r => (
                <li key={r.id}>
                  <code>{r.id}</code> → {r.ok
                    ? `fired ${r.fired || 0}, scanned ${r.scanned || 0}${r.skipped ? ` (skipped: ${r.skipped})` : ''}`
                    : <span className="text-danger-600">error: {r.error}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Recent runs ({runs.length})</p>
          {runs.length === 0 ? (
            <p className="text-xs text-gray-500">No runs yet.</p>
          ) : (
            <div className="border border-gray-200 rounded overflow-hidden max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
                  <tr>
                    <th className="text-left px-2 py-1 font-semibold uppercase tracking-wider text-gray-500">When</th>
                    <th className="text-left px-2 py-1 font-semibold uppercase tracking-wider text-gray-500">Rule</th>
                    <th className="text-left px-2 py-1 font-semibold uppercase tracking-wider text-gray-500">Target</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {runs.map(r => (
                    <tr key={r.id}>
                      <td className="px-2 py-1">{new Date(r.fired_at).toLocaleString()}</td>
                      <td className="px-2 py-1"><code>{r.rule}</code></td>
                      <td className="px-2 py-1 text-gray-600">{r.target_type ? `${r.target_type} #${r.target_id}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function WebhooksSection() {
  return (
    <Card
      title="Inbound Webhooks"
      subtitle="Connect Teams, Zoom, or any transcription tool. Each receiver authenticates with a shared secret you set on the backend."
    >
      <div className="space-y-3 text-sm">
        <div className="border border-gray-200 rounded p-3">
          <p className="font-semibold text-gray-900">Microsoft Teams</p>
          <p className="text-xs text-gray-600 mt-1">URL: <code className="bg-gray-100 px-1 py-0.5 rounded">POST /api/webhooks/teams?org=&lt;ORG_ID&gt;</code></p>
          <p className="text-xs text-gray-600">Header: <code className="bg-gray-100 px-1 py-0.5 rounded">X-Teams-Secret: $TEAMS_WEBHOOK_SECRET</code></p>
          <p className="text-[11px] text-gray-500 mt-1">Set the env var <code>TEAMS_WEBHOOK_SECRET</code> on the backend, then point a Power Automate flow at this URL on meeting end.</p>
        </div>
        <div className="border border-gray-200 rounded p-3">
          <p className="font-semibold text-gray-900">Zoom</p>
          <p className="text-xs text-gray-600 mt-1">URL: <code className="bg-gray-100 px-1 py-0.5 rounded">POST /api/webhooks/zoom?org=&lt;ORG_ID&gt;</code></p>
          <p className="text-xs text-gray-600">Auth: HMAC-SHA256 in <code>x-zm-signature</code> header per Zoom spec.</p>
          <p className="text-[11px] text-gray-500 mt-1">Set the env var <code>ZOOM_WEBHOOK_SECRET_TOKEN</code> on the backend; subscribe to <code>meeting.ended</code> and <code>recording.transcript_completed</code> in your Zoom app.</p>
        </div>
        <div className="border border-gray-200 rounded p-3">
          <p className="font-semibold text-gray-900">Generic (Otter.ai, Fireflies, Zapier)</p>
          <p className="text-xs text-gray-600 mt-1">URL: <code className="bg-gray-100 px-1 py-0.5 rounded">POST /api/webhooks/generic?org=&lt;ORG_ID&gt;&secret=$GENERIC_WEBHOOK_SECRET</code></p>
          <p className="text-[11px] text-gray-500 mt-1">JSON body: <code>{`{ source, external_id, title, participants, occurred_at, duration_minutes, recording_url, transcript, summary }`}</code>.</p>
        </div>
      </div>
    </Card>
  );
}

export default function AdminIntegrations() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="admin" />
      <Container>
        <PageHeader
          title="Integrations & Automation"
          subtitle="Wire QuickBooks, Teams, Zoom, and other systems to The Open CRM."
        />

        <div className="space-y-6">
          <QuickBooksSection />
          <AutomationSection />
          <WebhooksSection />
        </div>
      </Container>
    </div>
  );
}
