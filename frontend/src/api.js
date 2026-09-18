// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// API client with axios
//
// Session model (changed 2026-05): the auth token now lives in an httpOnly
// cookie set by the backend on /auth/login, /auth/google-signin, and
// /auth/2fa/verify. Browsers send it automatically; JS can't read it (XSS-safe).
//
// CSRF: the backend also sets a readable cookie called `csrfToken`. On every
// state-changing request (POST/PUT/PATCH/DELETE) we copy that value into the
// X-CSRF-Token header. The double-submit comparison on the server blocks
// cross-origin forgery because an attacker on another origin can't read the
// cookie to know the token.

import axios from 'axios';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5001/api';

// withCredentials: true → axios includes cookies on cross-origin requests
// (Cloud Run frontend → Cloud Run backend). The backend's CORS allowlist
// already permits credentials.
const api = axios.create({
  baseURL: API_URL,
  timeout: 10000,
  withCredentials: true,
});

// In-memory mirror of the CSRF token. csrf-csrf stores a HASHED secret in
// the `csrfToken` cookie — the RAW token (what we send via X-CSRF-Token)
// is only returned in the JSON body of token-minting endpoints. So the
// previous `|| readCookie('csrfToken')` fallback was wrong: it sent the
// hashed value as the header, the server re-hashed it, hashes didn't
// match, 403 every state-changing call. Always use the memo. If the memo
// is empty (page reload, etc.), refreshCsrfToken() below fetches a fresh
// one from /auth/csrf.
let csrfTokenMemo = null;
export function setCsrfToken(token) {
  csrfTokenMemo = token || null;
}
let csrfRefreshInFlight = null;
export async function refreshCsrfToken() {
  if (csrfRefreshInFlight) return csrfRefreshInFlight;
  csrfRefreshInFlight = (async () => {
    try {
      const r = await api.get('/auth/csrf');
      if (r.data?.csrfToken) setCsrfToken(r.data.csrfToken);
    } catch {
      // Swallow; the eventual mutating request will surface the 403 if
      // refresh fails.
    } finally {
      csrfRefreshInFlight = null;
    }
  })();
  return csrfRefreshInFlight;
}

