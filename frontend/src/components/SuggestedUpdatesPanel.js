// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// SuggestedUpdatesPanel — render Drive-intel writeback suggestions for a deal.
//
// Tabs:
//   - Pending:           per-field Apply / Reject cards.
//   - Recently applied:  list of writebacks (within 7d) with Undo button,
//                        disabled when appliedAt + 7d < now.
//
// Visibility:
//   - When `writebackEnabled` prop is false → render NOTHING (returns null).
//     Mirrors the spec: hide entire panel when the feature flag is off;
//     do not show an error / banner.
//   - When the backend returns 403/404/503 for the writeback endpoints,
//     we treat it as "flag flipped off mid-session" and hide silently.
//
// Apply flow & stale-data UX:
//   - On 409 STALE_DATA: refetch the list, surface a small inline
//     "Deal changed since suggested — review again" notice on the affected
//     row.
//
// Props:
//   - writebackEnabled : boolean      (derived in IntelSummaryPanel)
//   - dealId           : number
//   - summaryId        : number|null  (reserved; current backend always
//                                      generates against the latest summary)

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { drive } from '../api';

const cardCls =
  'bg-white rounded shadow-card border border-gray-200 p-4 sm:p-6';

// 7-day undo window — server is the source of truth; this matches it so
// the UI can pre-disable the Undo button rather than relying on a
// round-trip + 409 to discover the window is gone.
const UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function fieldLabel(field) {
  if (field === 'stage') return 'Stage';
  if (field === 'notes') return 'Notes (append)';
  if (field === 'expected_close_date') return 'Expected close date';
  return field;
}

function fmtValue(field, value) {
  if (value == null || value === '') return <em className="text-gray-400">empty</em>;
  if (field === 'notes') {
    const s = String(value);
    const preview = s.length > 240 ? s.slice(0, 240) + '…' : s;
    return <span className="whitespace-pre-wrap break-words">{preview}</span>;
  }
  if (field === 'expected_close_date') {
    // Tolerate either Date-from-pg or 'YYYY-MM-DD' string.
    const s = String(value).slice(0, 10);
    return s;
  }
  return String(value);
}

