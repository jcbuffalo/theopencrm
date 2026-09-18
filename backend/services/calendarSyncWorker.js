// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Calendar sync — background worker.
//
// Periodically pulls recent/updated Google Calendar events for every org that
// (a) has an active Calendar connection and (b) has the calendar_enabled
// feature on, matches each event to a deal by an attendee email, and upserts
// the matched events onto the deal/account timeline (services/calendarSync
// .syncOrg).
//
// Modelled on services/gmailInboundSyncWorker.js — module-level timer + tick() +
// startScheduler()/stopScheduler(). Same env gate as the other workers
// (AUTOMATION_ENABLED / production boot in index.js).
//
// SELF-THROTTLE: the connection carries last_sync_at (migration 115). Each tick
// only processes orgs whose last sync is older than MIN_INTERVAL so a short tick
// interval doesn't hammer the Calendar API — syncOrg's own updatedMin cursor
// then bounds the per-run fetch to events changed since that mark.
//
// GRACEFUL: syncOrg never throws for "not configured / not connected"; it
// returns a soft result we simply skip. A genuine per-org error (token revoked,
// network) is caught, logged, and does not abort the whole tick.

const pool   = require('../db');
const logger = require('./logger');
const featureFlags = require('./featureFlags');
const calendarSync = require('./calendarSync');

const DEFAULT_INTERVAL_MIN     = 30;  // how often the tick fires
const DEFAULT_MIN_INTERVAL_MIN = 15;  // don't re-sync an org more often than this

let timer = null;

// Orgs with an active Calendar connection that are due for a sync (never synced,
// or last synced longer ago than minIntervalMinutes). Feature-gating is checked
// per-org in the tick so a flag flip takes effect without a restart.
async function dueOrgIds(minIntervalMinutes) {
  const r = await pool.query(
    `SELECT org_id
       FROM org_calendar_connections
      WHERE status = 'active'
        AND (last_sync_at IS NULL
             OR last_sync_at < NOW() - ($1 || ' minutes')::interval)`,
    [String(minIntervalMinutes)]
  );
  return r.rows.map((row) => row.org_id);
}

async function tick({ minIntervalMinutes = DEFAULT_MIN_INTERVAL_MIN } = {}) {
  try {
    const orgIds = await dueOrgIds(minIntervalMinutes);
    if (orgIds.length === 0) {
      logger.info?.('calendar_sync_worker_tick_idle');
      return { orgs: 0, eventsMatched: 0 };
    }

    let orgsProcessed = 0;
    let eventsMatched = 0;

    for (const orgId of orgIds) {
      try {
        const on = await featureFlags.hasFeature(orgId, 'calendar_enabled');
        if (!on) continue;

        const result = await calendarSync.syncOrg({ orgId });
        if (!result || result.connected === false || result.configured === false) continue;

        eventsMatched += result.events_matched || 0;
        orgsProcessed++;
      } catch (err) {
        logger.warn?.('calendar_sync_worker_one_org_failed', { orgId, error: err && err.message });
      }
    }

    logger.info?.('calendar_sync_worker_tick_end', { orgsProcessed, eventsMatched });
    return { orgs: orgsProcessed, eventsMatched };
  } catch (err) {
    logger.warn?.('calendar_sync_worker_tick_error', { error: err && err.message });
    return { orgs: 0, eventsMatched: 0, error: err && err.message };
  }
}

function startScheduler({ intervalMinutes = DEFAULT_INTERVAL_MIN, minIntervalMinutes = DEFAULT_MIN_INTERVAL_MIN } = {}) {
  if (timer) return;
  const ms = Math.max(5, intervalMinutes) * 60 * 1000;
  // Run once shortly after startup (5s delay so migrations + the rest of boot
  // finish first), then on interval.
  setTimeout(() => { tick({ minIntervalMinutes }).catch(() => {}); }, 5000);
  timer = setInterval(() => {
    tick({ minIntervalMinutes }).catch(() => {});
  }, ms);
  logger.info?.('calendar_sync_worker_started', { intervalMinutes, minIntervalMinutes });
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  tick,
  startScheduler,
  stopScheduler,
  dueOrgIds,
};
