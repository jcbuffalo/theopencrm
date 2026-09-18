// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Super-admin → Platform Integrations.
//
// In-app configuration for platform-level third-party OAuth credentials so
// the operator can rotate them without a Cloud Run redeploy. Full spec at
// /PLATFORM_INTEGRATIONS_SPEC.md. Phase 1 ships only the Drive card; the
// page is deliberately structured around an INTEGRATIONS registry so adding
// Gmail / Stripe / Teams / Zoom in later phases is just dropping a new
// entry into the registry and an <IntegrationCard integration="…" /> into
// the render.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { platformIntegrations } from '../api';
import Nav from '../components/Nav';
import { useAuth } from '../AuthContext';
import { Alert, Button, Card, Container, Input, Modal, PageHeader, Spinner, StatusBadge } from '../components/ui';

// ---------------------------------------------------------------------------
// Integration registry
// ---------------------------------------------------------------------------
//
// One entry per integration we know how to render. The shape mirrors what
// backend/services/platformIntegrations.js' INTEGRATIONS object exposes
// (configFields + secretField + a client-side cousin of validateConfig),
// so the UI labels stay in sync with the server-side validation rules.
//
// `clientValidate(config, secret, { needsSecret })` runs BEFORE we hit the
// network — it's a courtesy, not a security control. The server validates
// authoritatively and we surface its 400 message inline regardless.

