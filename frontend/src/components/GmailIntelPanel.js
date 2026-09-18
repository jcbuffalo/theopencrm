// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// GmailIntelPanel — per-thread Gmail intel summary card for a deal.
//
// Mounted inside the DealPanel side-by-side with IntelSummaryPanel (Drive).
// Drives the full Gmail-intel UX flow on top of the Gmail foundation
// (PR #9 — connection, thread search, link, message sync). Three states:
//
//   - No threads linked → "Link an email thread" CTA opens GmailThreadPicker.
//     On confirm we POST the link (the picker handles that); we just
//     reload the thread list so the next state renders.
//   - Threads linked, no summary yet → thread selector + "Refresh intel"
//     button. We POST /api/deals/:id/gmail-intel/threads/:threadLinkId/refresh
//     which calls into services/gmailSummary.generate on the backend.
//   - Has summary → markdown body, key-facts pills, "Last generated X ago",
//     next-step pill if present, refresh button.
//
// If multiple threads are linked, a thread selector at the top lets the user
// pick which one to view; default is the most-recently-active thread (the
// list comes back ordered by last_message_at DESC from the backend).
//
// Hidden entirely (no error) when `gmail_intel_enabled` is off for the org.
// We detect this via 403 FEATURE_DISABLED on the thread-list probe and
// from a 503 "not configured" if Gmail OAuth isn't wired up at the
// platform level — same graceful-degradation pattern as IntelSummaryPanel.
//
// Props
//   dealId : number — required.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { gmailThreads } from '../api';
import GmailThreadPicker from './GmailThreadPicker';

// ---------------------------------------------------------------------------
// Tiny regex-based markdown → HTML transformer.
//
// COPIED VERBATIM from IntelSummaryPanel.js (intentionally — see spec). We
// keep this duplicated rather than extract a shared module so a Drive-side
// edit doesn't accidentally regress the Gmail card's rendering. The
// transformer is ~50 lines of pure code; the maintenance burden is real
// but bounded, and the alternative (one shared util) couples two
// independent features.
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdown(md) {
  if (!md) return { __html: '' };
  // 1. Extract fenced code blocks first and replace with placeholders so the
  // inline transforms below don't mangle them.
  const codeBlocks = [];
  let work = String(md).replace(/```([\s\S]*?)```/g, (_, code) => {
    const i = codeBlocks.length;
    codeBlocks.push(code);
    return ` CODEBLOCK${i} `;
  });

  // 2. Escape everything else.
  work = escapeHtml(work);

  // 3. Split into blocks by blank lines, transform each.
  const blocks = work.split(/\n\s*\n/);
  const html = blocks
    .map((block) => {
      const lines = block.split('\n');
      // Bullet list — consecutive lines starting with "- " or "* ".
      if (lines.every((l) => /^[-*]\s+/.test(l))) {
        const items = lines
          .map((l) => `<li>${inline(l.replace(/^[-*]\s+/, ''))}</li>`)
          .join('');
        return `<ul class="list-disc list-inside space-y-1">${items}</ul>`;
      }
      // Numbered list.
      if (lines.every((l) => /^\d+\.\s+/.test(l))) {
        const items = lines
          .map((l) => `<li>${inline(l.replace(/^\d+\.\s+/, ''))}</li>`)
          .join('');
        return `<ol class="list-decimal list-inside space-y-1">${items}</ol>`;
      }
      // Paragraph — preserve single newlines as <br> for terse line breaks.
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    })
    .join('\n');

  // 4. Restore fenced code blocks (escaped, monospaced).
  const restored = html.replace(
    / CODEBLOCK(\d+) /g,
    (_, i) =>
      `<pre class="bg-gray-100 rounded px-2 py-1 overflow-x-auto text-xs"><code>${escapeHtml(
        codeBlocks[Number(i)]
      )}</code></pre>`
  );

  return { __html: restored };
}

