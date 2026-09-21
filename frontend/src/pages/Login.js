// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth, api, POST_LOGIN_REDIRECT_KEY } from '../api';
import { useAuth } from '../AuthContext';
import { PENDING_KEY as SSO_PENDING_KEY } from './SsoHandoff';
import { consumeSetupIntent } from '../marketing/cta';
import Button from '../components/ui/Button';

// Backend API base (mirrors src/api.js). The SSO login flow is a top-level
// browser navigation to a backend GET that 302-redirects to the IdP, so we
// build the URL directly rather than going through the axios instance.
const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5001/api';

// Human-readable messages for the sso_error codes the /callback redirect can
// append to /login (see routes/ssoLoginRoutes.js). Unmapped codes fall back to
// a generic message — we never surface which internal check failed.
const SSO_ERROR_MESSAGES = {
  sso_not_enabled: 'Single sign-on is not enabled for that organization.',
  unknown_or_disabled: 'That SSO connection was not found or is disabled.',
  sso_incomplete_config: 'That SSO connection is not fully configured yet.',
  sso_state_expired: 'Your sign-in session expired. Please try again.',
  sso_user_other_org: 'That account belongs to a different organization.',
  account_not_active: 'That account is not active. Contact your administrator.',
};
function ssoErrorMessage(code) {
  return SSO_ERROR_MESSAGES[code] || 'Single sign-on failed. Please try again or use another method.';
}

// If the user was bounced here from /sso/handoff, take them back there after
// sign-in so the handoff can complete. Otherwise, if a mid-session 401 (see
// api.js's stashCurrentPath) stashed where they were working, return there
// instead of dropping them on the dashboard. Otherwise go to the dashboard.
// The SSO handoff key wins when both are set — it's a short-lived,
// one-shot flow that takes priority over a merely-convenient "come back
// here".
function consumePendingRedirect() {
  try {
    const pending = sessionStorage.getItem(SSO_PENDING_KEY);
    if (pending) {
      sessionStorage.removeItem(SSO_PENDING_KEY);
      return pending;
    }
  } catch {
    /* sessionStorage unavailable */
  }
  try {
    const returnTo = sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY);
    if (returnTo) {
      sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY);
      return returnTo;
    }
  } catch {
    /* sessionStorage unavailable */
  }
  // Marketing "Build my CRM" CTA (marketing/cta.js) — localStorage-carried so
  // it survives the verify-email link opening in a new tab. Only ever /setup
  // (optionally with ?template=wt:<id> from a /crm-for page).
  const setupIntent = consumeSetupIntent();
  if (setupIntent) return setupIntent;
  return '/';
}