const INTEGRATIONS = {
  drive: {
    title: 'Google Drive',
    description:
      'OAuth credentials Drive Intel uses to authorize per-org Drive folder access. Configure once; every org consents to the same OAuth app.',
    configFields: [
      {
        key: 'client_id',
        label: 'OAuth client ID',
        type: 'text',
        placeholder: '123456789-xxxxxxxxxxxx.apps.googleusercontent.com',
        help: 'From your Google Cloud Console → APIs & Services → Credentials. Must end with .apps.googleusercontent.com.',
      },
      {
        key: 'redirect_uri',
        label: 'Redirect URI',
        type: 'url',
        placeholder: 'https://your-backend.run.app/api/drive/auth/callback',
        help: 'Must match a URI registered with your Google OAuth client. Use the backend host, not the frontend.',
      },
    ],
    secretField: {
      key: 'client_secret',
      label: 'OAuth client secret',
      help: 'Stored encrypted at rest with the master key (DRIVE_TOKEN_ENCRYPTION_KEY env var). Never displayed after save.',
    },
    clientValidate(config, secret, { needsSecret }) {
      const errors = {};
      const clientId = (config.client_id || '').trim();
      const redirectUri = (config.redirect_uri || '').trim();
      if (!clientId) {
        errors.client_id = 'Client ID is required.';
      } else if (!clientId.endsWith('.apps.googleusercontent.com')) {
        errors.client_id =
          'Client ID must be a Google OAuth client (ends with .apps.googleusercontent.com).';
      }
      if (!redirectUri) {
        errors.redirect_uri = 'Redirect URI is required.';
      } else {
        try {
          // eslint-disable-next-line no-new
          new URL(redirectUri);
          if (!redirectUri.startsWith('https://')) {
            errors.redirect_uri = 'Redirect URI must start with https://';
          }
        } catch {
          errors.redirect_uri = 'Redirect URI must be a valid URL.';
        }
      }
      if (needsSecret && !secret) {
        errors.client_secret = 'Client secret is required.';
      }
      return errors;
    },
  },

  // Gmail integration foundation. Shape is identical to Drive — same
  // Google OAuth client format, same https-only redirect rule, same
  // client_secret encryption at rest. Backend registry entry lives at
  // services/platformIntegrations.js INTEGRATIONS.gmail.
  //
  // The big operational difference vs Drive is verification:
  // gmail.readonly is a Google "restricted" scope and a production
  // rollout to a general audience requires CASA verification (Tier 2
  // minimum) before Google will let you off the "unverified app"
  // warning page. Help text below calls this out next to the client-id
  // field so the operator isn't surprised when their consent screen
  // looks scary in testing.
  gmail: {
    title: 'Gmail',
    description:
      'OAuth credentials for Gmail thread linkage. Read-only scope (gmail.readonly). Configure once; every org consents to the same OAuth app.',
    configFields: [
      {
        key: 'client_id',
        label: 'OAuth client ID',
        type: 'text',
        placeholder: '123456789-xxxxxxxxxxxx.apps.googleusercontent.com',
        help: 'From your Google Cloud Console → APIs & Services → Credentials. Must end with .apps.googleusercontent.com. The gmail.readonly scope is "restricted" — your project needs CASA verification (Tier 2 minimum, ~6–12 weeks / $4K–$15K through a Google-approved assessor) before a general rollout will clear Google\'s "unverified app" warning.',
      },
      {
        key: 'redirect_uri',
        label: 'Redirect URI',
        type: 'url',
        placeholder: 'https://your-backend.run.app/api/gmail/auth/callback',
        help: 'Must match a URI registered with your Google OAuth client. Use the backend host, not the frontend.',
      },
    ],
    secretField: {
      key: 'client_secret',
      label: 'OAuth client secret',
      help: 'Stored encrypted at rest with the master key (DRIVE_TOKEN_ENCRYPTION_KEY env var — same key as Drive, shared deliberately so rotation only happens once). Never displayed after save.',
    },
    clientValidate(config, secret, { needsSecret }) {
      const errors = {};
      const clientId = (config.client_id || '').trim();
      const redirectUri = (config.redirect_uri || '').trim();
      if (!clientId) {
        errors.client_id = 'Client ID is required.';
      } else if (!clientId.endsWith('.apps.googleusercontent.com')) {
        errors.client_id =
          'Client ID must be a Google OAuth client (ends with .apps.googleusercontent.com).';
      }
      if (!redirectUri) {
        errors.redirect_uri = 'Redirect URI is required.';
      } else {
        try {
          // eslint-disable-next-line no-new
          new URL(redirectUri);
          if (!redirectUri.startsWith('https://')) {
            errors.redirect_uri = 'Redirect URI must start with https://';
          }
        } catch {
          errors.redirect_uri = 'Redirect URI must be a valid URL.';
        }
      }
      if (needsSecret && !secret) {
        errors.client_secret = 'Client secret is required.';
      }
      return errors;
    },
  },

  // Microsoft 365 (Outlook mail + calendar). One Azure app registration —
  // NOT a Google OAuth client, so the validation diverges: client_id is the
  // Azure "Application (client) ID" GUID, and there's an optional tenant
  // field ('common' multi-tenant default, or a specific tenant GUID/domain).
  // ONE credential set powers BOTH outlook_mail_enabled and
  // outlook_calendar_enabled — the user consents once to Mail.Read +
  // Calendars.ReadWrite + offline_access. Backend registry entry:
  // services/platformIntegrations.js INTEGRATIONS.msgraph.
  //
  // Verification note (Microsoft's analogue of Google's OAuth review):
  // multi-tenant apps need Azure PUBLISHER VERIFICATION (MPN account) —
  // since late 2020, users in other tenants cannot consent to unverified
  // multi-tenant apps at all. Single-tenant deployments (set the tenant
  // field) skip that entirely.
  msgraph: {
    title: 'Microsoft 365 (Outlook)',
    description:
      'Azure app registration for the Outlook mail + calendar integration. One credential set covers both surfaces (Mail.Read + Calendars.ReadWrite + offline_access). Configure once; every org consents to the same app.',
    configFields: [
      {
        key: 'client_id',
        label: 'Application (client) ID',
        type: 'text',
        placeholder: '11111111-2222-3333-4444-555555555555',
        help: 'From Azure Portal → App registrations → your app → Overview. A GUID. Multi-tenant apps need publisher verification before users in other tenants can consent.',
      },
      {
        key: 'redirect_uri',
        label: 'Redirect URI',
        type: 'url',
        placeholder: 'https://your-backend.run.app/api/msgraph/auth/callback',
        help: 'Must match a Web redirect URI registered on the Azure app. Use the backend host, not the frontend.',
      },
      {
        key: 'tenant',
        label: 'Tenant (optional)',
        type: 'text',
        placeholder: 'common',
        help: 'Leave blank (or "common") for multi-tenant. Set a tenant GUID or domain (e.g. contoso.onmicrosoft.com) to lock consent to one directory — single-tenant deployments skip publisher verification.',
      },
    ],
    secretField: {
      key: 'client_secret',
      label: 'Client secret value',
      help: 'From Azure Portal → Certificates & secrets. Copy the secret VALUE (not the secret ID) — it is only shown once. Stored encrypted at rest with the master key (DRIVE_TOKEN_ENCRYPTION_KEY env var — same key as Drive, shared deliberately so rotation only happens once). Never displayed after save. Azure secrets expire (max 24 months) — diary the rotation.',
    },
    clientValidate(config, secret, { needsSecret }) {
      const errors = {};
      const clientId = (config.client_id || '').trim();
      const redirectUri = (config.redirect_uri || '').trim();
      const tenant = (config.tenant || '').trim();
      if (!clientId) {
        errors.client_id = 'Application (client) ID is required.';
      } else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
        errors.client_id = 'Must be an Azure Application (client) ID — a GUID.';
      }
      if (!redirectUri) {
        errors.redirect_uri = 'Redirect URI is required.';
      } else {
        try {
          // eslint-disable-next-line no-new
          new URL(redirectUri);
          if (!redirectUri.startsWith('https://')) {
            errors.redirect_uri = 'Redirect URI must start with https://';
          }
        } catch {
          errors.redirect_uri = 'Redirect URI must be a valid URL.';
        }
      }
      if (tenant && !/^[a-z0-9][a-z0-9.-]{0,120}$/i.test(tenant)) {
        errors.tenant = 'Tenant must be "common", a tenant GUID, or a verified domain.';
      }
      if (needsSecret && !secret) {
        errors.client_secret = 'Client secret is required.';
      }
      return errors;
    },
  },

  // Future integrations land here. Same shape; no other code changes.
  // stripe: { ... },
};

