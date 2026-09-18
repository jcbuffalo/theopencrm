// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Admin → Enterprise SSO & provisioning. Org owners/admins configure the
// OIDC connection (issuer, client id/secret, allowed domain, login slug)
// and mint SCIM bearer tokens for their IdP. Backed by GET/PUT /api/admin/sso
// and POST/DELETE /api/admin/sso/scim-tokens. The whole surface is behind
// the platform-scoped `sso_enabled` flag — a 403 from the gate renders the
// "not enabled" notice rather than an error.

import React, { useEffect, useState } from 'react';
import api from '../api';
import Nav from '../components/Nav';
import { useAuth } from '../AuthContext';
import { Alert, Button, Card, Container, Input, PageHeader, Skeleton, StatusBadge } from '../components/ui';

export default function AdminSso() {
  const { user, isAdmin } = useAuth();
  const isOrgAdmin = isAdmin || user?.org_role === 'owner' || user?.org_role === 'admin';

  const [loading, setLoading] = useState(true);
  const [gated, setGated] = useState(false); // 403 from the feature gate
  const [data, setData] = useState(null); // { connection, scimTokens, scimBaseUrl }
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);

  // Editable form fields.
  const [form, setForm] = useState({ slug: '', issuer: '', clientId: '', clientSecret: '', allowedDomain: '', enabled: false });
  const [newToken, setNewToken] = useState(null); // plaintext shown once

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await api.get('/admin/sso');
      setData(r.data);
      const c = r.data.connection || {};
      setForm({
        slug: c.slug || '',
        issuer: c.issuer || '',
        clientId: c.clientId || '',
        clientSecret: '', // never populated from the server
        allowedDomain: c.allowedDomain || '',
        enabled: !!c.enabled,
      });
    } catch (err) {
      if (err.response?.status === 403) { setGated(true); }
      else setError(err.response?.data?.error || err.message || 'Failed to load SSO settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOrgAdmin) load();
    else setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOrgAdmin]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const body = {
        slug: form.slug,
        issuer: form.issuer,
        clientId: form.clientId,
        allowedDomain: form.allowedDomain,
        enabled: form.enabled,
      };
      // Only send clientSecret if the admin typed a new one (write-only).
      if (form.clientSecret) body.clientSecret = form.clientSecret;
      const r = await api.put('/admin/sso', body);
      setData((d) => ({ ...d, connection: r.data.connection }));
      setForm((f) => ({ ...f, clientSecret: '' }));
      setSavedAt(new Date());
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const generateToken = async () => {
    setError('');
    try {
      const r = await api.post('/admin/sso/scim-tokens', { name: 'IdP provisioning' });
      setNewToken(r.data.token);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to create SCIM token');
    }
  };

  const revokeToken = async (id) => {
    setError('');
    try {
      await api.delete(`/admin/sso/scim-tokens/${id}`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to revoke token');
    }
  };

  if (!isOrgAdmin) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Nav active="admin" />
        <Container size="narrow">
          <Alert tone="warning" icon="lock">
            Org owner or admin access required to manage SSO settings.
          </Alert>
        </Container>
      </div>
    );
  }

  const startUrl = data?.connection?.slug && data?.scimBaseUrl
    ? `${data.scimBaseUrl.replace(/\/scim\/v2$/, '')}/api/auth/sso/${data.connection.slug}/start`
    : null;
  const conn = data?.connection;

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="admin" />
      <Container size="narrow">
        <PageHeader
          title="Enterprise SSO & provisioning"
          subtitle="Connect your OpenID Connect (OIDC) identity provider so your team signs in with your IdP, and mint a SCIM token so your IdP can provision and deprovision users automatically."
        />

        {loading ? (
          <Card><Skeleton lines={6} /></Card>
        ) : gated ? (
          <Alert tone="warning" icon="lock" title="SSO is not enabled for this organization">
            Ask your platform administrator to turn on the
            <code className="mx-1 font-mono">sso_enabled</code> feature flag.
          </Alert>
        ) : (
          <div className="space-y-6">
            {/* --- OIDC connection --- */}
            <Card title="OIDC connection">
              <div className="space-y-4">
                <Input
                  label="Login slug"
                  hint="Short id for your login URL, e.g. acme. Lowercase letters, digits, hyphens."
                  value={form.slug}
                  onChange={(e) => setForm({ ...form, slug: e.target.value })}
                  placeholder="acme"
                />
                <Input
                  label="Issuer URL"
                  hint="Your IdP's OIDC issuer, e.g. https://login.microsoftonline.com/<tenant>/v2.0"
                  value={form.issuer}
                  onChange={(e) => setForm({ ...form, issuer: e.target.value })}
                  placeholder="https://idp.example.com"
                />
                <Input
                  label="Client ID"
                  value={form.clientId}
                  onChange={(e) => setForm({ ...form, clientId: e.target.value })}
                  placeholder="your OIDC application (client) id"
                />
                <Input
                  label="Client secret"
                  type="password"
                  hint={conn?.hasSecret ? 'A secret is stored. Leave blank to keep it; type a new value to replace it.' : 'Required. Stored encrypted at rest; never shown again.'}
                  value={form.clientSecret}
                  onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
                  placeholder={conn?.hasSecret ? '•••••••• (unchanged)' : 'client secret'}
                  autoComplete="new-password"
                />
                <Input
                  label="Allowed email domain"
                  hint="Only users whose verified email is on this domain may sign in via SSO, e.g. acme.com."
                  value={form.allowedDomain}
                  onChange={(e) => setForm({ ...form, allowedDomain: e.target.value })}
                  placeholder="acme.com"
                />

                <label className="flex items-center gap-2 text-sm text-gray-800">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-gray-300 text-brand-blue focus:ring-brand-blue"
                    checked={form.enabled}
                    onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                  />
                  Enable SSO for this organization
                </label>

                <div className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded p-3">
                  <div className="font-semibold text-gray-600 mb-1">Redirect (callback) URL — register this at your IdP:</div>
                  <code className="font-mono break-all">{(data?.scimBaseUrl || '').replace(/\/scim\/v2$/, '')}/api/auth/sso/callback</code>
                  {startUrl && (
                    <>
                      <div className="font-semibold text-gray-600 mt-2 mb-1">Your users' SSO start URL:</div>
                      <code className="font-mono break-all">{startUrl}</code>
                    </>
                  )}
                </div>
              </div>
            </Card>

            {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}

            <div className="flex items-center justify-between gap-3">
              <div className="text-xs text-gray-500">
                {savedAt ? `Last saved ${savedAt.toLocaleTimeString()}` : 'Changes apply org-wide on save.'}
              </div>
              <Button onClick={save} disabled={saving} loading={saving} loadingLabel="Saving…">
                Save connection
              </Button>
            </div>

            {/* --- SCIM tokens --- */}
            <Card
              title="SCIM provisioning tokens"
              subtitle={<>Give this bearer token to your IdP's SCIM connector. Base URL: <code className="font-mono">{data?.scimBaseUrl}</code></>}
              actions={<Button size="sm" variant="secondary" icon="plus" onClick={generateToken}>Generate token</Button>}
            >
              {newToken && (
                <Alert tone="success" title="Copy this token now — it won't be shown again:" className="mb-3">
                  <code className="font-mono text-xs break-all">{newToken}</code>
                </Alert>
              )}

              <div className="divide-y divide-gray-100">
                {(data?.scimTokens || []).length === 0 ? (
                  <div className="text-sm text-gray-500 py-2">No SCIM tokens yet. Mint one to let your identity provider provision and deprovision users automatically.</div>
                ) : (
                  data.scimTokens.map((t) => (
                    <div key={t.id} className="flex items-center justify-between py-2 text-sm gap-3">
                      <div className="flex items-center gap-2 flex-wrap min-w-0">
                        <code className="font-mono text-gray-700">{t.tokenPrefix}…</code>
                        {t.name ? <span className="text-gray-500">{t.name}</span> : null}
                        {t.revokedAt ? <StatusBadge tone="error" label="revoked" /> : null}
                        {t.lastUsedAt ? <span className="text-gray-400 text-xs">last used {new Date(t.lastUsedAt).toLocaleDateString()}</span> : null}
                      </div>
                      {!t.revokedAt && (
                        <button type="button" onClick={() => revokeToken(t.id)} className="text-danger-600 hover:underline text-xs flex-shrink-0">Revoke</button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </Card>
          </div>
        )}
      </Container>
    </div>
  );
}