// Attach CSRF token on state-changing requests. If the memo is empty (page
// reload after a previous session, etc.) refresh it before the request
// fires so we don't ship a missing header and 403 ourselves.
const MUTATING_METHODS = new Set(['post', 'put', 'patch', 'delete']);
api.interceptors.request.use(async (config) => {
  const method = (config.method || 'get').toLowerCase();
  if (MUTATING_METHODS.has(method)) {
    // Skip auto-refresh for the CSRF-exempt routes (login, register,
    // 2fa-verify, resend-verification, csrf itself, webhooks, etc.) — they
    // don't need the header and refresh would cause a chicken-and-egg.
    const url = config.url || '';
    const exemptPrefix = /^\/?auth\/(login|register|google-signin|test-login|2fa\/verify|resend-verification|csrf)$/;
    if (!exemptPrefix.test(url.replace(/^\/api\//, ''))) {
      if (!csrfTokenMemo) {
        await refreshCsrfToken();
      }
      if (csrfTokenMemo) {
        config.headers['X-CSRF-Token'] = csrfTokenMemo;
      }
    }
  }
  return config;
});

// Endpoints that probe auth state and are EXPECTED to 401 when signed out.
// AuthContext fires /auth/me on every page load — including public pages like
// the Landing marketing page at `/`. A 401 from these just means "not signed
// in"; it must NOT force a redirect, or unauthenticated visitors get bounced
// off the landing page straight to /login. Real in-app 401s (e.g. a /deals
// fetch failing mid-session) still redirect.
const AUTH_PROBE_PATHS = [/\/auth\/me$/, /\/auth\/csrf$/, /\/ai\/status$/];

// Handle responses — on a real (non-probe) 401, kick to login. No localStorage
// cleanup needed (we no longer store the JWT there).
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      const reqUrl = error.config?.url || '';
      const isProbe = AUTH_PROBE_PATHS.some((re) => re.test(reqUrl));
      // Skip the redirect for the ambient auth probes, and when we're already
      // on /login (avoids a redirect loop).
      if (
        !isProbe &&
        typeof window !== 'undefined' &&
        window.location &&
        !window.location.pathname.startsWith('/login')
      ) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

// ============================================================================
// STREAMED CHAT (Server-Sent Events over fetch)
// ============================================================================
//
// axios can't consume a streaming body in the browser, so the chat turn's
// streaming variant goes through fetch. It carries the SAME session
// credentials as the axios client: `credentials: 'include'` sends the
// httpOnly auth cookie cross-origin (the backend's CORS allowlist permits
// credentials, and the route sits under the same /api/ai gates), and the
// in-memory CSRF token is echoed in X-CSRF-Token — refreshed via /auth/csrf
// first if the memo is empty, exactly as the request interceptor does for
// every axios POST.
//
// streamChat(body, { onEvent, signal }) resolves with the `done` payload
// ({ session_id, reply, actions, explanation, usage } — the blocking route's
// JSON shape plus usage) and calls onEvent({ event, data }) for every event
// before it (status / token / reset / actions). It rejects with:
//   • err.response = { status, data } for a non-2xx JSON reply (400 / 402 /
//     429 / 503 — the shape axios errors carry, so one handler serves both
//     routes) and for a server-sent `error` event (status from the event);
//   • err.name === 'AbortError' when `signal` fires (Stop button);
//   • err.streamUnsupported = true when the reply isn't an event stream
//     (buffering proxy, older backend) — fall back to POST /ai/chat.
// err.firstEventSeen says whether anything streamed before the failure;
// falling back is only safe when it didn't (the server may have persisted
// the turn otherwise).

function parseSseBlock(raw) {
  let event = 'message';
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    let value = i === -1 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return null;
  return { event, data: data.join('\n') };
}

export async function streamChat(body, { onEvent, signal } = {}) {
  if (!csrfTokenMemo) await refreshCsrfToken();
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (csrfTokenMemo) headers['X-CSRF-Token'] = csrfTokenMemo;

  const res = await fetch(`${API_URL}/ai/chat/stream`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(body || {}),
    signal,
  });

  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    // Mirror the axios response interceptor: a real 401 mid-session means
    // the cookie is gone — send the user to sign in again.
    if (
      res.status === 401 &&
      typeof window !== 'undefined' &&
      window.location &&
      !window.location.pathname.startsWith('/login')
    ) {
      window.location.href = '/login';
    }
    const err = new Error((data && (data.error || data.message)) || `Request failed with status code ${res.status}`);
    err.response = { status: res.status, data };
    err.firstEventSeen = false;
    throw err;
  }

  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (!ctype.includes('text/event-stream') || !res.body || typeof res.body.getReader !== 'function') {
    const err = new Error('Streaming is not available');
    err.streamUnsupported = true;
    err.firstEventSeen = false;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const SEP = /\r?\n\r?\n/;
  let buf = '';
  let firstEventSeen = false;
  let done = null;

  const handle = (evt) => {
    let data = null;
    try { data = JSON.parse(evt.data); } catch { data = null; }
    firstEventSeen = true;
    if (evt.event === 'done') { done = data || {}; return; }
    if (evt.event === 'error') {
      const err = new Error((data && data.error) || 'Chat failed');
      err.response = { status: (data && data.status) || 502, data };
      err.firstEventSeen = true;
      throw err;
    }
    if (onEvent) onEvent({ event: evt.event, data });
  };

  try {
    for (;;) {
      const { done: eof, value } = await reader.read();
      if (eof) break;
      buf += decoder.decode(value, { stream: true });
      let m;
      while ((m = SEP.exec(buf))) {
        const raw = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const evt = parseSseBlock(raw);
        if (evt) handle(evt);
      }
      if (done) break;
    }
    if (!done && buf.trim()) {
      const evt = parseSseBlock(buf);
      if (evt) handle(evt);
    }
  } catch (err) {
    if (err && err.firstEventSeen === undefined) err.firstEventSeen = firstEventSeen;
    throw err;
  } finally {
    try { reader.cancel().catch(() => {}); } catch { /* already closed */ }
  }

  if (!done) {
    const err = new Error('The connection dropped before the reply finished.');
    err.firstEventSeen = firstEventSeen;
    throw err;
  }
  return done;
}
api.streamChat = streamChat;

// ============================================================================
// AUTHENTICATED FILE DOWNLOAD
// ============================================================================
//
// Session auth is an httpOnly cookie — JS can't read it, and a plain
// `<a href>` or a raw `fetch()` without credentials won't send it, so
// authenticated file endpoints (document downloads, quote/PO PDFs) 401 for
// every cookie-auth user. `localStorage.getItem('authToken')` is a dead
// relic that returns null for normal users. Route every authenticated
// download through the shared axios instance (withCredentials + CSRF) as a
// blob, then trigger a client-side download via a temporary object URL.
export async function downloadBlob(path, filename) {
  const res = await api.get(path, { responseType: 'blob' });
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ============================================================================
// AUTH API
// ============================================================================

export const auth = {
  register: async (name, email, password) => {
    const response = await api.post('/auth/register', { name, email, password });
    if (response.data?.csrfToken) setCsrfToken(response.data.csrfToken);
    return response.data;
  },

  login: async (email, password, idToken = null) => {
    // If idToken is provided, use Google signin endpoint.
    if (idToken) {
      const response = await api.post('/auth/google-signin', { idToken });
      if (response.data?.csrfToken) setCsrfToken(response.data.csrfToken);
      return response.data;
    }

    const response = await api.post('/auth/login', { email, password });
    if (response.data?.csrfToken) setCsrfToken(response.data.csrfToken);
    return response.data;
  },

  googleSignIn: async (idToken) => {
    const response = await api.post('/auth/google-signin', { idToken });
    if (response.data?.csrfToken) setCsrfToken(response.data.csrfToken);
    return response.data;
  },

  // Complete the 2FA challenge. tempToken comes from the previous login call
  // (when requires2fa: true). On success, the backend sets the auth cookie
  // and returns a fresh csrfToken.
  verify2fa: async (tempToken, code) => {
    const response = await api.post('/auth/2fa/verify', { tempToken, code });
    if (response.data?.csrfToken) setCsrfToken(response.data.csrfToken);
    return response.data;
  },

  logout: async () => {
    try {
      await api.post('/auth/logout');
    } catch (error) {
      // Log out anyway even if the request fails — the cookie may already be
      // expired/gone, and we still want to clear local state.
    }
    setCsrfToken(null);
  },

  getMe: () => api.get('/auth/me'),
};

// ============================================================================
// DRIVE INTEL API
// ============================================================================
//
// Thin wrappers around the endpoints documented in DRIVE_INTEL_SPEC.md §HTTP
// API. Every helper resolves with the parsed response data on success, or
// rejects with the original axios error so callers can distinguish 404 (no
// folder linked / no summary yet) from 503 (Drive feature/integration not
// configured on this deployment) from a real 5xx.
//
// Graceful-degradation contract: a 503 with body
// `{ error: 'Drive integration not configured' }` or
// `{ error: 'Drive feature not enabled' }` is a known state, not a bug — UI
// components surface a guidance message rather than a red error banner.

export const drive = {
  // -- Connection ----------------------------------------------------------
  // GET /api/drive/connection → { connected: bool, email?, expires_at?, status? }
  // 503 when env vars unset; component treats as "not configured".
  getConnection: () => api.get('/drive/connection').then((r) => r.data),

  // GET /api/drive/auth/start → { authUrl }
  // Caller opens authUrl in a new tab; on callback the backend redirects to
  // /settings#drive.
  startAuth: () => api.get('/drive/auth/start').then((r) => r.data),

  // DELETE /api/drive/connection — revokes the refresh token with Google and
  // deletes the row. Admin-only on the backend; component also guards.
  disconnect: () => api.delete('/drive/connection').then((r) => r.data),

  // -- Folder search & link ------------------------------------------------
  // GET /api/drive/folders/search?q= → up to 25 folder results.
  // Pass an empty string to seed an empty list rather than firing a request.
  searchFolders: (query) =>
    api
      .get('/drive/folders/search', { params: { q: query || '' } })
      .then((r) => r.data),

  // POST /api/deals/:id/drive-folder { drive_folder_id, folder_name }
  // Backend verifies readability and persists the 1:1 link.
  linkFolder: (dealId, folder) =>
    api
      .post(`/deals/${dealId}/drive-folder`, {
        drive_folder_id: folder.drive_folder_id,
        folder_name: folder.folder_name,
        // folder_url is optional in the API but we pass it through when we
        // have it (e.g. from the "paste URL" fallback) so the backend can
        // round-trip it onto the row without recomputing.
        folder_url: folder.folder_url,
      })
      .then((r) => r.data),

  // DELETE /api/deals/:id/drive-folder — cascades file rows.
  unlinkFolder: (dealId) =>
    api.delete(`/deals/${dealId}/drive-folder`).then((r) => r.data),

  // -- Sync + files --------------------------------------------------------
  // POST /api/deals/:id/drive-folder/sync → { jobId, status }
  sync: (dealId) =>
    api.post(`/deals/${dealId}/drive-folder/sync`).then((r) => r.data),

  // GET /api/deals/:id/drive-folder/files → [{ id, name, mime_type,
  //   size_bytes, extraction_status, extraction_error?, drive_modified_at }]
  getFiles: (dealId) =>
    api.get(`/deals/${dealId}/drive-folder/files`).then((r) => r.data),

  // -- Intel summary -------------------------------------------------------
  // GET /api/deals/:id/intel → latest deal_intel_summaries row (404 if none).
  getIntel: (dealId) =>
    api.get(`/deals/${dealId}/intel`).then((r) => r.data),

  // POST /api/deals/:id/intel/refresh — regenerate. Backend rate-limits to
  // 5/15min per deal; surfaces 402 if org over the AI cost cap.
  refreshIntel: (dealId) =>
    api.post(`/deals/${dealId}/intel/refresh`).then((r) => r.data),

  // GET /api/deals/:id/intel/history → last 10 summaries.
  getIntelHistory: (dealId) =>
    api.get(`/deals/${dealId}/intel/history`).then((r) => r.data),

  // -- Write-back-to-CRM suggestions (Phase 2) -----------------------------
  // All routes additionally gated by `drive_intel_writeback_enabled` on the
  // backend — a 403/404/503 from any of them is the signal that the panel
  // should be hidden client-side rather than show a red error banner.

  // POST /api/deals/:id/intel/suggest — generate per-field update suggestions
  // off the latest summary. Rate-limited 5/15min per deal. The optional
  // summaryId arg is currently ignored by the backend (always uses the
  // latest summary) but kept on the signature for a future "regenerate
  // against a historical snapshot" surface.
  suggestWriteback: (dealId, _summaryId) =>
    api.post(`/deals/${dealId}/intel/suggest`).then((r) => r.data),

  // GET /api/deals/:id/intel/suggestions?status= — defaults pending.
  listSuggestions: (dealId, status = 'pending') =>
    api
      .get(`/deals/${dealId}/intel/suggestions`, { params: { status } })
      .then((r) => r.data),

  // POST /api/deals/:id/intel/suggestions/:sid/apply — apply with stale-data
  // check; backend returns 409 STALE_DATA if the live deal changed since
  // suggestion was generated.
  applySuggestion: (dealId, sid) =>
    api.post(`/deals/${dealId}/intel/suggestions/${sid}/apply`).then((r) => r.data),

  // POST /api/deals/:id/intel/suggestions/:sid/reject — no deal mutation.
  rejectSuggestion: (dealId, sid) =>
    api.post(`/deals/${dealId}/intel/suggestions/${sid}/reject`).then((r) => r.data),

  // GET /api/deals/:id/intel/writebacks?within=7d — recently applied writes.
  listWritebacks: (dealId) =>
    api.get(`/deals/${dealId}/intel/writebacks`, { params: { within: '7d' } }).then((r) => r.data),

  // POST /api/deals/:id/intel/writeback/:wbId/undo — restore prior_value,
  // 7-day window enforced server-side (409 UNDO_WINDOW_EXPIRED past then).
  undoWriteback: (dealId, wbId) =>
    api.post(`/deals/${dealId}/intel/writeback/${wbId}/undo`).then((r) => r.data),
};

// ============================================================================
// GMAIL API (foundation — summarization endpoints land in a follow-up PR)
// ============================================================================
//
// Mirrors the `drive` namespace above. Two surfaces:
//
//   gmail        — OAuth connection management (admin surface).
//   gmailThreads — per-deal thread linkage, picker, sync.
//
// Backend routes are all gated behind the gmail_intel_enabled feature flag
// (default off — gmail.readonly is a Google "restricted" scope and a
// production rollout requires CASA verification, 6–12 weeks / $4–15K).
// A 404 from a probe typically means the flag is off for the current org,
// NOT that the integration is broken — UI should treat that as "not
// enabled for your account".

export const gmail = {
  // GET /api/gmail/connection → { connected: bool, email?, expires_at?,
  //   status?, last_error? }. 503 when OAuth client isn't configured;
  //   component treats as "not configured".
  getConnection: () => api.get('/gmail/connection').then((r) => r.data),

  // GET /api/gmail/auth/start → { authUrl }. Caller opens authUrl in a new
  // tab; on callback the backend redirects to /settings#gmail=connected.
  startAuth: () => api.get('/gmail/auth/start').then((r) => r.data),

  // DELETE /api/gmail/connection — revokes the refresh token with Google
  // and deletes the row. Admin-only on the backend; component also guards.
  disconnect: () => api.delete('/gmail/connection').then((r) => r.data),
};

export const gmailThreads = {
  // GET /api/gmail/threads/search?q= → { threads: [{ gmail_thread_id,
  //   subject, snippet, participants[], message_count, last_message_at }] }
  // Pass an empty string to seed the picker without firing a request.
  search: (query) =>
    api
      .get('/gmail/threads/search', { params: { q: query || '' } })
      .then((r) => r.data),

  // GET /api/deals/:id/gmail-threads → { threads: [...row shape...] }
  list: (dealId) =>
    api.get(`/deals/${dealId}/gmail-threads`).then((r) => r.data),

  // POST /api/deals/:id/gmail-threads { gmail_thread_id, subject? }
  // Backend verifies readability and persists the link (N:1 — multiple
  // threads per deal supported; upserts on (deal_id, gmail_thread_id)).
  link: (dealId, thread) =>
    api
      .post(`/deals/${dealId}/gmail-threads`, {
        gmail_thread_id: thread.gmail_thread_id,
        subject: thread.subject,
      })
      .then((r) => r.data),

  // DELETE /api/deals/:id/gmail-threads/:threadLinkId — cascades message rows.
  unlink: (dealId, threadLinkId) =>
    api
      .delete(`/deals/${dealId}/gmail-threads/${threadLinkId}`)
      .then((r) => r.data),

  // POST /api/deals/:id/gmail-threads/:threadLinkId/sync →
  //   { synced, skipped, errors[], messages_total }. Rate-limited 10/15min
  //   per (org, ip).
  sync: (dealId, threadLinkId) =>
    api
      .post(`/deals/${dealId}/gmail-threads/${threadLinkId}/sync`)
      .then((r) => r.data),

  // -- Per-thread intel summary (Phase 2 — migration 094) ------------------
  // Mirrors the `drive.getIntel` / `drive.refreshIntel` shape but on a
  // per-thread basis (a deal can have many threads; each gets its own
  // summary). Backend routes are also gated by `gmail_intel_enabled`.

  // GET /api/deals/:id/gmail-intel/threads/:threadLinkId → latest
  // deal_gmail_summaries row for the thread (404 if none yet).
  getThreadSummary: (dealId, threadLinkId) =>
    api
      .get(`/deals/${dealId}/gmail-intel/threads/${threadLinkId}`)
      .then((r) => r.data),

  // POST /api/deals/:id/gmail-intel/threads/:threadLinkId/refresh —
  // regenerate. Backend rate-limits to 5/15min per thread; surfaces 402
  // if org is over the AI cost cap, 422 if no extracted message bodies
  // are available yet (run a sync first).
  refreshThreadSummary: (dealId, threadLinkId) =>
    api
      .post(`/deals/${dealId}/gmail-intel/threads/${threadLinkId}/refresh`)
      .then((r) => r.data),
};

// ============================================================================
// GOOGLE CALENDAR API (migration 115)
// ============================================================================
//
// Two surfaces mirroring the `gmail` / `gmailThreads` split:
//
//   calendar     — OAuth connection management (admin surface) + org-wide sync.
//   dealCalendar — per-deal meeting list + "Schedule meeting" create.
//
// Backend routes are gated behind the calendar_enabled feature flag (default
// off — calendar.events is a Google "sensitive" scope requiring OAuth
// verification for a general-audience rollout). A 404 from a probe typically
// means the flag is off for the current org, NOT that the integration is
// broken — UI should treat that as "not enabled for your account".

export const calendar = {
  // GET /api/calendar/connection → { connected, email?, status?, last_error?,
  //   last_sync_at?, sync_status? }. 503 when OAuth client isn't configured.
  getConnection: () => api.get('/calendar/connection').then((r) => r.data),

  // GET /api/calendar/auth/start → { authUrl }. Caller opens authUrl in a new
  // tab; on callback the backend redirects to /settings#calendar=connected.
  startAuth: () => api.get('/calendar/auth/start').then((r) => r.data),

  // DELETE /api/calendar/connection — revokes the refresh token + deletes row.
  disconnect: () => api.delete('/calendar/connection').then((r) => r.data),

  // POST /api/calendar/sync → { connected, events_scanned, events_matched }.
  // Pulls recent/updated events and matches them to deals by attendee email.
  sync: () => api.post('/calendar/sync').then((r) => r.data),
};

export const msgraph = {
  // GET /api/msgraph/connection → { connected, email?, status?, last_error?,
  //   last_mail_sync_at?, mail_sync_status?, last_calendar_sync_at?,
  //   calendar_sync_status? }. 503 when the Microsoft app registration isn't
  //   configured; 403 FEATURE_DISABLED when neither outlook flag is on.
  getConnection: () => api.get('/msgraph/connection').then((r) => r.data),

  // GET /api/msgraph/auth/start → { authUrl }. Caller opens authUrl in a new
  // tab; on callback the backend redirects to /settings#outlook=connected.
  startAuth: () => api.get('/msgraph/auth/start').then((r) => r.data),

  // DELETE /api/msgraph/connection — deletes the stored tokens. (Microsoft
  // has no public revoke endpoint; the response notes where to fully revoke.)
  disconnect: () => api.delete('/msgraph/connection').then((r) => r.data),

  // POST /api/msgraph/mail/sync → { connected, messages_scanned,
  //   messages_matched }. Gated by outlook_mail_enabled.
  syncMail: () => api.post('/msgraph/mail/sync').then((r) => r.data),

  // POST /api/msgraph/calendar/sync → { connected, events_scanned,
  //   events_matched }. Gated by outlook_calendar_enabled.
  syncCalendar: () => api.post('/msgraph/calendar/sync').then((r) => r.data),
};

// Per-deal Outlook intel (migration 140 read surface). Gated by
// outlook_mail_enabled | outlook_calendar_enabled — a 403 FEATURE_DISABLED
// means the module is off; callers hide the panel.
export const dealOutlookIntel = {
  // GET /api/deals/:id/outlook-intel → { connected, messages: [...], events: [...] }
  get: (dealId) => api.get(`/deals/${dealId}/outlook-intel`).then((r) => r.data),
};

export const dealCalendar = {
  // GET /api/deals/:id/calendar-event → { events: [...] } (synced + created).
  list: (dealId) =>
    api.get(`/deals/${dealId}/calendar-event`).then((r) => r.data),

  // POST /api/deals/:id/calendar-event { title, start_at, end_at, attendees?,
  //   description? } → { success, event }. Creates the event on the connected
  //   org calendar and stores it deal-linked.
  create: (dealId, event) =>
    api.post(`/deals/${dealId}/calendar-event`, event).then((r) => r.data),
};

// ============================================================================
// PLATFORM INTEGRATIONS API
// ============================================================================
//
// Super-admin REST surface for managing platform-level OAuth credentials
// (Drive, Gmail, Stripe, etc.) without a redeploy. Documented in
// PLATFORM_INTEGRATIONS_SPEC.md §HTTP API. Phase 1 ships the Drive
// integration; the same shape is reused for future providers.
//
// Every response shape: { integration, configured, has_secret, config,
// updated_at, updated_by_user_id }. The decrypted secret is NEVER returned
// — only `has_secret: true|false` indicates whether one is stored.
//
// Error contract:
//   400 — server-side validation rejected the payload; surface the error
//         message inline next to the offending field.
//   403 — caller is not a super-admin.
//   404 — only from get() when no row exists for that integration yet
//         (treated as "Empty" state by the UI, not as a hard error).
//   503 — DRIVE_TOKEN_ENCRYPTION_KEY master key is missing on the backend;
//         the operator needs to set the env var before secrets can be
//         encrypted/decrypted at all. UI surfaces a guidance hint.

export const platformIntegrations = {
  // GET /api/admin/platform-integrations
  // Returns { integrations: [{ integration, configured, has_secret, config,
  //   updated_at, updated_by_user_id }, ...] }.
  list: () => api.get('/admin/platform-integrations').then((r) => r.data),

  // GET /api/admin/platform-integrations/:integration
  // 404 when no row exists yet; the caller is responsible for treating that
  // as the "Empty" render state rather than a hard error.
  get: (integration) =>
    api.get(`/admin/platform-integrations/${integration}`).then((r) => r.data),

  // PUT /api/admin/platform-integrations/:integration
  // Body: { config: {...}, secret?: string | null }
  //   - `secret` present (non-empty string): re-encrypts and stores it.
  //   - `secret` omitted or null: leaves the existing encrypted secret in
  //     place. (Use clear() to wipe everything.)
  // Returns the same shape as get().
  set: (integration, { config, secret } = {}) => {
    const body = { config: config || {} };
    if (secret != null && secret !== '') body.secret = secret;
    return api
      .put(`/admin/platform-integrations/${integration}`, body)
      .then((r) => r.data);
  },

  // DELETE /api/admin/platform-integrations/:integration
  // Deletes the row entirely — both config + secret. Use for "Clear all".
  clear: (integration) =>
    api.delete(`/admin/platform-integrations/${integration}`).then((r) => r.data),
};

// ============================================================================
// BRING-YOUR-OWN ANTHROPIC KEY (migration 153)
// ============================================================================
//
// One key per org, owner/admin managed, encrypted at rest. The backend never
// echoes the key back — only its last 4 characters. While a key is stored,
// every AI call goes out under it and is metered with billing_mode='byo_key'
// (charged $0 by us; Anthropic bills the org directly).

export const orgAiKey = {
  // GET /api/org/ai-key → { configured, provider, last4, last_validated_at,
  //   last_error, updated_at, billing_mode: 'byo_key'|'platform', can_manage }
  get: () => api.get('/org/ai-key').then((r) => r.data),

  // PUT /api/org/ai-key { key } — validates format, probes Anthropic once,
  // stores. 400 INVALID_KEY_FORMAT · 422 KEY_REJECTED · 403 ADMIN_REQUIRED.
  set: (key) => api.put('/org/ai-key', { key }).then((r) => r.data),

  // DELETE /api/org/ai-key — back to pay-as-you-go on the platform key.
  clear: () => api.delete('/org/ai-key').then((r) => r.data),
};

// ============================================================================
// ADMIN API
// ============================================================================
//
// Super-admin-only operations called from /admin/* pages. All require the
// caller's admin_role === 'super_admin'; non-super-admins get a 403 from the
// backend (the frontend page also gates).

export const admin = {
  // POST /api/admin/provision-org
  // Wraps backend/services/orgProvisioner.js. Pass `dryRun: true` to model
  // the change without writing — the response shape is identical, with the
  // exact `summary` the real run would produce. The form at
  // /admin/provision-org runs dry-run first, then enables a confirm button.
  //
  // Returns { ok, action: 'rename'|'create', orgId, userEmail, summary }.
  // Throws the axios error on 4xx/5xx; the page surfaces err.response.data.
  provisionOrg: (payload) =>
    api.post('/admin/provision-org', payload).then((r) => r.data),
};

// ============================================================================
// CUSTOMER SUCCESS API (CS-1 / CS-2 / CS-3)
// ============================================================================
//
// All routes are gated behind the `customer_success_enabled` feature flag on
// the backend (default off). A 403 from any of these means the flag is off for
// the current org — the UI hides the Accounts / Renewals surfaces via the
// `showAccountManagement` profile flag rather than relying on the error.

export const accounts = {
  // GET /api/accounts → { accounts: [{ id, name, lifecycle_stage, health_band,
  //   health_score, last_touch, days_since_last_touch, gone_quiet,
  //   next_renewal_date, days_to_next_renewal, ... }], summary: { total,
  //   gone_quiet: {d30,d60,d90}, renewing_soon: {d30,d60,d90} } }. The Accounts
  //   home rollup — one org-scoped, N+1-free query per account.
  list: () => api.get('/accounts').then((r) => r.data),

  // GET /api/accounts/:companyId/360 → { header: { company, last_touch,
  //   open_task_count, open_issue_count, open_deal_count }, timeline: [...] }.
  // Each timeline entry: { type, id, timestamp, title, detail, meta }.
  get360: (companyId) => api.get(`/accounts/${companyId}/360`).then((r) => r.data),

  // PATCH /api/companies/:id/lifecycle-stage { lifecycle_stage } → updated
  //   company row. Moves an account along its relationship lifecycle. Powers the
  //   inline stage editor on the Accounts home. Allowlist-validated server-side.
  setLifecycleStage: (companyId, lifecycle_stage) =>
    api.patch(`/companies/${companyId}/lifecycle-stage`, { lifecycle_stage }).then((r) => r.data),
};

// Customer Portal (migration 141) — ADMIN token management, gated by the
// portal_enabled module flag (default OFF). A 403 with code FEATURE_DISABLED
// means the module is off for this org — callers should hide the surface.
// The PUBLIC portal page (/portal/:token) does NOT use these; it calls the
// unauthenticated /api/public/portal/:token/* endpoints directly.
export const portal = {
  // GET /api/portal/tokens?company_id= → [{ id, company_id, token, label,
  //   is_active, expires_at, last_accessed_at, company_name, ... }]
  listTokens: (companyId) =>
    api.get(`/portal/tokens${companyId ? `?company_id=${companyId}` : ''}`).then((r) => r.data),
  // POST /api/portal/tokens { company_id, label?, contact_id?, expires_at? }
  mintToken: (payload) => api.post('/portal/tokens', payload).then((r) => r.data),
  // POST /api/portal/tokens/:id/revoke — soft revoke (link goes dark, row kept)
  revokeToken: (id) => api.post(`/portal/tokens/${id}/revoke`).then((r) => r.data),
  // DELETE /api/portal/tokens/:id — hard delete
  deleteToken: (id) => api.delete(`/portal/tokens/${id}`).then((r) => r.data),
  // Portal message thread (migration 150) — member-level (NOT admin-gated):
  // any org member can read and reply to a customer's portal thread.
  // GET /api/portal/messages?company_id= → [{ id, author_type, author_user_id,
  //   author_name, body, created_at }] oldest-first
  listMessages: (companyId) =>
    api.get(`/portal/messages?company_id=${companyId}`).then((r) => r.data),
  // POST /api/portal/messages { company_id, body } → the inserted row
  sendMessage: (companyId, body) =>
    api.post('/portal/messages', { company_id: Number(companyId), body }).then((r) => r.data),
};

// Support cases (CS-5, migration 134) — customer-facing service tickets. Same
// customer_success_enabled gate as accounts. Status: open|pending|resolved|
// closed; priority: low|normal|high|urgent (both allowlisted server-side;
// resolved_at is stamped/cleared by the backend on status transitions).
export const cases = {
  // GET /api/cases?status=&company_id=&priority= → [{ id, subject, status,
  //   priority, sla_due_at, resolved_at, company_id, company_name, ... }]
  //   sorted open-first, most severe first, tightest SLA first.
  list: (params = {}) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v != null)
    ).toString();
    return api.get(`/cases${q ? `?${q}` : ''}`).then((r) => r.data);
  },
  get: (id) => api.get(`/cases/${id}`).then((r) => r.data),
  create: (payload) => api.post('/cases', payload).then((r) => r.data),
  update: (id, payload) => api.put(`/cases/${id}`, payload).then((r) => r.data),
  remove: (id) => api.delete(`/cases/${id}`).then((r) => r.data),
};