// Phase 1 shipped the Drive card, then Gmail; this PR adds Microsoft 365
// (Outlook). Add more slugs here as new integrations gain UI.
const VISIBLE_INTEGRATIONS = ['drive', 'gmail', 'msgraph'];

// ---------------------------------------------------------------------------
// Relative-time helper
// ---------------------------------------------------------------------------
//
// No existing codebase helper to reuse (grepped); implementing a tiny inline
// version. Falls back to a locale string for >30d to avoid implying false
// precision ("a month ago" reads weird for a 90-day-old credential).

function relativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - then.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return then.toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

// Three render states from the spec:
//   configured  → success
//   partial     → warning (config saved but no secret yet)
//   empty       → neutral (no row at all)
const STATE_BADGE = {
  configured: { tone: 'success', label: 'Configured' },
  partial:    { tone: 'warning', label: 'Missing secret' },
  empty:      { tone: 'neutral', label: 'Not configured' },
};

// ---------------------------------------------------------------------------
// IntegrationCard
// ---------------------------------------------------------------------------
//
// Drives all three render states off `{ configured, has_secret }` from the
// list/get response. State machine:
//
//   data === null                       → empty   (no row)
//   has_secret === false                → partial (config maybe present, no secret)
//   configured === true                 → configured (both present)
//
// Per the spec, "configured" requires both config and secret. We trust the
// server's flag and don't recompute it from the parts.

