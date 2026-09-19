// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Chat — the Chat-First CRM front door.
//
// One calm surface with one focal point: the composer. The empty state is
// data-aware — a "today strip" built from GET /api/my-day (tasks due, deals
// stalling, renewals, at-risk / quiet accounts) whose chips SEED the composer
// so the user stays here; an org with no deals or contacts yet gets the
// first-run WelcomeCard instead (prompts, CSV import, sample data).
//
// Conversation state is persisted server-side (chat_sessions / chat_messages)
// and the most recent session is restored on mount, so a refresh doesn't lose
// the thread. "New chat" and a "Recent" list live in the overflow menu next
// to the composer, alongside the admin-only Debug mode toggle.
//
// Replies render through components/ChatMarkdown (headers, lists, links,
// code, tables — never raw HTML). Follow-up chips come in two kinds: `ask`
// chips seed the composer; `navigate` / `open_deal` chips leave the page.
// Write actions are confirm-first (ConfirmActionCard -> POST /ai/actions/apply).
//
// Pay-as-you-go: when /ai/status says the org can't burn AI yet, the
// AiBillingCard replaces the composer's normal state (see aiBilling below).

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import api, { streamChat } from '../api';
import { useAuth } from '../AuthContext';
import { stashComposeDraft } from '../composePrefill';
import Nav from '../components/Nav';
import WelcomeCard, { isWelcomeDismissed } from '../components/WelcomeCard';
import AiBillingCard from '../components/AiBillingCard';
import Button from '../components/ui/Button';
import { renderMarkdown } from '../components/ChatMarkdown';

// The four "general CRM goals" surfaced as starter chips once an org has
// data. Anything else the user types just becomes a freeform message.
const STARTER_PROMPTS = [
  'What should I focus on today?',
  "Who's gone quiet — which deals need a nudge?",
  'What can you help me with?',
  'Draft a warm check-in to my hottest deal',
];

// Debug-mode starter prompts (admins, Debug mode on). Map 1:1 to the most
// common self-service troubleshooting patterns the diagnostic tools cover.
const DEBUG_STARTER_PROMPTS = [
  "Why isn't my last plugin run showing results?",
  'Show me the last 10 failed audit events for my org',
  "Why am I not getting notification emails?",
  'What custom fields does my workspace have configured?',
];

// First-run starters for an org with no deals/contacts yet. Shown when the
// WelcomeCard has been dismissed but the workspace is still empty.
const FIRST_RUN_STARTERS = [
  { key: 'build', label: 'Describe how I sell — build my CRM', to: '/setup', adminOnly: true },
  { key: 'import', label: 'Import my contacts from a CSV', to: '/import' },
  { key: 'deal', label: 'Add my first deal', prompt: 'I want to add my first deal. Ask me for the company, the contact, what it is worth, and when I expect it to close — then set it up.' },
  { key: 'demo', label: 'Load sample data so I can explore', action: 'seed_demo' },
  { key: 'what', label: 'What can you do?', prompt: 'What can you do?' },
];

// Today-strip chips, keyed by the /api/my-day `counts` field. Label is the
// count phrase; prompt is what lands in the composer when clicked.
const TODAY_CHIPS = [
  { key: 'tasksDue', noun: ['task due today', 'tasks due today'], prompt: 'What tasks are due today, and which should I do first?' },
  { key: 'dealsNeedingAttention', noun: ['deal stalling', 'deals stalling'], prompt: 'Which of my deals are stalling, and what is the one thing to do on each?' },
  { key: 'renewals', noun: ['renewal in 30 days', 'renewals in 30 days'], prompt: 'Which renewals are coming up in the next 30 days, and how should I prepare?' },
  { key: 'atRiskAccounts', noun: ['at-risk account', 'at-risk accounts'], prompt: 'Which accounts are at risk, and what should I do about them first?' },
  { key: 'quietAccounts', noun: ['account gone quiet', 'accounts gone quiet'], prompt: 'Which accounts have gone quiet, and who should I reach out to first?' },
];

// Waiting copy for the window BEFORE the first stream event lands (the
// model's opening think, or the blocking fallback path where nothing streams
// at all). Once events arrive the live bubble's status line takes over.
const THINKING_LINES = [
  'Thinking…',
  'Looking through your CRM…',
  'Checking deals and tasks…',
  'Putting an answer together…',
];

// Restore the latest session on mount only if it's this recent; older
// threads are still one click away in the Recent menu, but landing on a
// week-old conversation every morning is the opposite of a calm surface.
const RESTORE_WINDOW_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Small inline icons (no emoji glyphs in chrome).
// ---------------------------------------------------------------------------
const ICON_PATHS = {
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  reply: <path d="M9 17l-5-5 5-5M4 12h11a5 5 0 0 1 5 5v2" />,
  check: <path d="M20 6 9 17l-5-5" />,
  bolt: <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />,
  pencil: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />,
  dots: <><circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
};

