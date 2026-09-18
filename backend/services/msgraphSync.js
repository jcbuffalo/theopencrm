// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Outlook / Microsoft 365 — org-wide sync orchestrators (mail + calendar).
//
// Two entry points worth calling from routes/workers:
//
//   syncMailOrg({ orgId })     — pull recent inbound messages, match each to a
//     deal by a participant email, upsert matches into outlook_messages.
//   syncCalendarOrg({ orgId }) — pull recently-changed events, match each to a
//     deal by an attendee/organizer email, upsert matches into
//     outlook_calendar_events.
//
// Both MIRROR services/calendarSync.syncOrg / gmailSync.syncOrg:
//   • GRACEFUL: never throw for "Microsoft isn't set up" — return
//     { configured:false } when the OAuth client is unset and
//     { connected:false } when the org has no active connection.
//   • IDEMPOTENT: upserts keyed on (org_id, msgraph_message_id) /
//     (org_id, msgraph_event_id); re-discovering a row touches it in place.
//   • DEAL-LINKED ONLY: unmatched messages/events are skipped entirely so
//     the timeline stays signal, not the user's whole mailbox/calendar.
//   • CURSORED: the connection carries last_mail_sync_at /
//     last_calendar_sync_at (migration 140). Each run fetches items newer
//     than the cursor (minus a 60s overlap) then advances it. First-ever
//     run uses a lookback window.
//
// The email→deal index is REUSED VERBATIM from gmailSync (deal's primary
// contact, POC email, any contact at the deal's company) — the association
// logic is identical whether the inbound signal arrives via Google or
// Microsoft.

const pool   = require('../db');
const logger = require('./logger');
const msgraphClient   = require('./msgraphClient');
const msgraphMail     = require('./msgraphMail');
const msgraphCalendar = require('./msgraphCalendar');
const { extractEmailAddr, buildEmailIndex, loadDealEmailIndex, matchThreadToDeal } = require('./gmailSync');

const DEFAULT_LOOKBACK_DAYS = 30;   // first-ever sync window when no cursor yet
const DEFAULT_MAX_MESSAGES  = 50;
const DEFAULT_MAX_EVENTS    = 100;

/**
 * Translate a cursor timestamp into the `since` bound for a Graph $filter.
 * 60s overlap avoids missing an item that landed mid-run. Pure — exported
 * for tests.
 */
function buildSince(lastSyncAt, lookbackDays = DEFAULT_LOOKBACK_DAYS) {
  let ms;
  if (lastSyncAt) {
    ms = new Date(lastSyncAt).getTime() - 60_000;
  } else {
    ms = Date.now() - lookbackDays * 86400 * 1000;
  }
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  return new Date(ms).toISOString();
}

/**
 * Collect the participant email addresses on a Graph calendar event —
 * attendees + organizer. Lowercased + de-duped. Pure — exported for tests.
 */
function eventParticipants(ev) {
  const out = new Set();
  const push = (raw) => {
    const email = extractEmailAddr(raw);
    if (email) out.add(email);
  };
  for (const a of (ev?.attendees || [])) push(a?.emailAddress?.address);
  push(ev?.organizer?.emailAddress?.address);
  return Array.from(out);
}

/**
 * Normalize a raw Graph event resource into the outlook_calendar_events row
 * shape. Pure — exported for tests.
 */
function normalizeMsEvent(ev) {
  const meetingLink = ev?.onlineMeeting?.joinUrl || ev?.onlineMeetingUrl || null;
  return {
    msgraph_event_id: ev?.id || null,
    title:            ev?.subject || null,
    description:      ev?.bodyPreview || null,
    start_at:         ev?.start?.dateTime ? `${ev.start.dateTime}Z`.replace(/Z+$/, 'Z') : null,
    end_at:           ev?.end?.dateTime ? `${ev.end.dateTime}Z`.replace(/Z+$/, 'Z') : null,
    attendees:        eventParticipants(ev),
    meeting_link:     meetingLink,
    web_link:         ev?.webLink || null,
    organizer_email:  extractEmailAddr(ev?.organizer?.emailAddress?.address) || null,
    status:           ev?.isCancelled ? 'cancelled' : 'confirmed',
  };
}

/**
 * Upsert one outlook_messages row keyed on (org_id, msgraph_message_id).
 * Preserves an existing deal_id (never nulled on re-sync). Returns the row
 * id. Exported for tests.
 */
