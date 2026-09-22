// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Settings page — consolidates the previously orphaned /your-rights flows
// and legal links into one tabbed surface. Tabs are deep-linkable via the
// URL hash (#profile, #privacy, #notifications, #legal). Default tab: profile.
//
// May 2026 update: the backend now supports PUT /api/me (name),
// POST /api/me/change-password, and PUT /api/me/notification-preferences,
// so Profile is editable, password change is wired up, and the
// Notifications tab is live.

import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import api from '../api';
import Nav from '../components/Nav';
import { useAuth } from '../AuthContext';
import DriveConnectCard from '../components/DriveConnectCard';
import CalendarConnectCard from '../components/CalendarConnectCard';
import OutlookConnectCard from '../components/OutlookConnectCard';
import LegalFooter from '../components/LegalFooter';
import { Alert, Button, Card, Container, Icon, Input, PageHeader, Skeleton, Tabs, Textarea } from '../components/ui';

const TABS = [
  { id: 'profile',       label: 'Profile'        },
  // Workspace is the org owner's self-service hub (modules, branding,
  // automations, templates, fields, plugins, import, reports, usage, team).
  // Only rendered for org owner/admin or platform admins — see visibleTabs().
  { id: 'workspace',     label: 'Workspace',     adminOnly: true },
  { id: 'billing',       label: 'Plan & Billing' },
  { id: 'privacy',       label: 'Privacy & Data' },
  { id: 'notifications', label: 'Notifications'  },
  { id: 'drive',         label: 'Drive'          },
  { id: 'calendar',      label: 'Calendar'       },
  { id: 'outlook',       label: 'Outlook'        },
  { id: 'developer',     label: 'Developer'      },
  { id: 'legal',         label: 'Legal'          },
];

