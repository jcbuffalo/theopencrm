// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Public /verify-email page — the landing target of the emailed verification
// link (?token=...) minted by services/emailVerification.js and
// /api/security/email/send-verification. Before this page existed the link
// fell through the unauthenticated catch-all to the Landing page and the
// token was never submitted (found while wiring the marketing CTA -> /setup
// path, spec 203 Phase 3). Posts the token to the public, CSRF-exempt
// POST /api/security/email/verify once on mount, then hands off to /login —
// where consumePendingRedirect() honours a "Build my CRM" intent so the new
// user lands in /setup. Deliberately no auto-login (2FA stays intact).

import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import Button from '../components/ui/Button';

export default function VerifyEmail() {
  const token = useMemo(() => {
    try {
      return new URLSearchParams(window.location.search).get('token') || '';
    } catch {
      return '';
    }
  }, []);

  const [state, setState] = useState(token ? 'verifying' : 'invalid'); // verifying | done | invalid | error
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    (async () => {
      try {
        await api.post('/security/email/verify', { token });
        if (!cancelled) setState('done');
      } catch (err) {
        if (cancelled) return;
        const status = err.response?.status;
        setMessage(err.response?.data?.error || '');
        setState(status === 400 ? 'invalid' : 'error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const goToLogin = () => {
    window.location.href = '/login';
  };

  return (
    <main id="main-content" className="min-h-screen bg-gradient-to-br from-primary-50 to-primary-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="text-4xl font-bold text-brand-blue mb-4">The Open CRM</div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">
            {state === 'done' ? 'Email verified' : state === 'verifying' ? 'Verifying your email' : 'This link will not work'}
          </h1>
        </div>

        <div className="bg-white rounded-xl shadow-lg p-8">
          {state === 'verifying' && (
            <p className="text-sm text-gray-600 text-center" role="status">One moment.</p>
          )}

          {state === 'done' && (
            <div>
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
                <p className="text-sm text-green-800">
                  Your email is confirmed. Sign in and you will be taken to the first screen: describe how you sell, and the CRM proposes your setup.
                </p>
              </div>
              <Button variant="primary" size="lg" fullWidth onClick={goToLogin}>
                Sign in
              </Button>
            </div>
          )}

          {(state === 'invalid' || state === 'error') && (
            <div>
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6">
                <p className="text-sm text-amber-800">
                  {state === 'error'
                    ? (message || 'Something went wrong on our side. Try the link again in a minute.')
                    : (message || 'This verification link is missing, expired, or was already used. Links last 24 hours and work once. Sign in and we will offer to send a new one.')}
                </p>
              </div>
              <Button variant="primary" size="lg" fullWidth onClick={goToLogin}>
                Go to sign in
              </Button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
