// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Friendly-status helpers for plugin run rows. Mirrors the backend module at
// backend/services/pluginRunFormatter.js — both files are tiny and read by
// non-technical-first surfaces (the runs viewer + the chat copilot). If you
// change a label here, change it there too.
//
// The backend already attaches `friendly_status` to every row returned by
// GET /api/plugins/:id/runs, but this module is used for:
//   1. status pill labels in the filter row (which exist BEFORE we have data),
//   2. badge tone selection (good/warn/bad/neutral),
//   3. tooltip glossary for the "DB queries" / "cpu_ms" columns.

export function friendlyStatus(rawStatus) {
  if (!rawStatus) return 'Status: unknown';
  switch (rawStatus) {
    case 'success':
    case 'ok':
      return 'Worked';
    case 'failed':
    case 'error':
      return "Didn't finish — there was an error";
    case 'budget_exceeded':
    case 'query_budget_exceeded':
    case 'task_budget_exceeded':
      return 'Hit the safety limit on database queries';
    case 'timed_out':
    case 'timeout':
      return 'Took too long — stopped at the 5-second mark';
    case 'sandbox_unavailable':
      return "The plugin sandbox isn't available right now";
    case 'running':
      return 'Still running';
    case 'memory_exceeded':
      return 'Used too much memory and was stopped';
    case 'concurrent_limit_exceeded':
      return 'Too many plugin runs happening at once';
    case 'quota_exceeded':
      return "This month's plugin run quota was reached";
    case 'rejected':
      return "Wasn't allowed to run";
    case 'killed':
      return 'Was stopped mid-run';
    default:
      return `Status: ${rawStatus}`;
  }
}

export function statusTone(rawStatus) {
  if (!rawStatus) return 'neutral';
  switch (rawStatus) {
    case 'success':
    case 'ok':
      return 'good';
    case 'running':
      return 'neutral';
    case 'budget_exceeded':
    case 'query_budget_exceeded':
    case 'task_budget_exceeded':
    case 'timed_out':
    case 'timeout':
    case 'memory_exceeded':
    case 'concurrent_limit_exceeded':
    case 'quota_exceeded':
      return 'warn';
    case 'failed':
    case 'error':
    case 'sandbox_unavailable':
    case 'killed':
      return 'bad';
    case 'rejected':
      return 'neutral';
    default:
      return 'neutral';
  }
}

// Tailwind class lookups for badge tones. Defined here so the runs UI and any
// future "recent runs" widget agree on the palette.
export const TONE_CLASSES = {
  good:    'bg-emerald-50 text-emerald-700 border-emerald-300',
  warn:    'bg-amber-50 text-amber-700 border-amber-300',
  bad:     'bg-red-50 text-red-700 border-red-300',
  neutral: 'bg-gray-100 text-gray-700 border-gray-300',
};

// Format cpu_ms as a short human string ("0.4s", "1.2s", "320ms"). Used in
// the runs table and the column tooltip.
export function formatDuration(ms) {
  if (ms == null) return '—';
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

// Friendly label for trigger_kind / trigger_source. The runs table prefers
// to show "chat" / "schedule" / "manual" rather than the raw enum.
export function triggerLabel(kind, source) {
  const k = (kind || '').toLowerCase();
  if (k === 'chat') return 'Chat';
  if (k === 'schedule' || k === 'cron') return 'Schedule';
  if (k === 'test_run') return 'Test run';
  if (k === 'manual') return source === 'copilot' ? 'Chat' : 'Manual';
  if (k === 'event' || source === 'event') return 'Event trigger';
  if (k) return k.charAt(0).toUpperCase() + k.slice(1);
  return 'Manual';
}
