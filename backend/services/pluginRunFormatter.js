// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Friendly-status mapping for plugin_runs rows. Lives in its own module so the
// chat tool, the runs API, and the runs UI all read from one source of truth.
//
// The raw status values come from services/pluginRunner.js (the runner finalizes
// each run with one of these). The friendly labels are deliberately short and
// non-technical — the runs viewer is built for the customer who clicked "Use
// this template" five minutes ago, not for a developer who knows what
// `budget_exceeded` means.
//
// Frontend has a parallel map in frontend/src/utils/pluginRunStatus.js. If you
// change a label here, change it there too (both files are tiny by design so
// the cost of duplication is lower than the cost of an extra round-trip).

/**
 * Map a raw plugin_runs.status value to a friendly customer-facing label.
 * Returns 'Status: <raw>' for anything not in the table so a new status added
 * later still surfaces SOMETHING readable instead of falling through to null.
 *
 * @param {string|null|undefined} rawStatus
 * @returns {string}
 */
function friendlyStatus(rawStatus) {
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
      return 'This month\'s plugin run quota was reached';
    case 'rejected':
      return "Wasn't allowed to run";
    case 'killed':
      return 'Was stopped mid-run';
    default:
      return `Status: ${rawStatus}`;
  }
}

/**
 * "Tone" hint for badge coloring. Lets the runs UI pick a consistent palette
 * without re-deriving from the raw status. The three buckets — `good`, `warn`,
 * `bad` — match the existing emerald/amber/red badge palette the runs table
 * uses on PluginDetail.js.
 *
 * @param {string|null|undefined} rawStatus
 * @returns {'good'|'warn'|'bad'|'neutral'}
 */
function statusTone(rawStatus) {
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

module.exports = { friendlyStatus, statusTone };
