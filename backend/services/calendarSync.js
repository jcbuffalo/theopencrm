// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Google Calendar integration — org-wide event sync orchestrator.
//
// One entry point worth calling from routes/workers: `syncOrg({ orgId })`.
//
// It pulls recent/updated Calendar events for a connected org, MATCHES each to
// a deal by an attendee (or organizer) email address — reusing the exact
// email→deal indexing gmailSync uses for inbound email — and UPSERTs the match
// into calendar_events so meetings land on the deal/account timeline.
//
// GRACEFUL DEGRADATION: syncOrg never throws for "Calendar isn't set up". It
// returns { configured:false } when the OAuth client is unset and
// { connected:false } when the org has no active connection — mirroring
// services/gmailSync.syncOrg.
//
// IDEMPOTENT: re-discovering an already-synced event is a cheap UPSERT keyed on
// (org_id, google_event_id). Unmatched events (no attendee maps to a deal) are
// skipped entirely — we only persist events tied to a deal, so the timeline
// stays signal, not the user's whole calendar.
//
// CURSOR: the connection carries last_sync_at (migration 115). Each run fetches
// events with updatedMin = last_sync_at (minus a 60s overlap), then advances the
// cursor. First-ever run uses a lookback window.

const pool   = require('../db');
const logger = require('./logger');
const calendar = require('./calendar');
// Reuse gmailSync's email→deal indexing verbatim — the association logic
// (deal's primary contact, POC email, any contact at the deal's company) is
// identical whether the inbound signal is an email thread or a calendar invite.
const { extractEmailAddr, buildEmailIndex, loadDealEmailIndex } = require('./gmailSync');

const DEFAULT_LOOKBACK_DAYS = 30;   // first-ever sync window when no cursor yet
const DEFAULT_MAX_EVENTS    = 100;

/**
 * Collect the participant email addresses on a Google Calendar event —
 * attendees + organizer + creator. Lowercased + de-duped. Pure — exported for
 * tests.
 */
function eventParticipants(ev) {
  const out = new Set();
  const push = (raw) => {
    const email = extractEmailAddr(raw);
    if (email) out.add(email);
  };
  for (const a of (ev?.attendees || [])) push(a?.email);
  push(ev?.organizer?.email);
  push(ev?.creator?.email);
  return Array.from(out);
}

/**
 * Given an event's participant emails and an email→deal index, return the
 * dealId of the first participant that matches, else null. Pure — exported for
 * tests.
 */
function matchEventToDeal(participants, emailIndex) {
  for (const p of participants || []) {
    const email = extractEmailAddr(p);
    if (email && emailIndex.has(email)) return emailIndex.get(email);
  }
  return null;
}

/**
 * Normalize a raw Google Calendar event resource into the calendar_events row
 * shape. Pure — exported for tests.
 */
function normalizeEvent(ev) {
  const start = ev?.start?.dateTime || ev?.start?.date || null;
  const end   = ev?.end?.dateTime   || ev?.end?.date   || null;
  // Meeting link: prefer hangoutLink, fall back to the first video conference
  // entry point in conferenceData.
  let meetingLink = ev?.hangoutLink || null;
  if (!meetingLink && Array.isArray(ev?.conferenceData?.entryPoints)) {
    const video = ev.conferenceData.entryPoints.find((e) => e.entryPointType === 'video');
    meetingLink = video?.uri || null;
  }
  return {
    google_event_id: ev?.id || null,
    title:           ev?.summary || null,
    description:     ev?.description || null,
    start_at:        start,
    end_at:          end,
    attendees:       eventParticipants(ev),
    meeting_link:    meetingLink,
    html_link:       ev?.htmlLink || null,
    organizer_email: extractEmailAddr(ev?.organizer?.email) || null,
    status:          ev?.status || null,
  };
}

/**
 * Translate the per-connection cursor into an updatedMin timestamp. A 60s
 * overlap avoids missing an event that changed mid-run. Pure — exported for
 * tests.
 */
