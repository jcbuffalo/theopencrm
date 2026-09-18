// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Outlook / Microsoft 365 calendar — thin Graph API client used by
// msgraphSync and routes. Mirrors services/calendar.js shapes so downstream
// code is symmetric with the Google Calendar family; the connection/token
// core is shared with msgraphMail via services/msgraphClient.js (one
// consent powers both).
//
// Exposes:
//   isConfigured()                              → async (shared core)
//   loadConnection(orgId)                       → the active connection row
//   listEvents(orgId, { updatedMin, maxResults }) → raw Graph event resources
//       changed since the cursor (msgraphSync normalizes them)
//   insertEvent(orgId, event)                   → create an event on the
//       user's default calendar; `event` uses the CRM-neutral shape below
//       and is translated to a Graph event resource here.
//
// CRM-NEUTRAL EVENT INPUT (insertEvent):
//   { title, description, start_at, end_at, attendees: [email], location }
//   — the same field names dealCalendarRoutes feeds calendar.insertEvent's
//   Google resource, so a future shared "create meeting" surface can target
//   either provider without reshaping.
//
// NO PII IN LOGS — see msgraphClient.js header.

const msgraphClient = require('./msgraphClient');

const DEFAULT_MAX_RESULTS = 100;

const LIST_SELECT = [
  'id',
  'subject',
  'bodyPreview',
  'start',
  'end',
  'attendees',
  'organizer',
  'onlineMeeting',
  'onlineMeetingUrl',
  'webLink',
  'isCancelled',
  'lastModifiedDateTime',
].join(',');

async function isConfigured() {
  return msgraphClient.isConfigured();
}

/**
 * List events on the user's default calendar changed since `updatedMin`
 * (Graph's lastModifiedDateTime) — the incremental-sync cursor, mirroring
 * Google's updatedMin. Returns the raw Graph event objects.
 */
async function listEvents(orgId, { updatedMin, maxResults = DEFAULT_MAX_RESULTS } = {}) {
  const cap = Math.max(1, Math.min(250, Number(maxResults) || DEFAULT_MAX_RESULTS));
  const query = {
    $select:  LIST_SELECT,
    $orderby: 'lastModifiedDateTime desc',
    $top:     String(cap),
  };
  if (updatedMin) {
    query.$filter = `lastModifiedDateTime ge ${new Date(updatedMin).toISOString()}`;
  }
  const json = await msgraphClient.apiFetch(orgId, '/me/events', { query });
  return json.value || [];
}

/**
 * Translate the CRM-neutral event input into a Graph event resource.
 * Pure — exported for tests.
 */
function toGraphEvent({ title, description, start_at, end_at, attendees, location } = {}) {
  const resource = {
    subject: title || '(no title)',
    body: {
      contentType: 'text',
      content: description || '',
    },
    start: {
      dateTime: new Date(start_at).toISOString(),
      timeZone: 'UTC',
    },
    end: {
      dateTime: new Date(end_at).toISOString(),
      timeZone: 'UTC',
    },
  };
  if (Array.isArray(attendees) && attendees.length > 0) {
    resource.attendees = attendees.map((email) => ({
      emailAddress: { address: String(email) },
      type: 'required',
    }));
  }
  if (location) {
    resource.location = { displayName: String(location) };
  }
  return resource;
}

/**
 * Create an event on the user's default calendar. Attendees receive invites
 * from Microsoft (Graph sends them automatically on creation when the event
 * has attendees — no sendUpdates knob like Google's). Returns the created
 * Graph event resource (includes id, webLink, onlineMeeting when present).
 */
async function insertEvent(orgId, event) {
  if (!event || !event.start_at || !event.end_at) {
    throw new Error('insertEvent: event with start_at and end_at is required');
  }
  return msgraphClient.apiFetch(orgId, '/me/events', {
    method: 'POST',
    body: toGraphEvent(event),
  });
}

module.exports = {
  isConfigured,
  loadConnection: msgraphClient.loadConnection,
  listEvents,
  insertEvent,
  // Exposed for tests:
  toGraphEvent,
};
