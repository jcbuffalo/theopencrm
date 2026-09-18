// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Super-admin → Provision Org page.
//
// First-customer onboarding flow. Calls POST /api/admin/provision-org which
// wraps backend/services/orgProvisioner.js — the same code path the
// `backend/scripts/provision-org.js` CLI uses. UX is dry-run-first: every
// submit runs as dryRun=true and renders the plan; only after that succeeds
// does the "Confirm + Apply" button become available. That keeps the destructive
// step (org rename / owner reassignment) gated behind a deliberate two-step.
//
// Gate: super-admin only. Backend rejects non-super-admins with 403; this page
// shows an "Access denied" panel rather than the form. Mirrors the
// AdminPlatformIntegrations.js pattern.

import React, { useState } from 'react';
import { admin } from '../api';
import Nav from '../components/Nav';
import { useAuth } from '../AuthContext';
import { KNOWN_PROFILES } from '../stages';
import { Alert, Button, Card, Container, Input, PageHeader, controlClasses } from '../components/ui';

// Single source of truth for the profile list — keeps `rin` (and any future
// profile) selectable without editing this page.
const PROFILES = KNOWN_PROFILES;

const MODES = [
  {
    id: 'rename-existing',
    label: 'Rename existing workspace',
    description: 'The admin user already self-registered. Repurpose their personal workspace as the customer org (keeps any data they\'ve entered).',
  },
  {
    id: 'create-new',
    label: 'Create new workspace',
    description: 'Spin up a fresh org. The admin user is moved into it as owner; their personal workspace remains separate.',
  },
];

const FEATURE_FLAGS = [
  { name: 'plugins_enabled',      label: 'Plugins',       description: 'User-built plugins. Off by default until Phase D ships.' },
  { name: 'drive_intel_enabled',  label: 'Drive Intel',   description: 'Google Drive opportunity-intel summarization. Off by default.' },
  { name: 'ai_features_enabled',  label: 'AI features',   description: 'Claude-powered AI helpers (deal summary, draft emails).' },
  { name: 'documents_enabled',    label: 'Documents',     description: 'Document upload + GCS storage module.' },
];

