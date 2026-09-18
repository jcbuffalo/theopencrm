// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// OutlookConnectCard — Microsoft 365 (Outlook mail + calendar) connection
// status + connect/disconnect.
//
// Dropped into the Settings page on the "Outlook" tab. Self-contained: probes
// its own state on mount via api.msgraph.getConnection(), and renders one of
// four states (mirrors CalendarConnectCard / GmailConnectCard exactly):
//
//   1. Loading        — initial probe in flight
//   2. Not configured — backend returned 503 (Microsoft app registration
//                       unset) or 403 (neither outlook flag enabled).
//   3. Not connected  — backend returned { connected: false }.
//                       Admin/owner: "Connect Microsoft 365" button.
//                       Non-admin: "Not connected — ask an admin".
//   4. Connected      — shows email + status + "Sync mail" / "Sync calendar"
//                       buttons. Admin/owner also gets "Disconnect" with
//                       inline confirmation.
//
// Only org owners and admins may connect or disconnect. Backend re-checks;
// this is purely a UX guard so non-admins don't see buttons that 403.
//
// SCOPE DISCLOSURE COPY (load-bearing): the banner spells out that we read
// mail (Mail.Read) and read+create calendar events (Calendars.ReadWrite) on
// the connected account. Keep it aligned with the Microsoft consent screen
// and the Azure app registration.

import React, { useCallback, useEffect, useState } from 'react';
import { msgraph } from '../api';
import { useAuth } from '../AuthContext';
import { Alert, Button, Card, Spinner, StatusBadge } from './ui';

const ADMIN_ROLES = new Set(['admin', 'owner']);

