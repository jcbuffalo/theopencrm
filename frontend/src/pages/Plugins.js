// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Plugins page — Phase C / D entry point.
//
// When the plugins_enabled feature flag is OFF for the caller's org, the
// /api/plugins route returns 403 FEATURE_DISABLED. We catch that and show
// a marketing-style "coming soon" view that explains what plugins will do.
// When the flag is ON, we list the org's plugins + offer creation flows.
//
// Conversational creation (POST /api/plugins/from-prompt) is queued for
// the Phase D builder UX. This page is the foundation it'll plug into.

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import Nav from '../components/Nav';
import { Alert, Button, Card, Container, EmptyState, Icon, PageHeader, Skeleton, StatusBadge } from '../components/ui';

const STATUS_TONE = { active: 'success', draft: 'neutral', suspended: 'warning' };

const PILLARS = [
  { eyebrow: 'Conversational', title: 'Describe it, deploy it',
    body: '"Email our warehouse when a deal hits ORDACK." Claude turns your description into a working plugin in seconds. You confirm the plain-English summary; we handle the rest.' },
  { eyebrow: 'Library', title: 'One-click installs',
    body: 'Pre-built plugins for QuickBooks sync, Slack notifications, daily stalled-deal digests, and more. Install with one click; customize with a form.' },
  { eyebrow: 'Safe by design', title: 'Sandboxed runtime',
    body: 'Each plugin runs in its own isolated context with hard CPU + memory + network quotas. A sloppy plugin can only affect your own workspace.' },
  { eyebrow: 'Code escape hatch', title: 'For the power users',
    body: null },
];

function ComingSoon() {
  return (
    <Container size="narrow">
      <div className="bg-gradient-to-br from-brand-blue/10 to-brand-mint/10 border border-brand-blue/30 rounded p-8 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-white text-brand-blue shadow-card">
          <Icon name="sparkles" size={24} />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900 mb-3">Plugins — coming soon</h1>
        <p className="text-base text-gray-700 max-w-2xl mx-auto">
          Build your own automations and integrations in plain English. Tell Claude what you want;
          the system generates a sandboxed plugin and runs it in your workspace. No code required —
          unless you want it.
        </p>
      </div>

      <div className="mt-8 grid sm:grid-cols-2 gap-4">
        {PILLARS.map((p) => (
          <Card key={p.eyebrow}>
            <div className="text-xs uppercase font-semibold text-brand-blue tracking-wider">{p.eyebrow}</div>
            <h3 className="text-base font-semibold text-gray-900 mt-1">{p.title}</h3>
            <p className="text-sm text-gray-600 mt-2">
              {p.body || (
                <>
                  Open any plugin in the JavaScript editor and tweak directly against a documented{' '}
                  <code className="bg-gray-100 px-1 rounded">crm</code> SDK. Same sandbox rules apply.
                </>
              )}
            </p>
          </Card>
        ))}
      </div>

      <p className="text-xs text-gray-500 mt-6 text-center">
        Plugins are part of the Professional and Enterprise tiers. Read the design at{' '}
        <a href="https://github.com/jcbuffalo/lightweight-crm/blob/master/PLUGIN_PLATFORM_VISION.md"
           target="_blank" rel="noreferrer" className="text-brand-blue underline">PLUGIN_PLATFORM_VISION.md</a>.
      </p>
    </Container>
  );
}

function PluginsList({ plugins, onRefresh }) {
  return (
    <>
      {plugins.length === 0 ? (
        <Card padding="none">
          <EmptyState
            icon="sparkles"
            title="No plugins yet"
            message="The fastest start: browse the extension library — ready-made automations (follow-ups, digests, data hygiene) you can turn on in one click. Or describe your own in plain English."
            action={
              <div className="flex gap-2 justify-center flex-wrap">
                <Button as={Link} to="/plugins/library" icon="search">Browse the extension library</Button>
                <Button as={Link} to="/plugins/new" variant="secondary" icon="plus">Build your own</Button>
              </div>
            }
          />
        </Card>
      ) : (
        <Card padding="none">
          <ul className="divide-y divide-gray-100">
            {plugins.map(p => (
              <li key={p.id}>
                <Link
                  to={`/plugins/${p.id}`}
                  className="block p-4 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-gray-900">{p.name}</span>
                    <StatusBadge tone={STATUS_TONE[p.status] || 'error'} label={p.status} className="capitalize" />
                    <span className="text-[11px] text-gray-500">{p.source_kind}</span>
                    <span className="ml-auto inline-flex items-center gap-1 text-xs text-gray-400">
                      View <Icon name="chevron-right" size={14} />
                    </span>
                  </div>
                  {p.description && <p className="text-xs text-gray-600 mt-1">{p.description}</p>}
                  {p.trigger_event && (
                    <p className="text-[11px] text-gray-500 mt-1">trigger: <code className="bg-gray-100 px-1 rounded">{p.trigger_event}</code></p>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <p className="text-xs text-gray-500">
        The plugin runtime is in Phase C build-out. Plugins created today are persisted but won't fire
        until the sandbox lands. See{' '}
        <a href="https://github.com/jcbuffalo/lightweight-crm/blob/master/PLUGIN_PLATFORM_VISION.md"
           target="_blank" rel="noreferrer" className="text-brand-blue underline">PLUGIN_PLATFORM_VISION.md</a>{' '}
        for status.
      </p>
    </>
  );
}

export default function Plugins() {
  const [plugins, setPlugins] = useState(null);
  const [error, setError] = useState('');
  const [featureDisabled, setFeatureDisabled] = useState(false);

  const load = async () => {
    setError('');
    try {
      const r = await api.get('/plugins');
      setPlugins(r.data.data || []);
      setFeatureDisabled(false);
    } catch (err) {
      if (err.response?.status === 403 && err.response?.data?.code === 'FEATURE_DISABLED') {
        setFeatureDisabled(true);
      } else {
        setError(err.response?.data?.error || err.message || 'Failed to load plugins');
      }
    }
  };

  useEffect(() => { load(); }, []);

  if (featureDisabled) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Nav active="plugins" />
        <ComingSoon />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="plugins" />
      <Container>
        <PageHeader
          title="Plugins"
          subtitle="Custom automations + integrations for this organization."
          primaryAction={<Button as={Link} to="/plugins/new" icon="plus">New plugin</Button>}
          secondaryActions={[
            { label: 'Extension library', icon: 'search', inline: true, as: Link, to: '/plugins/library' },
            { label: 'Refresh', icon: 'refresh', onClick: load },
          ]}
        />
        <div className="space-y-6">
          {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}
          {plugins == null && !error ? (
            <Card><Skeleton lines={4} /></Card>
          ) : plugins != null ? (
            <PluginsList plugins={plugins} onRefresh={load} />
          ) : null}
        </div>
      </Container>
    </div>
  );
}