function IntegrationCard({ integration, data, onChanged }) {
  const def = INTEGRATIONS[integration];
  const state = !data ? 'empty' : data.has_secret ? 'configured' : 'partial';

  // Edit state — seeded from `data` whenever it (re-)arrives, so a re-fetch
  // after save flushes any optimistic edits with the canonical server copy.
  const initialConfig = useMemo(() => data?.config || {}, [data]);
  const [config, setConfig] = useState(initialConfig);
  // `secret` is local-only — we never echo the stored value back from the
  // server, so this stays empty unless the user types a new one.
  const [secret, setSecret] = useState('');
  // In `configured` state, secret field starts disabled. "Replace secret"
  // unlocks it so the user has to opt in to rotating.
  const [secretUnlocked, setSecretUnlocked] = useState(false);

  // Per-field validation errors (mostly client-side; 400s from server map
  // into these too where we can attribute them to a field).
  const [fieldErrors, setFieldErrors] = useState({});
  // Card-level error (server 4xx/5xx without a field attribution).
  const [bannerError, setBannerError] = useState('');
  // Card-level success flash after a successful save.
  const [bannerSuccess, setBannerSuccess] = useState('');

  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Re-seed editable fields when the parent supplies new data. Critical for
  // the post-save re-fetch — without this, the UI would still show the
  // user's pre-save inputs even after the canonical values changed.
  useEffect(() => {
    setConfig(initialConfig);
    setSecret('');
    setSecretUnlocked(false);
    setFieldErrors({});
  }, [initialConfig]);

  const updateConfigField = (key, value) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
    if (fieldErrors[key]) {
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  const handleSave = async () => {
    setBannerError('');
    setBannerSuccess('');

    // Decide whether the secret is required for THIS save:
    //   - empty/partial state (no secret on the server) → yes, required
    //   - configured state, user did NOT unlock → no, leave existing secret
    //   - configured state, user unlocked + typed → yes (rotation)
    //   - configured state, user unlocked + left blank → no (treat as
    //     "I changed my mind"; ship the config edits, keep the secret)
    const serverHasSecret = state === 'configured';
    const secretRequired = !serverHasSecret || (secretUnlocked && secret !== '');

    const errors = def.clientValidate(config, secret, {
      needsSecret: secretRequired,
    });
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setSaving(true);
    try {
      // Only send `secret` when we have a fresh one to write. Otherwise
      // omit the field so the backend leaves the existing encrypted value
      // untouched (spec §HTTP API contract for PUT).
      const payload = { config };
      if (secret) payload.secret = secret;
      await platformIntegrations.set(integration, payload);
      setBannerSuccess('Saved.');
      // Re-fetch so we re-render in the new state (e.g. partial → configured).
      await onChanged();
    } catch (err) {
      const status = err?.response?.status;
      const message =
        err?.response?.data?.error ||
        err?.response?.data?.message ||
        err?.message ||
        'Save failed.';
      if (status === 400) {
        // Try to attribute the message to a field by substring match;
        // otherwise surface it as a banner. This keeps a11y meaningful
        // even when the backend evolves new error strings.
        const lower = message.toLowerCase();
        const fieldKeys = [
          ...def.configFields.map((f) => f.key),
          def.secretField.key,
        ];
        const matched = fieldKeys.find((k) => lower.includes(k));
        if (matched) {
          setFieldErrors({ [matched]: message });
        } else {
          setBannerError(message);
        }
      } else if (status === 503) {
        setBannerError(
          `The master encryption key (DRIVE_TOKEN_ENCRYPTION_KEY) is not configured on the backend. ` +
            `Ask your operator to set it before saving secrets.`
        );
      } else {
        setBannerError(message);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setClearing(true);
    setBannerError('');
    setBannerSuccess('');
    try {
      await platformIntegrations.clear(integration);
      setConfirmOpen(false);
      await onChanged();
    } catch (err) {
      setBannerError(
        err?.response?.data?.error || err?.message || 'Clear failed.'
      );
    } finally {
      setClearing(false);
    }
  };

  // Auto-clear the "Saved." flash after a few seconds so it doesn't linger.
  useEffect(() => {
    if (!bannerSuccess) return undefined;
    const t = setTimeout(() => setBannerSuccess(''), 3000);
    return () => clearTimeout(t);
  }, [bannerSuccess]);

  // a11y / collision-safety: prefix every field id with the integration
  // slug so multiple cards on the page never share an id.
  const fieldId = (key) => `pi-${integration}-${key}`;

  // Secret input is locked-by-default only in `configured` state.
  const secretLocked = state === 'configured' && !secretUnlocked;
  const badge = STATE_BADGE[state];

  return (
    <Card
      aria-labelledby={`${integration}-card-title`}
      title={<span id={`${integration}-card-title`}>{def.title}</span>}
      subtitle={def.description}
      actions={<StatusBadge tone={badge.tone} label={badge.label} size="md" />}
    >
      <div className="space-y-4">
        {bannerError && <Alert tone="danger" onDismiss={() => setBannerError('')}>{bannerError}</Alert>}
        {bannerSuccess && <Alert tone="success">{bannerSuccess}</Alert>}

        {def.configFields.map((f) => (
          <Input
            key={f.key}
            id={fieldId(f.key)}
            name={f.key}
            label={f.label}
            type={f.type || 'text'}
            autoComplete="off"
            spellCheck={false}
            value={config[f.key] || ''}
            onChange={(e) => updateConfigField(f.key, e.target.value)}
            placeholder={f.placeholder}
            error={fieldErrors[f.key]}
            hint={f.help}
          />
        ))}

        {/* Secret field — always rendered, but disabled-by-default in the
            `configured` state until the user clicks "Replace secret". */}
        <div>
          <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
            <label
              htmlFor={fieldId(def.secretField.key)}
              className="block text-sm font-medium text-gray-700"
            >
              {def.secretField.label}
            </label>
            {state === 'configured' && !secretUnlocked && (
              <Button variant="ghost" size="sm" onClick={() => setSecretUnlocked(true)}>
                Replace secret
              </Button>
            )}
            {state === 'configured' && secretUnlocked && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSecretUnlocked(false);
                  setSecret('');
                  setFieldErrors((prev) => {
                    const next = { ...prev };
                    delete next[def.secretField.key];
                    return next;
                  });
                }}
              >
                Keep existing
              </Button>
            )}
          </div>
          <Input
            id={fieldId(def.secretField.key)}
            name={def.secretField.key}
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={secretLocked}
            value={secretLocked ? '••••••••••••••••••••••••••••••••' : secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={secretLocked ? '' : 'Paste the OAuth client secret'}
            error={fieldErrors[def.secretField.key]}
            hint={def.secretField.help}
          />
        </div>
      </div>

      {state === 'configured' && data?.updated_at && (
        <p className="mt-4 text-xs text-gray-500">
          Last updated: {relativeTime(data.updated_at)}
          {data.updated_by_user_email
            ? ` by ${data.updated_by_user_email}`
            : data.updated_by_user_id
            ? ` by user #${data.updated_by_user_id}`
            : ''}
        </p>
      )}

      <div className="mt-5 flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3">
        {state === 'configured' ? (
          <Button
            variant="secondary"
            className="text-danger-700 border-danger-200 hover:bg-danger-50"
            onClick={() => setConfirmOpen(true)}
            disabled={saving || clearing}
          >
            Clear all credentials
          </Button>
        ) : (
          <span />
        )}
        <Button onClick={handleSave} disabled={clearing} loading={saving} loadingLabel="Saving…">
          {`Save ${def.title} integration`}
        </Button>
      </div>

      <Modal
        open={confirmOpen}
        onClose={() => { if (!clearing) setConfirmOpen(false); }}
        title={`Clear ${def.title} credentials?`}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={clearing}>Cancel</Button>
            <Button variant="danger" onClick={handleClear} loading={clearing} loadingLabel="Clearing…">Clear credentials</Button>
          </>
        }
      >
        <p className="text-sm text-gray-700">
          {`This deletes the stored config and encrypted secret. Existing ` +
            `connected orgs will fail OAuth until you re-configure. ` +
            `You can paste them back in afterward — there's no undo.`}
        </p>
      </Modal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// EmailTransportCard — operator guidance for the env-configured email sender.
// ---------------------------------------------------------------------------
//
// The transport itself is env-var config (SENDGRID_API_KEY, or GMAIL_USER +
// GMAIL_APP_PASSWORD — see services/email.js), not a platform_integrations
// row, so this card is read-only status + guidance. Its whole reason to
// exist is the Gmail warning: Gmail app-password SMTP is a great way to get
// started, and a bad way to run customer-facing volume.

function EmailTransportCard({ emailTransport }) {
  if (!emailTransport) return null;
  const { transport } = emailTransport;

  const badge =
    transport === 'sendgrid' ? { tone: 'success', label: 'SendGrid' } :
    transport === 'gmail'    ? { tone: 'warning', label: 'Gmail SMTP' } :
                               { tone: 'neutral', label: 'Not configured' };

  return (
    <Card
      title="Email transport"
      subtitle="How outbound email (sequences, notifications, invites, portal mail) is sent. Configured via environment variables, not stored here."
      actions={<StatusBadge tone={badge.tone} label={badge.label} size="md" />}
    >
      {transport === 'gmail' && (
        <Alert tone="warning" title="Gmail is fine for getting started — plan the move to SendGrid.">
          <ul className="list-disc pl-5 mt-1 space-y-1">
            <li><strong>~500 sends/day account cap.</strong> Gmail suspends sending past it; the sequence worker pauses itself at 400/day (override with <code className="bg-gray-100 px-1 rounded">GMAIL_DAILY_SEND_CAP</code>) so drips degrade gracefully instead of bouncing.</li>
            <li><strong>Weaker deliverability at volume.</strong> Customer-facing mail from a personal Gmail lacks your own domain&apos;s SPF/DKIM alignment and lands in spam more often.</li>
            <li><strong>Account-suspension risk.</strong> Bulk-looking traffic can get the whole Google account flagged — which also takes out anything else using it.</li>
          </ul>
          <p className="mt-2">
            Recommended: set <code className="bg-gray-100 px-1 rounded">SENDGRID_API_KEY</code> with
            a verified domain sender (<code className="bg-gray-100 px-1 rounded">SMTP_FROM</code>).
            SendGrid takes precedence automatically the moment the key is present — no other change needed.
          </p>
        </Alert>
      )}
      {transport === 'sendgrid' && (
        <p className="text-sm text-gray-600">
          Sending via SendGrid — the recommended production transport. Keep the sender domain&apos;s
          SPF/DKIM records verified in SendGrid to protect deliverability.
        </p>
      )}
      {transport === 'console' && (
        <p className="text-sm text-gray-600">
          No email transport configured — outbound mail is logged to the console and sequence sends
          wait until a transport exists. Set <code className="bg-gray-100 px-1 rounded">SENDGRID_API_KEY</code> (recommended)
          or <code className="bg-gray-100 px-1 rounded">GMAIL_USER</code> + <code className="bg-gray-100 px-1 rounded">GMAIL_APP_PASSWORD</code> on the backend service.
        </p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AdminPlatformIntegrations() {
  const { user } = useAuth();

  // Super-admin gate. Spec explicitly requires both flags:
  //   user.is_admin === true && user.admin_role === 'super_admin'
  // Matches the role check in backend/routes/adminRoutes.js' isSuperAdmin
  // middleware that gates the corresponding REST endpoints — anyone who
  // gets past this gate will also pass the backend check.
  const isSuperAdmin =
    user?.is_admin === true && user?.admin_role === 'super_admin';

  const [integrations, setIntegrations] = useState([]);
  const [emailTransport, setEmailTransport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await platformIntegrations.list();
      // Tolerate { data: [...] } (the live backend shape), { integrations:
      // [...] } (the older documented shape), or a raw array.
      const list = Array.isArray(data) ? data : data?.data || data?.integrations || [];
      setIntegrations(list);
      // Env-configured email transport rides along on the list response —
      // 'sendgrid' | 'gmail' | 'console'; used for the Gmail-limits warning.
      setEmailTransport(data?.email_transport || null);
    } catch (err) {
      setError(
        err?.response?.data?.error ||
          err?.message ||
          'Failed to load integrations.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isSuperAdmin) load();
  }, [isSuperAdmin, load]);

  // Look up the canonical row for a given integration slug. Used by each
  // card to render its current state; `undefined` means "no row" (i.e. the
  // Empty state). After save, the card calls load() to refresh the list.
  const dataFor = (slug) =>
    integrations.find((row) => row.integration === slug) || null;

  if (!isSuperAdmin) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Nav active="admin" />
        <Container size="narrow">
          <Alert tone="danger" icon="lock" title={<h1 className="font-semibold">Access denied</h1>}>
            Platform integrations can only be managed by a super-admin.
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
          title="Platform integrations"
          subtitle={
            <>
              Configure platform-level OAuth credentials for the integrations
              this CRM ships with. Changes take effect within ~60 seconds — no
              redeploy needed. Secrets are stored encrypted at rest with the
              master key from the <code className="bg-gray-100 px-1 rounded">DRIVE_TOKEN_ENCRYPTION_KEY</code> env var.
            </>
          }
        />

        <div className="space-y-6">
          {loading ? (
            <Spinner size="lg" label="Loading integrations…" />
          ) : error ? (
            <Alert
              tone="danger"
              action={<Button size="sm" variant="secondary" onClick={load}>Retry</Button>}
            >
              {error}
            </Alert>
          ) : (
            <>
              <EmailTransportCard emailTransport={emailTransport} />
              {VISIBLE_INTEGRATIONS.map((slug) => (
                <IntegrationCard
                  key={slug}
                  integration={slug}
                  data={dataFor(slug)}
                  onChanged={load}
                />
              ))}
            </>
          )}
        </div>
      </Container>
    </div>
  );
}
