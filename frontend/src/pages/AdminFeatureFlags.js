// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Modules page — self-service module toggles for a workspace.
//
// Available at /admin/feature-flags (linked from Settings → Workspace as
// "Modules"). Any org OWNER or ADMIN can turn their own workspace's modules
// on and off; the backend (routes/adminFeatureFlagRoutes.js) enforces the
// same rule. Platform-scoped flags (billing gate, phase-2 rollouts, SSO) are
// never returned to org admins — only platform super-admins see them, and
// they additionally get an org selector for cross-org support.
//
// The registry (services/featureFlags.js KNOWN_FLAGS) supplies plain-English
// `label` / `oneLiner` / `group` for every flag; the engineer-facing
// `description` is behind a "Details" disclosure.

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import Nav from '../components/Nav';
import { useAuth } from '../AuthContext';
import { Alert, Button, Card, Container, Input, PageHeader, Skeleton, StatusBadge } from '../components/ui';

const GROUP_ORDER = ['Sell', 'Customers', 'Insights', 'Integrations', 'Platform'];
const GROUP_BLURBS = {
  Sell:         'Everything on the way to a closed deal.',
  Customers:    'Keeping the customers you already won.',
  Insights:     'Reporting, AI and automation on top of your data.',
  Integrations: 'Connect the tools you already use. Most need a connection or API key before they do anything.',
  Platform:     'Platform-level switches. Super-admins only — handle with care.',
};