function fmtRelative(ts) {
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

export default function SuggestedUpdatesPanel({ writebackEnabled, dealId, summaryId }) {
  const [tab, setTab] = useState('pending');
  const [pending, setPending] = useState([]);
  const [writebacks, setWritebacks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [rowMessages, setRowMessages] = useState({}); // suggestionId → string
  const [hidden, setHidden] = useState(false); // flips true on 403/404/503

  const reload = useCallback(async () => {
    if (!writebackEnabled || !dealId || hidden) return;
    setLoading(true);
    setError('');
    try {
      const [sugRes, wbRes] = await Promise.allSettled([
        drive.listSuggestions(dealId, 'pending'),
        drive.listWritebacks(dealId),
      ]);

      // Both endpoints behind the writeback flag — if either replies
      // with the "feature off" signal, hide the entire panel.
      const flagOff = [sugRes, wbRes].some((r) => {
        if (r.status !== 'rejected') return false;
        const s = r.reason?.response?.status;
        const msg = r.reason?.response?.data?.error || '';
        return s === 503 || s === 403 ||
          (s === 404 && /feature/i.test(msg));
      });
      if (flagOff) {
        setHidden(true);
        return;
      }

      if (sugRes.status === 'fulfilled') {
        setPending(Array.isArray(sugRes.value) ? sugRes.value : []);
      } else if (sugRes.reason?.response?.status !== 404) {
        throw sugRes.reason;
      } else {
        setPending([]);
      }
      if (wbRes.status === 'fulfilled') {
        setWritebacks(Array.isArray(wbRes.value) ? wbRes.value : []);
      } else if (wbRes.reason?.response?.status !== 404) {
        throw wbRes.reason;
      } else {
        setWritebacks([]);
      }
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to load suggestions.');
    } finally {
      setLoading(false);
    }
  }, [writebackEnabled, dealId, hidden]);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleGenerate = async () => {
    if (generating) return;
    setGenerating(true);
    setError('');
    try {
      await drive.suggestWriteback(dealId, summaryId);
      await reload();
    } catch (err) {
      const status = err?.response?.status;
      const code = err?.response?.data?.code;
      if (status === 402) {
        setError(
          'AI usage cap reached — generating suggestions is blocked until the cap resets or you upgrade.'
        );
      } else if (status === 429) {
        setError(
          'Too many suggestion requests for this deal. Try again in a few minutes (5 per 15 min).'
        );
      } else if (status === 400 && code === 'NO_SUMMARY') {
        setError(
          'Generate an intel summary first — there\'s nothing to base suggestions on yet.'
        );
      } else if (status === 503 || status === 403) {
        setHidden(true);
      } else {
        setError(err?.response?.data?.error || 'Failed to generate suggestions.');
      }
    } finally {
      setGenerating(false);
    }
  };

  const handleApply = async (sug) => {
    setRowMessages((m) => ({ ...m, [sug.id]: '' }));
    try {
      await drive.applySuggestion(dealId, sug.id);
      await reload();
      setTab('applied');
    } catch (err) {
      const status = err?.response?.status;
      const code = err?.response?.data?.code;
      if (status === 409 && code === 'STALE_DATA') {
        setRowMessages((m) => ({
          ...m,
          [sug.id]: 'Deal changed since suggested — review again.',
        }));
        await reload();
      } else {
        setRowMessages((m) => ({
          ...m,
          [sug.id]: err?.response?.data?.error || 'Apply failed.',
        }));
      }
    }
  };

  const handleReject = async (sug) => {
    setRowMessages((m) => ({ ...m, [sug.id]: '' }));
    try {
      await drive.rejectSuggestion(dealId, sug.id);
      await reload();
    } catch (err) {
      setRowMessages((m) => ({
        ...m,
        [sug.id]: err?.response?.data?.error || 'Reject failed.',
      }));
    }
  };

  const handleUndo = async (wb) => {
    setRowMessages((m) => ({ ...m, [`wb-${wb.id}`]: '' }));
    try {
      await drive.undoWriteback(dealId, wb.id);
      await reload();
    } catch (err) {
      const status = err?.response?.status;
      if (status === 409) {
        setRowMessages((m) => ({
          ...m,
          [`wb-${wb.id}`]:
            err?.response?.data?.error ||
            'Cannot undo (window expired or already undone).',
        }));
      } else {
        setRowMessages((m) => ({
          ...m,
          [`wb-${wb.id}`]: err?.response?.data?.error || 'Undo failed.',
        }));
      }
    }
  };

  const tabBtnCls = (active) =>
    `px-3 py-2 min-h-[40px] text-sm font-medium rounded-t-lg border-b-2 -mb-px ${
      active
        ? 'border-brand-blue text-brand-blue'
        : 'border-transparent text-gray-500 hover:text-gray-700'
    }`;

  const recentlyApplied = useMemo(() => writebacks, [writebacks]);

  if (!writebackEnabled || hidden) return null;

  return (
    <div className={cardCls}>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-gray-900">
            Suggested updates from Drive intel
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            AI proposes CRM-field updates against an allowlist (stage, notes,
            expected close date). Apply/reject per row. Applied writes are
            undoable for 7 days.
          </p>
        </div>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={generating || loading}
          className="flex-shrink-0 px-4 py-2 min-h-[44px] bg-brand-blue hover:bg-brand-blue-dark text-white rounded-lg text-sm font-medium disabled:opacity-50"
        >
          {generating ? 'Generating…' : 'Generate suggestions'}
        </button>
      </div>

      <div className="mt-4 border-b border-gray-200 flex gap-1">
        <button
          type="button"
          className={tabBtnCls(tab === 'pending')}
          onClick={() => setTab('pending')}
        >
          Pending ({pending.length})
        </button>
        <button
          type="button"
          className={tabBtnCls(tab === 'applied')}
          onClick={() => setTab('applied')}
        >
          Recently applied ({recentlyApplied.length})
        </button>
      </div>

      {error ? (
        <div className="mt-3 bg-danger-50 border border-danger-200 text-danger-700 px-3 py-2 rounded text-sm">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="mt-4 flex items-center gap-2 text-gray-500 text-sm">
          <span
            className="inline-block w-4 h-4 border-2 border-gray-300 border-t-brand-blue rounded-full animate-spin"
            aria-hidden="true"
          />
          <span>Loading…</span>
        </div>
      ) : tab === 'pending' ? (
        pending.length === 0 ? (
          <p className="mt-4 text-sm text-gray-600">
            No pending suggestions. Click <em>Generate suggestions</em> to ask
            the AI for proposed updates based on the latest intel summary.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {pending.map((sug) => {
              const confPct = sug.confidence == null
                ? null
                : Math.round(Number(sug.confidence) * 100);
              return (
                <li
                  key={sug.id}
                  className="border border-gray-200 rounded-lg p-3 bg-gray-50"
                >
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold uppercase tracking-wide text-gray-600">
                        {fieldLabel(sug.field)}
                      </p>
                      <div className="mt-1 text-sm text-gray-900 grid grid-cols-1 sm:grid-cols-[auto_auto_1fr] gap-x-3 gap-y-1">
                        <span className="text-gray-500">Current:</span>
                        <span className="text-gray-500">→</span>
                        <span className="break-words">{fmtValue(sug.field, sug.current_value)}</span>
                        <span className="text-gray-500">Proposed:</span>
                        <span className="text-brand-blue">→</span>
                        <span className="break-words font-medium">{fmtValue(sug.field, sug.proposed_value)}</span>
                      </div>
                      {sug.reason ? (
                        <p className="mt-2 text-xs text-gray-600 italic break-words">
                          {sug.reason}
                        </p>
                      ) : null}
                      {confPct !== null ? (
                        <div className="mt-2">
                          <div
                            className="h-1.5 bg-gray-200 rounded-full overflow-hidden"
                            role="progressbar"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={confPct}
                            aria-label={`Confidence ${confPct}%`}
                          >
                            <div
                              className="h-full bg-brand-blue"
                              style={{ width: `${confPct}%` }}
                            />
                          </div>
                          <p className="text-[11px] text-gray-500 mt-0.5">
                            Confidence: {confPct}%
                          </p>
                        </div>
                      ) : null}
                      {rowMessages[sug.id] ? (
                        <p className="mt-2 text-xs text-warning-700 break-words">
                          {rowMessages[sug.id]}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex flex-row sm:flex-col gap-2 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => handleApply(sug)}
                        className="px-3 py-1.5 min-h-[36px] bg-brand-blue hover:bg-brand-blue-dark text-white rounded text-xs font-medium"
                      >
                        Apply
                      </button>
                      <button
                        type="button"
                        onClick={() => handleReject(sug)}
                        className="px-3 py-1.5 min-h-[36px] bg-white border border-gray-300 hover:bg-gray-50 text-gray-800 rounded text-xs font-medium"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )
      ) : recentlyApplied.length === 0 ? (
        <p className="mt-4 text-sm text-gray-600">
          No writebacks applied in the last 7 days.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-gray-100 border border-gray-200 rounded-lg">
          {recentlyApplied.map((wb) => {
            const undoable = !wb.undone_at && (Date.now() - new Date(wb.applied_at).getTime()) < UNDO_WINDOW_MS;
            return (
              <li
                key={wb.id}
                className="px-3 py-2 text-sm flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-600">
                    {fieldLabel(wb.field)}
                  </p>
                  <p className="text-sm text-gray-900 break-words">
                    {fmtValue(wb.field, wb.prior_value)}{' '}
                    <span className="text-gray-500">→</span>{' '}
                    <span className="font-medium">{fmtValue(wb.field, wb.new_value)}</span>
                  </p>
                  <p className="text-[11px] text-gray-500">
                    Applied {fmtRelative(wb.applied_at)}
                    {wb.undone_at ? ` · undone ${fmtRelative(wb.undone_at)}` : ''}
                  </p>
                  {rowMessages[`wb-${wb.id}`] ? (
                    <p className="text-xs text-warning-700 break-words mt-1">
                      {rowMessages[`wb-${wb.id}`]}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => handleUndo(wb)}
                  disabled={!undoable}
                  title={undoable ? 'Undo this writeback' : 'Undo window expired or already undone'}
                  className="flex-shrink-0 px-3 py-1.5 min-h-[36px] bg-white border border-gray-300 hover:bg-gray-50 disabled:bg-gray-100 disabled:text-gray-400 text-gray-800 rounded text-xs font-medium"
                >
                  Undo
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