// Account lifecycle stages (migration 122) — the relationship lifecycle, kept in
// sync with backend schemas/companies.LIFECYCLE_STAGES. Distinct from deal stage.
export const LIFECYCLE_STAGES = ['prospect', 'onboarding', 'active', 'at_risk', 'renewed', 'churned'];

// Relationship Pulse — lightweight NPS/CSAT per account (migration 124). Same
// customer_success_enabled gate as accounts/retention. Scores are stored 0–10
// (CSAT 1–5 normalized server-side); band is green/amber/red.
export const pulse = {
  // POST /api/pulse { company_id, score, kind?, contact_id?, comment? } →
  //   inserted row + { band, band_label }.
  record: (payload) => api.post('/pulse', payload).then((r) => r.data),

  // GET /api/pulse?company_id= → { pulses: [{ score, kind, comment, band, created_at, ... }] }.
  history: (companyId) => api.get('/pulse', { params: { company_id: companyId } }).then((r) => r.data),

  // GET /api/pulse/summary → { total_accounts, promoters, passives, detractors,
  //   nps (null when no pulses), latest_at }. Latest pulse per company.
  summary: () => api.get('/pulse/summary').then((r) => r.data),
};

// Success Playbooks (migration 123) — templated task checklists fired when an
// account enters a lifecycle stage. Gated by customer_success_enabled; writes
// are org-owner/admin only (403 otherwise).
export const playbooks = {
  // GET /api/playbooks → { playbooks: [{ id, name, trigger_stage, is_active,
  //   step_count, run_count, ... }], stages: [...] }
  list: () => api.get('/playbooks').then((r) => r.data),
  // GET /api/playbooks/:id → playbook row + steps: [{ id, title, description,
  //   offset_days, sort_order }]
  get: (id) => api.get(`/playbooks/${id}`).then((r) => r.data),
  // POST /api/playbooks { name, trigger_stage, is_active?, steps?: [...] }
  create: (payload) => api.post('/playbooks', payload).then((r) => r.data),
  // PUT /api/playbooks/:id { name?, trigger_stage?, is_active? }
  update: (id, payload) => api.put(`/playbooks/${id}`, payload).then((r) => r.data),
  remove: (id) => api.delete(`/playbooks/${id}`).then((r) => r.data),
  addStep: (id, payload) => api.post(`/playbooks/${id}/steps`, payload).then((r) => r.data),
  updateStep: (id, stepId, payload) => api.put(`/playbooks/${id}/steps/${stepId}`, payload).then((r) => r.data),
  removeStep: (id, stepId) => api.delete(`/playbooks/${id}/steps/${stepId}`).then((r) => r.data),
};

