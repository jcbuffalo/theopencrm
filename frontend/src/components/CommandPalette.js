// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// CommandPalette — the ONE search control in the app (⌘K / Ctrl+K, or the
// search button in the top bar).
//
// Three kinds of result live in one list:
//   1. "Go to" — every authenticated destination by name (from navConfig), so
//      pages demoted out of the top bar (Renewals, Feature flags, Usage, …)
//      stay one keystroke away.
//   2. Records — plain-text hits from GET /search (companies / contacts /
//      deals), debounced. This absorbs the old GlobalSearch text box.
//   3. "Ask AI" — the original Differentiation Bet #3: Claude turns a natural
//      language query ("deals over $50K from CA, no activity in 30 days")
//      into a filter spec and we navigate to the matching list page with the
//      spec in the URL. ⌘/Ctrl+Enter always runs this; plain Enter runs it
//      when nothing else is selected.

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../AuthContext';
import { getStageConfig } from '../stages';
import { buildDestinations, matchDestinations, CREATE_COMMANDS } from './nav/navConfig';
import { COMMAND_PALETTE_EVENT } from './Nav';

// Where the AI router may send the user. Keys are the `resource` values the
// backend spec can return; anything unknown falls back to an error.
const RESOURCE_TO_PATH = {
  deals:       '/deals',
  contacts:    '/contacts',
  companies:   '/companies',
  tasks:       '/tasks',
  leads:       '/leads',
  activities:  '/activities',
  accounts:    '/accounts',
  cases:       '/cases',
  renewals:    '/renewals',
  quotes:      '/quotes',
  issues:      '/issues',
  segments:    '/segments',
  sequences:   '/sequences',
  meetings:    '/calendar',
  surveys:     '/surveys',
  playbooks:   '/playbooks',
};

const EXAMPLES = [
  'deals over $50K from CA with no activity in 30 days',
  'hot deals in proposal stage',
  'dormant customers',
  'open tasks',
  'overdue deals',
  'vendor companies in California',
  'lead-status contacts',
];

function serializeFilter(filter) {
  const sp = new URLSearchParams();
  Object.entries(filter || {}).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    if (typeof v === 'boolean') { sp.set(k, v ? 'true' : 'false'); return; }
    sp.set(k, String(v));
  });
  return sp.toString();
}

// Queries that read like a question or a filter default to the AI row;
// one-or-two-word queries default to the first navigation / record hit.
function looksLikeAiQuery(q) {
  const words = q.trim().split(/\s+/).filter(Boolean);
  return words.length >= 4 || /[$\d]/.test(q) || /\b(over|under|without|no |last|since|days|weeks|months|stage|status)\b/i.test(q);
}

function recordRows(results) {
  if (!results) return [];
  const rows = [];
  (results.companies || []).slice(0, 4).forEach((c) => rows.push({
    kind: 'record', section: 'Companies', key: `co-${c.id}`, label: c.name,
    hint: [c.type || 'company', c.industry].filter(Boolean).join(' · '),
    to: `/companies?search=${encodeURIComponent(c.name)}`,
  }));
  (results.contacts || []).slice(0, 4).forEach((c) => {
    const name = `${c.first_name || ''} ${c.last_name || ''}`.trim();
    rows.push({
      kind: 'record', section: 'Contacts', key: `ct-${c.id}`, label: name || c.email,
      hint: c.email || c.job_title || '', to: `/contacts/${c.id}`,
    });
  });
  (results.deals || []).slice(0, 4).forEach((d) => rows.push({
    kind: 'record', section: 'Deals', key: `d-${d.id}`, label: d.title,
    hint: d.company_name || d.stage || '', to: `/deals?search=${encodeURIComponent(d.title)}`,
  }));
  return rows;
}

