// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Fire-and-forget browser crash reporter → POST /api/client-errors →
// logger.error(serviceContext synccrm-frontend) → GCP Error Reporting.
//
// HARD RULES:
//   - MUST NEVER THROW. Every statement is inside try/catch; a crash reporter
//     that crashes turns one incident into two.
//   - Fire-and-forget: no awaiting, no retries, response ignored. Uses plain
//     fetch with keepalive (NOT the shared axios instance — its interceptors
//     do CSRF refresh round-trips that may themselves be broken when the app
//     is crashing; the endpoint is CSRF-exempt and auth-optional anyway).
//   - Self-limiting: at most MAX_REPORTS per page lifetime, and duplicate
//     messages are sent once — an error loop must not flood the endpoint
//     (the server also rate-limits 10/15min/IP).

// Same env-inlined constant as api.js (kept literal here so this module has
// zero imports and can never be part of a broken dependency cycle).
const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5001/api';

const MAX_REPORTS = 3;
const MAX_STACK = 4096; // matches the server's truncation bound

let reportsSent = 0;
const seenMessages = new Set();

export default function reportClientError(error, info) {
  try {
    if (reportsSent >= MAX_REPORTS) return;

    const message = String((error && error.message) || error || 'Unknown client error').slice(0, 1000);
    if (seenMessages.has(message)) return;
    seenMessages.add(message);
    reportsSent += 1;

    const payload = JSON.stringify({
      message,
      stack: typeof error?.stack === 'string' ? error.stack.slice(0, MAX_STACK) : null,
      componentStack: typeof info?.componentStack === 'string' ? info.componentStack.slice(0, MAX_STACK) : null,
      path: typeof window !== 'undefined' ? window.location.pathname.slice(0, 300) : null,
      ua: typeof navigator !== 'undefined' ? String(navigator.userAgent).slice(0, 300) : null,
    });

    fetch(`${API_URL}/client-errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
      // Endpoint is auth-optional; sending the session cookie (when present)
      // lets the server annotate the report with a userId for triage. An
      // invalid/absent cookie is fine — optionalAuth degrades to anonymous.
      credentials: 'include',
    }).catch(() => {});
  } catch {
    // Swallow everything — see HARD RULES.
  }
}