// Win-back board (migration 127) — churned-account re-engagement. Same
// customer_success_enabled gate as accounts/retention.
export const winback = {
  // GET /api/winback → { companies: [{ id, name, industry, churned_reason,
  //   churned_at, days_since_churn, ... }] } — churned accounts, newest first.
  list: () => api.get('/winback').then((r) => r.data),

  // GET /api/winback/summary → { summary: { churned_total, churned_90d } }.
  summary: () => api.get('/winback/summary').then((r) => r.data),

  // POST /api/winback/:companyId/reengage { moveToStage? } → { message, task,
  //   company }. Creates the "Win-back outreach" task; moveToStage is
  //   allowlisted server-side to prospect|onboarding (default: stay churned).
  //   Org owner/admin only.
  reengage: (companyId, opts = {}) =>
    api.post(`/winback/${companyId}/reengage`, opts).then((r) => r.data),
};

export const serviceContracts = {
  // GET /api/service-contracts/renewals → { stages, total_count,
  //   total_annual_value, forecast_90d: { stages, total_count,
  //   total_annual_value } }. `stages` is keyed by renewal_stage
  //   (upcoming/at_risk/renewed/churned) → { count, annual_value }.
  renewals: () => api.get('/service-contracts/renewals').then((r) => r.data),

  // GET /api/service-contracts?... → contract rows (joined customer_name,
  //   deal_title, days_to_end). Used to populate the renewal board columns.
  list: (params = {}) =>
    api.get('/service-contracts', { params }).then((r) => r.data),
};

