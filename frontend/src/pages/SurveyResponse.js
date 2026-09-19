// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';

// Public survey-response page — /s/:token. NO AUTH: this renders for anonymous
// respondents following a shared or emailed link. It talks only to the public,
// CSRF-exempt, rate-limited endpoints (mirrors pages/LeadForm.js):
//   GET  /api/public/surveys/:token          → { name, question, kind, scale, responded }
//   POST /api/public/surveys/:token/respond  → { ok, already_responded }
// The response never carries org internals, and neither does this page.
// A token records exactly one response — retries land on the thank-you state.

export default function SurveyResponse() {
  const { token } = useParams();
  const [survey, setSurvey] = useState(null);   // { name, question, kind, scale, responded }
  const [missing, setMissing] = useState(false);
  const [score, setScore] = useState(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get(`/public/surveys/${encodeURIComponent(token)}`)
      .then((r) => {
        setSurvey(r.data);
        if (r.data?.responded) setDone(true); // already answered — straight to thanks
      })
      .catch(() => setMissing(true));
  }, [token]);

  const submit = async (e) => {
    e.preventDefault();
    if (score == null) { setError('Please pick a score first.'); return; }
    setSubmitting(true); setError(null);
    try {
      await api.post(`/public/surveys/${encodeURIComponent(token)}/respond`, {
        score,
        comment: comment.trim() || undefined,
      });
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
      <div className="w-full max-w-lg">
        <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 sm:p-8">
          {children}
        </div>
        <p className="text-center text-[11px] text-gray-400 mt-4">
          Powered by <a href="https://app.theopencrm.com" target="_blank" rel="noreferrer" className="text-gray-500 hover:text-gray-700 underline">The Open CRM</a> →
        </p>
      </div>
    </div>
  );

  if (missing) {
    return shell(
      <div className="text-center py-6">
        <div className="text-4xl mb-3" aria-hidden="true">🔍</div>
        <h1 className="text-lg font-semibold text-gray-900 mb-1">This survey isn't available</h1>
        <p className="text-sm text-gray-600">The link may have expired or been turned off. If someone sent it to you, ask them for a fresh one.</p>
      </div>
    );
  }

  if (!survey) {
    return shell(
      <div className="flex justify-center py-10">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary-600" />
      </div>
    );
  }

  if (done) {
    return shell(
      <div className="text-center py-6" role="status">
        <div className="text-4xl mb-3" aria-hidden="true">🙏</div>
        <h1 className="text-lg font-semibold text-gray-900 mb-1">Thanks for your feedback!</h1>
        <p className="text-sm text-gray-600">Your response has been recorded.</p>
      </div>
    );
  }

  const min = survey.scale?.min ?? 0;
  const max = survey.scale?.max ?? 10;
  const scores = [];
  for (let s = min; s <= max; s++) scores.push(s);
  const isNps = survey.kind === 'nps';

  return shell(
    <form onSubmit={submit} noValidate>
      <h1 className="text-xl font-bold text-gray-900 mb-1">{survey.name}</h1>
      <p className="text-sm text-gray-600 mb-5">{survey.question}</p>

      {error && <div className="mb-4 px-3 py-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg" role="alert">{error}</div>}

      <div className="flex flex-wrap gap-1.5 justify-center mb-1" role="radiogroup" aria-label="Score">
        {scores.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={score === s}
            onClick={() => setScore(s)}
            className={`min-w-[38px] min-h-[44px] px-2 rounded-lg border text-sm font-semibold transition ${
              score === s
                ? 'bg-brand-blue text-white border-brand-blue'
                : 'bg-white text-gray-700 border-gray-300 hover:border-brand-blue'
            }`}
          >
            {s}
          </button>
        ))}
      </div>
      <div className="flex justify-between text-[11px] text-gray-400 mb-4 px-1">
        <span>{isNps ? 'Not at all likely' : 'Very unsatisfied'}</span>
        <span>{isNps ? 'Extremely likely' : 'Very satisfied'}</span>
      </div>

      <label className="block mb-4">
        <span className="text-xs font-medium text-gray-600">Anything you'd like to add? (optional)</span>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={4}
          maxLength={4000}
          className="mt-1 w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-brand-blue"
        />
      </label>

      <button
        type="submit"
        disabled={submitting}
        className="w-full min-h-[44px] bg-brand-blue hover:bg-brand-blue-dark disabled:bg-brand-blue/60 text-white font-semibold text-sm rounded-lg transition"
      >
        {submitting ? 'Sending…' : 'Submit feedback'}
      </button>
    </form>
  );
}
