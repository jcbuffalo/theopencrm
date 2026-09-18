// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// SSO handoff page.
//
// Reached when a sibling product (e.g. the Workforce / VCI Points & Pay app)
// sends a user here via /sso/handoff?return=<their_url>. We verify the user is
// signed in, mint a short-lived token via POST /api/auth/sso/mint, and redirect
// the browser to <return>?token=<jwt>.
//
// If the user is NOT signed in, we stash the entire current URL (with the
// return param intact) in sessionStorage and bounce to /login. Login.js, on
// success, reads that key and brings the user back here.

import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import api from '../api';

const PENDING_KEY = 'sso_handoff_pending_url';

function SsoHandoff() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { user, loading } = useAuth();
  const [status, setStatus] = useState('working'); // working | error
  const [message, setMessage] = useState('Signing you in to the sibling app…');

  useEffect(() => {
    if (loading) return;
    const returnUrl = params.get('return');
    if (!returnUrl) {
      setStatus('error');
      setMessage('Missing return URL. Whoever sent you here forgot to include where to send you back.');
      return;
    }

    if (!user) {
      // Stash full path + query so Login can bounce back after sign-in.
      try {
        sessionStorage.setItem(
          PENDING_KEY,
          `/sso/handoff?return=${encodeURIComponent(returnUrl)}`,
        );
      } catch {
        // sessionStorage may be unavailable in private modes; non-fatal.
      }
      navigate('/login');
      return;
    }

    let cancelled = false;
    const mintAndRedirect = async () => {
      try {
        const res = await api.post('/auth/sso/mint', { return_url: returnUrl });
        if (cancelled) return;
        const { token, return_url } = res.data || {};
        if (!token || !return_url) {
          throw new Error('Bad response from SSO mint');
        }
        // Build the final redirect: <return>?token=<jwt> (preserve any
        // existing query params on the return URL).
        const target = new URL(return_url);
        target.searchParams.set('token', token);
        window.location.replace(target.toString());
      } catch (err) {
        if (cancelled) return;
        const data = err?.response?.data;
        setStatus('error');
        setMessage(
          data?.message ||
            data?.error ||
            err?.message ||
            'SSO sign-in failed. Try again from the sibling app.',
        );
      }
    };

    mintAndRedirect();
    return () => {
      cancelled = true;
    };
  }, [loading, user, params, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md bg-white rounded-lg shadow-md p-8 text-center">
        <h1 className="text-xl font-bold text-gray-900 mb-3">The Open CRM</h1>
        {status === 'working' ? (
          <>
            <div className="flex justify-center mb-4">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary-600" />
            </div>
            <p className="text-gray-700">{message}</p>
            <p className="text-xs text-gray-500 mt-4">
              You'll be redirected automatically — no action needed.
            </p>
          </>
        ) : (
          <>
            <div className="text-3xl mb-3">⚠</div>
            <p className="text-gray-800 mb-4">{message}</p>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="px-4 py-2 bg-primary-600 text-white rounded-md hover:bg-primary-700"
            >
              Back to The Open CRM
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default SsoHandoff;

// Export the storage key so Login.js can read it on successful sign-in.
export { PENDING_KEY };
