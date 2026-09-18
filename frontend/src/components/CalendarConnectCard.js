// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// CalendarConnectCard — Google Calendar connection status + connect/disconnect.
//
// Dropped into the Settings page on the "Calendar" tab. Self-contained: probes
// its own state on mount via api.calendar.getConnection(), and renders one of
// four states (mirrors GmailConnectCard exactly):
//
//   1. Loading        — initial probe in flight
//   2. Not configured — backend returned 503 (Calendar OAuth client unset).
//   3. Not connected  — backend returned { connected: false }.
//                       Admin/owner: "Connect Google Calendar" button.
//                       Non-admin: "Not connected — ask an admin".
//   4. Connected      — shows email + status + a "Sync now" button. Admin/owner
//                       also gets "Disconnect" with inline confirmation.
//
// Only org owners and admins may connect or disconnect. Backend re-checks; this
// is purely a UX guard so non-admins don't see buttons that 403.
//
// SCOPE DISCLOSURE COPY (load-bearing): the banner spells out that we create +
// read events on the connected calendar (calendar.events). Keep it aligned with
// the Google consent screen and the OAuth verification submission.

import React, { useCallback, useEffect, useState } from 'react';
import { calendar } from '../api';
import { useAuth } from '../AuthContext';
import { Alert, Button, Card, Spinner, StatusBadge } from './ui';

const ADMIN_ROLES = new Set(['admin', 'owner']);

export default function CalendarConnectCard() {
  const { user } = useAuth();
  const isAdmin = ADMIN_ROLES.has(user?.org_role) || !!user?.is_admin;

  const [loading, setLoading] = useState(true);
  const [notConfigured, setNotConfigured] = useState(false);
  const [conn, setConn] = useState(null);
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  const probe = useCallback(async () => {
    setError('');
    try {
      const data = await calendar.getConnection();
      setNotConfigured(false);
      setConn(data || { connected: false });
    } catch (err) {
      const status = err?.response?.status;
      const code = err?.response?.data?.error || '';
      if (status === 503 && /not configured|not enabled/i.test(code)) {
        setNotConfigured(true);
        setConn(null);
      } else {
        setError(err?.response?.data?.error || 'Failed to load Calendar connection status.');
        setConn(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { probe(); }, [probe]);

  // Re-probe when the tab regains focus — the user has just come back from the
  // Google consent popup and the connection state likely changed.
  useEffect(() => {
    if (!connecting) return undefined;
    const onFocus = () => { probe(); setConnecting(false); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [connecting, probe]);

  const handleConnect = async () => {
    setError('');
    try {
      const { authUrl } = await calendar.startAuth();
      if (!authUrl) { setError('Backend did not return an OAuth URL.'); return; }
      setConnecting(true);
      const popup = window.open(authUrl, '_blank', 'noopener');
      if (!popup) window.location.href = authUrl;
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not start Calendar authorization.');
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setError('');
    setDisconnecting(true);
    try {
      await calendar.disconnect();
      setConfirmDisconnect(false);
      await probe();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to disconnect Calendar.');
    } finally {
      setDisconnecting(false);
    }
  };

  const handleSync = async () => {
    setError('');
    setSyncMsg('');
    setSyncing(true);
    try {
      const r = await calendar.sync();
      if (r?.connected === false) {
        setSyncMsg('No active connection to sync.');
      } else {
        setSyncMsg(`Synced — ${r?.events_matched ?? 0} meeting(s) matched to deals.`);
      }
      await probe();
    } catch (err) {
      setError(err?.response?.data?.error || 'Sync failed.');
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Spinner size="sm" />
          <span>Loading Calendar connection…</span>
        </div>
      </Card>
    );
  }

  if (notConfigured) {
    return (
      <Card title="Calendar Integration">
        <Alert tone="warning" icon="lock" title="Google Calendar integration is not enabled for this deployment.">
          <p className="text-xs">
            Operator: configure the Calendar OAuth client at{' '}
            <code>/admin/platform-integrations</code> (or set{' '}
            <code>GOOGLE_CALENDAR_CLIENT_ID</code> /{' '}
            <code>GOOGLE_CALENDAR_CLIENT_SECRET</code> /{' '}
            <code>GOOGLE_CALENDAR_REDIRECT_URI</code> env vars), then enable the{' '}
            <code>calendar_enabled</code> feature flag for this org.
          </p>
        </Alert>
      </Card>
    );
  }

  const isConnected = !!conn?.connected;

  return (
    <Card
      title="Calendar Integration"
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
                ? 'Authorize a Google account to sync meetings to your deals and schedule events from a deal.'
                : 'Ask an admin to connect a Google account.'}
            </p>
          )}
          {/* Scope disclosure — load-bearing copy. Matches the calendar.events
              consent the user grants in Google's OAuth dialog. Don't soften. */}
          <p className="mt-2 text-xs text-gray-600">
            Creates and reads events on the connected Google Calendar. Meetings
            with a deal contact as an attendee are matched to that deal's timeline.
          </p>
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
                  <p className="text-xs text-gray-700">Disconnect Calendar? Meetings will stop syncing.</p>
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
                <div className="flex gap-2">
                  <Button variant="secondary" icon="refresh" onClick={handleSync} loading={syncing} loadingLabel="Syncing…">
                    Sync now
                  </Button>
                  <Button variant="secondary" onClick={() => setConfirmDisconnect(true)}>
                    Disconnect
                  </Button>
                </div>
              )
            ) : (
              <Button icon="calendar" onClick={handleConnect} loading={connecting} loadingLabel="Opening Google…">
                Connect Google Calendar
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