async function upsertMessage({ orgId, dealId, message }) {
  const r = await pool.query(
    `INSERT INTO outlook_messages
       (org_id, deal_id, msgraph_message_id, conversation_id, subject,
        body_preview, from_addr, to_addrs, received_at, web_link,
        created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
     ON CONFLICT (org_id, msgraph_message_id) DO UPDATE
       SET deal_id      = COALESCE(outlook_messages.deal_id, EXCLUDED.deal_id),
           subject      = EXCLUDED.subject,
           body_preview = EXCLUDED.body_preview,
           from_addr    = EXCLUDED.from_addr,
           to_addrs     = EXCLUDED.to_addrs,
           received_at  = EXCLUDED.received_at,
           web_link     = EXCLUDED.web_link,
           updated_at   = NOW()
     RETURNING id`,
    [
      orgId,
      dealId || null,
      message.msgraph_message_id,
      message.conversation_id,
      message.subject ? String(message.subject).slice(0, 1000) : null,
      message.body_preview,
      message.from_addr,
      message.to_addrs || [],
      message.received_at,
      message.web_link,
    ]
  );
  return r.rows[0].id;
}

/**
 * Upsert one outlook_calendar_events row keyed on (org_id, msgraph_event_id).
 * Preserves an existing source + deal_id, mirroring calendarSync.upsertEvent.
 * Returns the row id. Exported for tests.
 */
async function upsertEvent({ orgId, dealId, event, source = 'synced', createdBy = null }) {
  const r = await pool.query(
    `INSERT INTO outlook_calendar_events
       (org_id, deal_id, msgraph_event_id, title, description,
        start_at, end_at, attendees, meeting_link, web_link, organizer_email,
        status, source, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())
     ON CONFLICT (org_id, msgraph_event_id) DO UPDATE
       SET deal_id         = COALESCE(outlook_calendar_events.deal_id, EXCLUDED.deal_id),
           title           = EXCLUDED.title,
           description     = EXCLUDED.description,
           start_at        = EXCLUDED.start_at,
           end_at          = EXCLUDED.end_at,
           attendees       = EXCLUDED.attendees,
           meeting_link    = EXCLUDED.meeting_link,
           web_link        = EXCLUDED.web_link,
           organizer_email = EXCLUDED.organizer_email,
           status          = EXCLUDED.status,
           updated_at      = NOW()
     RETURNING id`,
    [
      orgId,
      dealId || null,
      event.msgraph_event_id,
      event.title,
      event.description,
      event.start_at,
      event.end_at,
      event.attendees || [],
      event.meeting_link,
      event.web_link,
      event.organizer_email,
      event.status,
      source,
      createdBy,
    ]
  );
  return r.rows[0].id;
}

/**
 * Shared graceful-degradation preamble: resolve configured/connected state.
 * Returns { soft } when the caller should bail with a soft result, else
 * { conn } with the active connection row.
 */
async function resolveConnection(orgId) {
  if (!(await msgraphClient.isConfigured())) {
    return { soft: { configured: false, connected: false, reason: 'msgraph_not_configured' } };
  }
  try {
    return { conn: await msgraphClient.loadConnection(orgId) };
  } catch (err) {
    if (err.code === 'MSGRAPH_NOT_CONNECTED' || err.code === 'MSGRAPH_CONNECTION_INACTIVE') {
      return { soft: { configured: true, connected: false, reason: err.code } };
    }
    throw err;
  }
}

/**
 * Run an org-wide inbound-mail sync: pull recent messages, match each to a
 * deal by a participant email, upsert the matches.
 */
