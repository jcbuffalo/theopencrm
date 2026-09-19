// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// WelcomeCard — the first-run surface on the Chat front door.
//
// Greets a brand-new workspace by its brand display name and offers a few
// first moves. Every move that CAN happen in chat is a chat prompt (it seeds
// the composer via `onPrompt` and the user stays on the page); only two
// genuinely need another screen (CSV import) or a server action (loading
// sample data, owner/admin only, via `onSeedDemo`).
//
// Props:
//   onPrompt(text)   — seed the chat composer with a prompt. When omitted the
//                      prompt tasks render as plain buttons that only record
//                      completion (back-compat for callers without a composer).
//   onSeedDemo()     — load sample data. Task hidden when not provided.
//   onDismiss()      — called after the user dismisses the card (so the host
//                      page can swap in a fallback surface).
//   hasData          — true once the org has deals/contacts: the card returns
//                      null (its job is done). null/undefined = unknown: show.
//
// State (dismissed / per-task completion) persists in localStorage per
// (user_id x org_id). Never re-shows once dismissed. Frontend-only.

import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../AuthContext';

// Catalogue of first-time tasks per white-label profile. Keep titles to
// 5–6 words and hints under 80 characters; the card lays them out as a
// compact vertical list and longer copy wraps badly on iPhone SE (375px).
// Unknown profiles (including jcp) fall back to the generic list.
const TASK_CATALOGUE = {
  generic: [
    // Owner/admin only (filtered below): the spec-203 first-run moment.
    { key: 'build_workspace', title: 'Describe how you sell — I’ll build your CRM', hint: 'Your pipeline, fields, and follow-ups from a few plain sentences.', to: '/setup', adminOnly: true },
    { key: 'import_contacts', title: 'Import your contacts', hint: 'Bring your book of business in from a CSV.', to: '/import' },
    { key: 'add_first_deal', title: 'Add your first deal', hint: 'Tell me about the opportunity you have right now.', prompt: 'I want to add my first deal. Ask me for the company, the contact, what it is worth, and when I expect it to close — then set it up.' },
    { key: 'load_sample_data', title: 'Load sample data to explore', hint: 'A small demo workspace you can clear in one click.', action: 'seed_demo' },
    { key: 'invite_teammate', title: 'Invite a teammate', hint: 'Bring your team into the same shared workspace.', prompt: 'How do I invite a teammate to my workspace?' },
    { key: 'what_can_you_do', title: 'Ask what I can do', hint: 'Plain-English tour of the copilot.', prompt: 'What can you do?' },
  ],
  zang: [
    { key: 'review_rfqs', title: 'Review your active RFQs', hint: 'Every open RFQ across the Pre-Sale phases at a glance.', prompt: 'Show me my active RFQs across the Pre-Sale phases.' },
    { key: 'add_vendor_quote', title: 'Add a vendor quote', hint: 'Log the supplier pricing that backs your customer quote.', prompt: 'How do I add a vendor quote?' },
    { key: 'open_issues_board', title: 'Open Issues board', hint: 'Track post-shipment problems before they snowball.', prompt: 'Show me my open issues.' },
    { key: 'load_sample_data', title: 'Load sample data to explore', hint: 'A small demo workspace you can clear in one click.', action: 'seed_demo' },
    { key: 'what_can_you_do', title: 'Ask what I can do', hint: 'Plain-English tour of the copilot.', prompt: 'What can you do?' },
  ],
};

export function tasksForProfile(profile) {
  if (profile && TASK_CATALOGUE[profile]) return TASK_CATALOGUE[profile];
  return TASK_CATALOGUE.generic;
}

// localStorage key shape:
//   theopencrm.welcome.v1.<user_id>.<org_id>
// Value is JSON-serialized:
//   { dismissedAt: ISO|null, completed: { [taskKey]: ISO } }
// We bump the v1 suffix if the task catalogue ever materially changes and we
// want to re-show the card to existing customers.
function storageKey(userId, orgId) {
  return `theopencrm.welcome.v1.${userId || 'anon'}.${orgId || 'none'}`;
}

export function isWelcomeDismissed(userId, orgId) {
  return !!readState(storageKey(userId, orgId)).dismissedAt;
}

function readState(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { dismissedAt: null, completed: {} };
    const parsed = JSON.parse(raw);
    return {
      dismissedAt: parsed?.dismissedAt || null,
      completed: parsed?.completed && typeof parsed.completed === 'object' ? parsed.completed : {},
    };
  } catch {
    return { dismissedAt: null, completed: {} };
  }
}

