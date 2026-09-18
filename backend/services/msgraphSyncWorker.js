// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Outlook / Microsoft 365 sync — background worker.
//
// Periodically pulls recent Outlook mail and recently-changed Outlook
// calendar events for every org that (a) has an active Microsoft 365
// connection and (b) has the corresponding feature flag on
// (outlook_mail_enabled / outlook_calendar_enabled — checked independently,
// per surface), matches each item to a deal by participant email, and
// upserts the matches onto the deal/account timeline (services/msgraphSync).
//
// Modelled on services/calendarSyncWorker.js — module-level timer + tick() +
// startScheduler()/stopScheduler(), same env gate as the other workers
// (AUTOMATION_ENABLED / production boot in index.js) — PLUS a workerLease
// claim per interval bucket (worker_runs table, migration 098) so multiple
// Cloud Run instances don't all fan out over the same orgs each period.
// The lease is belt; the per-org cursor self-throttle is suspenders (even
// two concurrent ticks converge on idempotent upserts + a cursor advance).
//
// GRACEFUL: syncMailOrg/syncCalendarOrg never throw for "not configured /
// not connected"; they return a soft result we simply skip. A genuine
// per-org error (token revoked, network) is caught, logged, and does not
// abort the whole tick.

const pool   = require('../db');
const logger = require('./logger');
const featureFlags = require('./featureFlags');
const workerLease = require('./workerLease');
const msgraphSync = require('./msgraphSync');

const WORKER_NAME = 'msgraph_sync';
const DEFAULT_INTERVAL_MIN     = 30;  // how often the tick fires
const DEFAULT_MIN_INTERVAL_MIN = 15;  // don't re-sync an org more often than this

let timer = null;

/**
 * Period key = UTC timestamp truncated to the interval bucket (same shape
 * sequenceWorker uses). One lease per bucket across all instances.
 */
function periodKey(now = new Date(), intervalMinutes = DEFAULT_INTERVAL_MIN) {
  const bucketMin = Math.floor(now.getUTCMinutes() / intervalMinutes) * intervalMinutes;
  return `${now.toISOString().slice(0, 13)}:${String(bucketMin).padStart(2, '0')}`;
}

// Orgs with an active Microsoft connection that are due for a sync on EITHER
// surface (never synced, or last synced longer ago than minIntervalMinutes).
// Feature-gating is checked per-org per-surface in the tick so a flag flip
// takes effect without a restart.
async function dueOrgIds(minIntervalMinutes) {
  const r = await pool.query(
    `SELECT org_id
       FROM org_msgraph_connections
      WHERE status = 'active'
        AND ((last_mail_sync_at IS NULL
              OR last_mail_sync_at < NOW() - ($1 || ' minutes')::interval)
          OR (last_calendar_sync_at IS NULL
              OR last_calendar_sync_at < NOW() - ($1 || ' minutes')::interval))`,
    [String(minIntervalMinutes)]
  );
  return r.rows.map((row) => row.org_id);
}

async function tick({ minIntervalMinutes = DEFAULT_MIN_INTERVAL_MIN, intervalMinutes = DEFAULT_INTERVAL_MIN } = {}) {
  const key = periodKey(new Date(), intervalMinutes);
  try {
    const won = await workerLease.claim(WORKER_NAME, key);
    if (!won) {
      logger.info?.('msgraph_sync_worker_lease_skipped', { periodKey: key });
      return { orgs: 0, messagesMatched: 0, eventsMatched: 0, skipped: true };
    }

    const orgIds = await dueOrgIds(minIntervalMinutes);
    if (orgIds.length === 0) {
      logger.info?.('msgraph_sync_worker_tick_idle');
      return { orgs: 0, messagesMatched: 0, eventsMatched: 0 };
    }

    let orgsProcessed = 0;
    let messagesMatched = 0;
    let eventsMatched = 0;

    for (const orgId of orgIds) {
      let touched = false;
      try {
        if (await featureFlags.hasFeature(orgId, 'outlook_mail_enabled')) {
          const result = await msgraphSync.syncMailOrg({ orgId });
          if (result && result.connected !== false && result.configured !== false) {
            messagesMatched += result.messages_matched || 0;
            touched = true;
          }
        }
      } catch (err) {
        logger.warn?.('msgraph_sync_worker_mail_org_failed', { orgId, error: err && err.message });
      }
      try {
        if (await featureFlags.hasFeature(orgId, 'outlook_calendar_enabled')) {
          const result = await msgraphSync.syncCalendarOrg({ orgId });
          if (result && result.connected !== false && result.configured !== false) {
            eventsMatched += result.events_matched || 0;
            touched = true;
          }
        }
      } catch (err) {
        logger.warn?.('msgraph_sync_worker_calendar_org_failed', { orgId, error: err && err.message });
      }
      if (touched) orgsProcessed++;
    }

    logger.info?.('msgraph_sync_worker_tick_end', { orgsProcessed, messagesMatched, eventsMatched });
    return { orgs: orgsProcessed, messagesMatched, eventsMatched };
  } catch (err) {
    // Release the lease on a failed tick so a retry within the same period
    // (e.g. another instance) can pick the work back up.
    await workerLease.release(WORKER_NAME, key).catch(() => {});
    logger.warn?.('msgraph_sync_worker_tick_error', { error: err && err.message });
    return { orgs: 0, messagesMatched: 0, eventsMatched: 0, error: err && err.message };
  }
}

function startScheduler({ intervalMinutes = DEFAULT_INTERVAL_MIN, minIntervalMinutes = DEFAULT_MIN_INTERVAL_MIN } = {}) {
  if (timer) return;
  const ms = Math.max(5, intervalMinutes) * 60 * 1000;
  // Run once shortly after startup (5s delay so migrations + the rest of
  // boot finish first), then on interval.
  setTimeout(() => { tick({ minIntervalMinutes, intervalMinutes }).catch(() => {}); }, 5000);
  timer = setInterval(() => {
    tick({ minIntervalMinutes, intervalMinutes }).catch(() => {});
  }, ms);
  logger.info?.('msgraph_sync_worker_started', { intervalMinutes, minIntervalMinutes });
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  tick,
  startScheduler,
  stopScheduler,
  dueOrgIds,
  periodKey,
  WORKER_NAME,
};
