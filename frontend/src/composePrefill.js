// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Hand-off store for "open the email composer with this draft" across a
// route change. Chat's `draft_email` chip navigates to /deals?dealId=N&compose=1;
// the drafted text can't ride in the URL (length, encoding, history noise), so
// the chip stashes it here and DealPanel takes it once the composer opens.
//
// One slot, keyed by deal id, take-once semantics. sessionStorage survives the
// route change (and a reload mid-hop) but not the tab; an in-memory fallback
// covers private windows where storage throws. Never used for anything that
// must persist.

const KEY = 'ocrm:compose-prefill';
let memory = null;

export function stashComposeDraft(dealId, text) {
  const entry = { dealId: Number(dealId), text: String(text || ''), at: Date.now() };
  memory = entry;
  try { window.sessionStorage.setItem(KEY, JSON.stringify(entry)); } catch { /* storage unavailable */ }
}

// Returns the stashed draft text for `dealId` (and clears it), or null.
export function takeComposeDraft(dealId) {
  let entry = memory;
  if (!entry) {
    try {
      const raw = window.sessionStorage.getItem(KEY);
      entry = raw ? JSON.parse(raw) : null;
    } catch { entry = null; }
  }
  memory = null;
  try { window.sessionStorage.removeItem(KEY); } catch { /* storage unavailable */ }
  if (!entry || Number(entry.dealId) !== Number(dealId)) return null;
  // Stale stash (older than 10 minutes) is discarded — the user has moved on.
  if (Date.now() - Number(entry.at || 0) > 10 * 60 * 1000) return null;
  return entry.text || null;
}
