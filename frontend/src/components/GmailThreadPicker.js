// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// GmailThreadPicker — search Gmail and link a thread to a deal.
//
// Drop-in panel for the Deal detail page. Renders a search input, fires
// /api/gmail/threads/search?q= with debounce, and shows results as a
// scrollable list. Each row has a "Link" button that posts to
// /api/deals/:id/gmail-threads.
//
// PROPS
//   dealId     — number; the deal we're linking threads to.
//   onLinked   — optional callback fired after a successful link, so the
//                parent can refresh its thread list.
//
// EMPTY / ERROR STATES
//   - Empty query → seed an empty list, do NOT fire a network call.
//   - 503 from search → render the operator-facing "Gmail not configured"
//     hint, no inputs.
//   - 409 → "reconnect Gmail" guidance (typical when the connection is
//     present but token has been revoked at Google).
//   - Other errors → inline banner with a Retry button.
//
// QUERY GRAMMAR
//   The `q` parameter is forwarded verbatim to Gmail's users.threads.list,
//   which accepts the same operators as the Gmail search box: `from:`,
//   `to:`, `subject:`, `after:`, etc. We don't try to translate or
//   sanitize beyond a 500-char cap on the backend.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { gmailThreads } from '../api';

const DEBOUNCE_MS = 350;

export default function GmailThreadPicker({ dealId, onLinked }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [notConfigured, setNotConfigured] = useState(false);
  const [linkingId, setLinkingId] = useState(null);
  const [linkedIds, setLinkedIds] = useState(new Set());

  // Cancel-on-stale ref — if the user types a second time before the
  // first response arrives, ignore the first. A monotonically-increasing
  // counter beats a per-request boolean because it's robust against
  // out-of-order fetches.
  const reqSeqRef = useRef(0);

  const runSearch = useCallback(async (q) => {
    const myReqId = ++reqSeqRef.current;
    setError('');
    if (!q || !q.trim()) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    try {
      const data = await gmailThreads.search(q);
      if (reqSeqRef.current !== myReqId) return; // a newer search has started
      setNotConfigured(false);
      setResults(Array.isArray(data?.threads) ? data.threads : []);
    } catch (err) {
      if (reqSeqRef.current !== myReqId) return;
      const status = err?.response?.status;
      const code = err?.response?.data?.error || '';
      if (status === 503 && /not configured|not enabled/i.test(code)) {
        setNotConfigured(true);
        setResults([]);
      } else if (status === 409) {
        setError(
          'Gmail is not connected for this org. Ask an admin to connect a Google account in Settings.'
        );
        setResults([]);
      } else if (status === 401) {
        setError(
          'Gmail connection is no longer authorized. Disconnect and reconnect in Settings.'
        );
        setResults([]);
      } else {
        setError(
          err?.response?.data?.error || 'Search failed. Try again.'
        );
        setResults([]);
      }
    } finally {
      if (reqSeqRef.current === myReqId) setSearching(false);
    }
  }, []);

  // Debounced search-on-type.
  useEffect(() => {
    const t = setTimeout(() => {
      runSearch(query);
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, runSearch]);

  const handleLink = async (thread) => {
    setLinkingId(thread.gmail_thread_id);
    setError('');
    try {
      await gmailThreads.link(dealId, {
        gmail_thread_id: thread.gmail_thread_id,
        subject: thread.subject,
      });
      setLinkedIds((prev) => {
        const next = new Set(prev);
        next.add(thread.gmail_thread_id);
        return next;
      });
      if (typeof onLinked === 'function') {
        try { onLinked(thread); } catch { /* parent handler errors don't break the picker */ }
      }
    } catch (err) {
      setError(
        err?.response?.data?.error || 'Failed to link thread. Try again.'
      );
    } finally {
      setLinkingId(null);
    }
  };

  if (notConfigured) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 sm:p-6">
        <h3 className="text-base font-semibold text-gray-900">
          Link a Gmail thread
        </h3>
        <p className="mt-2 text-sm text-gray-700">
          Gmail integration is not enabled for this deployment.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 sm:p-6">
      <h3 className="text-base font-semibold text-gray-900 mb-2">
        Link a Gmail thread
      </h3>
      <p className="text-xs text-gray-600 mb-3">
        Search uses the Gmail query grammar — e.g.{' '}
        <code className="bg-gray-100 px-1 rounded">from:vendor@example.com</code>{' '}
        or <code className="bg-gray-100 px-1 rounded">subject:&quot;RFQ 1234&quot;</code>.
      </p>

      <input
        type="search"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search your inbox…"
        aria-label="Search Gmail threads"
        className="w-full px-3 py-2 min-h-[44px] text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-blue/40 focus:border-brand-blue"
      />

      {error ? (
        <div
          role="alert"
          className="mt-3 bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm break-words"
        >
          {error}
        </div>
      ) : null}

      <div className="mt-3 max-h-96 overflow-y-auto -mx-2 sm:mx-0">
        {searching ? (
          <div className="flex items-center gap-2 text-gray-500 text-sm px-2 py-3">
            <span
              className="inline-block w-4 h-4 border-2 border-gray-300 border-t-brand-blue rounded-full animate-spin"
              aria-hidden="true"
            />
            Searching…
          </div>
        ) : results.length === 0 ? (
          <p className="text-sm text-gray-500 px-2 py-3">
            {query.trim()
              ? 'No threads match that search.'
              : 'Type a query above to find threads.'}
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {results.map((t) => {
              const alreadyLinked = linkedIds.has(t.gmail_thread_id);
              const isLinking = linkingId === t.gmail_thread_id;
              return (
                <li
                  key={t.gmail_thread_id}
                  className="px-2 py-3 flex items-start justify-between gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {t.subject || '(no subject)'}
                    </p>
                    {Array.isArray(t.participants) && t.participants.length > 0 ? (
                      <p className="text-xs text-gray-500 truncate">
                        {t.participants.slice(0, 4).join(', ')}
                        {t.participants.length > 4 ? ` +${t.participants.length - 4} more` : ''}
                      </p>
                    ) : null}
                    {t.snippet ? (
                      <p className="text-xs text-gray-600 mt-1 line-clamp-2 break-words">
                        {t.snippet}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleLink(t)}
                    disabled={isLinking || alreadyLinked}
                    className={
                      alreadyLinked
                        ? 'flex-shrink-0 px-3 py-2 min-h-[36px] rounded-lg text-sm font-medium bg-green-50 text-green-700 border border-green-200 cursor-default'
                        : 'flex-shrink-0 px-3 py-2 min-h-[36px] rounded-lg text-sm font-medium bg-brand-blue hover:bg-brand-blue-dark text-white disabled:opacity-50'
                    }
                  >
                    {alreadyLinked ? 'Linked' : isLinking ? 'Linking…' : 'Link'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
