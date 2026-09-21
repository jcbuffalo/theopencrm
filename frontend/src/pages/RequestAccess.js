// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api';
import BrandLogo from '../components/BrandLogo';

export default function RequestAccess() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', company: '', reason: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // 'pending' (approval-gated deployment) | 'active' (open signup, no
  // verification needed) | 'verify' (open signup, but must click a
  // verification link before signing in); null until submitted.
  const [success, setSuccess] = useState(null);
  const [resendStatus, setResendStatus] = useState(null); // null | 'sending' | 'sent' | 'failed'

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const r = await api.post('/request-access', form);
      if (r.data.active && r.data.verification_required) setSuccess('verify');
      else if (r.data.active) setSuccess('active');
      else if (r.data.pending) setSuccess('pending');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to submit request. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const resendVerification = async () => {
    if (!form.email) return;
    setResendStatus('sending');
    try {
      await api.post('/auth/resend-verification', { email: form.email });
      setResendStatus('sent');
    } catch {
      setResendStatus('failed');
    }
  };

  if (success === 'verify') {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 max-w-md w-full text-center">
          <div className="text-5xl mb-4">✉️</div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Check your inbox</h1>
          <p className="text-gray-600 mb-1">
            We sent a link to <strong>{form.email}</strong> — click it to verify
            your email, then sign in.
          </p>
          <p className="text-sm text-gray-500 mb-6">
            Didn't get it? Check spam, or send it again below.
          </p>
          <div className="flex flex-col gap-2 items-center">
            <button
              onClick={resendVerification}
              disabled={resendStatus === 'sending' || resendStatus === 'sent'}
              className="px-4 py-2 bg-brand-blue hover:bg-brand-blue-dark text-white rounded-lg text-sm font-medium disabled:opacity-50"
            >
              {resendStatus === 'sending' ? 'Sending…' : resendStatus === 'sent' ? '✓ Sent' : 'Resend verification email'}
            </button>
            <button
              onClick={() => navigate('/login')}
              className="px-3 py-1.5 text-sm text-gray-600 hover:underline"
            >Go to sign in</button>
          </div>
          {resendStatus === 'failed' && (
            <p className="text-xs text-red-700 mt-3">Couldn't send. Try again, or contact support.</p>
          )}
        </div>
      </div>
    );
  }

  if (success === 'active') {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 max-w-md w-full text-center">
          <div className="text-5xl mb-4">🎉</div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Your workspace is ready</h1>
          <p className="text-gray-600 mb-6">
            Your account is active — sign in now to get started.
          </p>
          <button
            onClick={() => navigate('/login')}
            className="px-4 py-2 bg-brand-blue hover:bg-brand-blue-dark text-white rounded-lg text-sm font-medium"
          >Sign in</button>
        </div>
      </div>
    );
  }

  if (success === 'pending') {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 max-w-md w-full text-center">
          <div className="text-5xl mb-4">✉️</div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Request submitted</h1>
          <p className="text-gray-600 mb-6">
            Your access request has been received. An admin will review it; you'll receive an email when access is granted.
          </p>
          <button
            onClick={() => navigate('/')}
            className="px-4 py-2 bg-brand-blue hover:bg-brand-blue-dark text-white rounded-lg text-sm font-medium"
          >Return home</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <Link to="/"><BrandLogo size={28} /></Link>
          <Link to="/login" className="text-sm text-gray-600 hover:text-gray-900">Already have access? Sign in</Link>
        </div>
      </header>

      <main id="main-content" className="flex-1 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8 max-w-md w-full">
          <h1 className="text-2xl font-bold text-gray-900 mb-1">Create your account</h1>
          <p className="text-sm text-gray-600 mb-6">
            Free to start — your own workspace, no credit card. Just tell us a bit about yourself.
          </p>

          {error && <div className="bg-red-50 text-red-700 px-3 py-2 rounded text-sm mb-4">{error}</div>}

          <form onSubmit={submit} className="space-y-3">
            <div>
              <label htmlFor="ra-name" className="block text-xs font-medium text-gray-700 mb-1">Full name *</label>
              <input id="ra-name" name="name" autoComplete="name" type="text" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:border-brand-blue" />
            </div>
            <div>
              <label htmlFor="ra-email" className="block text-xs font-medium text-gray-700 mb-1">Work email *</label>
              <input id="ra-email" name="email" autoComplete="email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:border-brand-blue" />
            </div>
            <div>
              <label htmlFor="ra-password" className="block text-xs font-medium text-gray-700 mb-1">Password *</label>
              <input id="ra-password" name="password" autoComplete="new-password" type="password" required value={form.password} aria-describedby="ra-password-hint" onChange={(e) => setForm({ ...form, password: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:border-brand-blue" />
              <p id="ra-password-hint" className="text-[11px] text-gray-500 mt-1">10+ characters, mixing letters, numbers, and symbols.</p>
            </div>
            <div>
              <label htmlFor="ra-company" className="block text-xs font-medium text-gray-700 mb-1">Company</label>
              <input id="ra-company" name="organization" autoComplete="organization" type="text" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:border-brand-blue" />
            </div>
            <div>
              <label htmlFor="ra-reason" className="block text-xs font-medium text-gray-700 mb-1">Why do you want access?</label>
              <textarea id="ra-reason" name="reason" rows={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:border-brand-blue"
                placeholder="Optional — brief context helps the admin review faster." />
            </div>
            <div className="pt-2">
              <button type="submit" disabled={submitting}
                className="w-full px-4 py-2 bg-brand-blue hover:bg-brand-blue-dark text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {submitting ? 'Creating…' : 'Create account'}
              </button>
            </div>
          </form>

          <p className="text-[11px] text-gray-500 mt-6 text-center">
            By submitting, you agree to our{' '}
            <Link to="/terms" className="text-brand-blue hover:underline">Terms</Link> and{' '}
            <Link to="/privacy" className="text-brand-blue hover:underline">Privacy Policy</Link>.
          </p>
        </div>
      </main>
    </div>
  );
}
