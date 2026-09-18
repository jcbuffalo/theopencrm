// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';

export default function AcceptInvite() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { signIn } = useAuth();
  const [invite, setInvite] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [form, setForm] = useState({ name: '', password: '', confirm: '' });
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  const API = process.env.REACT_APP_API_URL || 'http://localhost:5001/api';

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API}/invites/${token}`);
        const data = await res.json();
        if (!res.ok) { setErr(data.error || 'Invalid invite'); return; }
        setInvite(data.invite);
      } catch {
        setErr('Failed to load invite');
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  const submit = async e => {
    e.preventDefault();
    if (form.password !== form.confirm) { setErr('Passwords do not match'); return; }
    setSubmitting(true);
    setErr('');
    try {
      const res = await fetch(`${API}/invites/${token}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.name, password: form.password }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error || 'Failed to join'); setSubmitting(false); return; }

      signIn(data.user.email, data.user.name, data.user.id);
      setSuccess(true);
      setTimeout(() => navigate('/'), 2000);
    } catch {
      setErr('Something went wrong. Please try again.');
      setSubmitting(false);
    }
  };

  const f = key => ({ value: form[key], onChange: e => { setForm(p => ({ ...p, [key]: e.target.value })); setErr(''); } });
  const inputCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500';

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (err && !invite) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="bg-white rounded-2xl shadow p-8 max-w-md w-full text-center">
          <div className="text-4xl mb-3">🚫</div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">Invite Unavailable</h2>
          <p className="text-gray-600 text-sm">{err}</p>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="bg-white rounded-2xl shadow p-8 max-w-md w-full text-center">
          <div className="text-4xl mb-3">🎉</div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">Welcome to the team!</h2>
          <p className="text-gray-500 text-sm">Redirecting you to the dashboard…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-blue-600 mb-1">The Open CRM</h1>
          <p className="text-gray-500 text-sm">You've been invited to join</p>
          <div className="mt-3 inline-block bg-blue-50 border border-blue-200 rounded-lg px-4 py-2">
            <p className="font-semibold text-blue-800">{invite.org_name}</p>
          </div>
        </div>

        <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 mb-5 text-sm text-center">
          Joining as <strong>{invite.email}</strong>
        </div>

        {err && <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg mb-4">{err}</p>}

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Your Name</label>
            <input {...f('name')} className={inputCls} placeholder="Jane Smith" autoFocus required />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Create Password</label>
            <input type="password" {...f('password')} className={inputCls} placeholder="8+ characters" required />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Confirm Password</label>
            <input type="password" {...f('confirm')} className={inputCls} placeholder="Same password" required />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full py-2.5 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 transition text-sm"
          >
            {submitting ? 'Joining…' : 'Join Workspace'}
          </button>
        </form>
      </div>
    </div>
  );
}
