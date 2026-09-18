// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Public /reset-password page — the landing target of the emailed reset link
// (?token=...). Collects a new password + confirmation and hits
// POST /api/security/password-reset/confirm. On an invalid / expired / used
// token the page offers the "request a new link" path back to
// /forgot-password. Deliberately no auto-login on success: the user signs in
// themselves (2FA, where enrolled, stays intact).

import React, { useMemo, useState } from 'react';
import { api } from '../api';
import Button from '../components/ui/Button';

// Error codes the confirm endpoint returns for dead tokens — all of them are
// fixed by requesting a fresh link, so they share the "request a new link" UI.
const DEAD_TOKEN_CODES = ['RESET_TOKEN_INVALID', 'RESET_TOKEN_EXPIRED', 'RESET_TOKEN_USED'];

export default function ResetPassword() {
  const token = useMemo(() => {
    try {
      return new URLSearchParams(window.location.search).get('token') || '';
    } catch {
      return '';
    }
  }, []);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [deadToken, setDeadToken] = useState(!token); // no ?token= → straight to the re-request path
  const [done, setDone] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    // Mirror the backend floor client-side for fast feedback; the server is
    // the source of truth on the full policy (classes, reuse, HIBP).
    if (password !== confirm) {
      setError('New password and confirmation do not match.');
      return;
    }
    if (password.length < 10) {
      setError('Password must be at least 10 characters.');
      return;
    }

    setBusy(true);
    try {
      await api.post('/security/password-reset/confirm', { token, password });
      setDone(true);
    } catch (err) {
      const data = err.response?.data;
      if (data?.code && DEAD_TOKEN_CODES.includes(data.code)) {
        setDeadToken(true);
        setError(data.error);
        return;
      }
      setError(data?.error || err.message || 'Failed to reset password. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main id="main-content" className="min-h-screen bg-gradient-to-br from-primary-50 to-primary-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="text-4xl font-bold text-brand-blue mb-4">The Open CRM</div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">Choose a new password</h1>
        </div>

        <div className="bg-white rounded-xl shadow-lg p-8">
          {done ? (
            <div>
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
                <h2 className="text-base font-semibold text-green-900 mb-1">Password updated</h2>
                <p className="text-sm text-green-800">
                  Your password has been changed. Sign in with it now — if you have
                  two-factor authentication enabled, you'll still be asked for your code.
                </p>
              </div>
              <Button variant="primary" size="md" fullWidth onClick={() => { window.location.href = '/login'; }}>
                Go to sign in
              </Button>
            </div>
          ) : deadToken ? (
            <div>
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6">
                <h2 className="text-base font-semibold text-amber-900 mb-1">This link won't work</h2>
                <p className="text-sm text-amber-800">
                  {error || 'This reset link is missing, expired, or has already been used. Reset links last 30 minutes and work once.'}
                </p>
              </div>
              <Button variant="primary" size="md" fullWidth onClick={() => { window.location.href = '/forgot-password'; }}>
                Request a new link
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3">
              {error && (
                <div role="alert" className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <p className="text-red-700 text-sm">⚠️ {error}</p>
                </div>
              )}
              <p className="text-sm text-gray-600">
                Minimum 10 characters, with at least 3 of: lowercase, uppercase, digit, symbol.
              </p>
              <input
                type="password"
                placeholder="New password"
                name="new-password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-blue focus:border-brand-blue"
                disabled={busy}
                autoFocus
                aria-label="New password"
              />
              <input
                type="password"
                placeholder="Confirm new password"
                name="confirm-password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-blue focus:border-brand-blue"
                disabled={busy}
                aria-label="Confirm new password"
              />
              <Button type="submit" variant="primary" size="md" fullWidth disabled={busy || !password || !confirm} loading={busy}>
                {busy ? 'Saving…' : 'Set new password'}
              </Button>
            </form>
          )}

          <div className="mt-6 pt-4 border-t border-gray-200 text-center text-sm">
            <a href="/login" className="text-brand-blue hover:underline font-medium">Back to sign in</a>
          </div>
        </div>
      </div>
    </main>
  );
}