function Icon({ name, size = 14, className = '' }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {ICON_PATHS[name] || ICON_PATHS.arrow}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Action chips
// ---------------------------------------------------------------------------

// Map an action chip emitted by the backend to a click handler. Question
// chips (`ask`) seed the composer and keep the user here; navigation chips
// leave the page. The Deals page reads ?dealId=N (+ &compose=1) and opens
// the DealPanel for that deal on load, so open_deal / draft_email are real
// deep links.
function actionHandler(action, { navigate, seed }) {
  return () => {
    if (action.kind === 'ask') {
      seed(action.prompt || action.label);
    } else if (action.kind === 'navigate' && action.path) {
      navigate(action.path);
    } else if (action.kind === 'open_deal' && action.deal_id) {
      navigate(`/deals?dealId=${action.deal_id}`);
    } else if (action.kind === 'draft_email' && action.deal_id) {
      // The drafted text rides along out-of-band (composePrefill.js) so the
      // composer opens with Subject/Body already filled in.
      if (action.draft) stashComposeDraft(action.deal_id, action.draft);
      navigate(`/deals?dealId=${action.deal_id}&compose=1`);
    }
  };
}

// Confirm-first write-action card. Emitted by the backend as an `apply_action`
// chip carrying the validated `proposal`. Nothing is written on render — only
// when the user clicks Apply, which POSTs the proposal to the lone writer
// (/ai/actions/apply, which re-validates server-side). `api` injects the CSRF
// header, so no extra plumbing is needed here.
function ConfirmActionCard({ action }) {
  const [state, setState] = useState('idle'); // idle | applying | applied | error | cancelled
  const [errorText, setErrorText] = useState('');
  // Some service applies return a follow-up destination (e.g. saving a chat-
  // built plugin draft returns { applied: { open_path: '/plugins/:id', … } }).
  const [applied, setApplied] = useState(null);

  const apply = async () => {
    setState('applying');
    setErrorText('');
    try {
      const res = await api.post('/ai/actions/apply', { proposal: action.proposal });
      setApplied(res.data?.applied || null);
      setState('applied');
    } catch (err) {
      setErrorText(err.response?.data?.detail || err.response?.data?.error || 'Could not apply that change.');
      setState('error');
    }
  };

  const summary = action.proposal?.summary || action.label || 'Apply this change';

  return (
    <div className="w-full max-w-md bg-white border border-brand-blue/40 rounded-xl px-3 py-2.5 shadow-sm text-sm">
      <div className="flex items-start gap-2">
        <Icon name="check" className="text-brand-blue mt-1 flex-shrink-0" />
        <span className="flex-1 text-gray-800">{summary}</span>
      </div>
      {state === 'applied' ? (
        <div className="mt-2 flex items-center gap-3">
          <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600"><Icon name="check" size={12} /> Applied</span>
          {applied?.open_path && (
            <Link
              to={applied.open_path}
              className="text-xs font-medium text-brand-blue hover:underline"
            >
              {applied.open_label || 'Open'}
            </Link>
          )}
        </div>
      ) : state === 'error' ? (
        <div className="mt-2">
          <div className="text-xs text-red-600 mb-1.5">{errorText}</div>
          <button
            onClick={apply}
            className="px-3 py-1 bg-brand-blue text-white text-xs font-medium rounded-full hover:bg-brand-blue/90 transition"
          >
            Retry
          </button>
        </div>
      ) : state === 'cancelled' ? (
        <div className="mt-2 text-xs text-gray-400">Cancelled.</div>
      ) : (
        <div className="mt-2 flex gap-2">
          <button
            onClick={apply}
            disabled={state === 'applying'}
            className="px-3 py-1 bg-brand-blue text-white text-xs font-medium rounded-full hover:bg-brand-blue/90 disabled:opacity-50 transition"
          >
            {state === 'applying' ? 'Applying…' : 'Apply'}
          </button>
          <button
            onClick={() => setState('cancelled')}
            disabled={state === 'applying'}
            className="px-3 py-1 bg-white border border-gray-300 text-gray-600 text-xs font-medium rounded-full hover:bg-gray-50 disabled:opacity-50 transition"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// Confirm-first PLUGIN-RUN apply card. Emitted by the backend as an
// `apply_plugin_run` chip carrying { pluginId, runId, proposalCount, summary }
// after a `run_plugin` tool call previewed changes but wrote nothing. Clicking
// Apply POSTs { runId } to the lone plugin writer (POST /api/plugins/:id/apply)
// which re-loads the stored proposals server-side, re-validates them, and
// applies in one org-scoped transaction. The client never supplies the fields
// to write — it can only name the run it wants committed.
//
// The apply endpoint is owner/admin gated: a member gets a 403, which we
// surface as a friendly "ask an admin" note rather than a retryable error. A
// 409 (already applied) is treated as terminal-success-ish (nothing more to do).
function ApplyPluginRunCard({ action }) {
  const [state, setState] = useState('idle'); // idle | applying | applied | forbidden | already | error | dismissed
  const [errorText, setErrorText] = useState('');
  const [appliedCount, setAppliedCount] = useState(null);

  const apply = async () => {
    setState('applying');
    setErrorText('');
    try {
      const res = await api.post(`/plugins/${action.pluginId}/apply`, { runId: action.runId });
      const count = res.data?.result?.applied_count;
      setAppliedCount(Number.isInteger(count) ? count : null);
      setState('applied');
    } catch (err) {
      const status = err.response?.status;
      if (status === 403) {
        setState('forbidden');
      } else if (status === 409) {
        setState('already');
      } else {
        setErrorText(err.response?.data?.error || err.response?.data?.detail || 'Could not apply these changes.');
        setState('error');
      }
    }
  };

  const summary = action.summary || action.label || 'Apply the staged changes';

  return (
    <div className="w-full max-w-md bg-white border border-brand-blue/40 rounded-xl px-3 py-2.5 shadow-sm text-sm">
      <div className="flex items-start gap-2">
        <Icon name="bolt" className="text-brand-blue mt-1 flex-shrink-0" />
        <span className="flex-1 text-gray-800">{summary}</span>
      </div>
      {state === 'applied' ? (
        <div className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-green-600">
          <Icon name="check" size={12} /> Applied{appliedCount !== null ? ` ${appliedCount} change${appliedCount === 1 ? '' : 's'}` : ''}
        </div>
      ) : state === 'already' ? (
        <div className="mt-2 text-xs font-medium text-gray-500">Already applied</div>
      ) : state === 'forbidden' ? (
        <div className="mt-2 text-xs text-amber-600">
          Only an org owner or admin can apply these changes. Ask an admin to apply them.
        </div>
      ) : state === 'error' ? (
        <div className="mt-2">
          <div className="text-xs text-red-600 mb-1.5">{errorText}</div>
          <button
            onClick={apply}
            className="px-3 py-1 bg-brand-blue text-white text-xs font-medium rounded-full hover:bg-brand-blue/90 transition"
          >
            Retry
          </button>
        </div>
      ) : state === 'dismissed' ? (
        <div className="mt-2 text-xs text-gray-400">Dismissed.</div>
      ) : (
        <div className="mt-2 flex gap-2">
          <button
            onClick={apply}
            disabled={state === 'applying'}
            className="px-3 py-1 bg-brand-blue text-white text-xs font-medium rounded-full hover:bg-brand-blue/90 disabled:opacity-50 transition"
          >
            {state === 'applying' ? 'Applying…' : 'Apply'}
          </button>
          <button
            onClick={() => setState('dismissed')}
            disabled={state === 'applying'}
            className="px-3 py-1 bg-white border border-gray-300 text-gray-600 text-xs font-medium rounded-full hover:bg-gray-50 disabled:opacity-50 transition"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function ActionChip({ action, onClick }) {
  const isAsk = action.kind === 'ask';
  const icon = isAsk ? 'reply' : action.kind === 'draft_email' ? 'pencil' : 'arrow';
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full transition shadow-sm border ' +
        (isAsk
          ? 'bg-white border-gray-300 text-gray-700 hover:border-brand-blue hover:text-brand-blue'
          : 'bg-white border-brand-blue text-brand-blue hover:bg-brand-blue hover:text-white')
      }
    >
      <span>{action.label}</span>
      <Icon name={icon} size={12} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Empty-state surfaces
// ---------------------------------------------------------------------------

function StarterChips({ onPick, busy, debugMode }) {
  const prompts = debugMode ? DEBUG_STARTER_PROMPTS : STARTER_PROMPTS;
  return (
    <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
      {prompts.map((p, i) => (
        <button
          type="button"
          key={`${debugMode ? 'd' : 'n'}-${i}`}
          disabled={busy}
          onClick={() => onPick(p)}
          className="text-left px-4 py-3 bg-white border border-gray-200 hover:border-brand-blue hover:bg-brand-blue/5 rounded-xl text-sm text-gray-700 disabled:opacity-50 transition shadow-sm"
        >
          {p}
        </button>
      ))}
    </div>
  );
}

function FirstRunStarters({ onSeed, onNavigate, onSeedDemo, canSeedDemo, busy }) {
  // canSeedDemo doubles as "is owner/admin" — the same role gate the builder's
  // apply pieces enforce server-side.
  const items = FIRST_RUN_STARTERS.filter((s) => (s.action !== 'seed_demo' && !s.adminOnly) || canSeedDemo);
  return (
    <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2" data-testid="first-run-starters">
      {items.map((s) => (
        <button
          type="button"
          key={s.key}
          disabled={busy}
          onClick={() => {
            if (s.to) onNavigate(s.to);
            else if (s.action === 'seed_demo') onSeedDemo();
            else onSeed(s.prompt);
          }}
          className="text-left px-4 py-3 bg-white border border-gray-200 hover:border-brand-blue hover:bg-brand-blue/5 rounded-xl text-sm text-gray-700 disabled:opacity-50 transition shadow-sm flex items-center justify-between gap-2"
        >
          <span>{s.label}</span>
          <Icon name={s.to ? 'arrow' : s.action ? 'bolt' : 'reply'} size={12} className="text-gray-400 flex-shrink-0" />
        </button>
      ))}
    </div>
  );
}

// Compact "today" chips from /api/my-day. Only non-zero buckets render;
// clicking one seeds the composer (stays on chat).
function TodayStrip({ myDay, onPick }) {
  const counts = myDay?.counts || {};
  const chips = TODAY_CHIPS.filter((c) => Number(counts[c.key]) > 0);
  if (!myDay) return null;
  if (!chips.length) {
    return (
      <p className="mt-3 text-xs text-gray-400 inline-flex items-center gap-1.5" data-testid="today-strip-empty">
        <Icon name="check" size={12} /> Nothing is due or drifting today.
      </p>
    );
  }
  return (
    <div className="mt-3" data-testid="today-strip">
      <div className="text-[11px] uppercase tracking-wide text-gray-400 mb-1.5">Today</div>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((c) => {
          const n = Number(counts[c.key]);
          return (
            <button
              type="button"
              key={c.key}
              onClick={() => onPick(c.prompt)}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white border border-gray-200 text-xs text-gray-700 hover:border-brand-blue hover:text-brand-blue transition shadow-sm"
            >
              <span className="font-semibold tabular-nums">{n}</span>
              <span>{c.noun[n === 1 ? 0 : 1]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="mt-3 flex gap-1.5" aria-hidden="true">
      {[0, 1, 2].map((i) => <span key={i} className="h-6 w-28 rounded-full bg-gray-200/70 animate-pulse" />)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message bubbles
// ---------------------------------------------------------------------------

function UserBubble({ text }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] bg-brand-blue text-white rounded-2xl rounded-tr-sm px-4 py-2 text-sm sm:text-base shadow-sm">
        <div className="whitespace-pre-wrap leading-relaxed">{text}</div>
      </div>
    </div>
  );
}

function ThinkingBubble() {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const line = THINKING_LINES[Math.min(Math.floor(secs / 3), THINKING_LINES.length - 1)];
  return (
    <div className="flex justify-start">
      <div className="bg-gray-100 text-gray-500 rounded-2xl rounded-tl-sm px-4 py-3 text-sm sm:text-base shadow-sm inline-flex items-center gap-2" role="status" aria-live="polite">
        <span className="inline-block h-3 w-3 rounded-full border-2 border-gray-400 border-t-transparent animate-spin" aria-hidden="true" />
        <span>{line}</span>
        {secs >= 4 && <span className="text-xs text-gray-400 tabular-nums">{secs}s</span>}
      </div>
    </div>
  );
}

// `streaming` marks the live bubble for a turn in flight: `status` is the
// current tool line ("Looking at overdue tasks…"), `note` is a pre-tool
// preamble the server retracted (kept as a muted line so text never just
// vanishes), and `text` grows token by token. Markdown renders progressively
// (the renderer tolerates an unclosed fence); the final `done` payload
// replaces the whole message.
function AssistantBubble({ text, actions, explanation, streaming, status, note, navigate, seed }) {
  const hasText = !!text;
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%]">
        <div
          className="bg-gray-100 text-gray-900 rounded-2xl rounded-tl-sm px-4 py-3 text-sm sm:text-base shadow-sm"
          data-testid={streaming ? 'assistant-streaming' : undefined}
        >
          {note && <div className="text-xs text-gray-500 italic mb-1.5">{note}</div>}
          {hasText && <div>{renderMarkdown(text)}</div>}
          {streaming && (status || !hasText) && (
            <div
              className={'inline-flex items-center gap-2 text-gray-500 ' + (hasText ? 'mt-2 text-xs' : '')}
              role="status"
              aria-live="polite"
            >
              <span className="inline-block h-3 w-3 rounded-full border-2 border-gray-400 border-t-transparent animate-spin" aria-hidden="true" />
              <span>{status || 'Thinking…'}</span>
            </div>
          )}
        </div>
        {actions && actions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {actions.map((a, i) =>
              a.kind === 'apply_action'
                ? <ConfirmActionCard key={i} action={a} />
                : a.kind === 'apply_plugin_run'
                  ? <ApplyPluginRunCard key={i} action={a} />
                  : <ActionChip key={i} action={a} onClick={actionHandler(a, { navigate, seed })} />
            )}
          </div>
        )}
        {explanation && (
          <div className="mt-1.5 text-[11px] text-gray-400 px-1">{explanation}</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overflow menu ("…" next to the composer): New chat, Recent, Debug mode.
// ---------------------------------------------------------------------------

function relativeTime(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function OverflowMenu({ open, onClose, sessions, currentSessionId, onNewChat, onOpenSession, isAdmin, debugMode, onToggleDebug }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  const recent = (sessions || []).slice(0, 10);
  const item = 'w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2';

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Chat options"
      className="absolute bottom-full left-0 mb-2 w-72 max-w-[calc(100vw-2rem)] bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden z-20"
    >
      <button type="button" role="menuitem" className={item} onClick={() => { onNewChat(); onClose(); }}>
        <Icon name="plus" size={14} className="text-gray-400" /> New chat
      </button>
      {isAdmin && (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={debugMode}
          className={item}
          onClick={() => { onToggleDebug(); onClose(); }}
        >
          <span className={'inline-block h-3.5 w-3.5 rounded border ' + (debugMode ? 'bg-brand-blue border-brand-blue' : 'border-gray-300')} aria-hidden="true" />
          Debug mode {debugMode ? 'on' : 'off'}
        </button>
      )}
      <div className="border-t border-gray-100">
        <div className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wide text-gray-400">Recent</div>
        {recent.length === 0 ? (
          <div className="px-3 pb-2.5 text-xs text-gray-400">No earlier chats yet.</div>
        ) : (
          <ul className="max-h-64 overflow-y-auto pb-1">
            {recent.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { onOpenSession(s.id); onClose(); }}
                  className={item + (s.id === currentSessionId ? ' bg-brand-blue/5' : '')}
                >
                  <Icon name="clock" size={13} className="text-gray-300 flex-shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{s.preview || 'Untitled chat'}</span>
                  <span className="text-[11px] text-gray-400 flex-shrink-0">{relativeTime(s.last_message_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// Server rows -> the in-memory message shape. One-shot apply cards are
// dropped on restore: a stale proposal card re-appearing after a refresh is
// more confusing than helpful (the server re-validates anyway).
function messagesFromRows(rows) {
  return (rows || []).map((r) => ({
    role: r.role,
    text: r.content || '',
    actions: (Array.isArray(r.actions) ? r.actions : []).filter(
      (a) => a && a.kind !== 'apply_action' && a.kind !== 'apply_plugin_run'
    ),
    explanation: '',
  }));
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Chat() {
  const { user, aiEnabled, aiBilling, refreshAiStatus, isAdmin, orgProfile, orgRole } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [sessionId, setSessionId] = useState(null);
  const [messages, setMessages] = useState([]); // {role, text, actions, explanation}
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // AuthContext probes /api/ai/status once on sign-in. If it reports
  // configured=false we surface a graceful inline banner instead of letting
  // the user discover the 503 by typing a message. null = still loading.
  const aiUnavailable = aiEnabled === false;
  // Pay-as-you-go gate. Two sources, same shape: the up-front verdict from
  // /ai/status (via AuthContext) and any AI_BILLING_* 402 body a request
  // returns mid-conversation. Either one swaps the composer for the billing
  // card so the user gets a "Start AI plan" button, never a raw red error.
  const [billingBlock, setBillingBlock] = useState(null);
  const billingGate = billingBlock || (aiBilling && aiBilling.allowed === false ? aiBilling : null);
  // After Stripe Checkout sends the user back with ?ai_subscribed=1 the
  // webhook that flips ai_billing_status may land a beat later, so we poll
  // the status probe a few times before declaring victory (or giving up and
  // showing the card again with a "just paid?" hint).
  const [activating, setActivating] = useState(false);
  const [planStarted, setPlanStarted] = useState(false);
  // Debug mode (admins only). When on, the chat POST sends `mode: 'debug'`:
  // debug rate limiter, diagnostic system prompt, customer-facing tool suite.
  const [debugMode, setDebugMode] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Empty-state data: the /my-day payload plus whether the org has any
  // deals/contacts at all (null = unknown / still loading).
  const [home, setHome] = useState({ loading: true, myDay: null, hasData: null });
  const [welcomeDismissed, setWelcomeDismissed] = useState(() => isWelcomeDismissed(user?.id, user?.org_id));
  const [sessions, setSessions] = useState([]);
  const [seedingDemo, setSeedingDemo] = useState(false);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  const canSeedDemo = ['owner', 'admin'].includes(orgRole || user?.org_role);

  // Auto-scroll to the bottom whenever messages change or busy flips.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, busy]);

  // Auto-grow the composer with its content (capped; then it scrolls).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  // Put text in the composer and focus it — the user stays on chat and can
  // edit before sending. Used by today chips, ask chips, and WelcomeCard.
  const seedComposer = useCallback((text) => {
    setInput(text || '');
    setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* ignore */ }
    }, 0);
  }, []);

  // Empty-state data. Fires whenever we land on the empty state (mount, New
  // chat). One read: /my-day now carries `has_data` ({ deals, contacts,
  // companies } counts), which answers "is this org empty?" without pulling
  // the full /deals and /contacts lists. If the field is absent (older
  // backend, count failed) we fall back to the old two-list probe. Any
  // failure just leaves its slice unknown so the page still renders.
  const isEmpty = messages.length === 0;
  // Runs regardless of isEmpty: a session restored from the last 24h (see
  // below) still needs /my-day so the Today strip can render above the
  // restored thread, not just in the pristine empty state.
  useEffect(() => {
    let alive = true;
    setHome((h) => ({ ...h, loading: true }));
    (async () => {
      const md = await api.get('/my-day').catch(() => null);
      const payload = md?.data && typeof md.data === 'object' ? md.data : null;
      const myDay = payload && payload.counts ? payload : null;
      const hd = payload?.has_data;
      let hasData = null;
      if (hd && typeof hd === 'object' && ['deals', 'contacts', 'companies'].some((k) => Number.isFinite(Number(hd[k])))) {
        hasData = Number(hd.deals) > 0 || Number(hd.contacts) > 0 || Number(hd.companies) > 0;
      } else {
        const [dl, ct] = await Promise.allSettled([api.get('/deals'), api.get('/contacts')]);
        const dealsKnown = dl.status === 'fulfilled' && Array.isArray(dl.value?.data);
        const contactsKnown = ct.status === 'fulfilled' && Array.isArray(ct.value?.data);
        if (dealsKnown && dl.value.data.length > 0) hasData = true;
        else if (contactsKnown && ct.value.data.length > 0) hasData = true;
        else if (dealsKnown && contactsKnown) hasData = false;
      }
      if (!alive) return;
      setHome({ loading: false, myDay, hasData });
    })();
    return () => { alive = false; };
  }, [isEmpty]);

  // Session restore. On first mount, pull the session list; if the most
  // recent one is fresh (RESTORE_WINDOW_MS) load its messages so a refresh
  // doesn't lose the thread. Seeded flows (?seed=…) always start fresh.
  // The list endpoints sit behind the AI feature/billing gates, so any
  // failure here is silently "no history".
  const loadSession = useCallback(async (id) => {
    try {
      const r = await api.get(`/ai/chat/sessions/${id}/messages`);
      setSessionId(id);
      setMessages(messagesFromRows(r.data?.messages));
      setError('');
    } catch {
      /* leave the current view alone */
    }
  }, []);

  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const params = new URLSearchParams(location.search);
    if (params.get('seed')) return;
    api.get('/ai/chat/sessions')
      .then((r) => {
        const list = Array.isArray(r.data?.sessions) ? r.data.sessions : [];
        setSessions(list);
        const latest = list[0];
        if (!latest) return;
        const age = Date.now() - new Date(latest.last_message_at || latest.started_at || 0).getTime();
        if (age >= 0 && age < RESTORE_WINDOW_MS && Number(latest.message_count) > 0) loadSession(latest.id);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshSessions = useCallback(() => {
    api.get('/ai/chat/sessions')
      .then((r) => setSessions(Array.isArray(r.data?.sessions) ? r.data.sessions : []))
      .catch(() => {});
  }, []);

  const startNewChat = useCallback(() => {
    setSessionId(null);
    setMessages([]);
    setError('');
    setInput('');
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  // The in-flight streamed turn's AbortController (Stop button).
  const abortRef = useRef(null);
  const stopGenerating = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
  }, []);

  // Send a turn. Streams by default (POST /ai/chat/stream → SSE): the
  // assistant bubble appears as soon as the first event lands and fills in
  // progressively — tool status lines, then tokens — and the `done` payload
  // (same shape as the blocking route) replaces it. If the stream can't even
  // start (older backend, buffering proxy, blocked fetch) we fall back to
  // the blocking POST /ai/chat transparently. Server rulings (400 / 402 /
  // 429 / 503) are never retried — they route to the same handling either way.
  const sendMessage = useCallback(async (text) => {
    if (!text.trim() || busy) return;
    if (aiUnavailable || billingGate) {
      // Hard-stop the optimistic path so we never burn a 503/402 round-trip
      // when we already know AI is unconfigured or unbilled. The banner /
      // billing card explains why and what to do.
      return;
    }
    setError('');
    const userMsg = { role: 'user', text };
    setMessages(m => [...m, userMsg]);
    setInput('');
    setBusy(true);

    const body = {
      session_id: sessionId,
      message: text.trim(),
      // Only include mode when on — keeps the wire shape minimal and
      // unsurprising for non-debug users. The backend treats missing /
      // any-other value as "normal chat".
      ...(debugMode ? { mode: 'debug' } : {}),
    };

    // The live (streaming) bubble sits at the end of `messages` while the
    // turn is open. `live` mirrors it outside React state so event handlers
    // don't race on stale closures.
    const live = { text: '', status: '', note: '' };
    const patchLive = (patch) => setMessages(m => {
      const last = m[m.length - 1];
      const isLive = !!(last && last.streaming);
      const base = isLive ? last : { role: 'assistant', streaming: true, text: '', status: '', note: '', actions: [], explanation: '' };
      return [...(isLive ? m.slice(0, -1) : m), { ...base, ...patch }];
    });
    const withoutLive = (m) => (m.length && m[m.length - 1].streaming ? m.slice(0, -1) : m);
    const finalize = (msg) => setMessages(m => [...withoutLive(m), msg]);
    // Roll back the optimistic user message so they can re-edit and retry.
    const rollback = () => {
      setMessages(m => withoutLive(m).slice(0, -1));
      setInput(text);
    };

    const controller = new AbortController();
    abortRef.current = controller;
    let firstEvent = false;

    try {
      let payload;
      try {
        payload = await streamChat(body, {
          signal: controller.signal,
          onEvent: ({ event, data }) => {
            firstEvent = true;
            if (event === 'status') {
              live.status = data?.text || '';
              patchLive({ status: live.status });
            } else if (event === 'token') {
              live.text += data?.text || '';
              live.status = '';
              patchLive({ text: live.text, status: '' });
            } else if (event === 'reset') {
              // The text so far was a pre-tool preamble; keep it as a note.
              live.note = data?.text || live.text || live.note;
              live.text = '';
              patchLive({ text: '', note: live.note });
            } else if (event === 'actions') {
              patchLive({ actions: data?.actions || [], explanation: data?.explanation || '' });
            }
          },
        });
      } catch (err) {
        if (err?.name === 'AbortError') {
          // Stopped by the user. Keep what streamed (marked), else put the
          // message back in the composer. The server persisted nothing.
          if (live.text) {
            finalize({ role: 'assistant', text: live.text, actions: [], explanation: 'Stopped.' });
          } else {
            rollback();
          }
          return;
        }
        const status = err?.response?.status;
        const seen = firstEvent || !!err?.firstEventSeen;
        // Only fall back when the stream never got going AND the server
        // hasn't ruled on the request (a 404/405 means the stream route
        // isn't there; no status at all means fetch/transport failed).
        const canFallBack = !seen && (!status || status === 404 || status === 405);
        if (!canFallBack) throw err;
        setMessages(withoutLive);
        const res = await api.post('/ai/chat', body, { timeout: 60000 }); // tool-use loop can take 5-15s end to end
        payload = res.data || {};
      }
      const { session_id: newSessionId, reply, actions, explanation } = payload || {};
      if (newSessionId && !sessionId) setSessionId(newSessionId);
      finalize({
        role: 'assistant',
        text: reply || '(no reply)',
        actions: actions || [],
        explanation: explanation || '',
      });
    } catch (err) {
      const data = err?.response?.data;
      const msg = data?.error || err.message || 'Chat failed';
      if (err?.response?.status === 429) {
        setError(data?.code === 'CHAT_DAILY_CAP'
          ? 'You hit your daily chat cap. Try again tomorrow.'
          : 'Sending too fast. Wait a minute and try again.');
      } else if (err?.response?.status === 503) {
        setError('AI is not configured on this deployment. Tell your admin to set ANTHROPIC_API_KEY.');
      } else if (err?.response?.status === 402 && String(data?.code || '').startsWith('AI_BILLING')) {
        // Billing gate fired mid-conversation (trial just expired, admin
        // halted, etc). Swap in the card; the 402 body carries the same
        // fields as /ai/status minus can_manage / stripe_ready, which we
        // borrow from the last probe.
        setBillingBlock({
          ...data,
          message: data.error || data.message,
          can_manage: aiBilling?.can_manage,
          stripe_ready: aiBilling?.stripe_ready,
        });
        refreshAiStatus();
      } else {
        setError(msg);
      }
      rollback();
    } finally {
      abortRef.current = null;
      setBusy(false);
      // Re-focus the input after the round-trip so the next message flows.
      setTimeout(() => { inputRef.current?.focus(); }, 0);
    }
  }, [busy, sessionId, debugMode, aiUnavailable, billingGate, aiBilling, refreshAiStatus]);

  // Return from Stripe Checkout. Strip the query param so a refresh doesn't
  // re-trigger, then poll /ai/status (0s, 2s, 4s, 8s, 12s) until the webhook
  // has flipped the org to active. Cancel just clears the param.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('ai_subscribed') === '1') {
      setBillingBlock(null);
      setActivating(true);
      navigate('/chat', { replace: true });
    } else if (params.get('ai_subscribe_cancelled') === '1') {
      navigate('/chat', { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  useEffect(() => {
    if (!activating) return undefined;
    let cancelled = false;
    const delays = [0, 2000, 4000, 8000, 12000];
    let i = 0;
    let timer = null;
    const tick = async () => {
      if (cancelled) return;
      await refreshAiStatus();
      i += 1;
      if (i < delays.length) timer = setTimeout(tick, delays[i]);
      else if (!cancelled) setActivating(false);
    };
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activating]);

  useEffect(() => {
    if (activating && aiBilling && aiBilling.allowed) {
      setActivating(false);
      setPlanStarted(true);
    }
  }, [activating, aiBilling]);

  // Seed-prompt from a record or template navigation. Three seeds:
  //   ?seed=customize_plugin&plugin_id=<n>&template_name=…  (PluginLibrary)
  //   ?seed=deal&deal_id=<n>          ("Ask the copilot" on the deal drawer)
  //   ?seed=contact&contact_id=<n>    ("Ask the copilot" on the contact drawer)
  // Each auto-fires ONE grounded first user message. We clear the query
  // params right after seeding so a refresh doesn't re-fire the message.
  //
  // Guard rails:
  //   • Only seed when the conversation is empty AND the user hasn't typed.
  //   • Only seed when AI is configured (don't burn a round-trip on a 503).
  //   • Use a ref-like flag (seededRef) so a remount during the network call
  //     doesn't double-fire.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    if (aiUnavailable || billingGate) return;
    if (busy) return;
    if (messages.length > 0) return;
    if (input.trim()) return;
    const params = new URLSearchParams(location.search);
    const seed = params.get('seed');
    let prompt = null;
    if (seed === 'customize_plugin') {
      const pluginId = params.get('plugin_id');
      const templateName = params.get('template_name') || 'this template';
      if (!pluginId) return;
      prompt = `I just copied the "${templateName}" template into my workspace as a draft (plugin id ${pluginId}). It's turned off right now. Walk me through what it does in plain English, and ask me what I'd like to change.`;
    } else if (seed === 'deal') {
      // Chat-from-record ("Ask the copilot" on the deal drawer). One grounded
      // opening turn: the model resolves the deal via get_deal itself.
      const dealId = Number(params.get('deal_id'));
      if (!Number.isInteger(dealId) || dealId <= 0) return;
      prompt = `Give me the state of deal #${dealId} — where it stands, what's changed recently, and the single next step I should take. If it has no committed next step, suggest one.`;
    } else if (seed === 'contact') {
      // The copilot has no contact-read tool (deliberately — tool count is
      // lint-pinned), so ground the opening turn client-side: pull the
      // contact + their deal ids and hand them over in the message.
      const contactId = Number(params.get('contact_id'));
      if (!Number.isInteger(contactId) || contactId <= 0) return;
      seededRef.current = true;
      navigate('/chat', { replace: true });
      (async () => {
        let who = `contact #${contactId}`;
        let dealsLine = '';
        try {
          const [c, d] = await Promise.allSettled([
            api.get(`/contacts/${contactId}`),
            api.get(`/contacts/${contactId}/deals`),
          ]);
          if (c.status === 'fulfilled' && c.value?.data) {
            const x = c.value.data;
            const name = `${x.first_name || ''} ${x.last_name || ''}`.trim();
            const bits = [x.job_title, x.email, x.status ? `status ${x.status}` : null].filter(Boolean).join(', ');
            who = `${name || 'this contact'} (contact #${contactId}${bits ? `; ${bits}` : ''})`;
          }
          if (d.status === 'fulfilled' && Array.isArray(d.value?.data) && d.value.data.length) {
            dealsLine = ` Their deals: ${d.value.data.slice(0, 8).map((dl) => `#${dl.id} "${dl.title}" (${dl.stage})`).join(', ')} — use get_deal on those for detail.`;
          }
        } catch { /* fall back to the id-only prompt */ }
        sendMessage(`Brief me on ${who}.${dealsLine} Tell me where the relationship stands, what's happened recently, and the single best next step to move it forward.`);
      })();
      return;
    }
    if (!prompt) return;
    seededRef.current = true;
    sendMessage(prompt);
    navigate('/chat', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiUnavailable, billingGate, busy, messages.length, location.search]);

  // Load sample data (owner/admin). The DemoBanner is mounted app-wide and
  // reads demo status on mount, so a reload is the honest way to show it.
  const seedDemo = useCallback(async () => {
    if (seedingDemo) return;
    setSeedingDemo(true);
    setError('');
    try {
      await api.post('/admin/demo/seed', { profile: orgProfile === 'zang' ? 'zang' : 'generic' });
      window.location.reload();
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not load sample data.');
      setSeedingDemo(false);
    }
  }, [seedingDemo, orgProfile]);

  const onKeyDown = (e) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const greetingName = user?.name ? user.name.split(' ')[0] : '';
  const composerDisabled = busy || aiUnavailable || !!billingGate;
  // True once the first stream event has landed: the live bubble is on
  // screen, so the generic ThinkingBubble steps aside.
  const liveStreaming = messages.length > 0 && !!messages[messages.length - 1].streaming;
  const showFirstRun = home.hasData === false;
  const showDebug = isAdmin && debugMode;

  const emptyStateBody = useMemo(() => {
    if (home.loading && home.hasData === null) return <HomeSkeleton />;
    if (showFirstRun) {
      return welcomeDismissed ? (
        <FirstRunStarters
          onSeed={seedComposer}
          onNavigate={navigate}
          onSeedDemo={seedDemo}
          canSeedDemo={canSeedDemo}
          busy={composerDisabled || seedingDemo}
        />
      ) : (
        <div className="mt-4">
          <WelcomeCard
            onPrompt={seedComposer}
            onSeedDemo={canSeedDemo ? seedDemo : undefined}
            onDismiss={() => setWelcomeDismissed(true)}
            hasData={home.hasData}
          />
          {seedingDemo && <p className="text-xs text-gray-500 mt-1">Loading sample data…</p>}
        </div>
      );
    }
    return (
      <>
        {!showDebug && <TodayStrip myDay={home.myDay} onPick={seedComposer} />}
        <StarterChips onPick={sendMessage} busy={composerDisabled} debugMode={showDebug} />
      </>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home, showFirstRun, welcomeDismissed, canSeedDemo, busy, seedingDemo, showDebug, seedComposer, sendMessage, composerDisabled]);

  return (
    <div className="h-screen bg-gray-50 flex flex-col">
      <Nav active="chat" />
      <main className="flex-1 min-h-0 flex flex-col max-w-3xl w-full mx-auto px-3 sm:px-6 py-4 sm:py-6 overflow-hidden">
        {/* Top-of-page banner: AI not configured on this deployment. */}
        {aiUnavailable && (
          <div className="mb-3 bg-amber-50 border border-amber-300 text-amber-900 rounded-lg px-4 py-3 text-sm">
            <div className="font-semibold mb-0.5">AI features aren't activated on this deployment yet.</div>
            <div className="text-amber-800 text-xs">
              Contact your operator to set <code className="bg-amber-100 px-1 py-0.5 rounded font-mono">ANTHROPIC_API_KEY</code> on the backend.
              Until then the copilot, deal summaries, and plugin generation will stay disabled. Everything else in the CRM works normally.
            </div>
          </div>
        )}
        {/* Pay-as-you-go: the self-serve front door. Shown in place of the
            composer's normal state when the org can't burn AI yet; a slim
            countdown strip while a trial is running; a one-line "you're
            live" note right after checkout completes. */}
        {!aiUnavailable && activating && (
          <div className="mb-3 rounded-lg border border-brand-blue/20 bg-brand-blue/5 px-4 py-3 text-sm text-gray-700 flex items-center gap-2">
            <span className="inline-block h-3 w-3 rounded-full border-2 border-brand-blue border-t-transparent animate-spin" aria-hidden="true" />
            Activating your AI plan…
          </div>
        )}
        {!aiUnavailable && !activating && planStarted && !billingGate && (
          <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
            <span className="font-semibold">AI is on.</span> You're set up on pay-as-you-go: ask away.
          </div>
        )}
        {!aiUnavailable && !activating && billingGate && (
          <AiBillingCard billing={billingGate} returnTo="chat" className="mb-4" />
        )}
        {!aiUnavailable && !billingGate && aiBilling?.status === 'trial' && aiBilling.trial_ends_at && (
          <AiBillingCard billing={aiBilling} variant="trial" returnTo="chat" className="mb-3" />
        )}

        {/* Empty state: greeting + today strip (or first-run surface). */}
        {isEmpty ? (
          <div className="mb-1">
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">
              {greetingName ? `Hey ${greetingName}.` : 'Hey.'} What’s on your plate?
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Ask in plain English. I’ll look at your pipeline and point you at the one thing to do next.
            </p>
            {emptyStateBody}
          </div>
        ) : (
          <div className="mb-1">
            {/* A restored thread (see the restore effect above) still deserves
                the morning briefing — just collapsed by default so it doesn't
                compete with the conversation for attention. */}
            {!showDebug && home.myDay && (
              <details className="mb-1.5 group">
                <summary className="cursor-pointer select-none list-none inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600">
                  <Icon name="clock" size={11} /> Today's briefing
                </summary>
                <div className="mt-1.5">
                  <TodayStrip myDay={home.myDay} onPick={seedComposer} />
                </div>
              </details>
            )}
            <div className="flex items-center justify-end">
              <button
                type="button"
                onClick={startNewChat}
                className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-brand-blue px-2 py-1 rounded transition"
              >
                <Icon name="plus" size={12} /> New chat
              </button>
            </div>
          </div>
        )}

        {/* Scrollable message list. Grows to fill remaining viewport. */}
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto py-3 space-y-3">
          {showDebug && (
            <div className="text-xs text-brand-blue bg-brand-blue/5 border border-brand-blue/20 rounded-lg px-3 py-2">
              <span className="font-semibold">Debug mode:</span> I can inspect audit logs, plugin runs, email sends, and saved views for you. Try “Why didn’t my last plugin run succeed?” or “Show me the last 5 failed audits.”
            </div>
          )}
          {messages.map((m, i) => (
            m.role === 'user'
              ? <UserBubble key={i} text={m.text} />
              : (
                <AssistantBubble
                  key={i}
                  text={m.text}
                  actions={m.actions}
                  explanation={m.explanation}
                  streaming={m.streaming}
                  status={m.status}
                  note={m.note}
                  navigate={navigate}
                  seed={seedComposer}
                />
              )
          ))}
          {busy && !liveStreaming && <ThinkingBubble />}
          {error && (
            <div className="flex justify-start">
              <div className="max-w-[90%] bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-2 text-sm">
                {error}
              </div>
            </div>
          )}
        </div>

        {/* Sticky composer — the page's one focal point. */}
        <div className="relative border-t border-gray-200 bg-white sticky bottom-0 pt-3 -mx-3 sm:-mx-6 px-3 sm:px-6 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-4">
          <OverflowMenu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            sessions={sessions}
            currentSessionId={sessionId}
            onNewChat={startNewChat}
            onOpenSession={loadSession}
            isAdmin={isAdmin}
            debugMode={debugMode}
            onToggleDebug={() => setDebugMode((d) => !d)}
          />
          <div className="flex gap-2 items-end">
            <button
              type="button"
              aria-label="Chat options"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => { if (!menuOpen) refreshSessions(); setMenuOpen((o) => !o); }}
              className="flex-shrink-0 h-11 w-9 inline-flex items-center justify-center rounded-xl text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition"
            >
              <Icon name="dots" size={18} />
            </button>
            <textarea
              ref={inputRef}
              autoFocus
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={composerDisabled}
              aria-label="Message"
              placeholder={
                aiUnavailable ? 'AI is not configured on this deployment'
                : billingGate     ? 'Start the AI plan above to chat'
                : busy            ? 'Thinking…'
                                  : 'Ask anything about your pipeline…'
              }
              className="flex-1 px-4 py-3 border border-gray-300 focus:border-brand-blue rounded-xl text-base outline-none disabled:opacity-60 resize-none leading-relaxed max-h-[200px]"
            />
            {busy ? (
              <button
                type="button"
                onClick={stopGenerating}
                aria-label="Stop generating"
                className="flex-shrink-0 h-11 px-4 inline-flex items-center gap-2 rounded-xl border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:border-red-400 hover:text-red-600 transition"
              >
                <span className="inline-block h-2.5 w-2.5 rounded-sm bg-current" aria-hidden="true" />
                Stop
              </button>
            ) : (
              <Button
                variant="primary"
                size="md"
                onClick={() => sendMessage(input)}
                disabled={composerDisabled || !input.trim()}
                className="rounded-xl h-11"
                aria-label="Send message"
              >
                Send
              </Button>
            )}
          </div>
          <p className="mt-1.5 text-[10px] text-gray-400 text-center">
            Enter to send, Shift+Enter for a new line. Replies are AI-generated — verify before acting on a draft or sending an email.
          </p>
        </div>
      </main>
    </div>
  );
}