// Inline transforms — bold > italic > inline code. Order matters: code first
// so we don't bold inside backticks.
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code class="bg-gray-100 rounded px-1">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelative(ts) {
  if (!ts) return '';
  const then = new Date(ts).getTime();
  if (Number.isNaN(then)) return '';
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) {
    const m = Math.round(diffSec / 60);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (diffSec < 86400) {
    const h = Math.round(diffSec / 3600);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const d = Math.round(diffSec / 86400);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

const cardCls =
  'bg-white rounded shadow-card border border-gray-200 p-4 sm:p-6';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function GmailIntelPanel({ dealId, onHidden }) {
  // featureOff: true when backend returns 403 FEATURE_DISABLED on the
  // thread-list probe — we hide the panel entirely in that case.
  const [featureOff, setFeatureOff] = useState(false);
  // notConfigured: true when backend returns 503 (Gmail OAuth client not
  // configured at the platform level). Same UX as IntelSummaryPanel.
  const [notConfigured, setNotConfigured] = useState(false);

  const [threads, setThreads] = useState([]);
  const [selectedThreadLinkId, setSelectedThreadLinkId] = useState(null);
  const [summary, setSummary] = useState(null); // null = none yet for the selected thread
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Load the deal's thread list. On 403 FEATURE_DISABLED we hide. On 503 we
  // render the "not configured" sub-state.
  const loadThreads = useCallback(async () => {
    if (!dealId) return;
    setLoading(true);
    setError('');
    try {
      const data = await gmailThreads.list(dealId);
      const list = Array.isArray(data?.threads) ? data.threads : [];
      setThreads(list);
      setFeatureOff(false);
      setNotConfigured(false);
      // If no thread is selected yet, default to the most recently-active.
      // The backend orders by last_message_at DESC NULLS LAST so list[0] is
      // the right pick. Keep an existing selection if it's still in the list.
      setSelectedThreadLinkId((prev) => {
        if (prev && list.some((t) => t.id === prev)) return prev;
        return list.length > 0 ? list[0].id : null;
      });
    } catch (err) {
      const status = err?.response?.status;
      const code   = err?.response?.data?.code;
      if (status === 403 && code === 'FEATURE_DISABLED') {
        setFeatureOff(true);
      } else if (status === 503) {
        setNotConfigured(true);
      } else {
        setError(err?.response?.data?.error || 'Failed to load Gmail threads.');
      }
      setThreads([]);
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    loadThreads();
  }, [loadThreads]);

  useEffect(() => { if (featureOff) onHidden?.(); }, [featureOff, onHidden]);

  // Load the summary for the selected thread whenever it changes.
  const loadSummary = useCallback(async () => {
    if (!dealId || !selectedThreadLinkId) {
      setSummary(null);
      return;
    }
    setError('');
    try {
      const data = await gmailThreads.getThreadSummary(dealId, selectedThreadLinkId);
      setSummary(data || null);
    } catch (err) {
      const status = err?.response?.status;
      if (status === 404) {
        setSummary(null);
      } else if (status === 503) {
        setNotConfigured(true);
      } else {
        setError(err?.response?.data?.error || 'Failed to load Gmail intel summary.');
      }
    }
  }, [dealId, selectedThreadLinkId]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  // Picker confirmed a link → reload the thread list. The picker already
  // POSTed the link; we don't need to do it here.
  const handleThreadLinked = async () => {
    setPickerOpen(false);
    await loadThreads();
  };

  // Refresh: best-effort sync of the current thread first, then ask for a
  // fresh summary. The sync is non-fatal — if it fails (typically because
  // the rate limiter caught us, or the connection is broken) we still try
  // the summary refresh against whatever is already cached.
  const handleRefresh = async () => {
    if (refreshing || !selectedThreadLinkId) return;
    setRefreshing(true);
    setError('');
    try {
      setSyncing(true);
      try {
        await gmailThreads.sync(dealId, selectedThreadLinkId);
      } catch {
        // Sync failures are non-fatal here; the user may have already
        // synced recently. The summary refresh will tell us if there's
        // genuinely nothing extracted to summarize (422 NO_EXTRACTED_CONTENT).
      } finally {
        setSyncing(false);
      }
      const row = await gmailThreads.refreshThreadSummary(dealId, selectedThreadLinkId);
      if (row) setSummary(row);
      // Reload the thread list so message_count / last_message_at reflect
      // the new sync without forcing the user to switch threads.
      await loadThreads();
    } catch (err) {
      const status = err?.response?.status;
      const code   = err?.response?.data?.code;
      if (status === 402) {
        setError('AI usage cap reached for this org. Refresh blocked until the cap resets or you upgrade.');
      } else if (status === 429) {
        setError('Refreshed too often. Try again in a few minutes (5 refreshes per 15 min per thread).');
      } else if (status === 422 && code === 'NO_EXTRACTED_CONTENT') {
        setError('No extracted message content yet. The thread sync may still be in progress — wait a moment and try again.');
      } else if (status === 422 && code === 'BAD_MODEL_REPLY') {
        setError('AI returned an unparseable summary twice in a row. Try again later or pick a different thread.');
      } else {
        setError(err?.response?.data?.error || 'Failed to refresh Gmail intel.');
      }
    } finally {
      setRefreshing(false);
    }
  };

  const keyFacts = useMemo(() => {
    const raw = summary?.key_facts || [];
    return Array.isArray(raw) ? raw : [];
  }, [summary]);

  const selectedThread = useMemo(
    () => threads.find((t) => t.id === selectedThreadLinkId) || null,
    [threads, selectedThreadLinkId]
  );

  // -------------------------------------------------------------------------
  // States
  // -------------------------------------------------------------------------

  // Hidden entirely — feature off for this org. Render nothing so the
  // surrounding DealPanel layout doesn't reserve dead space.
  if (featureOff) return null;

  if (loading) {
    return (
      <div className={cardCls}>
        <div className="flex items-center gap-2 text-gray-500 text-sm">
          <span
            className="inline-block w-4 h-4 border-2 border-gray-300 border-t-brand-blue rounded-full animate-spin"
            aria-hidden="true"
          />
          <span>Loading Gmail intel…</span>
        </div>
      </div>
    );
  }

  if (notConfigured) {
    return (
      <div className={cardCls}>
        <h3 className="text-base font-semibold text-gray-900">
          Intel from Gmail
        </h3>
        <p className="mt-2 text-sm text-gray-700">
          Gmail integration is not enabled for this deployment.
        </p>
      </div>
    );
  }

  // No threads linked yet.
  if (threads.length === 0) {
    return (
      <>
        <div className={cardCls}>
          <h3 className="text-base font-semibold text-gray-900">
            Intel from Gmail
          </h3>
          <p className="mt-2 text-sm text-gray-700">
            Link an email thread to this deal and we'll summarize the
            conversation — quotes mentioned, next-step asks, blockers —
            into a running status snapshot.
          </p>
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="px-4 py-2 min-h-[44px] bg-brand-blue hover:bg-brand-blue-dark text-white rounded-lg text-sm font-medium"
            >
              Link an email thread
            </button>
          </div>
          {error ? (
            <div className="mt-3 bg-danger-50 border border-danger-200 text-danger-700 px-3 py-2 rounded text-sm">
              {error}
            </div>
          ) : null}
        </div>
        {pickerOpen ? (
          <div className="mt-3">
            <GmailThreadPicker dealId={dealId} onLinked={handleThreadLinked} />
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={() => setPickerOpen(false)}
                className="text-sm text-gray-600 underline"
              >
                Close picker
              </button>
            </div>
          </div>
        ) : null}
      </>
    );
  }

  const lastGenerated = summary?.generated_at;
  const nextStep = summary?.next_step || null;
  const showThreadSelector = threads.length > 1;

  // Linked but no summary for the selected thread yet.
  if (!summary) {
    return (
      <>
        <div className={cardCls}>
          <h3 className="text-base font-semibold text-gray-900">
            Intel from Gmail
          </h3>
          {showThreadSelector ? (
            <ThreadSelector
              threads={threads}
              value={selectedThreadLinkId}
              onChange={setSelectedThreadLinkId}
            />
          ) : (
            <p className="mt-1 text-xs text-gray-500 truncate">
              Thread: {selectedThread?.subject || '(no subject)'}
            </p>
          )}
          <p className="mt-2 text-sm text-gray-700">
            {selectedThread?.message_count
              ? `${selectedThread.message_count} message${selectedThread.message_count === 1 ? '' : 's'} in this thread.`
              : 'No messages synced yet for this thread.'}{' '}
            Click Refresh to generate the first intel summary.
          </p>
          <div className="mt-4 flex flex-wrap gap-2 items-center">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              className="px-4 py-2 min-h-[44px] bg-brand-blue hover:bg-brand-blue-dark text-white rounded-lg text-sm font-medium disabled:opacity-50"
            >
              {refreshing
                ? (syncing ? 'Syncing thread…' : 'Generating…')
                : 'Refresh intel'}
            </button>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="px-3 py-2 min-h-[44px] text-sm text-brand-blue underline"
            >
              Link another thread
            </button>
          </div>
          {error ? (
            <div className="mt-3 bg-danger-50 border border-danger-200 text-danger-700 px-3 py-2 rounded text-sm">
              {error}
            </div>
          ) : null}
        </div>
        {pickerOpen ? (
          <div className="mt-3">
            <GmailThreadPicker dealId={dealId} onLinked={handleThreadLinked} />
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={() => setPickerOpen(false)}
                className="text-sm text-gray-600 underline"
              >
                Close picker
              </button>
            </div>
          </div>
        ) : null}
      </>
    );
  }

  // -------------------------------------------------------------------------
  // Has a summary — full card.
  // -------------------------------------------------------------------------
  return (
    <>
      <div className={cardCls}>
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-gray-900">
              Intel from Gmail
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Last refreshed:{' '}
              <time
                dateTime={lastGenerated}
                title={new Date(lastGenerated).toLocaleString()}
              >
                {formatRelative(lastGenerated)}
              </time>
            </p>
          </div>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex-shrink-0 px-4 py-2 min-h-[44px] bg-brand-blue hover:bg-brand-blue-dark text-white rounded-lg text-sm font-medium disabled:opacity-50"
          >
            {refreshing
              ? (syncing ? 'Syncing thread…' : 'Refreshing…')
              : 'Refresh'}
          </button>
        </div>

        {/* Thread selector — only shown when there are multiple linked. */}
        {showThreadSelector ? (
          <div className="mt-3">
            <ThreadSelector
              threads={threads}
              value={selectedThreadLinkId}
              onChange={setSelectedThreadLinkId}
            />
          </div>
        ) : (
          <p className="mt-1 text-xs text-gray-500 truncate">
            Thread: {selectedThread?.subject || '(no subject)'}
          </p>
        )}

        {/* Next-step pill — first-class call-out so the rep sees the
            single most-important action without scanning the markdown. */}
        {nextStep ? (
          <div className="mt-4 border border-blue-200 bg-blue-50 rounded-lg p-3">
            <div className="text-[10px] uppercase font-semibold text-brand-blue tracking-wide mb-0.5">
              Next step
            </div>
            <div className="text-sm text-gray-900 break-words">{nextStep}</div>
          </div>
        ) : null}

        {/* Narrative */}
        {summary.summary_md ? (
          <div className="mt-4 border border-gray-200 rounded-lg p-3 bg-gray-50">
            <div
              className="prose prose-sm max-w-none text-sm text-gray-800 leading-relaxed break-words"
              // The renderer escapes input then re-introduces only the
              // whitelisted tags; no user-supplied script can survive.
              dangerouslySetInnerHTML={renderMarkdown(summary.summary_md)}
            />
          </div>
        ) : null}

        {/* Key facts */}
        {keyFacts.length > 0 ? (
          <div className="mt-4">
            <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
              Key facts
            </h4>
            <ul className="mt-2 flex flex-wrap gap-2">
              {keyFacts.map((kf, i) => (
                <li
                  key={i}
                  className="bg-blue-50 text-brand-blue border border-blue-100 rounded-full px-3 py-1 text-xs max-w-full break-words"
                  title={
                    kf.source_message_id
                      ? `Source message: ${kf.source_message_id}`
                      : undefined
                  }
                >
                  <span className="font-semibold">{kf.label}:</span>{' '}
                  <span className="font-normal">{kf.value}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-4">
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="text-sm text-brand-blue underline"
          >
            Link another thread
          </button>
        </div>

        {error ? (
          <div className="mt-3 bg-danger-50 border border-danger-200 text-danger-700 px-3 py-2 rounded text-sm flex items-start justify-between gap-2">
            <span className="break-words">{error}</span>
            <button
              type="button"
              onClick={loadSummary}
              className="text-danger-700 underline text-sm flex-shrink-0"
            >
              Retry
            </button>
          </div>
        ) : null}
      </div>
      {pickerOpen ? (
        <div className="mt-3">
          <GmailThreadPicker dealId={dealId} onLinked={handleThreadLinked} />
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={() => setPickerOpen(false)}
              className="text-sm text-gray-600 underline"
            >
              Close picker
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// ThreadSelector — small <select> shown when a deal has >1 linked thread.
// Lives in this file so it doesn't accidentally become a shared util.
// ---------------------------------------------------------------------------
function ThreadSelector({ threads, value, onChange }) {
  return (
    <label className="block mt-1">
      <span className="text-[10px] uppercase font-semibold text-gray-500 tracking-wide">
        Thread
      </span>
      <select
        value={value || ''}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Select Gmail thread"
        className="mt-1 block w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white"
      >
        {threads.map((t) => {
          const when = t.last_message_at
            ? new Date(t.last_message_at).toLocaleDateString()
            : 'no messages yet';
          const subject = t.subject || '(no subject)';
          return (
            <option key={t.id} value={t.id}>
              {subject} — {when}
            </option>
          );
        })}
      </select>
    </label>
  );
}