export const segments = {
  // GET /api/segments/schema → { entity_types, fields: { company: [{field,
  //   ops}], contact: [...] }, bulk_actions, cadence_overdue_days,
  //   max_member_limit }. The criteria allowlist — the builder UI renders from
  //   this so it can't drift from the backend compiler.
  schema: () => api.get('/segments/schema').then((r) => r.data),

  // POST /api/segments/preview { entity_type, criteria } → { count, sample }.
  //   Live member-count preview for UNSAVED criteria. Non-allowlisted
  //   field/op → 400 with the allowlist message.
  preview: (entity_type, criteria) =>
    api.post('/segments/preview', { entity_type, criteria }).then((r) => r.data),

  list: () => api.get('/segments').then((r) => r.data),
  get: (id) => api.get(`/segments/${id}`).then((r) => r.data),
  create: (payload) => api.post('/segments', payload).then((r) => r.data),
  update: (id, payload) => api.put(`/segments/${id}`, payload).then((r) => r.data),
  remove: (id) => api.delete(`/segments/${id}`).then((r) => r.data),

  // GET /api/segments/:id/members → { total, members, entity_type }. Paginated
  //   and server-capped.
  members: (id, params = {}) =>
    api.get(`/segments/${id}/members`, { params }).then((r) => r.data),

  // POST /api/segments/:id/bulk { action, params } → { action, affected }.
  //   Allowlisted verbs only (set_lifecycle_stage / assign_owner /
  //   create_task); org owner/admin only. ALWAYS confirm-first in the UI —
  //   membership is re-evaluated at write time.
  bulk: (id, action, params = {}) =>
    api.post(`/segments/${id}/bulk`, { action, params }).then((r) => r.data),
};

export { api };
export default api;