async function syncMailOrg({ orgId, lookbackDays, maxMessages } = {}) {
  if (!orgId) throw new Error('syncMailOrg requires { orgId }');

  const pre = await resolveConnection(orgId);
  if (pre.soft) return pre.soft;
  const conn = pre.conn;

  await pool.query(
    `UPDATE org_msgraph_connections
        SET mail_sync_status = 'in_progress',
            mail_sync_error  = NULL,
            updated_at       = NOW()
      WHERE org_id = $1`,
    [orgId]
  );

  try {
    const emailIndex = buildEmailIndex(await loadDealEmailIndex(orgId));

    let messagesScanned = 0;
    let messagesMatched = 0;
    const messages = [];

    // No deals carry an email → nothing could match. Skip the Graph fetch
    // entirely (saves quota) but still advance the cursor below.
    if (emailIndex.size > 0) {
      const cap = Number(maxMessages) > 0 ? Number(maxMessages) : DEFAULT_MAX_MESSAGES;
      const since = buildSince(conn.last_mail_sync_at, lookbackDays);
      const stubs = await msgraphMail.listMessages(orgId, { since, maxResults: cap });
      messagesScanned = stubs.length;

      for (const stub of stubs) {
        const dealId = matchThreadToDeal(stub.participants, emailIndex);
        if (!dealId) continue; // only persist deal-linked mail
        messagesMatched++;
        try {
          const rowId = await upsertMessage({ orgId, dealId, message: stub });
          messages.push({ deal_id: dealId, outlook_message_id: rowId, msgraph_message_id: stub.msgraph_message_id });
        } catch (err) {
          logger.warn('msgraph_mail_sync_message_failed', {
            orgId, msgraph_message_id: stub.msgraph_message_id, error: err.message,
          });
        }
      }
    }

    // Advance the cursor to NOW() and stamp bookkeeping.
    await pool.query(
      `UPDATE org_msgraph_connections
          SET last_mail_sync_at      = NOW(),
              mail_sync_status       = 'ok',
              mail_sync_error        = NULL,
              last_mail_synced_count = $2,
              updated_at             = NOW()
        WHERE org_id = $1`,
      [orgId, messagesMatched]
    );

    logger.info('msgraph_mail_sync_org_complete', { orgId, messagesScanned, messagesMatched });
    return {
      configured: true,
      connected: true,
      messages_scanned: messagesScanned,
      messages_matched: messagesMatched,
      messages,
    };
  } catch (err) {
    await pool.query(
      `UPDATE org_msgraph_connections
          SET mail_sync_status = 'failed',
              mail_sync_error  = $2,
              updated_at       = NOW()
        WHERE org_id = $1`,
      [orgId, err.message || 'sync_failed']
    ).catch(() => {});
    throw err;
  }
}

/**
 * Run an org-wide calendar sync: pull recently-changed events, match each to
 * a deal by a participant email, upsert the matches.
 */
async function syncCalendarOrg({ orgId, lookbackDays, maxEvents } = {}) {
  if (!orgId) throw new Error('syncCalendarOrg requires { orgId }');

  const pre = await resolveConnection(orgId);
  if (pre.soft) return pre.soft;
  const conn = pre.conn;

  await pool.query(
    `UPDATE org_msgraph_connections
        SET calendar_sync_status = 'in_progress',
            calendar_sync_error  = NULL,
            updated_at           = NOW()
      WHERE org_id = $1`,
    [orgId]
  );

  try {
    const emailIndex = buildEmailIndex(await loadDealEmailIndex(orgId));

    let eventsScanned = 0;
    let eventsMatched = 0;
    const events = [];

    if (emailIndex.size > 0) {
      const cap = Number(maxEvents) > 0 ? Number(maxEvents) : DEFAULT_MAX_EVENTS;
      const updatedMin = buildSince(conn.last_calendar_sync_at, lookbackDays);
      const raw = await msgraphCalendar.listEvents(orgId, { updatedMin, maxResults: cap });
      eventsScanned = raw.length;

      for (const ev of raw) {
        const norm = normalizeMsEvent(ev);
        if (!norm.msgraph_event_id) continue;
        const dealId = matchThreadToDeal(norm.attendees, emailIndex);
        if (!dealId) continue; // only persist deal-linked events
        eventsMatched++;
        try {
          const rowId = await upsertEvent({ orgId, dealId, event: norm, source: 'synced' });
          events.push({ deal_id: dealId, outlook_event_id: rowId, msgraph_event_id: norm.msgraph_event_id });
        } catch (err) {
          logger.warn('msgraph_calendar_sync_event_failed', {
            orgId, msgraph_event_id: norm.msgraph_event_id, error: err.message,
          });
        }
      }
    }

    await pool.query(
      `UPDATE org_msgraph_connections
          SET last_calendar_sync_at      = NOW(),
              calendar_sync_status       = 'ok',
              calendar_sync_error        = NULL,
              last_calendar_synced_count = $2,
              updated_at                 = NOW()
        WHERE org_id = $1`,
      [orgId, eventsMatched]
    );

    logger.info('msgraph_calendar_sync_org_complete', { orgId, eventsScanned, eventsMatched });
    return {
      configured: true,
      connected: true,
      events_scanned: eventsScanned,
      events_matched: eventsMatched,
      events,
    };
  } catch (err) {
    await pool.query(
      `UPDATE org_msgraph_connections
          SET calendar_sync_status = 'failed',
              calendar_sync_error  = $2,
              updated_at           = NOW()
        WHERE org_id = $1`,
      [orgId, err.message || 'sync_failed']
    ).catch(() => {});
    throw err;
  }
}

module.exports = {
  syncMailOrg,
  syncCalendarOrg,
  upsertMessage,
  upsertEvent,
  // Exposed for tests:
  buildSince,
  eventParticipants,
  normalizeMsEvent,
};
