// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// DriveConnectCard — Google Drive connection status + connect/disconnect.
//
// Designed to be dropped into the Settings page on a new "Drive Integration"
// tab. Self-contained: probes its own state on mount via api.drive
// .getConnection(), and renders one of four states:
//
//   1. Loading        — initial probe in flight
//   2. Not configured — backend returned 503 (Drive env vars unset).
//                       Shows operator-facing guidance, no buttons.
//   3. Not connected  — backend returned { connected: false }.
//                       Admin/owner: "Connect Google Drive" button (opens
//                       authUrl from /drive/auth/start in a new tab).
//                       Non-admin: "Not connected — ask an admin".
//   4. Connected      — shows email + status. Admin/owner: "Disconnect" with
//                       inline confirmation; non-admin: read-only "Connected
//                       as <email>".
//
// Per DRIVE_INTEL_SPEC.md, only org owners and admins may connect or
// disconnect. Backend re-checks; this is purely a UX guard so non-admins
// don't see buttons that 403.

import React, { useCallback, useEffect, useState } from 'react';
import { drive } from '../api';
import { useAuth } from '../AuthContext';
import { Alert, Button, Card, Spinner, StatusBadge } from './ui';

// Roles permitted to mutate the org-level connection.
const ADMIN_ROLES = new Set(['admin', 'owner']);

export default function DriveConnectCard() {
  const { user } = useAuth();
  // org_role is 'owner' | 'admin' | 'member' (set on /auth/me); fall back to
  // the global is_admin flag so super-admins can manage in any org.
  const isAdmin = ADMIN_ROLES.has(user?.org_role) || !!user?.is_admin;

  const [loading, setLoading] = useState(true);
  // notConfigured: 503 from backend → "Drive integration not enabled on this
  // deployment". Distinct from `connected: false`, which means "configured
  // but no org connection yet".
  const [notConfigured, setNotConfigured] = useState(false);
  const [conn, setConn] = useState(null); // { connected, email, status, ... }
  const [error, setError] = useState('');
  // Connect button "did the popup open" UX state — we re-probe on focus when
  // the user comes back from the OAuth tab so the card transitions to
  // Connected without a manual refresh.
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const probe = useCallback(async () => {
    setError('');
    try {
      const data = await drive.getConnection();
      setNotConfigured(false);
      setConn(data || { connected: false });
    } catch (err) {
      const status = err?.response?.status;
      const code = err?.response?.data?.error || '';
      if (
        status === 503 &&
        /not configured|not enabled/i.test(code)
      ) {
        setNotConfigured(true);
        setConn(null);
      } else {
        setError(
          err?.response?.data?.error ||
            'Failed to load Drive connection status.'
        );
        setConn(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    probe();
  }, [probe]);

  // Re-probe when the tab regains focus — the user has just come back from
  // the Google consent popup and the connection state likely changed.
  useEffect(() => {
    if (!connecting) return undefined;
    const onFocus = () => {
      probe();
      setConnecting(false);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [connecting, probe]);

  const handleConnect = async () => {
    setError('');
    try {
      const { authUrl } = await drive.startAuth();
      if (!authUrl) {
        setError('Backend did not return an OAuth URL.');
        return;
      }
      // Open in a new tab so the user doesn't lose the Settings page state.
      // The OAuth callback on the backend redirects to /settings#drive.
      setConnecting(true);
      const popup = window.open(authUrl, '_blank', 'noopener');
      if (!popup) {
        // Popup blocked — fall back to a same-tab nav.
        window.location.href = authUrl;
      }
    } catch (err) {
      setError(
        err?.response?.data?.error ||
          'Could not start Google Drive authorization.'
      );
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setError('');
    setDisconnecting(true);
    try {
      await drive.disconnect();
      setConfirmDisconnect(false);
      await probe();
    } catch (err) {
      setError(
        err?.response?.data?.error || 'Failed to disconnect Google Drive.'
      );
    } finally {
      setDisconnecting(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Spinner size="sm" />
          <span>Loading Drive connection…</span>
        </div>
      </Card>
    );
  }

  // Not-configured state — operator hint, no admin/non-admin split (nobody
  // can fix it from the UI; the deployment owner needs to set env vars).
  if (notConfigured) {
    return (
      <Card title="Google Drive Integration">
        <Alert tone="warning" icon="lock" title="Drive integration is not enabled for this deployment.">
          <p className="text-xs">
            Operator: set <code>GOOGLE_DRIVE_CLIENT_ID</code>,{' '}
            <code>GOOGLE_DRIVE_CLIENT_SECRET</code>,{' '}
            <code>GOOGLE_DRIVE_REDIRECT_URI</code>, and{' '}
            <code>DRIVE_TOKEN_ENCRYPTION_KEY</code> on the backend, then
            enable the <code>drive_intel_enabled</code> feature flag for this
            org.
          </p>
        </Alert>
      </Card>
    );
  }

  const isConnected = !!conn?.connected;

  return (
    <Card
      title="Google Drive Integration"
      actions={isConnected
        ? <StatusBadge tone={conn.status && conn.status !== 'active' ? 'warning' : 'success'} label={conn.status && conn.status !== 'active' ? conn.status : 'Connected'} className="capitalize" />
        : <StatusBadge tone="neutral" label="Not connected" />}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {isConnected ? (
            <p className="text-sm text-gray-700 break-words">
              Connected as{' '}
              <span className="font-medium text-gray-900">
                {conn.email || 'unknown account'}
              </span>
            </p>
          ) : (
            <p className="text-sm text-gray-700">
              Not connected.{' '}
              {isAdmin
                ? 'Authorize a Google account to enable Drive intel summaries on deals.'
                : 'Ask an admin to connect a Google account.'}
            </p>
          )}
          {conn?.last_error ? (
            <p className="mt-2 text-xs text-warning-700 break-words">
              Last error: {conn.last_error}
            </p>
          ) : null}
        </div>

        {/* Action column. Only admins/owners get mutating controls. */}
        {isAdmin ? (
          <div className="flex flex-shrink-0 flex-col gap-2 sm:items-end">
            {isConnected ? (
              confirmDisconnect ? (
                <div className="flex flex-col gap-2 sm:items-end">
                  <p className="text-xs text-gray-700">
                    Disconnect Google Drive? Linked deal folders will stop
                    syncing.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => setConfirmDisconnect(false)}
                      disabled={disconnecting}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="danger"
                      onClick={handleDisconnect}
                      loading={disconnecting}
                      loadingLabel="Disconnecting…"
                    >
                      Disconnect
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="secondary" onClick={() => setConfirmDisconnect(true)}>
                  Disconnect
                </Button>
              )
            ) : (
              <Button
                icon="external"
                onClick={handleConnect}
                loading={connecting}
                loadingLabel="Opening Google…"
              >
                Connect Google Drive
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
