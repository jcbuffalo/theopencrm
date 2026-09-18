// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import api from '../api';
import Nav from '../components/Nav';
import { useAuth } from '../AuthContext';
import { Alert, Button, Card, Container, Icon, Input, PageHeader, Skeleton } from '../components/ui';

function EmailVerifySection() {
  const { user } = useAuth();
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const send = async () => {
    setSending(true);
    setError('');
    try {
      const r = await api.post('/security/email/send-verification');
      setResult(r.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send verification');
    } finally {
      setSending(false);
    }
  };

  return (
    <Card
      title="Email verification"
      subtitle={<>Confirm your email address. Required when <code className="bg-gray-100 px-1 rounded text-xs">EMAIL_VERIFICATION_REQUIRED=true</code> is set.</>}
    >
      {error && <Alert tone="danger" className="mb-3" onDismiss={() => setError('')}>{error}</Alert>}
      {result?.alreadyVerified ? (
        <p className="text-sm text-success-700 inline-flex items-center gap-1.5"><Icon name="check-circle" size={16} />Email is already verified.</p>
      ) : result?.sent ? (
        <p className="text-sm text-success-700 inline-flex items-center gap-1.5"><Icon name="check-circle" size={16} />Verification email sent. Check your inbox.</p>
      ) : result && !result.sent ? (
        <p className="text-sm text-warning-700">Verification token recorded but no email was sent — SMTP is not configured on this server.</p>
      ) : (
        <Button size="sm" icon="mail" onClick={send} loading={sending} loadingLabel="Sending…">
          Send verification email
        </Button>
      )}
      <p className="text-xs text-gray-500 mt-3">Logged-in as <code>{user?.email}</code></p>
    </Card>
  );
}

function TwoFactorSection() {
  const [status, setStatus] = useState(null);
  const [enrolling, setEnrolling] = useState(false);
  const [enrollment, setEnrollment] = useState(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const r = await api.get('/security/2fa/status');
      setStatus(r.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load 2FA status');
    }
  };
  useEffect(() => { load(); }, []);

  const start = async () => {
    setError('');
    setEnrolling(true);
    try {
      const r = await api.post('/security/2fa/enroll');
      setEnrollment(r.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Enrollment failed');
    } finally {
      setEnrolling(false);
    }
  };

  const verify = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const r = await api.post('/security/2fa/verify-enroll', { code: code.trim() });
      setRecoveryCodes(r.data.recoveryCodes);
      setEnrollment(null);
      setCode('');
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Invalid code');
    }
  };

  const disable = async () => {
    if (!window.confirm('Disable two-factor authentication on this account?')) return;
    await api.post('/security/2fa/disable');
    setRecoveryCodes(null);
    load();
  };

  return (
    <Card
      title="Two-factor authentication"
      subtitle="TOTP — works with Google Authenticator, 1Password, Authy, Bitwarden, etc."
    >
      {error && <Alert tone="danger" className="mb-3" onDismiss={() => setError('')}>{error}</Alert>}

      {!status ? (
        <div role="status" aria-label="Loading"><Skeleton lines={2} /></div>
      ) : !status.libraryAvailable ? (
        <p className="text-sm text-warning-700">2FA library not installed on this server. Add <code className="bg-gray-100 px-1 rounded">speakeasy</code> + <code className="bg-gray-100 px-1 rounded">qrcode</code> to backend deps and redeploy.</p>
      ) : status.enabled ? (
        <div>
          <p className="text-sm text-success-700 mb-3 inline-flex items-center gap-1.5"><Icon name="check-circle" size={16} />2FA is enabled on your account.</p>
          {recoveryCodes && (
            <Alert tone="warning" title="Save these recovery codes — they're shown once." className="mb-3">
              <ul className="grid grid-cols-2 gap-1 text-xs font-mono mt-1">
                {recoveryCodes.map(c => <li key={c}>{c}</li>)}
              </ul>
            </Alert>
          )}
          <Button variant="secondary" size="sm" className="!text-danger-700 !border-danger-300 hover:!bg-danger-50" onClick={disable}>
            Disable 2FA
          </Button>
        </div>
      ) : enrollment ? (
        <form onSubmit={verify} className="space-y-3">
          <p className="text-sm text-gray-700">Scan the QR code with your authenticator app, then enter the 6-digit code below to confirm.</p>
          {enrollment.qrDataUrl && <img src={enrollment.qrDataUrl} alt="2FA QR code" className="border border-gray-200 rounded" style={{ width: 180, height: 180 }} />}
          <p className="text-xs text-gray-500">Can't scan? Manual entry: <code className="bg-gray-100 px-1 rounded text-[11px]">{enrollment.secret}</code></p>
          <Input
            type="text" inputMode="numeric" maxLength={6}
            aria-label="6-digit code"
            placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            className="font-mono tracking-widest"
            wrapperClassName="w-32"
            required
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm">Verify &amp; enable</Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => { setEnrollment(null); setCode(''); }}>Cancel</Button>
          </div>
        </form>
      ) : (
        <Button size="sm" icon="lock" onClick={start} loading={enrolling} loadingLabel="Starting…">
          Enable 2FA
        </Button>
      )}
    </Card>
  );
}

export default function SecuritySettings() {
  // When an admin signs in without 2FA, /login redirects here with this state
  // (set in Login.js handler). Surface it as a warning banner above the
  // controls so they don't miss what they're supposed to do.
  const location = useLocation();
  const enrollNotice = location.state?.enrollNotice;

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav active="admin" />
      <Container size="narrow">
        <PageHeader title="Security" subtitle="Per-user security controls." />
        <div className="space-y-6">
          {enrollNotice && (
            <Alert tone="warning" title="Action required">
              {enrollNotice} Use the section below to enable it now.
            </Alert>
          )}
          <EmailVerifySection />
          <TwoFactorSection />
        </div>
      </Container>
    </div>
  );
}
