// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Admin → Branding page. Owners and super-admins manage the org's display
// name, logo, primary color, vertical-specific labels, and which workflow
// profile (generic vs. zang) the org is on.
//
// Backed by PUT /api/org which does a partial JSONB merge on branding so
// editing one field doesn't clobber others.

import React, { useEffect, useState } from 'react';
import api from '../api';
import Nav from '../components/Nav';
import { useAuth } from '../AuthContext';
import { KNOWN_PROFILES } from '../stages';
import { Alert, Button, Card, Container, Input, PageHeader, Skeleton, controlClasses } from '../components/ui';

// Single source of truth for the profile list — keeps `rin` (and any future
// profile) selectable, and guarantees an org already on `rin` sees its own
// option checked rather than silently falling off the list.
const PROFILES = KNOWN_PROFILES;

export default function AdminBranding() {
  const { user, isAdmin, refreshUser } = useAuth();
  const [org, setOrg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);

  // Local edit state
  const [name, setName] = useState('');
  const [profile, setProfile] = useState('generic');
  const [branding, setBranding] = useState({});

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await api.get('/org');
      setOrg(r.data.org);
      setName(r.data.org.name || '');
      setProfile(r.data.org.profile || 'generic');
      setBranding(r.data.org.branding || {});
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load organization');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await api.put('/org', {
        name: name.trim(),
        profile,
        branding,
      });
      setSavedAt(new Date());
      // Refresh user so Nav picks up the new branding immediately.
      await refreshUser();
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const updateBranding = (key, value) => {
    setBranding(prev => {
      const next = { ...prev };
      if (value === '' || value == null) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  };

  const updateLabel = (key, value) => {
    setBranding(prev => {
      const labels = { ...(prev.labels || {}) };
      if (value === '' || value == null) {
        delete labels[key];
      } else {
        labels[key] = value;
      }
      const next = { ...prev };
      if (Object.keys(labels).length === 0) {
        delete next.labels;
      } else {
        next.labels = labels;
      }
      return next;
    });
  };

  if (!isAdmin && user?.org_role !== 'owner') {
    return (
      <div className="min-h-screen bg-gray-50">
        <Nav active="admin" />
        <Container size="narrow">
          <Alert tone="warning" icon="lock">
            Org owner or admin access required to manage branding.
          </Alert>
        </Container>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="admin" />
      <Container size="narrow">
        <PageHeader
          title="Organization branding"
          subtitle="Manage the display name, logo, color, and vertical-specific labels for your organization. Changes take effect immediately for everyone in this org."
        />

        {loading ? (
          <Card><Skeleton lines={6} /></Card>
        ) : error && !org ? (
          <Alert tone="danger">{error}</Alert>
        ) : (
          <div className="space-y-6">

            {/* Profile picker */}
            <Card
              title="Workflow profile"
              subtitle="Picks which stage set, transitions, and feature panels render in the app. Changing this swaps the user-facing experience across Kanban, deals, and reports."
            >
              <div className="space-y-2">
                {PROFILES.map(p => (
                  <label key={p.id} className={`flex gap-3 items-start p-3 rounded border-2 cursor-pointer ${profile === p.id ? 'border-brand-blue bg-info-50' : 'border-gray-200 hover:bg-gray-50'}`}>
                    <input
                      type="radio"
                      name="profile"
                      value={p.id}
                      checked={profile === p.id}
                      onChange={() => setProfile(p.id)}
                      className="mt-0.5 text-brand-blue focus:ring-brand-blue"
                    />
                    <div className="flex-1">
                      <div className="font-semibold text-gray-900">{p.label}</div>
                      <p className="text-xs text-gray-600 mt-0.5">{p.description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </Card>

            {/* Branding fields */}
            <Card title="Branding">
              <div className="space-y-4">
                <Input
                  label="Organization name (internal)"
                  hint="Internal identifier — appears in admin tools and audit logs."
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="e.g. Acme Corp"
                />

                <Input
                  label="Display name (user-facing)"
                  hint="Shown in the top nav and on customer-facing PDFs. Use a public-facing brand if it differs from the legal entity name."
                  type="text"
                  value={branding.displayName || ''}
                  onChange={e => updateBranding('displayName', e.target.value)}
                  placeholder={`Defaults to "${name}" if blank`}
                />

                <Input
                  label="Logo URL"
                  hint="Public HTTPS URL. SVG preferred for crisp scaling. Leave blank to use the default Open CRM mark."
                  type="url"
                  value={branding.logoUrl || ''}
                  onChange={e => updateBranding('logoUrl', e.target.value)}
                  placeholder="https://your-cdn.example.com/logo.svg"
                />

                <div>
                  <label htmlFor="branding-primary-color" className="block text-sm font-medium text-gray-700 mb-1">Primary color</label>
                  <div className="flex gap-3 items-center">
                    <input
                      id="branding-primary-color"
                      type="color"
                      value={branding.primaryColor || '#1e3a8a'}
                      onChange={e => updateBranding('primaryColor', e.target.value)}
                      className="h-10 w-16 border border-gray-300 rounded cursor-pointer"
                    />
                    <input
                      type="text"
                      aria-label="Primary color hex"
                      value={branding.primaryColor || ''}
                      onChange={e => updateBranding('primaryColor', e.target.value)}
                      placeholder="#1e3a8a"
                      className={controlClasses({ className: 'flex-1 font-mono' })}
                    />
                  </div>
                </div>
              </div>
            </Card>

            {/* Vertical-specific labels */}
            <Card
              title="Label overrides"
              subtitle="A small set of user-facing nouns the app uses. Override them to match your vertical's terminology. Leave blank to use the platform default."
            >
              <div className="space-y-4">
                <Input
                  label='"Deal" singular'
                  type="text"
                  value={branding.labels?.deal || ''}
                  onChange={e => updateLabel('deal', e.target.value)}
                  placeholder="Deal"
                  className="font-mono"
                />

                <Input
                  label='"Deals" plural'
                  type="text"
                  value={branding.labels?.deals || ''}
                  onChange={e => updateLabel('deals', e.target.value)}
                  placeholder="Deals"
                  className="font-mono"
                />

                <Input
                  label="External reference label"
                  hint='e.g. "Zang #", "Job ID", "PO Reference" — whatever your business calls the master tracking number.'
                  type="text"
                  value={branding.labels?.externalRef || ''}
                  onChange={e => updateLabel('externalRef', e.target.value)}
                  placeholder="External Ref"
                  className="font-mono"
                />
              </div>
            </Card>

            {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

            <div className="flex items-center justify-between gap-3 sticky bottom-0 bg-gray-50 pt-3 pb-2 -mx-4 px-4 border-t border-gray-200">
              <div className="text-xs text-gray-500">
                {savedAt ? `Last saved ${savedAt.toLocaleTimeString()}` : 'Changes apply org-wide on save.'}
              </div>
              <Button onClick={save} disabled={saving} loading={saving} loadingLabel="Saving…">
                Save changes
              </Button>
            </div>
          </div>
        )}
      </Container>
    </div>
  );
}