function writeState(key, state) {
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    /* Quota / privacy mode — best-effort; the card just won't persist. */
  }
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export default function WelcomeCard({ onPrompt, onSeedDemo, onDismiss, hasData }) {
  const { user, orgProfile, orgBranding, orgName, orgRole } = useAuth();
  const isAdmin = ['owner', 'admin'].includes(orgRole || user?.org_role);

  // Resolve a stable storage key only when we actually have a user. Until
  // /auth/me resolves, user is null and we should render nothing — otherwise
  // we'd briefly write/read under the 'anon.none' key and have a flash.
  const key = useMemo(() => {
    if (!user?.id) return null;
    return storageKey(user.id, user.org_id);
  }, [user?.id, user?.org_id]);

  // null until we've read localStorage. Render nothing during that beat so
  // we never flash a card the user previously dismissed.
  const [state, setState] = useState(null);

  useEffect(() => {
    if (!key) {
      setState(null);
      return;
    }
    setState(readState(key));
  }, [key]);

  if (!key || !state) return null;
  if (state.dismissedAt) return null;
  if (hasData === true) return null;

  const tasks = tasksForProfile(orgProfile)
    .filter((t) => t.action !== 'seed_demo' || typeof onSeedDemo === 'function')
    .filter((t) => !t.adminOnly || isAdmin);

  // Greeting precedence: branding display name, else org name, else the
  // user's first name. Branding override is what makes the card feel
  // bespoke for Northwind / Zang / future white-label deployments.
  const displayName =
    (orgBranding && orgBranding.displayName) ||
    orgName ||
    (user?.name ? user.name.split(' ')[0] : null);

  const greeting = displayName
    ? `Welcome to The Open CRM, ${displayName}.`
    : 'Welcome to The Open CRM.';

  const handleDismiss = () => {
    const next = { ...state, dismissedAt: new Date().toISOString() };
    setState(next);
    writeState(key, next);
    if (typeof onDismiss === 'function') onDismiss();
  };

  const markDone = (taskKey) => {
    // Best-effort progress tracking — we mark the task complete as soon as
    // the user clicks it. There's no backend verification; this is a visual
    // nudge, not a workflow gate.
    if (state.completed?.[taskKey]) return;
    const next = {
      ...state,
      completed: { ...(state.completed || {}), [taskKey]: new Date().toISOString() },
    };
    setState(next);
    writeState(key, next);
  };

  const handleTaskClick = (task) => {
    markDone(task.key);
    if (task.prompt && typeof onPrompt === 'function') onPrompt(task.prompt);
    else if (task.action === 'seed_demo' && typeof onSeedDemo === 'function') onSeedDemo();
  };

  const rowClass = 'group w-full text-left flex items-start gap-3 px-2 sm:px-3 py-2 -mx-2 sm:-mx-3 rounded-lg hover:bg-brand-blue/5 focus:bg-brand-blue/5 focus:outline-none focus:ring-2 focus:ring-brand-blue/40 transition';

  const rowBody = (task, done) => (
    <>
      <span
        aria-hidden="true"
        className={
          'mt-0.5 flex-shrink-0 w-5 h-5 rounded-full border inline-flex items-center justify-center ' +
          (done
            ? 'bg-brand-blue border-brand-blue text-white'
            : 'border-gray-300 text-gray-400 group-hover:border-brand-blue group-hover:text-brand-blue')
        }
      >
        {done ? <CheckIcon /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={
            'block text-sm font-medium ' +
            (done ? 'text-gray-500 line-through' : 'text-gray-900 group-hover:text-brand-blue')
          }
        >
          {task.title}
        </span>
        <span className="block text-xs text-gray-500 mt-0.5 break-words">
          {task.hint}
        </span>
      </span>
      <span
        aria-hidden="true"
        className="flex-shrink-0 self-center text-gray-300 group-hover:text-brand-blue"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </span>
    </>
  );

  return (
    <div
      role="region"
      aria-label="First-session welcome"
      className="mb-4 bg-white border border-gray-200 rounded-xl shadow-sm p-4 sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base sm:text-lg font-semibold text-gray-900 break-words">
            {greeting}
          </h2>
          <p className="text-xs sm:text-sm text-gray-500 mt-0.5">
            A few first moves. Most of them happen right here in chat.
          </p>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss welcome card"
          className="flex-shrink-0 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-full w-8 h-8 inline-flex items-center justify-center transition"
        >
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      <ul className="mt-3 space-y-1.5">
        {tasks.map((task) => {
          const done = !!state.completed?.[task.key];
          return (
            <li key={task.key}>
              {task.to ? (
                <Link to={task.to} onClick={() => markDone(task.key)} className={rowClass}>
                  {rowBody(task, done)}
                </Link>
              ) : (
                <button type="button" onClick={() => handleTaskClick(task)} className={rowClass}>
                  {rowBody(task, done)}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