export default function Login() {
  const navigate = useNavigate();
  const { signIn } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [loginMethods, setLoginMethods] = useState([]);
  const [emailFormVisible, setEmailFormVisible] = useState(false);
  const [testUserSelected, setTestUserSelected] = useState(null);
  const [testUsers, setTestUsers] = useState([]);
  const [formData, setFormData] = useState({ email: '', password: '' });

  // 2FA challenge state — populated when /auth/login or /auth/google-signin
  // returns { requires2fa: true, tempToken, user }. The tempToken is held
  // only in component state (NOT localStorage / sessionStorage) so it
  // disappears on tab close — by design, the server-side expiry is 5min.
  const [twoFa, setTwoFa] = useState(null); // { tempToken, email }
  const [twoFaCode, setTwoFaCode] = useState('');
  // Email-verification gate: shown when login returns 403 EMAIL_NOT_VERIFIED.
  // Holds { email } so the resend button knows who to re-send to.
  const [needsVerification, setNeedsVerification] = useState(null);
  const [resendStatus, setResendStatus] = useState(null); // null | 'sending' | 'sent' | 'failed'

  // Enterprise SSO affordance: user types a work email or org slug; we resolve
  // it to an enabled connection and hand off to the backend start URL.
  const [ssoVisible, setSsoVisible] = useState(false);
  const [ssoIdentifier, setSsoIdentifier] = useState('');
  const [ssoBusy, setSsoBusy] = useState(false);
  const [ssoError, setSsoError] = useState(null);

  // Surface any sso_error the /callback redirect appended to the URL.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('sso_error');
      if (code) {
        setSsoError(ssoErrorMessage(code));
        setSsoVisible(true);
      }
    } catch { /* URL parsing unavailable */ }
  }, []);

  const handleSsoContinue = async (e) => {
    e.preventDefault();
    const identifier = ssoIdentifier.trim();
    if (!identifier) return;
    setSsoBusy(true);
    setSsoError(null);
    try {
      const res = await api.get('/auth/sso/resolve', { params: { identifier } });
      if (res.data?.found && res.data?.slug) {
        // Top-level navigation so the browser follows the IdP 302.
        window.location.href = `${API_URL}/auth/sso/${encodeURIComponent(res.data.slug)}/start`;
        return;
      }
      setSsoError('No single sign-on is configured for that email or organization.');
    } catch (err) {
      setSsoError(err.response?.data?.error || 'Could not start single sign-on. Try again.');
    } finally {
      setSsoBusy(false);
    }
  };

  // Helper — common branch for "we got a session back" from any login path.
  // Admins without 2FA get a GENTLE, dismissible nudge (a banner rendered app-
  // wide — see components/TwoFactorNudge.js), NOT a forced security page. The
  // first authenticated screen should be the product's value (the Chat-First
  // front door), not a security chore. There is no server-side block on
  // un-enrolled admins, so landing on the app is safe.
  const finalizeLogin = async (result) => {
    await signIn();
    if (result?.requires_2fa_enrollment) {
      try { sessionStorage.setItem('promptEnroll2fa', '1'); } catch { /* private-mode: skip the nudge */ }
    }
    navigate(consumePendingRedirect());
  };

  // Fetch available login methods and test users
  useEffect(() => {
    const fetchLoginOptions = async () => {
      try {
        const response = await api.get('/auth/login-options');
        setLoginMethods(response.data.availableMethods || []);

        // Fetch test users if test login is available
        if (response.data.availableMethods?.some((m) => m.type === 'test')) {
          try {
            const testResponse = await api.get('/auth/test-users');
            setTestUsers(testResponse.data.testUsers || []);
          } catch (err) {
            console.log('Test users endpoint not available');
          }
        }
      } catch (err) {
        console.error('Failed to fetch login options:', err);
        // Fallback to Google OAuth if endpoint not available
        setLoginMethods([
          {
            type: 'google',
            name: 'Google OAuth',
            endpoint: '/auth/google-signin',
            configured: !!process.env.REACT_APP_GOOGLE_CLIENT_ID,
          },
        ]);
      }
    };

    fetchLoginOptions();
    loadGoogleSignIn();
  }, []);

  const loadGoogleSignIn = () => {
    if (!window.google) {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = () => initGoogleButton();
      document.head.appendChild(script);
    } else {
      initGoogleButton();
    }
  };

  // Initialize the Google client and render the official sign-in button into
  // #google-signin-button as soon as the GSI library is ready. Done on mount
  // so the button appears without an extra "click to load" step.
  // FedCM-safe: uses use_fedcm_for_prompt instead of the deprecated
  // notification-status callbacks.
  const initGoogleButton = () => {
    if (!window.google || !process.env.REACT_APP_GOOGLE_CLIENT_ID) return;
    try {
      window.google.accounts.id.initialize({
        client_id: process.env.REACT_APP_GOOGLE_CLIENT_ID,
        use_fedcm_for_prompt: true,
        callback: handleGoogleCredential,
        cancel_on_tap_outside: true,
      });
      const target = document.getElementById('google-signin-button');
      if (target) {
        // The GSI iframe takes a fixed pixel width and ignores its parent's
        // constraints — passing 320 on a 320px viewport (iPhone SE) plus the
        // login card's padding pushes the iframe ~58px past the right edge.
        // Clamp to the actual container width so the button fits any phone.
        const containerWidth = Math.max(200, Math.min(320, target.clientWidth || 320));
        target.style.overflow = 'hidden';
        target.style.maxWidth = '100%';
        window.google.accounts.id.renderButton(target, {
          theme: 'outline', size: 'large', width: containerWidth, text: 'continue_with',
        });
      }
    } catch (err) {
      console.error('Google init failed:', err);
    }
  };

  const handleGoogleCredential = async (response) => {
    setLoading(true);
    setError(null);
    try {
      const result = await auth.login(null, null, response.credential);
      if (result?.requires2fa) {
        setTwoFa({ tempToken: result.tempToken, email: result.user?.email || '' });
        return;
      }
      if (result.success) {
        await finalizeLogin(result);
      } else {
        setError(result.error || 'Sign in failed');
      }
    } catch (err) {
      const data = err.response?.data;
      if (data?.pending) {
        navigate('/pending', { state: { message: data.error } });
        return;
      }
      const detail = data?.detail ? ` (${data.detail})` : '';
      const reqId = data?.requestId ? ` [request: ${data.requestId.slice(0, 8)}]` : '';
      setError(`${data?.error || err.message || 'Google Sign-In failed'}${detail}${reqId}`);
    } finally {
      setLoading(false);
    }
  };

  // Fallback handler for the custom branded button — only invoked if the
  // official Google button hasn't rendered yet (e.g. GSI script still loading).
  // Triggers the FedCM One Tap prompt as a fallback.
  const handleGoogleSignIn = async () => {
    if (!window.google) {
      setError('Google Sign-In is loading. Please try again in a moment.');
      return;
    }
    try {
      // Re-init in case it failed earlier
      window.google.accounts.id.initialize({
        client_id: process.env.REACT_APP_GOOGLE_CLIENT_ID,
        use_fedcm_for_prompt: true,
        callback: handleGoogleCredential,
      });
      // Show the One Tap prompt. Under FedCM, no notification-status callbacks.
      window.google.accounts.id.prompt();
      // Also re-render the official button as a backup.
      const target = document.getElementById('google-signin-button');
      if (target && !target.hasChildNodes()) {
        window.google.accounts.id.renderButton(target, {
          theme: 'outline', size: 'large', width: 320, text: 'continue_with',
        });
      }
    } catch (err) {
      setError(err.message || 'Google Sign-In failed to start');
    }
  };

  const handleEmailLogin = async (e) => {
    e.preventDefault();
    try {
      setLoading(true);
      setError(null);

      const result = await auth.login(formData.email, formData.password);
      if (result?.requires2fa) {
        setTwoFa({ tempToken: result.tempToken, email: result.user?.email || formData.email });
        return;
      }
      if (result.success) {
        await finalizeLogin(result);
      } else {
        setError(result.error || 'Login failed');
      }
    } catch (err) {
      const data = err.response?.data;
      if (data?.pending) {
        navigate('/pending', { state: { message: data.error } });
        return;
      }
      if (data?.code === 'EMAIL_NOT_VERIFIED') {
        setNeedsVerification({ email: data.email || formData.email });
        setError(null);
        return;
      }
      setError(data?.error || err.error || err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const resendVerification = async () => {
    if (!needsVerification?.email) return;
    setResendStatus('sending');
    try {
      // The /security/email/send endpoint mints a token + emails it.
      // Available unauthenticated because the user can't log in yet.
      const { default: api } = await import('../api');
      await api.post('/auth/resend-verification', { email: needsVerification.email });
      setResendStatus('sent');
    } catch {
      setResendStatus('failed');
    }
  };

  const handleTestLogin = async (testUser) => {
    try {
      setLoading(true);
      setError(null);

      const result = await auth.login(testUser.email, testUser.password);
      if (result?.requires2fa) {
        setTwoFa({ tempToken: result.tempToken, email: result.user?.email || testUser.email });
        return;
      }
      if (result.success) {
        await finalizeLogin(result);
      } else {
        setError(result.error || 'Test login failed');
      }
    } catch (err) {
      const data = err.response?.data;
      if (data?.pending) {
        navigate('/pending', { state: { message: data.error } });
        return;
      }
      setError(data?.error || err.error || err.message || 'Test login failed');
    } finally {
      setLoading(false);
    }
  };

  // 2FA verification step. Triggered when the user submits their 6-digit code
  // (or a recovery code) on the second-stage form.
  const handle2faSubmit = async (e) => {
    e.preventDefault();
    if (!twoFa?.tempToken) return;
    try {
      setLoading(true);
      setError(null);
      const result = await auth.verify2fa(twoFa.tempToken, twoFaCode.trim());
      if (result.success) {
        await finalizeLogin(result);
      } else {
        setError(result.error || 'Verification failed');
      }
    } catch (err) {
      const data = err.response?.data;
      // The most common failure modes are "bad code" (401) and "tempToken
      // expired" (also 401). On expired-token, kick back to the start so the
      // user can re-enter their password and get a fresh tempToken.
      if (data?.error?.includes('expired') || data?.error?.includes('Sign in again')) {
        setTwoFa(null);
        setTwoFaCode('');
        setError(data.error);
        return;
      }
      setError(data?.error || err.message || 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  const cancel2fa = () => {
    setTwoFa(null);
    setTwoFaCode('');
    setError(null);
  };

  return (
    <main id="main-content" className="min-h-screen bg-gradient-to-br from-primary-50 to-primary-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="text-4xl font-bold text-brand-blue mb-4">The Open CRM</div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">Welcome back</h1>
          <p className="text-gray-600">Sign in to your account</p>
        </div>

        {/* Auth Card */}
        <div className="bg-white rounded-xl shadow-lg p-8">
          {!twoFa && <p className="text-gray-600 text-center mb-6">Sign in to manage your pipeline</p>}

          {/* Error Message */}
          {error && (
            <div role="alert" className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
              <p className="text-red-700 text-sm">⚠️ {error}</p>
            </div>
          )}

          {/* Email-verification challenge — hides the rest of the sign-in
              surface once the user has cleared password but not verified
              their email. Resend hits the existing security flow endpoints. */}
          {needsVerification && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6">
              <h2 className="text-base font-semibold text-amber-900 mb-1">Verify your email</h2>
              <p className="text-sm text-amber-800">
                Check the inbox for <code className="text-xs">{needsVerification.email}</code> for a verification link. Click it, then sign in again.
              </p>
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={resendVerification}
                  disabled={resendStatus === 'sending' || resendStatus === 'sent'}
                  className="px-3 py-1.5 text-sm bg-amber-600 text-white rounded font-medium hover:bg-amber-700 disabled:opacity-50"
                >
                  {resendStatus === 'sending' ? 'Sending…' : resendStatus === 'sent' ? '✓ Sent' : 'Resend verification email'}
                </button>
                <button
                  onClick={() => { setNeedsVerification(null); setResendStatus(null); }}
                  className="px-3 py-1.5 text-sm text-amber-900 hover:underline"
                >
                  Use a different email
                </button>
              </div>
              {resendStatus === 'failed' && (
                <p className="text-xs text-red-700 mt-2">Couldn't send. Try again, or contact support.</p>
              )}
            </div>
          )}

          {/* 2FA challenge — hides the rest of the sign-in surface once the
              user has cleared the password / Google step. tempToken is held
              in component state and expires server-side after 5 minutes.
              Visual style intentionally gentler than the prior text-2xl /
              tracking-[0.4em] treatment, which read as alarming. */}
          {twoFa ? (
            <form onSubmit={handle2faSubmit} className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 mb-1">Enter your verification code</h2>
                <p className="text-sm text-gray-600">
                  Signed in as <code className="text-xs">{twoFa.email}</code>. Paste the 6-digit code from your authenticator app.
                </p>
              </div>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                placeholder="000000"
                value={twoFaCode}
                onChange={(e) => setTwoFaCode(e.target.value.replace(/\s+/g, ''))}
                className="w-full px-4 py-3 text-lg font-mono tracking-[0.2em] text-center border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                autoFocus
                maxLength={32}
                disabled={loading}
                aria-label="Authentication code"
              />
              <p className="text-xs text-gray-500">
                No authenticator handy? Enter one of your recovery codes instead — each works once.
              </p>
              <Button
                type="submit"
                variant="primary"
                size="lg"
                fullWidth
                disabled={loading || twoFaCode.length < 6}
                loading={loading}
              >
                {loading ? 'Verifying…' : 'Verify'}
              </Button>
              <button
                type="button"
                onClick={cancel2fa}
                className="w-full text-sm text-gray-700 hover:text-gray-900 underline underline-offset-2 py-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue rounded"
              >
                Use a different account or sign-in method
              </button>
            </form>
          ) : (
            <>

          {/* Google Sign-In */}
          {loginMethods.some((m) => m.type === 'google') && (
            <>
              <div id="google-signin-button" className="w-full mb-4"></div>
              <button
                onClick={handleGoogleSignIn}
                disabled={loading}
                className="w-full bg-white border-2 border-gray-300 hover:border-primary-500 hover:shadow-md disabled:opacity-50 text-gray-700 font-bold py-3 px-4 rounded-lg transition flex items-center justify-center gap-3"
              >
                <svg width="20" height="20" viewBox="0 0 48 48">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                </svg>
                {loading ? 'Signing in...' : 'Continue with Google'}
              </button>
            </>
          )}

          {/* Email Login */}
          {loginMethods.some((m) => m.type === 'email') && (
            <>
              {!emailFormVisible ? (
                <Button
                  variant="secondary"
                  size="lg"
                  fullWidth
                  onClick={() => setEmailFormVisible(true)}
                  className="mt-4"
                >
                  Continue with email
                </Button>
              ) : (
                <form onSubmit={handleEmailLogin} className="mt-4 space-y-3">
                  <input
                    type="email"
                    placeholder="Email"
                    name="email"
                    autoComplete="username"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-blue focus:border-brand-blue"
                    disabled={loading}
                    aria-label="Email address"
                  />
                  <input
                    type="password"
                    placeholder="Password"
                    name="password"
                    autoComplete="current-password"
                    value={formData.password}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-blue focus:border-brand-blue"
                    disabled={loading}
                    aria-label="Password"
                  />
                  <div className="text-right">
                    <a href="/forgot-password" className="text-sm text-brand-blue hover:underline">
                      Forgot password?
                    </a>
                  </div>
                  <Button
                    type="submit"
                    variant="primary"
                    size="md"
                    fullWidth
                    disabled={loading}
                    loading={loading}
                  >
                    {loading ? 'Signing in…' : 'Sign in'}
                  </Button>
                </form>
              )}
            </>
          )}

          {/* Enterprise SSO — available to any org that has configured + enabled
              an OIDC connection. Inert (backend returns found:false) otherwise,
              so showing the entry point universally is safe. */}
          <div className="mt-4">
            {!ssoVisible ? (
              <button
                type="button"
                onClick={() => setSsoVisible(true)}
                className="w-full text-sm text-gray-700 hover:text-gray-900 underline underline-offset-2 py-2"
              >
                Sign in with SSO
              </button>
            ) : (
              <form onSubmit={handleSsoContinue} className="space-y-2">
                <input
                  type="text"
                  placeholder="Work email or organization ID"
                  value={ssoIdentifier}
                  onChange={(e) => setSsoIdentifier(e.target.value)}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-blue focus:border-brand-blue"
                  disabled={ssoBusy}
                  autoFocus
                  aria-label="Work email or organization ID for SSO"
                />
                {ssoError && <p className="text-sm text-red-700">{ssoError}</p>}
                <Button type="submit" variant="secondary" size="md" fullWidth disabled={ssoBusy || !ssoIdentifier.trim()} loading={ssoBusy}>
                  {ssoBusy ? 'Redirecting…' : 'Continue with SSO'}
                </Button>
              </form>
            )}
          </div>

          {/* Test Login */}
          {loginMethods.some((m) => m.type === 'test') && testUsers.length > 0 && (
            <div className="mt-4">
              <p className="text-sm text-gray-600 mb-2">Demo Accounts (Development):</p>
              <div className="space-y-2">
                {testUsers.map((user) => (
                  <button
                    key={user.email}
                    onClick={() => handleTestLogin(user)}
                    disabled={loading}
                    className="w-full bg-blue-50 hover:bg-blue-100 disabled:opacity-50 text-blue-700 font-semibold py-2 px-4 rounded-lg transition text-sm"
                  >
                    <div className="font-medium">{user.name}</div>
                    <div className="text-xs text-blue-600">{user.email}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
            </>
          )}

          <div className="mt-6 pt-4 border-t border-gray-200 text-center text-sm">
            <span className="text-gray-600">New here? </span>
            <a href="/request-access" className="text-brand-blue hover:underline font-medium">Create your free account</a>
          </div>

          <p className="text-center text-gray-500 text-xs mt-4">
            By signing in, you agree to our{' '}
            <a href="/terms" className="text-brand-blue hover:underline inline-flex items-center min-h-[32px] px-1 align-middle">Terms</a>
            {' '}and{' '}
            <a href="/privacy" className="text-brand-blue hover:underline inline-flex items-center min-h-[32px] px-1 align-middle">Privacy Policy</a>.
          </p>
        </div>
      </div>
    </main>
  );
}