function buildUpdatedMin(lastSyncAt, lookbackDays = DEFAULT_LOOKBACK_DAYS) {
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
 * Upsert one calendar_events row keyed on (org_id, google_event_id). Preserves
 * an existing source (so a 'created' event isn't relabeled 'synced' when the
 * sync later re-discovers it) and an existing deal_id (never null it out on
 * re-sync). Returns the row id. Exported for tests.
 */
async function upsertEvent({ orgId, dealId, event, source = 'synced', createdBy = null }) {
  const r = await pool.query(
    `INSERT INTO calendar_events
       (org_id, deal_id, google_event_id, calendar_id, title, description,
        start_at, end_at, attendees, meeting_link, html_link, organizer_email,
        status, source, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'primary', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())
     ON CONFLICT (org_id, google_event_id) DO UPDATE
       SET deal_id         = COALESCE(calendar_events.deal_id, EXCLUDED.deal_id),
           title           = EXCLUDED.title,
           description     = EXCLUDED.description,
           start_at        = EXCLUDED.start_at,
           end_at          = EXCLUDED.end_at,
           attendees       = EXCLUDED.attendees,
           meeting_link    = EXCLUDED.meeting_link,
           html_link       = EXCLUDED.html_link,
           organizer_email = EXCLUDED.organizer_email,
           status          = EXCLUDED.status,
           updated_at      = NOW()
     RETURNING id`,
    [
      orgId,
      dealId || null,
      event.google_event_id,
      event.title,
      event.description,
      event.start_at,
      event.end_at,
      event.attendees || [],
      event.meeting_link,
      event.html_link,
      event.organizer_email,
      event.status,
      source,
      createdBy,
    ]
  );
  return r.rows[0].id;
}

/**
 * Run an org-wide calendar sync: pull recent/updated events, match each to a
 * deal by a participant email, upsert the matches.
 *
 * @param {object} opts
 * @param {number} opts.orgId          — required
 * @param {number} [opts.lookbackDays] — window for the first sync (no cursor yet)
 * @param {number} [opts.maxEvents]    — cap on events scanned per run
 * @returns {Promise<object>} summary; shape depends on configured/connected state.
 */
async function syncOrg({ orgId, lookbackDays, maxEvents } = {}) {
  if (!orgId) throw new Error('syncOrg requires { orgId }');

  // Graceful degradation: OAuth client not configured at the platform level.
  if (!(await calendar.isConfigured())) {
    return { configured: false, connected: false, reason: 'calendar_not_configured' };
  }

  // Org has no active connection → nothing to do (soft, not an error).
  let conn;
  try {
    conn = await calendar.loadConnection(orgId);
  } catch (err) {
    if (err.code === 'CALENDAR_NOT_CONNECTED' || err.code === 'CALENDAR_CONNECTION_INACTIVE') {
      return { configured: true, connected: false, reason: err.code };
    }
    throw err;
  }

  await pool.query(
    `UPDATE org_calendar_connections
        SET sync_status = 'in_progress',
            sync_error  = NULL,
            updated_at  = NOW()
      WHERE org_id = $1`,
    [orgId]
  );

  try {
    const emailIndex = buildEmailIndex(await loadDealEmailIndex(orgId));

    let eventsScanned = 0;
    let eventsMatched = 0;
    const events = [];

    // No deals carry an email → nothing could match. Skip the Calendar fetch
    // entirely (saves quota) but still advance the cursor below.
    if (emailIndex.size > 0) {
      const cap = Number(maxEvents) > 0 ? Number(maxEvents) : DEFAULT_MAX_EVENTS;
      const updatedMin = buildUpdatedMin(conn.last_sync_at, lookbackDays);
      const raw = await calendar.listEvents(orgId, { updatedMin, maxResults: cap });
      eventsScanned = raw.length;

      for (const ev of raw) {
        const norm = normalizeEvent(ev);
        if (!norm.google_event_id) continue;
        const dealId = matchEventToDeal(norm.attendees, emailIndex);
        if (!dealId) continue; // only persist deal-linked events
        eventsMatched++;
        try {
          const rowId = await upsertEvent({ orgId, dealId, event: norm, source: 'synced' });
          events.push({ deal_id: dealId, calendar_event_id: rowId, google_event_id: norm.google_event_id });
        } catch (err) {
          logger.warn('calendar_sync_event_failed', {
            orgId, google_event_id: norm.google_event_id, error: err.message,
          });
        }
      }
    }

    // Advance the cursor to NOW() and stamp bookkeeping.
    await pool.query(
      `UPDATE org_calendar_connections
          SET last_sync_at      = NOW(),
              sync_status       = 'ok',
              sync_error        = NULL,
              last_synced_count = $2,
              updated_at        = NOW()
        WHERE org_id = $1`,
      [orgId, eventsMatched]
    );

    logger.info('calendar_sync_org_complete', { orgId, eventsScanned, eventsMatched });
    return {
      configured: true,
      connected: true,
      events_scanned: eventsScanned,
      events_matched: eventsMatched,
      events,
    };
  } catch (err) {
    await pool.query(
      `UPDATE org_calendar_connections
          SET sync_status = 'failed',
              sync_error  = $2,
              updated_at  = NOW()
        WHERE org_id = $1`,
      [orgId, err.message || 'sync_failed']
    ).catch(() => {});
    throw err;
  }
}

module.exports = {
  syncOrg,
  upsertEvent,
  // Exposed for tests:
  eventParticipants,
  matchEventToDeal,
  normalizeEvent,
  buildUpdatedMin,
};