function Toggle({ on, busy, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:opacity-50 ${
        on ? 'bg-brand-blue' : 'bg-gray-200'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition ${
          on ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

function ModuleRow({ flag, orgId, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showDetails, setShowDetails] = useState(false);

  const toggle = async () => {
    setBusy(true);
    setError('');
    try {
      const next = !flag.currentValue;
      if (next === flag.defaultValue && flag.isOverride) {
        // Flipping back to the default: DELETE so the module inherits the
        // default again rather than carrying a permanent override.
        await api.delete(`/admin/feature-flags/flags/${orgId}/${flag.name}`);
      } else {
        await api.put(`/admin/feature-flags/flags/${orgId}/${flag.name}`, { value: next });
      }
      onChanged();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-start justify-between gap-4 px-5 py-3 border-b border-gray-100 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-gray-900">{flag.label || flag.name}</span>
          {flag.scope === 'platform' && <StatusBadge tone="accent" label="platform" />}
          {flag.isOverride && (
            <StatusBadge tone="neutral" label={`set for this workspace (default ${flag.defaultValue ? 'on' : 'off'})`} />
          )}
        </div>
        <p className="text-sm text-gray-600 mt-0.5">{flag.oneLiner || flag.description}</p>
        {flag.oneLiner && flag.description && (
          <button
            type="button"
            onClick={() => setShowDetails(s => !s)}
            className="mt-1 text-xs text-gray-400 hover:text-gray-600 underline"
          >
            {showDetails ? 'Hide details' : 'Details'}
          </button>
        )}
        {showDetails && (
          <p className="mt-1 text-xs text-gray-500">
            <code className="text-gray-500">{flag.name}</code> &mdash; {flag.description}
          </p>
        )}
        {error && <p className="text-xs text-danger-600 mt-1" role="alert">{error}</p>}
      </div>
      <div className="flex flex-col items-end gap-1 flex-shrink-0">
        <Toggle on={!!flag.currentValue} busy={busy} onClick={toggle} label={`${flag.label || flag.name}: ${flag.currentValue ? 'on' : 'off'}`} />
        <span className="text-[11px] text-gray-500">{flag.currentValue ? 'On' : 'Off'}</span>
      </div>
    </div>
  );
}

export default function AdminFeatureFlags() {
  const { isAdmin, adminRole, orgRole, orgName } = useAuth();
  const isSuperAdmin = isAdmin && adminRole === 'super_admin';
  const canManage = isAdmin || orgRole === 'owner' || orgRole === 'admin';

  const [flags, setFlags] = useState([]);
  const [profile, setProfile] = useState('');
  const [orgId, setOrgId] = useState(null);       // org currently displayed (from the API)
  const [viewOrg, setViewOrg] = useState(null);   // super-admin: explicit org to view (null = own org)
  const [targetOrg, setTargetOrg] = useState('');  // super-admin org selector input
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const path = viewOrg ? `/admin/feature-flags/flags/${viewOrg}` : '/admin/feature-flags/flags';
      const r = await api.get(path);
      const data = r.data?.data || {};
      setFlags(Array.isArray(data.flags) ? data.flags : []);
      setProfile(data.profile || '');
      setOrgId(data.orgId ?? null);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load modules');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (canManage) load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [canManage, viewOrg]);

  if (!canManage) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Nav active="admin" />
        <Container size="narrow">
          <Alert tone="warning" icon="lock">
            Only a workspace owner or admin can change which modules are turned on.
          </Alert>
        </Container>
      </div>
    );
  }

  const grouped = flags.reduce((acc, f) => {
    const g = f.group || 'Other';
    (acc[g] = acc[g] || []).push(f);
    return acc;
  }, {});
  const groups = [...GROUP_ORDER.filter(g => grouped[g]?.length), ...Object.keys(grouped).filter(g => !GROUP_ORDER.includes(g))];
  const onCount = flags.filter(f => f.currentValue).length;

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="admin" />
      <Container>
        <PageHeader
          breadcrumb={[{ label: 'Workspace', to: '/settings#workspace' }, { label: 'Modules' }]}
          title="Modules"
          subtitle={
            <>
              Turn parts of the CRM on or off for {orgName ? <span className="font-medium">{orgName}</span> : 'this workspace'}.
              Start light and switch things on as you need them. Turning a module off hides it and blocks its
              API for everyone in the workspace; nothing is deleted, so you can turn it back on any time.
            </>
          }
          primaryAction={{ label: 'Reload', icon: 'refresh', variant: 'secondary', onClick: load }}
        />

        <div className="space-y-6">
          {isSuperAdmin && (
            <Card padding="sm">
              <form
                onSubmit={(e) => { e.preventDefault(); setViewOrg(targetOrg.trim() ? Number(targetOrg) : null); }}
                className="flex items-end gap-2 text-sm"
              >
                <Input
                  label="Super-admin: view org ID"
                  type="number"
                  min="1"
                  size="sm"
                  value={targetOrg}
                  onChange={e => setTargetOrg(e.target.value)}
                  placeholder="(your org)"
                  wrapperClassName="w-40"
                />
                <Button type="submit" variant="secondary" size="sm">Load</Button>
              </form>
            </Card>
          )}

          <Card
            padding="none"
            title={
              loading ? 'Loading modules' : (
                <>
                  <span className="font-semibold">{onCount}</span> of {flags.length} modules on
                </>
              )
            }
            subtitle={
              !loading && (profile || (isSuperAdmin && orgId)) ? (
                <>
                  {profile && <span>workflow: <code>{profile}</code></span>}
                  {isSuperAdmin && orgId && <span className="ml-3">org #{orgId}</span>}
                </>
              ) : undefined
            }
          >
            {loading ? (
              <div className="p-5"><Skeleton lines={6} /></div>
            ) : error ? (
              <div className="p-4"><Alert tone="danger">{error}</Alert></div>
            ) : flags.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-500">No modules registered.</div>
            ) : (
              groups.map(group => (
                <div key={group}>
                  <div className="px-5 py-2 bg-gray-50 border-b border-t border-gray-100">
                    <h3 className="text-xs uppercase font-semibold text-gray-600 tracking-wider">{group}</h3>
                    {GROUP_BLURBS[group] && <p className="text-xs text-gray-500 mt-0.5">{GROUP_BLURBS[group]}</p>}
                  </div>
                  {grouped[group].map(flag => (
                    <ModuleRow key={flag.name} flag={flag} orgId={orgId} onChanged={load} />
                  ))}
                </div>
              ))
            )}
          </Card>

          <p className="text-xs text-gray-500">
            Changes take effect within about 30 seconds. Integrations also need their connection or API key
            set up under <Link to="/settings" className="underline">Settings</Link> before they do anything.
          </p>
        </div>
      </Container>
    </div>
  );
}