export default function OutlookConnectCard() {
  const { user } = useAuth();
  const isAdmin = ADMIN_ROLES.has(user?.org_role) || !!user?.is_admin;

  const [loading, setLoading] = useState(true);
  const [notConfigured, setNotConfigured] = useState(false);
  const [notEnabled, setNotEnabled] = useState(false);
  const [conn, setConn] = useState(null);
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [syncing, setSyncing] = useState('');   // '' | 'mail' | 'calendar'
  const [syncMsg, setSyncMsg] = useState('');

  const probe = useCallback(async () => {
    setError('');
    try {
      const data = await msgraph.getConnection();
      setNotConfigured(false);
      setNotEnabled(false);
      setConn(data || { connected: false });
    } catch (err) {
      const status = err?.response?.status;
      const code = err?.response?.data?.code || '';
      const msg = err?.response?.data?.error || '';
      if (status === 503 && /not configured/i.test(msg)) {
        setNotConfigured(true);
        setConn(null);
      } else if (status === 403 && code === 'FEATURE_DISABLED') {
        setNotEnabled(true);
        setConn(null);
      } else {
        setError(msg || 'Failed to load Microsoft 365 connection status.');
        setConn(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { probe(); }, [probe]);

  // Re-probe when the tab regains focus — the user has just come back from
  // the Microsoft consent popup and the connection state likely changed.
  useEffect(() => {
    if (!connecting) return undefined;
    const onFocus = () => { probe(); setConnecting(false); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [connecting, probe]);

  const handleConnect = async () => {
    setError('');
    try {
      const { authUrl } = await msgraph.startAuth();
      if (!authUrl) { setError('Backend did not return an OAuth URL.'); return; }
      setConnecting(true);
      const popup = window.open(authUrl, '_blank', 'noopener');
      if (!popup) window.location.href = authUrl;
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not start Microsoft 365 authorization.');
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setError('');
    setDisconnecting(true);
    try {
      await msgraph.disconnect();
      setConfirmDisconnect(false);
      await probe();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to disconnect Microsoft 365.');
    } finally {
      setDisconnecting(false);
    }
  };

  const handleSync = async (surface) => {
    setError('');
    setSyncMsg('');
    setSyncing(surface);
    try {
      const r = surface === 'mail' ? await msgraph.syncMail() : await msgraph.syncCalendar();
      if (r?.connected === false) {
        setSyncMsg('No active connection to sync.');
      } else if (surface === 'mail') {
        setSyncMsg(`Mail synced — ${r?.messages_matched ?? 0} message(s) matched to deals.`);
      } else {
        setSyncMsg(`Calendar synced — ${r?.events_matched ?? 0} meeting(s) matched to deals.`);
      }
      await probe();
    } catch (err) {
      const code = err?.response?.data?.code;
      if (code === 'FEATURE_DISABLED') {
        setSyncMsg('');
        setError(`The Outlook ${surface} module is not enabled for this organization.`);
      } else {
        setError(err?.response?.data?.error || 'Sync failed.');
      }
    } finally {
      setSyncing('');
    }
  };

  if (loading) {
    return (
      <Card>
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Spinner size="sm" />
          <span>Loading Microsoft 365 connection…</span>
        </div>
      </Card>
    );
  }

  if (notConfigured || notEnabled) {
    return (
      <Card title="Microsoft 365 (Outlook)">
        <Alert
          tone="warning"
          icon="lock"
          title={notEnabled
            ? 'The Outlook integration is not enabled for this organization.'
            : 'Microsoft 365 integration is not enabled for this deployment.'}
        >
          <p className="text-xs">
            Operator: configure the Azure app registration under{' '}
            <code>Microsoft 365 (Outlook)</code> at{' '}
            <code>/admin/platform-integrations</code>, then enable the{' '}
            <code>outlook_mail_enabled</code> and/or{' '}
            <code>outlook_calendar_enabled</code> feature flags for this org.
          </p>
        </Alert>
      </Card>
    );
  }

  const isConnected = !!conn?.connected;

  return (
    <Card
      title="Microsoft 365 (Outlook)"
      actions={isConnected
        ? <StatusBadge tone={conn.status && conn.status !== 'active' ? 'warning' : 'success'} label={conn.status && conn.status !== 'active' ? conn.status : 'Connected'} className="capitalize" />
        : <StatusBadge tone="neutral" label="Not connected" />}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {isConnected ? (
            <p className="text-sm text-gray-700 break-words">
              Connected as{' '}
              <span className="font-medium text-gray-900">{conn.email || 'unknown account'}</span>
            </p>
          ) : (
            <p className="text-sm text-gray-700">
              Not connected.{' '}
              {isAdmin
                ? 'Authorize a Microsoft 365 account to sync Outlook mail and meetings to your deals.'
                : 'Ask an admin to connect a Microsoft 365 account.'}
            </p>
          )}
          {/* Scope disclosure — load-bearing copy. Matches the Mail.Read +
              Calendars.ReadWrite consent the user grants in Microsoft's
              dialog. Don't soften. */}
          <p className="mt-2 text-xs text-gray-600">
            Reads mail and reads/creates calendar events on the connected
            Microsoft 365 account. Messages and meetings with a deal contact
            as a participant are matched to that deal's timeline.
          </p>
          {isConnected ? (
            <p className="mt-1 text-xs text-gray-500">
              To fully revoke access after disconnecting, remove this app at{' '}
              <a href="https://myaccount.microsoft.com/" target="_blank" rel="noreferrer" className="underline">
                myaccount.microsoft.com
              </a>.
            </p>
          ) : null}
          {conn?.last_error ? (
            <p className="mt-2 text-xs text-warning-700 break-words">Last error: {conn.last_error}</p>
          ) : null}
          {syncMsg ? <p className="mt-2 text-xs text-success-700" role="status">{syncMsg}</p> : null}
        </div>

        {isAdmin ? (
          <div className="flex flex-shrink-0 flex-col gap-2 sm:items-end">
            {isConnected ? (
              confirmDisconnect ? (
                <div className="flex flex-col gap-2 sm:items-end">
                  <p className="text-xs text-gray-700">Disconnect Microsoft 365? Mail and meetings will stop syncing.</p>
                  <div className="flex gap-2">
                    <Button variant="secondary" onClick={() => setConfirmDisconnect(false)} disabled={disconnecting}>
                      Cancel
                    </Button>
                    <Button variant="danger" onClick={handleDisconnect} loading={disconnecting} loadingLabel="Disconnecting…">
                      Disconnect
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    icon="mail"
                    onClick={() => handleSync('mail')}
                    disabled={!!syncing && syncing !== 'mail'}
                    loading={syncing === 'mail'}
                    loadingLabel="Syncing…"
                  >
                    Sync mail
                  </Button>
                  <Button
                    variant="secondary"
                    icon="calendar"
                    onClick={() => handleSync('calendar')}
                    disabled={!!syncing && syncing !== 'calendar'}
                    loading={syncing === 'calendar'}
                    loadingLabel="Syncing…"
                  >
                    Sync calendar
                  </Button>
                  <Button variant="secondary" onClick={() => setConfirmDisconnect(true)}>
                    Disconnect
                  </Button>
                </div>
              )
            ) : (
              <Button icon="external" onClick={handleConnect} loading={connecting} loadingLabel="Opening Microsoft…">
                Connect Microsoft 365
              </Button>
            )}
          </div>
        ) : null}
      </div>

      {error ? (
        <Alert
          tone="danger"
          className="mt-3"
          action={<Button size="sm" variant="ghost" onClick={probe}>Retry</Button>}
        >
          {error}
        </Alert>
      ) : null}
    </Card>
  );
}