// Read-only value block (login email, workspace, role) that sits in a form
// alongside editable Inputs and shares their frame.
function ReadOnlyField({ label, value, hint, className = '' }) {
  return (
    <div>
      <span className="block text-sm font-medium text-gray-700 mb-1">{label}</span>
      <div className={`px-3 py-2 min-h-[40px] bg-gray-50 border border-gray-200 rounded text-sm text-gray-900 ${className}`}>{value}</div>
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Profile tab — editable name + read-only email + change-password form
// ---------------------------------------------------------------------------

function NameCard({ user }) {
  const { refreshUser } = useAuth();
  const [name, setName] = useState(user?.name || '');
  // notification_email + notification_phone are nullable on the server. We
  // store them as plain strings here (empty string = cleared) and translate
  // back to null when calling PUT /me.
  const [notifEmail, setNotifEmail] = useState(user?.notification_email || '');
  const [notifPhone, setNotifPhone] = useState(user?.notification_phone || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  // Keep the local edit fields in sync if the user object changes from
  // elsewhere (other tab, refreshUser() after notification toggle, etc.).
  useEffect(() => { setName(user?.name || ''); }, [user?.name]);
  useEffect(() => { setNotifEmail(user?.notification_email || ''); }, [user?.notification_email]);
  useEffect(() => { setNotifPhone(user?.notification_phone || ''); }, [user?.notification_phone]);

  const dirtyName  = name.trim() !== (user?.name || '').trim();
  const dirtyEmail = notifEmail.trim() !== (user?.notification_email || '');
  const dirtyPhone = notifPhone.trim() !== (user?.notification_phone || '');
  const dirty = dirtyName || dirtyEmail || dirtyPhone;

  const save = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess(false);

    const trimmedName  = name.trim();
    const trimmedEmail = notifEmail.trim();
    const trimmedPhone = notifPhone.trim();

    if (!trimmedName) { setError('Name cannot be empty'); return; }
    if (trimmedName.length > 120) { setError('Name must be 120 characters or fewer'); return; }
    if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError('Notification email must be a valid email address');
      return;
    }
    if (trimmedEmail && trimmedEmail.length > 254) {
      setError('Notification email must be 254 characters or fewer');
      return;
    }
    if (trimmedPhone && !trimmedPhone.startsWith('+')) {
      setError('Phone number must be in E.164 format (start with + and country code)');
      return;
    }

    // Build the patch. Only include fields the user actually changed; that
    // keeps the audit log entry tidy and limits side-effects.
    const patch = {};
    if (dirtyName)  patch.name = trimmedName;
    if (dirtyEmail) patch.notification_email = trimmedEmail || null;
    if (dirtyPhone) patch.notification_phone = trimmedPhone || null;

    setBusy(true);
    try {
      await api.put('/me', patch);
      await refreshUser();
      setSuccess(true);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to update profile');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Account"
      subtitle="Update your display name and the email/phone we use for app notifications."
    >
      <p className="text-sm text-gray-600">
        To change your <em>login</em> email, contact{' '}
        <a className="text-brand-blue underline" href="mailto:johncolesassistant@gmail.com">
          johncolesassistant@gmail.com
        </a>{' '}— we don't yet have a self-service login-email change flow.
      </p>

      <form onSubmit={save} className="mt-4 space-y-4">
        <Input
          label="Name"
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          maxLength={120}
          disabled={busy}
        />
        <ReadOnlyField
          label="Login email"
          value={user?.email || '—'}
          hint="Contact support to change your login email."
        />

        <Input
          label="Notification email"
          type="email"
          value={notifEmail}
          onChange={e => setNotifEmail(e.target.value)}
          maxLength={254}
          disabled={busy}
          placeholder={user?.email ? `Same as login email (${user.email})` : 'Same as login email'}
          hint="Leave blank to send notifications to your login email."
        />

        <Input
          label="Phone number"
          type="tel"
          value={notifPhone}
          onChange={e => setNotifPhone(e.target.value)}
          maxLength={32}
          disabled={busy}
          placeholder="+1 555 555 0123"
          hint={<>E.164 format (starts with <code>+</code> and country code). Leave blank to disable SMS.</>}
        />

        {user?.org_name && <ReadOnlyField label="Workspace" value={user.org_name} />}
        {user?.org_role && <ReadOnlyField label="Role" value={user.org_role} className="capitalize" />}

        {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}
        {success && <Alert tone="success" onDismiss={() => setSuccess(false)}>Saved.</Alert>}

        <Button type="submit" disabled={!dirty} loading={busy} loadingLabel="Saving…">
          Save changes
        </Button>
      </form>
    </Card>
  );
}

function ChangePasswordCard() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess(false);

    if (!currentPassword || !newPassword || !confirmPassword) {
      setError('Please fill in all three fields.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }
    if (newPassword.length < 10) {
      // Mirror backend floor; server is the source of truth on full policy.
      setError('New password must be at least 10 characters.');
      return;
    }
    if (newPassword === currentPassword) {
      setError('New password must be different from current password.');
      return;
    }

    setBusy(true);
    try {
      await api.post('/me/change-password', { currentPassword, newPassword });
      setSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to change password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Change password"
      subtitle="Use a unique password you don't use anywhere else. Minimum 10 characters, with at least 3 of: lowercase, uppercase, digit, symbol."
    >
      <form onSubmit={submit} className="space-y-4">
        <Input
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={e => setCurrentPassword(e.target.value)}
          disabled={busy}
        />
        <Input
          label="New password"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={e => setNewPassword(e.target.value)}
          disabled={busy}
        />
        <Input
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={e => setConfirmPassword(e.target.value)}
          disabled={busy}
        />

        {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}
        {success && <Alert tone="success" onDismiss={() => setSuccess(false)}>Password updated.</Alert>}

        <Button type="submit" loading={busy} loadingLabel="Saving…">Change password</Button>
      </form>
    </Card>
  );
}

function ProfileTab({ user }) {
  return (
    <div className="space-y-6">
      <NameCard user={user} />
      <ChangePasswordCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Privacy & Data tab — lifted from the old YourRights.js
// ---------------------------------------------------------------------------

function ExportCard() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const downloadExport = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.get('/me/export?download=1', { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([r.data], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `theopencrm-export-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Export failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Export your data">
      <p className="text-sm text-gray-600">
        Download a machine-readable copy of every record tied to your account — companies, contacts,
        deals, activities, tasks, quotes, and your own audit log entries. JSON; open in any text
        editor or feed into another tool.
      </p>
      {error && <Alert tone="danger" className="mt-3" onDismiss={() => setError('')}>{error}</Alert>}
      <Button
        className="mt-4"
        icon="download"
        onClick={downloadExport}
        loading={busy}
        loadingLabel="Preparing your export…"
      >
        Download my data
      </Button>
    </Card>
  );
}

function DeletionCard() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const r = await api.get('/me/delete-account/status');
      setStatus(r.data.deletion);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const schedule = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post('/me/delete-account', { confirm: true, reason: reason || null });
      setShowConfirm(false);
      setReason('');
      await refresh();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to schedule deletion');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post('/me/delete-account/cancel');
      await refresh();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to cancel deletion');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return (
    <Card title="Delete your account" role="status" aria-label="Loading">
      <Skeleton lines={3} />
    </Card>
  );

  const isScheduled = status && status.status === 'scheduled';

  return (
    <Card title="Delete your account">
      <p className="text-sm text-gray-600">
        Schedule your account for deletion. We hold a 7-day grace period during which you can cancel.
        After the grace period your workspace data is removed and your account record is deleted
        within 90 days. Backup copies may persist for up to 30 days after deletion per our Privacy
        Policy.
      </p>

      {error && <Alert tone="danger" className="mt-3" onDismiss={() => setError('')}>{error}</Alert>}

      {isScheduled ? (
        <Alert
          tone="warning"
          title="Account deletion scheduled"
          className="mt-4"
          action={
            <Button variant="secondary" size="sm" onClick={cancel} loading={busy} loadingLabel="Cancelling…">
              Cancel deletion
            </Button>
          }
        >
          Scheduled for: {new Date(status.scheduled_at).toLocaleString()}
          {status.reason && <span className="block mt-1">Reason: <em>{status.reason}</em></span>}
        </Alert>
      ) : showConfirm ? (
        <div className="mt-4 border border-danger-200 rounded p-4 bg-danger-50">
          <p className="text-sm font-semibold text-danger-900">Are you sure?</p>
          <p className="text-xs text-danger-800 mt-1">
            Your account will be scheduled for deletion 7 days from now. You can cancel anytime
            during that window.
          </p>
          <Textarea
            label="Reason (optional, helps us improve)"
            wrapperClassName="mt-3"
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={2}
            placeholder="Optional"
          />
          <div className="mt-3 flex gap-2">
            <Button variant="danger" size="sm" onClick={schedule} loading={busy} loadingLabel="Scheduling…">
              Yes, schedule deletion
            </Button>
            <Button variant="secondary" size="sm" onClick={() => { setShowConfirm(false); setReason(''); }} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="secondary"
          className="mt-4 !text-danger-700 !border-danger-300 hover:!bg-danger-50"
          onClick={() => setShowConfirm(true)}
        >
          Schedule account deletion
        </Button>
      )}
    </Card>
  );
}

function OtherRightsCard() {
  return (
    <Card title="Other rights">
      <ul className="text-sm text-gray-700 space-y-2 list-disc pl-5">
        <li>
          <strong>Right to access:</strong> use the export above. The JSON includes every record
          tied to your account.
        </li>
        <li>
          <strong>Right to correct:</strong> most fields are user-editable in the app. For fields
          you can't edit (e.g., your email after sign-up), email{' '}
          <a className="text-brand-blue underline" href="mailto:johncolesassistant@gmail.com">
            johncolesassistant@gmail.com
          </a>.
        </li>
        <li>
          <strong>Right to opt-out of marketing:</strong> we currently send only transactional
          emails (password reset, access approval, security alerts). No marketing communications
          go out.
        </li>
        <li>
          <strong>Right to non-discrimination:</strong> exercising any right above will not affect
          your service or pricing.
        </li>
        <li>
          <strong>State-specific rights</strong> (California CCPA/CPRA + 22 other states with
          comprehensive privacy laws): you can also direct any request via email.
        </li>
      </ul>
    </Card>
  );
}

function PrivacyTab({ user }) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600">
        Signed in as <code>{user?.email}</code>. The actions below are immediate; we audit every
        request. See our <Link to="/privacy" className="text-brand-blue underline">Privacy Policy</Link>{' '}
        for the full text.
      </p>
      <ExportCard />
      <DeletionCard />
      <OtherRightsCard />
      <p className="text-xs text-gray-500">
        Questions or complaints? Email{' '}
        <a className="text-brand-blue underline" href="mailto:johncolesassistant@gmail.com">
          johncolesassistant@gmail.com
        </a>. You may also file a complaint with your state attorney general or applicable data
        protection authority.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notifications tab — per-category × per-channel matrix.
//
// Each row is a notification CATEGORY (task_assigned, task_overdue,
// deal_activity, weekly_summary). Each column is a CHANNEL (email, sms).
// Toggles are optimistic with rollback on error.
//
// Wire shape (matches migration 066 + PUT /api/me/notification-preferences):
//   { [category]: { email: bool, sms: bool } }
// ---------------------------------------------------------------------------

const NOTIFICATION_CATEGORIES = [
  {
    key:   'task_assigned',
    label: 'When a task is assigned to me',
    blurb: 'Notify me whenever a teammate (or automation) assigns me a task.',
    defaults: { email: true,  sms: false },
  },
  {
    key:   'task_overdue',
    label: 'When one of my tasks is overdue',
    blurb: 'Daily reminder once a task passes its due date.',
    defaults: { email: true,  sms: false },
  },
  {
    key:   'deal_activity',
    label: "When there's new activity on a deal I own",
    blurb: 'Comments, stage changes, and new linked activities.',
    defaults: { email: false, sms: false },
  },
  {
    key:   'weekly_summary',
    label: 'Weekly summary every Monday',
    blurb: "A digest of last week's wins, losses, and what's on deck.",
    defaults: { email: true,  sms: false },
  },
  // July-2026 module wave (migration 144). Wire channels are strictly opt-in
  // for these (higher volume / system-generated); the in-app bell always
  // records them regardless of these toggles.
  {
    key:   'case_assigned',
    label: 'When a support case is assigned to me',
    blurb: 'Notify me when a teammate makes me the owner of a case.',
    defaults: { email: false, sms: false },
  },
  {
    key:   'case_status_changed',
    label: 'When a case I own changes status',
    blurb: 'Open, pending, resolved, or closed transitions on my cases.',
    defaults: { email: false, sms: false },
  },
  {
    key:   'lead_captured',
    label: 'When a new lead is captured',
    blurb: 'A lead arrives via a web form (or capture surface) and lands with me.',
    defaults: { email: false, sms: false },
  },
  {
    key:   'lead_assigned',
    label: 'When a lead is assigned to me',
    blurb: 'A teammate (or round-robin) makes me a lead’s owner.',
    defaults: { email: false, sms: false },
  },
  {
    key:   'meeting_scheduled',
    label: 'When a meeting is scheduled on a record I own',
    blurb: 'Someone books a meeting linked to one of my deals or accounts.',
    defaults: { email: false, sms: false },
  },
  {
    key:   'sequence_completed',
    label: 'When a contact finishes one of my email sequences',
    blurb: 'They received every step — a good moment for a personal follow-up.',
    defaults: { email: false, sms: false },
  },
  {
    key:   'playbook_tasks_created',
    label: 'When a playbook creates tasks on my account',
    blurb: 'A lifecycle-stage playbook fired and spawned its checklist.',
    defaults: { email: false, sms: false },
  },
  {
    key:   'mention',
    label: 'When a teammate @mentions me in a comment',
    blurb: 'Someone tagged you in a comment on a deal, account, or case.',
    defaults: { email: false, sms: false },
  },
  {
    key:   'portal_case_submitted',
    label: 'When a customer files a support request via their portal',
    blurb: 'An external customer opened a case through a shared portal link.',
    defaults: { email: false, sms: false },
  },
  {
    key:   'portal_quote_response',
    label: 'When a customer responds to a quote via their portal',
    blurb: 'A customer approved or requested changes on a shared quote.',
    defaults: { email: false, sms: false },
  },
  {
    key:   'portal_message_received',
    label: 'When a customer writes in their portal thread',
    blurb: 'A customer sent a message through their shared portal link.',
    defaults: { email: false, sms: false },
  },
  {
    key:   'portal_document_uploaded',
    label: 'When a customer uploads a file via their portal',
    blurb: 'A customer sent a document through their shared portal link.',
    defaults: { email: false, sms: false },
  },
  // Platform guardrails (migration 174). Only super-admins ever receive
  // these; shown to everyone so the toggle is discoverable.
  {
    key:   'platform_budget',
    label: 'Platform AI budget and trial-slot alerts (super-admins)',
    blurb: 'When unbilled AI cost or live trial slots cross 50 / 80 / 100%. Comes with a one-click pause for new trials.',
    defaults: { email: false, sms: false },
  },
];

const NOTIFICATION_CHANNELS = ['email', 'sms'];

function Toggle({ checked, onChange, disabled, ariaLabel }) {
  // Track is h-8 w-14 (32x56) so the tap target meets the 32px mobile floor;
  // the inner thumb is h-6 w-6 (24x24) for a clear visual switch.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex h-8 w-14 flex-shrink-0 items-center rounded-full transition ${
        checked ? 'bg-brand-blue' : 'bg-gray-300'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span
        className={`inline-block h-6 w-6 transform rounded-full bg-white transition ${
          checked ? 'translate-x-7' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Email delivery (spec 204): instant / grouped every 15 min / one digest a
// day at an hour of your choosing. Wire shape lives under the same JSONB as
// the categories: { email_delivery: { mode, hour, tz } }. The browser's IANA
// timezone rides along with every save so "07:00" means the user's 07:00.
// ---------------------------------------------------------------------------

const DELIVERY_MODES = [
  { key: 'daily',   label: 'One email a day',        blurb: 'Everything that needs you — tasks due, next steps, quiet accounts, plus anything that happened — in one morning email with buttons that do the work.' },
  { key: 'batched', label: 'Grouped every 15 minutes', blurb: 'Alerts are held briefly and sent together, so a burst becomes one email.' },
  { key: 'instant', label: 'As it happens',          blurb: 'One email per alert, right away. Each still carries its one-click buttons.' },
];

function browserTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}

function fmtHour(h) {
  const d = new Date(2000, 0, 1, h, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric' });
}

function EmailDeliveryCard({ user, refreshUser }) {
  const stored = (user?.notification_preferences && user.notification_preferences.email_delivery) || {};
  const [mode, setMode] = useState(DELIVERY_MODES.some((m) => m.key === stored.mode) ? stored.mode : 'daily');
  const [hour, setHour] = useState(Number.isInteger(stored.hour) ? stored.hour : 7);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const tz = stored.tz || browserTimezone();

  useEffect(() => {
    const cur = (user?.notification_preferences && user.notification_preferences.email_delivery) || {};
    if (DELIVERY_MODES.some((m) => m.key === cur.mode)) setMode(cur.mode);
    if (Number.isInteger(cur.hour)) setHour(cur.hour);
  }, [user]);

  const save = async (patch) => {
    setSaving(true);
    setError('');
    setNote('');
    try {
      const body = { email_delivery: { ...patch } };
      const btz = browserTimezone();
      if (btz) body.email_delivery.tz = btz;
      await api.put('/me/notification-preferences', body);
      await refreshUser();
      setNote('Saved.');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const sendNow = async () => {
    setSending(true);
    setError('');
    setNote('');
    try {
      const r = await api.post('/me/notification-digest/send-now');
      const d = r.data || {};
      if (d.sent) setNote(`Sent "${d.subject}" to ${user?.notification_email || user?.email}. Check your inbox.`);
      else if (d.reason === 'empty') setNote('Nothing to send right now — no tasks due, next steps, quiet accounts, or new alerts. Nice.');
      else if (d.reason === 'no_address') setError('No email address on file.');
      else setNote('Nothing was sent.');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  return (
    <Card
      title="Email delivery"
      subtitle="How the alerts below reach your inbox. Every email carries one-click buttons (mark done, snooze, log a touch) that work without signing in."
    >
      <fieldset className="space-y-2" disabled={saving}>
        <legend className="sr-only">Email delivery mode</legend>
        {DELIVERY_MODES.map((m) => (
          <div key={m.key} className={`p-3 rounded-lg border ${mode === m.key ? 'border-brand-blue bg-brand-blue/5' : 'border-gray-200 hover:border-gray-300'}`}>
            <label className="flex gap-3 items-start cursor-pointer">
              <input
                type="radio"
                name="email_delivery_mode"
                value={m.key}
                checked={mode === m.key}
                onChange={() => { setMode(m.key); save({ mode: m.key, hour }); }}
                className="mt-1"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-gray-900">{m.label}</span>
                <span className="block text-xs text-gray-500 mt-0.5">{m.blurb}</span>
              </span>
            </label>
            {m.key === 'daily' && mode === 'daily' && (
              <div className="mt-2 ml-7 flex flex-wrap items-center gap-2 text-sm text-gray-700">
                <label htmlFor="digest-hour" className="text-xs text-gray-600">Send at</label>
                <select
                  id="digest-hour"
                  value={hour}
                  onChange={(e) => { const h = Number(e.target.value); setHour(h); save({ mode: 'daily', hour: h }); }}
                  className="border border-gray-300 rounded px-2 py-1 text-sm bg-white"
                >
                  {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{fmtHour(h)}</option>)}
                </select>
                {tz && <span className="text-xs text-gray-500">{tz}</span>}
              </div>
            )}
          </div>
        ))}
      </fieldset>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm" onClick={sendNow} disabled={sending || saving}>
          {sending ? 'Sending…' : "Send me today's digest now"}
        </Button>
        <span className="text-xs text-gray-500">Same email the daily schedule sends. Handy to see what it looks like.</span>
      </div>
      {note && <p className="text-sm text-green-700 mt-3" role="status">{note}</p>}
      {error && <Alert tone="danger" className="mt-3" onDismiss={() => setError('')}>{error}</Alert>}
    </Card>
  );
}

function NotificationsTab() {
  const { user, refreshUser } = useAuth();

  // useAuth().user.notification_preferences is the source of truth at mount.
  // Local state mirrors it so optimistic toggles feel instant; we re-sync
  // whenever the user object changes (e.g. after refreshUser()).
  const buildState = (u) => {
    const prefs = u?.notification_preferences || {};
    const out = {};
    for (const { key, defaults } of NOTIFICATION_CATEGORIES) {
      const cur = prefs[key] && typeof prefs[key] === 'object' ? prefs[key] : {};
      out[key] = {
        email: typeof cur.email === 'boolean' ? cur.email : defaults.email,
        sms:   typeof cur.sms   === 'boolean' ? cur.sms   : defaults.sms,
      };
    }
    return out;
  };

  const [prefs, setPrefs] = useState(() => buildState(user));
  // pendingCell is a "category:channel" string so we can disable just the one
  // toggle being saved (and not the rest of the grid).
  const [pendingCell, setPendingCell] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => { setPrefs(buildState(user)); }, [user]);

  const phoneSet = !!(user?.notification_phone);
  const effectiveEmail = user?.notification_email || user?.email;

  const setCell = async (category, channel, value) => {
    const previous = prefs[category]?.[channel];
    if (previous === value) return;
    setError('');
    // Optimistic flip
    setPrefs(p => ({ ...p, [category]: { ...p[category], [channel]: value } }));
    setPendingCell(`${category}:${channel}`);
    try {
      await api.put('/me/notification-preferences', { [category]: { [channel]: value } });
      // Pull the canonical user record so the AuthContext stays authoritative.
      await refreshUser();
    } catch (err) {
      // Roll back on error and surface the message.
      setPrefs(p => ({ ...p, [category]: { ...p[category], [channel]: previous } }));
      setError(err.response?.data?.error || err.message || 'Failed to update preference');
    } finally {
      setPendingCell(null);
    }
  };

  return (
    <div className="space-y-6">
      <EmailDeliveryCard user={user} refreshUser={refreshUser} />
      <Card
        title="Notification channels"
        subtitle="Choose how we reach you for each category. We only send transactional notifications — no marketing."
      >
        {/* Effective destinations panel — at a glance, where each channel goes. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
          <div className="bg-gray-50 border border-gray-200 rounded px-3 py-2">
            <div className="font-medium text-gray-700 inline-flex items-center gap-1.5"><Icon name="mail" size={14} className="text-gray-400" />Email goes to:</div>
            <div className="text-gray-900 mt-0.5 break-all">{effectiveEmail || '—'}</div>
          </div>
          <div className="bg-gray-50 border border-gray-200 rounded px-3 py-2">
            <div className="font-medium text-gray-700 inline-flex items-center gap-1.5"><Icon name="phone" size={14} className="text-gray-400" />SMS goes to:</div>
            <div className="text-gray-900 mt-0.5">
              {phoneSet ? (
                user.notification_phone
              ) : (
                <span className="text-gray-500 italic">Not set — add a number in Profile</span>
              )}
            </div>
          </div>
        </div>

        {error && <Alert tone="danger" className="mt-3" onDismiss={() => setError('')}>{error}</Alert>}

        {/* The 4×2 matrix. On narrow screens it stacks; on sm+ it's a tidy
            two-column toggle grid aligned under "Email" and "SMS" headers. */}
        <div className="mt-4 border-t border-gray-100">
          {/* Header row */}
          <div className="hidden sm:grid grid-cols-[1fr_5rem_5rem] gap-2 px-1 pt-3 pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">
            <div></div>
            <div className="text-center">Email</div>
            <div className="text-center">SMS</div>
          </div>
          <ul className="divide-y divide-gray-100">
            {NOTIFICATION_CATEGORIES.map(({ key, label, blurb }) => {
              const row = prefs[key] || { email: false, sms: false };
              const emailPending = pendingCell === `${key}:email`;
              const smsPending   = pendingCell === `${key}:sms`;
              const smsDisabled  = smsPending || !phoneSet;
              return (
                <li
                  key={key}
                  className="py-3 px-1 grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_5rem_5rem] gap-2 items-center"
                >
                  <div className="min-w-0 col-span-2 sm:col-span-1">
                    <div className="text-sm font-medium text-gray-900">{label}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{blurb}</div>
                  </div>
                  <div className="flex sm:block items-center sm:text-center gap-2">
                    <span className="sm:hidden text-xs font-semibold text-gray-500 uppercase">Email</span>
                    <div className="sm:flex sm:justify-center">
                      <Toggle
                        checked={!!row.email}
                        disabled={emailPending}
                        onChange={(v) => setCell(key, 'email', v)}
                        ariaLabel={`${label} — email`}
                      />
                    </div>
                  </div>
                  <div className="flex sm:block items-center sm:text-center gap-2">
                    <span className="sm:hidden text-xs font-semibold text-gray-500 uppercase">SMS</span>
                    <div className="sm:flex sm:flex-col sm:items-center">
                      <Toggle
                        checked={!!row.sms && phoneSet}
                        disabled={smsDisabled}
                        onChange={(v) => setCell(key, 'sms', v)}
                        ariaLabel={`${label} — SMS`}
                      />
                      {!phoneSet && (
                        <span className="hidden sm:block text-[10px] text-gray-400 mt-1 text-center leading-tight">
                          Set a phone in Profile
                        </span>
                      )}
                    </div>
                  </div>
                  {!phoneSet && (
                    <div className="sm:hidden col-span-2 text-[10px] text-gray-400 -mt-1">
                      Set a phone in Profile to enable SMS.
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legal tab — links out to the existing public legal pages
// ---------------------------------------------------------------------------

const LEGAL_LINKS = [
  {
    to:    '/privacy',
    label: 'Privacy Policy',
    blurb: 'What we collect, why we collect it, how long we keep it, and your rights.',
  },
  {
    to:    '/terms',
    label: 'Terms of Service',
    blurb: 'The agreement governing your use of The Open CRM, including the AS-IS disclaimer.',
  },
  {
    to:    '/legal/dpa',
    label: 'Data Processing Agreement',
    blurb: 'Template DPA for customers who need a signed processor agreement (GDPR Art. 28).',
  },
  {
    to:    '/legal/subprocessors',
    label: 'Subprocessors',
    blurb: 'The list of third parties that process customer data on our behalf.',
  },
];

function LegalTab() {
  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600">
        Our public legal documents. Each opens in the same tab — use the back button to return.
      </p>
      <ul className="space-y-2">
        {LEGAL_LINKS.map(({ to, label, blurb }) => (
          <li key={to}>
            <Link
              to={to}
              className="flex items-center justify-between gap-3 bg-white border border-gray-200 rounded shadow-card p-4 hover:border-brand-blue transition"
            >
              <div className="min-w-0">
                <div className="font-medium text-gray-900">{label}</div>
                <div className="text-sm text-gray-600 mt-0.5">{blurb}</div>
              </div>
              <Icon name="chevron-right" size={16} className="text-gray-400 flex-shrink-0" />
            </Link>
          </li>
        ))}
      </ul>
      <LegalFooter className="border-t border-gray-200" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drive tab — Google Drive opportunity-intel connection (see
// DRIVE_INTEL_SPEC.md). The card handles its own connect/disconnect /
// not-configured / not-connected / connected states + admin gating; the tab
// is just the lightweight shell.
// ---------------------------------------------------------------------------

function TabIntro({ title, children }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
      <p className="text-sm text-gray-600 mt-1">{children}</p>
    </div>
  );
}

function DriveTab({ user }) {
  return (
    <div className="space-y-6 max-w-2xl">
      <TabIntro title="Drive integration">
        Connect a Google Drive account so the CRM can summarize an opportunity
        from the files in a shared deal folder — contracts, meeting notes,
        requirements docs. Read-only; you choose the folder per deal.
      </TabIntro>
      <DriveConnectCard user={user} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calendar tab — Google Calendar integration (migration 115). The card handles
// its own connect/disconnect / not-configured / not-connected / connected
// states + admin gating + a "Sync now" trigger; the tab is the shell.
// ---------------------------------------------------------------------------

function CalendarTab({ user }) {
  return (
    <div className="space-y-6 max-w-2xl">
      <TabIntro title="Calendar integration">
        Connect a Google Calendar so meetings with your deal contacts show up
        on the deal and account timeline — and so you can schedule a meeting
        straight from a deal. Matched to deals by attendee email.
      </TabIntro>
      <CalendarConnectCard user={user} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Outlook tab — Microsoft 365 mail + calendar integration (migration 140).
// One connection powers both surfaces; the card handles its own connect/
// disconnect / not-configured / not-connected / connected states + admin
// gating + per-surface "Sync now" triggers; the tab is the shell.
// ---------------------------------------------------------------------------

function OutlookTab({ user }) {
  return (
    <div className="space-y-6 max-w-2xl">
      <TabIntro title="Outlook / Microsoft 365">
        Connect a Microsoft 365 account so Outlook email and meetings with
        your deal contacts land on the deal and account timeline. One
        connection covers both mail and calendar; matched to deals by
        participant email.
      </TabIntro>
      <OutlookConnectCard user={user} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace tab — the org owner's self-service hub. Every card links to a
// surface an owner/admin is authorized to use but that previously had no
// inbound link outside the platform-admin console.
// ---------------------------------------------------------------------------

const WORKSPACE_CARDS = [
  { to: '/setup',                 icon: 'sparkles',    title: 'Build from a description', blurb: 'Describe how you sell; get the pipeline, fields and follow-ups drafted for you to approve.' },
  { to: '/templates',             icon: 'copy',        title: 'Workspace templates', blurb: 'Save how your workspace is set up, reuse it, or start from one the community shared.' },
  { to: '/admin/feature-flags',   icon: 'settings',    title: 'Modules',         blurb: 'Turn parts of the CRM on or off. Start light; switch things on as you need them.' },
  { to: '/settings/pipeline',     icon: 'trending-up', title: 'Pipeline stages', blurb: 'Name and order the stages your deals move through.' },
  { to: '/admin/branding',        icon: 'star',        title: 'Branding',        blurb: 'Your name, logo, colour and the labels your team sees.' },
  { to: '/admin/customizations',  icon: 'edit',        title: 'Custom fields',   blurb: 'Add the fields your business actually tracks on companies, contacts, deals and tasks.' },
  { to: '/admin/automation',      icon: 'refresh',     title: 'Automations',     blurb: '"When this happens, do that" rules that run on their own.' },
  { to: '/admin/email-templates', icon: 'mail',        title: 'Email templates', blurb: 'Shared templates with merge fields for the whole team.' },
  { to: '/plugins',               icon: 'sparkles',    title: 'Plugins',         blurb: 'Build small tools for your workspace, or pick one from the library.', requiresFlag: 'plugins_enabled' },
  { to: '/import',                icon: 'upload',      title: 'Import data',     blurb: 'Bring in companies, contacts and deals from a CSV.' },
  { to: '/reports/builder',       icon: 'filter',      title: 'Report builder',  blurb: 'Build and save the reports you want to look at every week.' },
  { to: '/usage',                 icon: 'briefcase',   title: 'Usage & billing', blurb: 'See exactly what AI has cost this month and manage billing.' },
  { to: '/team',                  icon: 'users',       title: 'Team',            blurb: 'Invite people and set who is an owner, admin or member.' },
];

// Outbound email identity — the From: display name and Reply-To every
// customer-facing email (composer sends, sequence steps) goes out with.
// GET/PUT /api/org/email-identity (services/senderIdentity.js). The sending
// ADDRESS stays the platform's; only the name is yours — the preview shows
// exactly what lands in the recipient's inbox. Do this before real outreach.
function EmailIdentityCard() {
  const { user } = useAuth();
  const [state, setState] = useState(null);   // server payload
  const [form, setForm] = useState({ sender_name: '', reply_to: '' });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);       // { tone, text }

  useEffect(() => {
    let cancelled = false;
    api.get('/org/email-identity')
      .then((r) => {
        if (cancelled) return;
        setState(r.data);
        setForm({ sender_name: r.data?.sender_name || '', reply_to: r.data?.reply_to || '' });
      })
      .catch(() => { if (!cancelled) setState({ error: true }); });
    return () => { cancelled = true; };
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true); setMsg(null);
    try {
      const r = await api.put('/org/email-identity', {
        sender_name: form.sender_name.trim() || null,
        reply_to: form.reply_to.trim() || null,
      });
      setState(r.data);
      setForm({ sender_name: r.data?.sender_name || '', reply_to: r.data?.reply_to || '' });
      setMsg({ tone: 'success', text: 'Saved. New sends use this identity right away.' });
    } catch (err) {
      setMsg({ tone: 'danger', text: err.response?.data?.error || 'Could not save.' });
    } finally {
      setSaving(false);
    }
  };

  if (state?.error) return null; // personal workspace / older backend — nothing to configure
  const dirty = state && (form.sender_name !== (state.sender_name || '') || form.reply_to !== (state.reply_to || ''));

  return (
    <Card
      title={<span className="flex items-center gap-2"><Icon name="mail" size={16} className="text-gray-400" />Outbound email identity</span>}
    >
      {!state ? <Skeleton lines={3} /> : (
        <form onSubmit={save} className="space-y-3">
          <p className="text-sm text-gray-600">
            How your emails show up in a prospect's inbox — one-off sends and sequence steps alike.
            The sending address stays ours; the name and the Reply-To are yours, so replies come straight back to you.
            Every message also carries an unsubscribe link.
          </p>
          {msg && <Alert tone={msg.tone} onDismiss={() => setMsg(null)}>{msg.text}</Alert>}
          {state.email_configured === false && (
            <Alert tone="warning">Email isn't activated on this deployment yet, so nothing actually sends — but the identity is saved for when it is.</Alert>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="Sender name"
              value={form.sender_name}
              maxLength={120}
              placeholder={user?.name || 'e.g. John Coles'}
              hint="Shown as the From name. Leave blank to use your workspace name."
              onChange={(e) => setForm((f) => ({ ...f, sender_name: e.target.value }))}
            />
            <Input
              label="Reply-to address"
              type="email"
              value={form.reply_to}
              placeholder={user?.email || 'you@yourcompany.com'}
              hint="Where replies land. Leave blank to use each sender's own login email."
              onChange={(e) => setForm((f) => ({ ...f, reply_to: e.target.value }))}
            />
          </div>
          <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700">
            <div><span className="font-semibold text-gray-500">From:</span> <code className="break-all">{state.effective?.from}</code></div>
            <div className="mt-0.5"><span className="font-semibold text-gray-500">Reply-To:</span> <code className="break-all">{state.effective?.reply_to || '(each sender\'s login email)'}</code></div>
          </div>
          <div className="flex justify-end">
            <Button type="submit" loading={saving} loadingLabel="Saving…" disabled={!dirty}>Save identity</Button>
          </div>
        </form>
      )}
    </Card>
  );
}

function WorkspaceTab() {
  const { orgName, orgRole, isAdmin } = useAuth();
  // Plugins is default-off; only show the card once the module is on. We
  // read the org's effective modules (owner/admin may call this route).
  const [flags, setFlags] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api.get('/admin/feature-flags/flags')
      .then(r => {
        if (cancelled) return;
        const map = {};
        for (const f of (r.data?.data?.flags || [])) map[f.name] = !!f.currentValue;
        setFlags(map);
      })
      .catch(() => { if (!cancelled) setFlags({}); });
    return () => { cancelled = true; };
  }, []);

  const cards = WORKSPACE_CARDS.filter(c => !c.requiresFlag || (flags && flags[c.requiresFlag]));

  return (
    <div className="space-y-6">
      <TabIntro title={orgName || 'Your workspace'}>
        You are {orgRole === 'owner' ? 'the owner' : isAdmin ? 'a platform admin' : 'an admin'} of this workspace.
        Everything here is yours to change — no ticket, no vendor admin. Turn modules on and off,
        brand it, add fields, write automations, and build your own tools.
      </TabIntro>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {cards.map(c => (
          <Link
            key={c.to}
            to={c.to}
            className="block bg-white border border-gray-200 rounded shadow-card p-4 hover:border-brand-blue transition"
          >
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-info-50 text-brand-blue" aria-hidden="true">
                <Icon name={c.icon} size={18} />
              </span>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-gray-900 inline-flex items-center gap-1">
                  {c.title}
                  <Icon name="arrow-right" size={14} className="text-gray-400" />
                </div>
                <p className="text-xs text-gray-600 mt-0.5">{c.blurb}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>
      {flags && !flags.plugins_enabled && (
        <p className="text-xs text-gray-500">
          Want to build your own tools? Turn on <span className="font-medium">Plugins</span> under{' '}
          <Link to="/admin/feature-flags" className="underline">Modules</Link>.
        </p>
      )}
      <EmailIdentityCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan & Billing tab — the reachable plan picker (/settings#billing).
// Prices/quota rows mirror the Stripe config (services/stripe.js: Starter $15,
// Pro $39) and the tier caps (services/tierLimits.js + quotaEnforcer.js).
// Upgrade → POST /billing/checkout; Manage billing → POST /billing/portal.
// Degrades gracefully when Stripe isn't configured (503 STRIPE_NOT_CONFIGURED
// / configured:false → an explanatory notice instead of dead buttons).
// ---------------------------------------------------------------------------

const BILLING_PLANS = [
  {
    tier: 'free',
    name: 'Free',
    price: '$0',
    period: 'forever',
    features: [
      '1 seat',
      'Up to 100 contacts · 10 deals',
      '50 AI requests / user / month',
      'Community support',
    ],
  },
  {
    tier: 'starter',
    name: 'Starter',
    price: '$15',
    period: 'per seat / month',
    features: [
      'Up to 10 seats',
      'Unlimited contacts, companies & deals',
      '500 AI requests / user / month',
      'Email support',
    ],
  },
  {
    tier: 'pro',
    name: 'Professional',
    price: '$39',
    period: 'per seat / month',
    features: [
      'Up to 50 seats',
      'Unlimited contacts, companies & deals',
      '5,000 AI requests / user / month',
      'Priority support',
    ],
  },
];

// ---------------------------------------------------------------------------
// AI Gateway card (spec 202) — mint / list / revoke ocrm_gw_* keys that let a
// SELF-HOSTED Open CRM instance route its AI calls through the hosted metered
// proxy, billed to this workspace. Rendered only when AI pay-as-you-go is
// active/comped (minting 402s otherwise) and the viewer can manage billing.
// The plaintext key is shown exactly once after minting (copy-once pattern,
// mirroring Settings → Developer API keys).
// ---------------------------------------------------------------------------

function GatewayKeyCopyBox({ value }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked — the value is still selectable */ }
  };
  return (
    <Alert tone="warning" title="Your new gateway key" className="my-3">
      <div className="flex items-center gap-2 mt-1">
        <code className="flex-1 text-xs font-mono text-gray-900 break-all bg-white border border-warning-200 rounded px-2 py-1">
          {value}
        </code>
        <Button size="sm" variant="secondary" icon={copied ? 'check' : 'copy'} onClick={copy}>
          {copied ? 'Copied!' : 'Copy'}
        </Button>
      </div>
      <div className="text-[11px] mt-1">
        This key will not be shown again. On your self-hosted server set{' '}
        <code className="font-mono">OPENCRM_AI_GATEWAY_KEY</code> to this value (no other AI config needed).
      </div>
    </Alert>
  );
}

function GatewayKeysCard() {
  const [keys, setKeys] = useState(null);
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [freshKey, setFreshKey] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const r = await api.get('/billing/ai/gateway-keys');
      setKeys(r.data.keys || []);
    } catch (e) {
      setKeys([]);
      setError(e.response?.data?.error || 'Failed to load gateway keys');
    }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async (e) => {
    e.preventDefault();
    if (!label.trim()) return;
    setCreating(true); setError(''); setFreshKey(null);
    try {
      const r = await api.post('/billing/ai/gateway-keys', { label: label.trim() });
      setFreshKey(r.data.key);
      setLabel('');
      await load();
    } catch (e2) {
      setError(e2.response?.data?.error || 'Failed to create gateway key');
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id) => {
    if (!window.confirm('Revoke this gateway key? The self-hosted instance using it will lose AI access within seconds.')) return;
    setError('');
    try {
      await api.delete(`/billing/ai/gateway-keys/${id}`);
      await load();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to revoke gateway key');
    }
  };

  return (
    <Card
      title="AI Gateway"
      subtitle="Point a self-hosted Open CRM at our metered AI — usage bills to this workspace."
    >
      <form onSubmit={create} className="flex items-end gap-2 mb-3">
        <Input
          label="Key label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. office self-host"
          wrapperClassName="flex-1"
        />
        <Button type="submit" icon="plus" disabled={!label.trim()} loading={creating} loadingLabel="Minting…">
          Mint key
        </Button>
      </form>

      {freshKey && <GatewayKeyCopyBox value={freshKey} />}
      {error && <Alert tone="danger" className="mb-3" onDismiss={() => setError('')}>{error}</Alert>}

      {keys === null ? (
        <Skeleton lines={2} />
      ) : keys.length === 0 ? (
        <p className="text-xs text-gray-500">
          No gateway keys yet. Mint one and set it as <code className="font-mono">OPENCRM_AI_GATEWAY_KEY</code> on
          your self-hosted server — its AI calls will be metered here at the same pay-as-you-go rate,
          under the same monthly cap.
        </p>
      ) : (
        <ul className="divide-y divide-gray-100 text-sm">
          {keys.map(k => (
            <li key={k.id} className="py-2 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-900 truncate">{k.label}</div>
                <div className="text-xs text-gray-500 font-mono">{k.key_prefix}…</div>
              </div>
              <div className="text-xs text-gray-500 text-right">
                <div>{k.status === 'revoked' ? 'Revoked' : (k.last_used_at ? `Last used ${new Date(k.last_used_at).toLocaleDateString()}` : 'Never used')}</div>
                <div>{Number(k.requests_count || 0).toLocaleString()} requests</div>
              </div>
              {k.status !== 'revoked' && (
                <Button size="sm" variant="secondary" onClick={() => revoke(k.id)}>Revoke</Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function BillingTab() {
  const auth = useAuth();
  const canManage = isWorkspaceAdmin(auth);
  const [status, setStatus] = useState(null); // { configured, tier, hasStripeCustomer }
  const [aiStatus, setAiStatus] = useState(null); // { status: 'active'|'comped'|... } from /billing/ai/status
  const [busy, setBusy] = useState('');       // tier being checked out, or 'portal'
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.get('/billing/status')
      .then(r => { if (!cancelled) setStatus(r.data); })
      .catch(() => { if (!cancelled) setStatus({ configured: false, tier: 'free' }); });
    api.get('/billing/ai/status')
      .then(r => { if (!cancelled) setAiStatus(r.data); })
      .catch(() => { if (!cancelled) setAiStatus(null); });
    return () => { cancelled = true; };
  }, []);

  const stripeReady = !!status?.configured;
  const currentTier = status?.tier || 'free';

  const startCheckout = async (tier) => {
    setError(''); setNotice(''); setBusy(tier);
    try {
      const r = await api.post('/billing/checkout', { tier });
      if (r.data?.url) { window.location.assign(r.data.url); return; }
      setError('Could not start checkout. Try again.');
    } catch (e) {
      const code = e.response?.data?.code;
      if (code === 'STRIPE_NOT_CONFIGURED') {
        setNotice('Billing is not enabled on this deployment yet. Contact your operator to upgrade.');
      } else if (e.response?.status === 403) {
        setNotice('Only a workspace owner or admin can change the plan. Ask them to upgrade.');
      } else {
        setError(e.response?.data?.error || 'Could not start checkout.');
      }
    } finally {
      setBusy('');
    }
  };

  const openPortal = async () => {
    setError(''); setNotice(''); setBusy('portal');
    try {
      const r = await api.post('/billing/portal');
      if (r.data?.url) { window.location.assign(r.data.url); return; }
      setError('Could not open the billing portal.');
    } catch (e) {
      const code = e.response?.data?.code;
      if (code === 'STRIPE_NOT_CONFIGURED') {
        setNotice('Billing is not enabled on this deployment yet.');
      } else if (code === 'NO_STRIPE_CUSTOMER') {
        setNotice('No billing account yet — complete an upgrade first.');
      } else if (e.response?.status === 403) {
        setNotice('Only a workspace owner or admin can manage billing.');
      } else {
        setError(e.response?.data?.error || 'Could not open the billing portal.');
      }
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="space-y-6">
      <TabIntro title="Plan & Billing">
        Your workspace is on the <span className="font-semibold capitalize">{currentTier}</span> plan.
        Upgrade to lift seat, record and AI limits — AI usage is billed pay-as-you-go on top,
        or bring your own Anthropic key. Self-hosting is always free (AGPL-3.0).
      </TabIntro>

      {error && <Alert tone="danger" onDismiss={() => setError('')}>{error}</Alert>}
      {notice && <Alert tone="info" onDismiss={() => setNotice('')}>{notice}</Alert>}
      {status && !stripeReady && (
        <Alert tone="info">
          Online billing is not enabled on this deployment. Plans are shown for reference —
          contact your operator to change tiers.
        </Alert>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {BILLING_PLANS.map(plan => {
          const isCurrent = plan.tier === currentTier;
          return (
            <div
              key={plan.tier}
              className={`bg-white border rounded shadow-card p-4 flex flex-col ${isCurrent ? 'border-brand-blue ring-1 ring-brand-blue' : 'border-gray-200'}`}
            >
              <div className="flex items-baseline justify-between">
                <h3 className="text-sm font-semibold text-gray-900">{plan.name}</h3>
                {isCurrent && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-brand-blue">Current</span>
                )}
              </div>
              <div className="mt-1">
                <span className="text-2xl font-bold text-gray-900">{plan.price}</span>
                <span className="ml-1 text-xs text-gray-500">{plan.period}</span>
              </div>
              <ul className="mt-3 space-y-1.5 text-xs text-gray-600 flex-1">
                {plan.features.map(f => (
                  <li key={f} className="flex items-start gap-1.5">
                    <Icon name="check" size={14} className="text-brand-blue flex-shrink-0 mt-0.5" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              {plan.tier !== 'free' && !isCurrent && (
                <Button
                  className="mt-4"
                  size="sm"
                  disabled={!stripeReady || !canManage || !!busy}
                  loading={busy === plan.tier}
                  onClick={() => startCheckout(plan.tier)}
                >
                  Upgrade to {plan.name}
                </Button>
              )}
              {isCurrent && plan.tier !== 'free' && (
                <p className="mt-4 text-xs text-gray-500">This is your current plan.</p>
              )}
            </div>
          );
        })}
      </div>

      {canManage && (aiStatus?.status === 'active' || aiStatus?.status === 'comped') && (
        <GatewayKeysCard />
      )}

      {canManage ? (
        <Card
          title="Manage billing"
          subtitle="Change plan, update your card, or download invoices in the Stripe customer portal."
        >
          <Button
            variant="secondary"
            disabled={!stripeReady || !!busy}
            loading={busy === 'portal'}
            onClick={openPortal}
            iconRight="arrow-right"
          >
            Open billing portal
          </Button>
        </Card>
      ) : (
        <p className="text-xs text-gray-500">
          Only a workspace owner or admin can change the plan or manage billing.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page shell with tab navigation
// ---------------------------------------------------------------------------

function isWorkspaceAdmin(auth) {
  return !!auth?.isAdmin || auth?.orgRole === 'owner' || auth?.orgRole === 'admin';
}

function visibleTabs(auth) {
  return TABS.filter(t => !t.adminOnly || isWorkspaceAdmin(auth));
}

function tabFromHash(hash, tabs) {
  const id = (hash || '').replace(/^#/, '');
  return tabs.find(t => t.id === id)?.id || 'profile';
}

export default function Settings() {
  const auth = useAuth();
  const { user } = auth;
  const tabs = visibleTabs(auth);
  const location = useLocation();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState(() => tabFromHash(location.hash, tabs));

  // Keep the tab in sync with the URL hash so deep links (and back/forward)
  // work. We use replace: true on tab clicks so the history isn't polluted
  // with one entry per tab click.
  useEffect(() => {
    const next = tabFromHash(location.hash, tabs);
    if (next !== activeTab) setActiveTab(next);
  }, [location.hash, tabs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectTab = (id) => {
    setActiveTab(id);
    navigate(`/settings#${id}`, { replace: true });
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="settings" />
      <Container>
        <PageHeader
          title="Settings"
          subtitle="Manage your account, your data, and review our legal documents."
          className="mb-4"
        />

        <Tabs
          items={tabs.map(t => ({ id: t.id, label: t.label }))}
          value={activeTab}
          onChange={selectTab}
          aria-label="Settings sections"
          className="mb-6"
        />

        {/* Tab content */}
        <section className="min-w-0">
          {activeTab === 'profile'       && <ProfileTab user={user} />}
          {activeTab === 'workspace'     && isWorkspaceAdmin(auth) && <WorkspaceTab />}
          {activeTab === 'billing'       && <BillingTab />}
          {activeTab === 'privacy'       && <PrivacyTab user={user} />}
          {activeTab === 'notifications' && <NotificationsTab />}
          {activeTab === 'drive'         && <DriveTab user={user} />}
          {activeTab === 'calendar'      && <CalendarTab user={user} />}
          {activeTab === 'outlook'       && <OutlookTab user={user} />}
          {activeTab === 'developer'     && (
            <Card
              title="Developer platform"
              subtitle="Create API keys to call the CRM from your own scripts and integrations, and register outbound webhooks to receive events (deal created, stage changed)."
            >
              <Button as={Link} to="/settings/developer" iconRight="arrow-right">
                Manage API keys &amp; webhooks
              </Button>
            </Card>
          )}
          {activeTab === 'legal'         && <LegalTab />}
        </section>
      </Container>
    </div>
  );
}
