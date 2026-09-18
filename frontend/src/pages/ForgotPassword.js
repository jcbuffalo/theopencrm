// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Public /forgot-password page. Collects an email and hits the deliberately
// enumeration-proof POST /api/security/password-reset/request — the success
// state is generic ("if that email has an account…") no matter what, so this
// page never confirms whether an address is registered.

import React, { useState } from 'react';
import { api } from '../api';
import Button from '../components/ui/Button';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/security/password-reset/request', { email: email.trim() });
      setSent(true);
    } catch (err) {
      // 429 (rate limit) and 400 (malformed email) are the only non-generic
      // outcomes the endpoint can produce.
      setError(err.response?.data?.error || 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main id="main-content" className="min-h-screen bg-gradient-to-br from-primary-50 to-primary-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="text-4xl font-bold text-brand-blue mb-4">The Open CRM</div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">Reset your password</h1>
          <p className="text-gray-600">We'll email you a link to choose a new one</p>
        </div>

        <div className="bg-white rounded-xl shadow-lg p-8">
          {sent ? (
            <div>
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
                <h2 className="text-base font-semibold text-green-900 mb-1">Check your inbox</h2>
                <p className="text-sm text-green-800">
                  If that email has an account, a reset link is on the way. The link
                  expires in 30 minutes — if it doesn't arrive, check your spam folder
                  or request another one.
                </p>
              </div>
              <Button variant="secondary" size="md" fullWidth onClick={() => { setSent(false); setError(null); }}>
                Send another link
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
                Enter the email you sign in with and we'll send you a password-reset link.
              </p>
              <input
                type="email"
                placeholder="Email"
                name="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-blue focus:border-brand-blue"
                disabled={busy}
                autoFocus
                aria-label="Email address"
              />
              <Button type="submit" variant="primary" size="md" fullWidth disabled={busy || !email.trim()} loading={busy}>
                {busy ? 'Sending…' : 'Email me a reset link'}
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