// Quick-add rows — always offered (empty query) and still matched against a
// typed query so "new deal" or "log a call" surfaces them directly.
function matchesCreateQuery(cmd, q) {
  if (!q) return true;
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${cmd.label} ${cmd.keywords || ''}`.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

function createRows(q) {
  return CREATE_COMMANDS
    .filter((c) => matchesCreateQuery(c, q))
    .map((c) => ({ kind: 'nav', section: 'Create', key: `create-${c.key}`, label: c.label, hint: null, to: c.to }));
}

export default function CommandPalette() {
  const { user, orgProfile, orgFeatures, isAdmin, adminRole } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [records, setRecords] = useState(null);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lastExplanation, setLastExplanation] = useState('');
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const debounceRef = useRef(null);
  const [example] = useState(() => EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)]);

  const destinations = useMemo(
    () => buildDestinations({
      cfg: getStageConfig(orgProfile),
      orgFeatures,
      isAdmin,
      isSuperAdmin: adminRole === 'super_admin',
    }),
    [orgProfile, orgFeatures, isAdmin, adminRole],
  );

  const close = useCallback(() => {
    setOpen(false);
    setError('');
    setLastExplanation('');
    setQuery('');
    setRecords(null);
    setSelected(0);
  }, []);

  // Global hotkey + the top bar's search button (custom event). Scoped to
  // window so it survives route changes; off when nobody is signed in.
  useEffect(() => {
    if (!user) return undefined;
    const onKey = (e) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape' && open) {
        e.preventDefault();
        close();
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(COMMAND_PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(COMMAND_PALETTE_EVENT, onOpen);
    };
  }, [user, open, close]);

  useEffect(() => {
    if (open) setTimeout(() => { inputRef.current?.focus(); }, 0);
  }, [open]);

  useEffect(() => { if (open) close(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [location.pathname]);

  // Debounced plain-text record search.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!open || q.length < 2) { setRecords(null); return undefined; }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await api.get(`/search?q=${encodeURIComponent(q)}`);
        setRecords(res.data || null);
      } catch {
        setRecords(null);
      }
    }, 200);
    return () => clearTimeout(debounceRef.current);
  }, [query, open]);

  // The flat, ordered row list the keyboard walks.
  const rows = useMemo(() => {
    const q = query.trim();
    const create = createRows(q);
    if (!q) {
      return [...create, ...destinations.slice(0, 8).map((d) => ({ kind: 'nav', section: 'Quick links', key: `nav-${d.key}`, label: d.label, hint: d.group, to: d.to }))];
    }
    const nav = matchDestinations(destinations, q, 5).map((d) => ({ kind: 'nav', section: 'Go to', key: `nav-${d.key}`, label: d.label, hint: d.group, to: d.to }));
    const recs = recordRows(records);
    const ai = { kind: 'ai', section: 'Ask AI', key: 'ai', label: `Find records matching "${q}"`, hint: 'Claude turns this into a filter' };
    return looksLikeAiQuery(q) ? [ai, ...create, ...nav, ...recs] : [...create, ...nav, ...recs, ai];
  }, [query, destinations, records]);

  useEffect(() => { setSelected(0); }, [query, records]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${selected}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  const runAi = async () => {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setError('');
    try {
      // 2-5s end-to-end is normal; override the 10s axios default.
      const res = await api.post('/ai/search', { query: q }, { timeout: 30000 });
      const { resource, filter, explanation } = res.data || {};
      const path = RESOURCE_TO_PATH[resource];
      if (!path) {
        setError('AI picked a resource we cannot route to. Try rephrasing.');
        return;
      }
      setLastExplanation(explanation || '');
      const qs = serializeFilter(filter);
      navigate(qs ? `${path}?${qs}` : path);
      if (explanation) setTimeout(close, 600); else close();
    } catch (err) {
      const data = err?.response?.data;
      const msg = data?.error || err.message || 'AI search failed';
      if (err?.response?.status === 429) {
        setError('You are sending searches too fast. Wait a minute and try again.');
      } else if (data?.code === 'MALFORMED_RESPONSE' || data?.code === 'INVALID_SPEC' || data?.code === 'EMPTY_FILTER') {
        setError(`${msg}  —  try rephrasing.`);
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  const activate = (row) => {
    if (!row) return;
    if (row.kind === 'ai') { runAi(); return; }
    close();
    navigate(row.to);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((s) => Math.min(rows.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) { runAi(); return; }
      activate(rows[selected]);
    }
  };

  if (!user || !open) return null;

  let lastSection = null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-16 sm:pt-28 px-4 bg-black/40"
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-label="Search or ask anything"
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center px-4 py-3 gap-3 border-b border-gray-100">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-gray-400 flex-shrink-0" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`Search pages and records, or try: ${example}`}
            disabled={busy}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={rows[selected] ? `cp-row-${selected}` : undefined}
            aria-autocomplete="list"
            className="flex-1 text-base outline-none placeholder-gray-400 bg-transparent disabled:opacity-60"
          />
          {busy ? (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <span className="animate-spin inline-block h-4 w-4 border-2 border-gray-300 border-t-brand-blue rounded-full" />
              <span>Asking…</span>
            </div>
          ) : (
            <kbd className="hidden sm:inline-block text-[10px] uppercase tracking-wider text-gray-400 border border-gray-200 rounded px-1.5 py-0.5">esc</kbd>
          )}
        </div>

        <ul id="command-palette-list" ref={listRef} role="listbox" className="max-h-[50vh] overflow-y-auto py-1.5">
          {rows.map((row, idx) => {
            const showHeading = row.section !== lastSection;
            lastSection = row.section;
            const on = idx === selected;
            return (
              <React.Fragment key={row.key}>
                {showHeading && (
                  <li aria-hidden="true" className="px-4 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{row.section}</li>
                )}
                <li
                  id={`cp-row-${idx}`}
                  data-idx={idx}
                  role="option"
                  aria-selected={on}
                  onMouseEnter={() => setSelected(idx)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => activate(row)}
                  className={`mx-1.5 px-2.5 min-h-[36px] rounded-md flex items-center gap-3 cursor-pointer text-sm ${on ? 'bg-blue-50 text-brand-blue' : 'text-gray-700 hover:bg-gray-50'}`}
                >
                  {row.kind === 'ai' ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0" aria-hidden="true">
                      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
                    </svg>
                  ) : row.kind === 'nav' ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-gray-400" aria-hidden="true">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  ) : (
                    <span className="w-4 flex-shrink-0" aria-hidden="true" />
                  )}
                  <span className="truncate">{row.label}</span>
                  {row.hint && <span className="ml-auto text-xs text-gray-400 truncate max-w-[40%]">{row.hint}</span>}
                  {on && <kbd className="hidden sm:inline text-[10px] text-gray-400 border border-gray-200 rounded px-1">↵</kbd>}
                </li>
              </React.Fragment>
            );
          })}
        </ul>

        <div className="px-4 py-2.5 border-t border-gray-100 text-xs text-gray-500 min-h-[40px] flex items-center justify-between gap-3">
          {error ? (
            <>
              <span className="text-red-600">{error}</span>
              <button
                onClick={() => { setError(''); inputRef.current?.focus(); }}
                className="text-brand-blue hover:underline font-medium whitespace-nowrap"
              >
                Try rephrasing
              </button>
            </>
          ) : lastExplanation ? (
            <span>{lastExplanation}</span>
          ) : (
            <span>
              Type a page, a name, or a plain-English question.
              {' '}<kbd className="text-[10px] text-gray-400 border border-gray-200 rounded px-1">↑↓</kbd> pick
              {' '}<kbd className="text-[10px] text-gray-400 border border-gray-200 rounded px-1">↵</kbd> open
              {' '}<kbd className="text-[10px] text-gray-400 border border-gray-200 rounded px-1">⌘↵</kbd> ask AI
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
