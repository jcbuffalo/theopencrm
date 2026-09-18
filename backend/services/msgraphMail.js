// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Outlook / Microsoft 365 mail — thin Graph API client used by msgraphSync
// and routes. Mirrors services/gmail.js shapes so downstream code is
// symmetric with the Gmail family; the connection/token core is shared with
// msgraphCalendar via services/msgraphClient.js (one consent powers both).
//
// Exposes:
//   isConfigured()                        → async (delegates to the shared core)
//   loadConnection(orgId)                 → the active connection row
//   listMessages(orgId, { since, maxResults }) → normalized message stubs,
//       newest first — the shape msgraphSync matches to deals:
//       { msgraph_message_id, conversation_id, subject, body_preview,
//         from_addr, to_addrs[], participants[], received_at, web_link }
//   fetchMessage(orgId, messageId)        → raw Graph message resource
//
// SELECT DISCIPLINE: listMessages requests only the fields it needs via
// $select — never the full body — so a routine sync run doesn't pull mail
// content that will just be discarded. bodyPreview (Graph's ~255-char
// snippet) is the Outlook analogue of Gmail's thread snippet.
//
// NO PII IN LOGS — see msgraphClient.js header.

const msgraphClient = require('./msgraphClient');

const DEFAULT_MAX_RESULTS = 50;

const LIST_SELECT = [
  'id',
  'conversationId',
  'subject',
  'bodyPreview',
  'from',
  'toRecipients',
  'ccRecipients',
  'receivedDateTime',
  'webLink',
].join(',');

async function isConfigured() {
  return msgraphClient.isConfigured();
}

/**
 * Extract the bare address from a Graph recipient object
 * ({ emailAddress: { name, address } }). Pure — exported for tests.
 */
function recipientAddr(recipient) {
  const addr = recipient?.emailAddress?.address;
  return addr ? String(addr).trim().toLowerCase() : null;
}

/**
 * Normalize a raw Graph message resource into the stub shape msgraphSync
 * consumes. Pure — exported for tests.
 */
function normalizeMessage(m) {
  const from = recipientAddr(m?.from);
  const tos = (m?.toRecipients || []).map(recipientAddr).filter(Boolean);
  const ccs = (m?.ccRecipients || []).map(recipientAddr).filter(Boolean);
  const participants = Array.from(new Set([from, ...tos, ...ccs].filter(Boolean)));
  return {
    msgraph_message_id: m?.id || null,
    conversation_id:    m?.conversationId || null,
    subject:            m?.subject || null,
    body_preview:       m?.bodyPreview || null,
    from_addr:          from,
    to_addrs:           [...tos, ...ccs],
    participants,
    received_at:        m?.receivedDateTime || null,
    web_link:           m?.webLink || null,
  };
}

/**
 * List recent messages in the connected mailbox, newest first, optionally
 * bounded to messages received since a cursor timestamp. Returns normalized
 * stubs (see normalizeMessage).
 */
async function listMessages(orgId, { since, maxResults = DEFAULT_MAX_RESULTS } = {}) {
  const cap = Math.max(1, Math.min(100, Number(maxResults) || DEFAULT_MAX_RESULTS));
  const query = {
    $select:  LIST_SELECT,
    $orderby: 'receivedDateTime desc',
    $top:     String(cap),
  };
  if (since) {
    query.$filter = `receivedDateTime ge ${new Date(since).toISOString()}`;
  }
  const json = await msgraphClient.apiFetch(orgId, '/me/messages', { query });
  return (json.value || []).map(normalizeMessage).filter((m) => m.msgraph_message_id);
}

/**
 * Fetch a single message with its full payload (body included). Returns the
 * raw Graph message resource — the future extraction/summarization pass
 * (mirror of gmailExtract/gmailSummary) is the intended consumer.
 */
async function fetchMessage(orgId, messageId) {
  if (!messageId) throw new Error('fetchMessage: messageId is required');
  return msgraphClient.apiFetch(orgId, `/me/messages/${encodeURIComponent(messageId)}`);
}

module.exports = {
  isConfigured,
  loadConnection: msgraphClient.loadConnection,
  listMessages,
  fetchMessage,
  // Exposed for tests:
  recipientAddr,
  normalizeMessage,
};
