// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';

// Public lead-capture page — /f/:token. NO AUTH: this renders for anonymous
// visitors (shared link or embedded iframe). It talks only to the public,
// CSRF-exempt, rate-limited endpoints:
//   GET  /api/public/lead-forms/:token         → { name, fields }
//   POST /api/public/lead-forms/:token/submit  → { ok, redirect_url }
// The response never carries org internals, and neither does this page.

const FIELD_META = {
  email:        { label: 'Email',           type: 'email' },
  phone:        { label: 'Phone',           type: 'tel' },
  company_name: { label: 'Company',         type: 'text' },
  title:        { label: 'Job title',       type: 'text' },
  notes:        { label: 'How can we help?', type: 'textarea' },
};

export default function LeadForm() {
  const { token } = useParams();
  const [form, setForm] = useState(null);     // { name, fields }
  const [missing, setMissing] = useState(false);
  const [values, setValues] = useState({ name: '' });
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get(`/public/lead-forms/${encodeURIComponent(token)}`)
      .then((r) => setForm(r.data))
      .catch(() => setMissing(true));
  }, [token]);

  const set = (k) => (e) => setValues((v) => ({ ...v, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (!values.name.trim()) { setError('Please tell us your name.'); return; }
    setSubmitting(true); setError(null);
    try {
      const res = await api.post(`/public/lead-forms/${encodeURIComponent(token)}/submit`, values);
      if (res.data?.redirect_url) {
        window.location.assign(res.data.redirect_url);
        return;
      }
      setDone(true);
    } catch (err) {
      setError(
        err.response?.status === 429
          ? 'Too many submissions from your network right now — please try again in a few minutes.'
          : err.response?.data?.error || 'Something went wrong. Please try again.'
      );
      setSubmitting(false);
    }
  };

  const shell = (children) => (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md bg-white border border-gray-200 rounded-2xl shadow-sm p-6 sm:p-8">
        {children}
      </div>
    </div>
  );

  if (missing) {
    return shell(
      <div className="text-center py-6">
        <div className="text-4xl mb-3" aria-hidden="true">🔍</div>
        <h1 className="text-lg font-semibold text-gray-900 mb-1">This form isn't available</h1>
        <p className="text-sm text-gray-600">The link may have expired or been turned off. If someone sent it to you, ask them for a fresh one.</p>
      </div>
    );
  }

  if (!form) {
    return shell(
      <div className="flex justify-center py-10">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary-600" />
      </div>
    );
  }

  if (done) {
    return shell(
      <div className="text-center py-6" role="status">
        <div className="text-4xl mb-3" aria-hidden="true">✅</div>
        <h1 className="text-lg font-semibold text-gray-900 mb-1">Thanks — got it!</h1>
        <p className="text-sm text-gray-600">Your message is on its way. Someone will be in touch soon.</p>
      </div>
    );
  }

  const enabledFields = Object.keys(FIELD_META).filter((k) => form.fields?.[k]);

  return shell(
    <form onSubmit={submit} noValidate>
      <h1 className="text-xl font-bold text-gray-900 mb-1">{form.name}</h1>
      <p className="text-sm text-gray-500 mb-5">Leave your details and we'll get back to you.</p>

      {error && <div className="mb-4 px-3 py-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg" role="alert">{error}</div>}

      <label className="block mb-3">
        <span className="text-xs font-medium text-gray-600">Name *</span>
        <input
          value={values.name}
          onChange={set('name')}
          required
          autoComplete="name"
          className="mt-1 w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-brand-blue"
        />
      </label>

      {enabledFields.map((k) => {
        const meta = FIELD_META[k];
        return (
          <label key={k} className="block mb-3">
            <span className="text-xs font-medium text-gray-600">{meta.label}</span>
            {meta.type === 'textarea' ? (
              <textarea
                value={values[k] || ''}
                onChange={set(k)}
                rows={4}
                className="mt-1 w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-brand-blue"
              />
            ) : (
              <input
                value={values[k] || ''}
                onChange={set(k)}
                type={meta.type}
                autoComplete={k === 'email' ? 'email' : k === 'phone' ? 'tel' : k === 'company_name' ? 'organization' : 'off'}
                className="mt-1 w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-brand-blue"
              />
            )}
          </label>
        );
      })}

      <button
        type="submit"
        disabled={submitting}
        className="mt-2 w-full min-h-[44px] bg-brand-blue hover:bg-brand-blue-dark disabled:bg-brand-blue/60 text-white font-semibold text-sm rounded-lg transition"
      >
        {submitting ? 'Sending…' : 'Send'}
      </button>
    </form>
  );
}
