// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useState } from 'react';
import { Link } from 'react-router-dom';

// PUBLIC PAGE — no auth required. Accessible at /data-deletion.
// Required by Google Play / Google OAuth User Data Policy: a published URL
// where users can request deletion of their account and personal data.

export default function DataDeletion() {
  const [form, setForm] = useState({ email: '', reason: '', confirm: false });
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!form.email || !form.confirm) return;
    setError('');
    try {
      const API = process.env.REACT_APP_API_URL || 'http://localhost:5001/api';
      await fetch(`${API}/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Data Deletion Request',
          email: form.email,
          message: `Account deletion request for: ${form.email}\n\nReason (optional): ${form.reason || '(not provided)'}`,
          interest: 'data-deletion',
        }),
      });
      setSent(true);
    } catch {
      setError('Failed to submit request. Please email johnbcoles@gmail.com directly.');
    }
  };

  return (
    <div className="min-h-screen bg-white">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <Link to="/" className="text-xl font-bold text-blue-600">The Open CRM</Link>
          <div className="flex gap-4 text-sm">
            <Link to="/" className="text-gray-600 hover:text-gray-900 inline-flex items-center min-h-[32px]">Home</Link>
            <Link to="/privacy" className="text-gray-600 hover:text-gray-900 inline-flex items-center min-h-[32px]">Privacy</Link>
            <Link to="/terms" className="text-gray-600 hover:text-gray-900 inline-flex items-center min-h-[32px]">Terms</Link>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12 [&_a]:inline-block [&_a]:py-1 [&_a]:align-middle [&_a]:text-brand-blue-darker">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Delete your account and data</h1>
        <p className="text-gray-600 mb-8">You can request permanent deletion of your account and the personal data we hold about you at any time.</p>

        <section className="bg-blue-50 border border-blue-200 rounded-lg p-6 mb-8">
          <h2 className="text-lg font-bold text-gray-900 mb-2">What gets deleted</h2>
          <ul className="list-disc list-inside text-sm text-gray-700 space-y-1">
            <li>Your account record (email, name, password hash, Google sign-in association)</li>
            <li>Your authentication sessions</li>
            <li>Your terms-acceptance record</li>
            <li>Personal data you uploaded that is not part of business records owned by an organization you belong to</li>
          </ul>
          <h3 className="text-sm font-semibold text-gray-900 mt-4 mb-1">What is retained</h3>
          <ul className="list-disc list-inside text-sm text-gray-700 space-y-1">
            <li>
              Business records you contributed to a shared workspace (e.g., contacts, deals, quotes that other org
              members rely on) — these belong to the workspace owner. To remove these, request deletion via your
              workspace owner.
            </li>
            <li>
              Audit log entries — retained for security and compliance purposes, with personal identifiers
              pseudonymized after deletion.
            </li>
            <li>
              Backups — automatically purged according to our backup retention policy (typically within 30 days).
            </li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-lg font-bold text-gray-900 mb-3">How to request deletion</h2>
          <div className="space-y-3">
            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <h3 className="font-semibold text-gray-900 text-sm mb-1">Option 1 — Email us</h3>
              <p className="text-sm text-gray-700">
                Send an email from the address associated with your account to{' '}
                <a href="mailto:johnbcoles@gmail.com?subject=Data%20Deletion%20Request" className="text-blue-600 hover:underline font-medium">
                  johnbcoles@gmail.com
                </a>{' '}
                with the subject line "Data Deletion Request". We will verify your identity and complete the deletion
                within 30 days.
              </p>
            </div>

            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <h3 className="font-semibold text-gray-900 text-sm mb-1">Option 2 — Submit the form below</h3>
              {sent ? (
                <div className="bg-green-50 border border-green-200 rounded p-3 text-sm text-green-900">
                  ✓ Your deletion request has been received. We'll confirm completion to your email within 30 days. If
                  you do not hear back, please email <a href="mailto:johnbcoles@gmail.com" className="underline">johnbcoles@gmail.com</a> directly.
                </div>
              ) : (
                <form onSubmit={submit} className="space-y-3 mt-2">
                  {error && <div className="bg-red-50 text-red-700 px-3 py-2 rounded text-sm">{error}</div>}
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Email address on your account *</label>
                    <input
                      type="email" required
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                      placeholder="you@example.com"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Reason (optional)</label>
                    <textarea
                      rows={3}
                      value={form.reason}
                      onChange={(e) => setForm({ ...form, reason: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                      placeholder="Optional — helps us improve the product."
                    />
                  </div>
                  <label className="flex items-start gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox" required
                      checked={form.confirm}
                      onChange={(e) => setForm({ ...form, confirm: e.target.checked })}
                      className="mt-1"
                    />
                    <span>
                      I understand this will permanently delete my account and that this action cannot be undone.
                      Business records contributed to a shared workspace will remain with that workspace.
                    </span>
                  </label>
                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={!form.email || !form.confirm}
                      className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >Submit deletion request</button>
                  </div>
                </form>
              )}
            </div>

            <div className="bg-white border border-gray-200 rounded-lg p-4">
              <h3 className="font-semibold text-gray-900 text-sm mb-1">Option 3 — Revoke Google access (Google Sign-In users)</h3>
              <p className="text-sm text-gray-700">
                If you signed in with Google, you can also revoke this app's access to your Google account at{' '}
                <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline hover:no-underline">myaccount.google.com/permissions</a>.
                This stops new authentication but does not delete data we already hold — please also use Option 1 or 2
                above.
              </p>
            </div>
          </div>
        </section>

        <section className="mb-8">
          <h2 className="text-lg font-bold text-gray-900 mb-2">Timeline & confirmation</h2>
          <ul className="list-disc list-inside text-sm text-gray-700 space-y-1">
            <li>We confirm receipt within 5 business days.</li>
            <li>We complete deletion within 30 calendar days, often faster.</li>
            <li>We email confirmation when deletion is complete.</li>
            <li>Backups containing your data are purged on our standard rolling backup cycle (no later than 30 additional days).</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-bold text-gray-900 mb-2">Other rights</h2>
          <p className="text-sm text-gray-700">
            You can also request access to your data, correction, or export. See the{' '}
            <Link to="/privacy" className="text-blue-600 underline hover:no-underline">Privacy Policy</Link> for full details.
          </p>
        </section>
      </main>

      <footer className="border-t border-gray-200 mt-12">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 text-xs text-gray-500 flex justify-between flex-wrap gap-3">
          <span>© 2026 John Coles. All rights reserved.</span>
          <div className="flex gap-2 sm:gap-4 flex-wrap items-center">
            <Link to="/privacy"        className="hover:text-gray-700 inline-flex items-center min-h-[32px] px-1">Privacy</Link>
            <Link to="/terms"          className="hover:text-gray-700 inline-flex items-center min-h-[32px] px-1">Terms</Link>
            <Link to="/data-deletion"  className="hover:text-gray-700 inline-flex items-center min-h-[32px] px-1">Delete data</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