export default function AdminProvisionOrg() {
  const { user } = useAuth();
  // Same super-admin shape AdminPlatformIntegrations.js uses.
  const isSuperAdmin =
    user?.is_admin === true && user?.admin_role === 'super_admin';

  // Form state
  const [name, setName] = useState('');
  const [profile, setProfile] = useState('generic');
  const [adminEmail, setAdminEmail] = useState('');
  const [mode, setMode] = useState('rename-existing');
  const [displayName, setDisplayName] = useState('');
  const [primaryColor, setPrimaryColor] = useState('#2076CD');
  const [logoUrl, setLogoUrl] = useState('');
  const [labelDeal, setLabelDeal] = useState('');
  const [labelDeals, setLabelDeals] = useState('');
  const [labelExternalRef, setLabelExternalRef] = useState('');
  const [flags, setFlags] = useState({}); // { plugins_enabled: true, ... }
  const [seedDemo, setSeedDemo] = useState(true);

  // Flow state — dry-run-first
  const [submitting, setSubmitting] = useState(false);
  const [dryRunResult, setDryRunResult] = useState(null);
  const [applyResult, setApplyResult] = useState(null);
  const [error, setError] = useState('');

  const buildPayload = (dryRun) => {
    const branding = {};
    if (displayName.trim())   branding.displayName = displayName.trim();
    if (primaryColor)         branding.primaryColor = primaryColor;
    if (logoUrl.trim())       branding.logoUrl = logoUrl.trim();
    const labels = {};
    if (labelDeal.trim())        labels.deal = labelDeal.trim();
    if (labelDeals.trim())       labels.deals = labelDeals.trim();
    if (labelExternalRef.trim()) labels.externalRef = labelExternalRef.trim();
    if (Object.keys(labels).length) branding.labels = labels;

    // Only include flags the operator actually toggled — omitted flags stay
    // at the org's default. We don't want to inadvertently force-off a flag
    // that's on by default org-wide.
    const featureFlags = {};
    for (const [k, v] of Object.entries(flags)) {
      if (v === true || v === false) featureFlags[k] = v;
    }

    return {
      name: name.trim(),
      profile,
      adminEmail: adminEmail.trim(),
      mode,
      branding,
      featureFlags,
      seedDemo,
      dryRun,
    };
  };

  const submitDryRun = async () => {
    setSubmitting(true);
    setError('');
    setDryRunResult(null);
    setApplyResult(null);
    try {
      const result = await admin.provisionOrg(buildPayload(true));
      setDryRunResult(result);
    } catch (err) {
      const data = err?.response?.data;
      setError(data?.error || err?.message || 'Dry-run failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const submitApply = async () => {
    setSubmitting(true);
    setError('');
    try {
      const result = await admin.provisionOrg(buildPayload(false));
      setApplyResult(result);
    } catch (err) {
      const data = err?.response?.data;
      setError(data?.error || err?.message || 'Apply failed.');
    } finally {
      setSubmitting(false);
    }
  };

  // After a successful apply, clear out the dry-run plan so the form returns
  // to a clean state (and the operator can provision another customer).
  const reset = () => {
    setDryRunResult(null);
    setApplyResult(null);
    setError('');
    setName('');
    setAdminEmail('');
    setDisplayName('');
    setLogoUrl('');
    setLabelDeal('');
    setLabelDeals('');
    setLabelExternalRef('');
    setFlags({});
  };

  if (!isSuperAdmin) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Nav active="admin" />
        <Container size="narrow">
          <Alert tone="danger" icon="lock" title="Access denied">
            Org provisioning can only be performed by a super-admin.
          </Alert>
        </Container>
      </div>
    );
  }

  const canSubmit = name.trim() && adminEmail.trim() && !submitting;

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="admin" />
      <Container size="narrow">
        <PageHeader
          title="Provision customer org"
          subtitle={
            <>
              One-stop onboarding for a new customer. Wraps the same logic as the{' '}
              <code className="bg-gray-100 px-1 rounded">backend/scripts/provision-org.js</code> CLI
              so you don't need a Cloud SQL proxy. Dry-run first; confirm to apply.
            </>
          }
        />

        {applyResult ? (
          <SuccessPanel result={applyResult} onReset={reset} />
        ) : (
          <div className="space-y-6">

            <Card title="Org">
              <div className="space-y-4">
                <Input
                  label="Org name (internal)"
                  required
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Northwind"
                />

                <ChoiceGroup label="Workflow profile">
                  {PROFILES.map((p) => (
                    <Choice key={p.id} name="profile" value={p.id} checked={profile === p.id} onChange={() => setProfile(p.id)} title={p.label} description={p.description} />
                  ))}
                </ChoiceGroup>

                <Input
                  label="Admin email"
                  required
                  type="email"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  placeholder="johnosberg@gmail.com"
                  hint="Must already exist in /admin/access-requests (status = active)."
                />

                <ChoiceGroup label="Mode">
                  {MODES.map((m) => (
                    <Choice key={m.id} name="mode" value={m.id} checked={mode === m.id} onChange={() => setMode(m.id)} title={m.label} description={m.description} />
                  ))}
                </ChoiceGroup>
              </div>
            </Card>

            <Card title="Branding">
              <div className="space-y-4">
                <Input
                  label="Display name"
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder={name ? `Defaults to "${name}"` : 'Customer-facing brand'}
                />

                <div>
                  <label htmlFor="provision-primary-color" className="block text-sm font-medium text-gray-700 mb-1">Primary color</label>
                  <div className="flex gap-3 items-center">
                    <input
                      id="provision-primary-color"
                      type="color"
                      value={primaryColor || '#2076CD'}
                      onChange={(e) => setPrimaryColor(e.target.value)}
                      className="h-10 w-16 border border-gray-300 rounded cursor-pointer"
                      aria-label="Primary color picker"
                    />
                    <input
                      type="text"
                      aria-label="Primary color hex"
                      value={primaryColor}
                      onChange={(e) => setPrimaryColor(e.target.value)}
                      placeholder="#2076CD"
                      className={controlClasses({ className: 'flex-1 font-mono' })}
                    />
                  </div>
                </div>

                <Input
                  label="Logo URL"
                  type="url"
                  value={logoUrl}
                  onChange={(e) => setLogoUrl(e.target.value)}
                  placeholder="https://your-cdn.example.com/logo.svg"
                />

                <Input
                  label='"Deal" singular'
                  type="text"
                  value={labelDeal}
                  onChange={(e) => setLabelDeal(e.target.value)}
                  placeholder="Deal"
                  className="font-mono"
                />

                <Input
                  label='"Deals" plural'
                  type="text"
                  value={labelDeals}
                  onChange={(e) => setLabelDeals(e.target.value)}
                  placeholder="Deals"
                  className="font-mono"
                />

                <Input
                  label="External reference label"
                  type="text"
                  value={labelExternalRef}
                  onChange={(e) => setLabelExternalRef(e.target.value)}
                  placeholder="External Ref"
                  className="font-mono"
                />
              </div>
            </Card>

            <Card
              title="Feature flags"
              subtitle={
                <>
                  Initial flags to set on the new org. Leave a toggle untouched to use the org default; flip it to explicitly enable/disable.
                  Full per-org control lives at <code className="bg-gray-100 px-1 rounded">/admin/feature-flags</code>.
                </>
              }
            >
              <div className="space-y-2">
                {FEATURE_FLAGS.map((f) => {
                  const state = flags[f.name]; // undefined | true | false
                  return (
                    <div key={f.name} className="flex items-start gap-3 p-3 rounded border border-gray-200 bg-white">
                      <div className="flex-1">
                        <div className="font-semibold text-gray-900 text-sm">{f.label}</div>
                        <p className="text-xs text-gray-600 mt-0.5">{f.description}</p>
                        <div className="text-xs text-gray-500 font-mono mt-1">{f.name}</div>
                      </div>
                      <div className="flex gap-1 text-xs">
                        <ToggleButton
                          active={state === true}
                          onClick={() => setFlags((p) => ({ ...p, [f.name]: true }))}
                          label="On"
                        />
                        <ToggleButton
                          active={state === false}
                          onClick={() => setFlags((p) => ({ ...p, [f.name]: false }))}
                          label="Off"
                        />
                        <ToggleButton
                          active={state === undefined}
                          onClick={() => setFlags((p) => { const n = { ...p }; delete n[f.name]; return n; })}
                          label="Default"
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>

            <Card title="Demo data">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={seedDemo}
                  onChange={(e) => setSeedDemo(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand-blue focus:ring-brand-blue"
                />
                <div className="flex-1">
                  <div className="font-semibold text-gray-900 text-sm">Seed demo data</div>
                  <p className="text-xs text-gray-600 mt-0.5">
                    Populate the org with realistic [demo]-tagged companies,
                    contacts, and deals so charts aren't empty on day one.
                    Wipe later via <code className="bg-gray-100 px-1 rounded">POST /api/admin/demo/wipe</code>.
                  </p>
                </div>
              </label>
            </Card>

            {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

            {dryRunResult && (
              <DryRunPanel result={dryRunResult} />
            )}

            <div className="flex items-center justify-end gap-3 sticky bottom-0 bg-gray-50 pt-3 pb-2 -mx-4 px-4 border-t border-gray-200">
              <Button
                variant="secondary"
                onClick={submitDryRun}
                disabled={!canSubmit}
                loading={submitting && !dryRunResult}
                loadingLabel="Running…"
              >
                Dry-run
              </Button>
              <Button
                onClick={submitApply}
                disabled={!dryRunResult || submitting}
                title={dryRunResult ? '' : 'Run a dry-run first'}
                loading={submitting && !!dryRunResult}
                loadingLabel="Applying…"
                icon="check"
              >
                Confirm + Apply
              </Button>
            </div>
          </div>
        )}
      </Container>
    </div>
  );
}

function ChoiceGroup({ label, children }) {
  return (
    <fieldset>
      <legend className="block text-sm font-medium text-gray-700 mb-1">{label}</legend>
      <div className="space-y-2">{children}</div>
    </fieldset>
  );
}

function Choice({ name, value, checked, onChange, title, description }) {
  return (
    <label className={`flex gap-3 items-start p-3 rounded border-2 cursor-pointer ${checked ? 'border-brand-blue bg-info-50' : 'border-gray-200 hover:bg-gray-50'}`}>
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="mt-0.5 text-brand-blue focus:ring-brand-blue"
      />
      <div className="flex-1">
        <div className="font-semibold text-gray-900 text-sm">{title}</div>
        <p className="text-xs text-gray-600 mt-0.5">{description}</p>
      </div>
    </label>
  );
}

function ToggleButton({ active, onClick, label }) {
  return (
    <Button type="button" size="sm" variant={active ? 'primary' : 'secondary'} aria-pressed={active} onClick={onClick}>
      {label}
    </Button>
  );
}

function DryRunPanel({ result }) {
  return (
    <Alert tone="info" title="Dry-run plan">
      <p className="text-xs mb-3">
        Reviewed — no writes performed yet. Click <b>Confirm + Apply</b> to
        execute exactly this plan.
      </p>
      <div className="text-sm space-y-1 mb-3">
        <div><b>Action:</b> {result.action === 'create' ? 'create new org' : 'rename existing org'}</div>
        <div><b>Target user:</b> {result.userEmail}</div>
        {result.orgId && <div><b>Target org id:</b> {result.orgId}</div>}
        {result.summary?.existingDataCounts && (
          <div>
            <b>Existing data in target org:</b>{' '}
            {result.summary.existingDataCounts.deals} deals ·{' '}
            {result.summary.existingDataCounts.companies} companies ·{' '}
            {result.summary.existingDataCounts.contacts} contacts
          </div>
        )}
        {result.summary?.featureFlagsSet?.length > 0 && (
          <div><b>Feature flags:</b> {result.summary.featureFlagsSet.join(', ')}</div>
        )}
        <div><b>Seed demo data:</b> {result.summary?.seedDemo ? 'yes' : 'no'}</div>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer font-semibold">Raw plan JSON</summary>
        <pre className="mt-2 bg-white border border-info-200 rounded p-3 overflow-x-auto text-gray-800">
          {JSON.stringify(result, null, 2)}
        </pre>
      </details>
    </Alert>
  );
}

function SuccessPanel({ result, onReset }) {
  return (
    <Card title="Org provisioned" subtitle={`${result.userEmail} can now sign in to org "${result.summary?.name}" (id ${result.orgId}). Branding and feature flags applied.`}>
      <div className="space-y-3">
        <ul className="text-sm text-gray-700 list-disc list-inside space-y-1">
          <li>Verify branding: <code className="bg-gray-100 px-1 rounded">/admin/branding</code></li>
          <li>Verify pipeline: <code className="bg-gray-100 px-1 rounded">/deals</code></li>
          <li>Wipe demo later: <code className="bg-gray-100 px-1 rounded">POST /api/admin/demo/wipe</code></li>
        </ul>
        {result.summary?.featureFlagErrors?.length > 0 && (
          <Alert tone="warning" title="Some feature flags failed to apply:">
            <ul className="list-disc list-inside mt-1 text-xs">
              {result.summary.featureFlagErrors.map((e, i) => (
                <li key={i}><code>{e.name}</code>: {e.error}</li>
              ))}
            </ul>
          </Alert>
        )}
        <details className="text-xs">
          <summary className="cursor-pointer text-gray-700 font-semibold">Raw result JSON</summary>
          <pre className="mt-2 bg-gray-50 border border-gray-200 rounded p-3 overflow-x-auto text-gray-800">
            {JSON.stringify(result, null, 2)}
          </pre>
        </details>
        <Button variant="secondary" onClick={onReset} icon="plus">Provision another</Button>
      </div>
    </Card>
  );
}
