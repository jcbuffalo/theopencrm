// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Inbound email sync — background worker.
//
// Periodically pulls recent Gmail threads for every org that (a) has an active
// Gmail connection and (b) has the gmail_intel_enabled feature on, matches each
// thread to a deal by a participant email, and syncs the matched threads'
// messages onto the deal/account timeline (services/gmailSync.syncOrg).
//
// Modelled on services/accountHealthWorker.js — module-level timer + tick() +
// startScheduler()/stopScheduler(). Same env gate as the other workers
// (AUTOMATION_ENABLED / production boot in index.js).
//
// SELF-THROTTLE: the connection carries last_inbound_sync_at (migration 107).
// Each tick only processes orgs whose last sync is older than MIN_INTERVAL so a
// short tick interval doesn't hammer the Gmail API — syncOrg's own timestamp
// cursor then bounds the per-run fetch to messages newer than that mark.
//
// GRACEFUL: syncOrg never throws for "not configured / not connected"; it
// returns a soft result we simply skip. A genuine per-org error (token revoked,
// network) is caught, logged, and does not abort the whole tick.

const pool   = require('../db');
const logger = require('./logger');
const featureFlags = require('./featureFlags');
const gmailSync = require('./gmailSync');

const DEFAULT_INTERVAL_MIN   = 30;  // how often the tick fires
const DEFAULT_MIN_INTERVAL_MIN = 15; // don't re-sync an org more often than this

let timer = null;

// Orgs with an active Gmail connection that are due for a sync (never synced,
// or last synced longer ago than minIntervalMinutes). Feature-gating is checked
// per-org in the tick so a flag flip takes effect without a restart.
async function dueOrgIds(minIntervalMinutes) {
  const r = await pool.query(
    `SELECT org_id
       FROM org_gmail_connections
      WHERE status = 'active'
        AND (last_inbound_sync_at IS NULL
             OR last_inbound_sync_at < NOW() - ($1 || ' minutes')::interval)`,
    [String(minIntervalMinutes)]
  );
  return r.rows.map((row) => row.org_id);
}

async function tick({ minIntervalMinutes = DEFAULT_MIN_INTERVAL_MIN } = {}) {
  try {
    const orgIds = await dueOrgIds(minIntervalMinutes);
    if (orgIds.length === 0) {
      logger.info?.('gmail_inbound_sync_worker_tick_idle');
      return { orgs: 0, threadsMatched: 0, messagesSynced: 0 };
    }

    let orgsProcessed = 0;
    let threadsMatched = 0;
    let messagesSynced = 0;

    for (const orgId of orgIds) {
      try {
        // Per-org feature gate — only orgs that have cleared Gmail verification
        // (and turned the module on) get auto-synced.
        const on = await featureFlags.hasFeature(orgId, 'gmail_intel_enabled');
        if (!on) continue;

        const result = await gmailSync.syncOrg({ orgId });
        if (!result || result.connected === false || result.configured === false) continue;

        threadsMatched += result.threads_matched || 0;
        messagesSynced += result.messages_synced || 0;
        orgsProcessed++;
      } catch (err) {
        logger.warn?.('gmail_inbound_sync_worker_one_org_failed', { orgId, error: err && err.message });
      }
    }

    logger.info?.('gmail_inbound_sync_worker_tick_end', { orgsProcessed, threadsMatched, messagesSynced });
    return { orgs: orgsProcessed, threadsMatched, messagesSynced };
  } catch (err) {
    logger.warn?.('gmail_inbound_sync_worker_tick_error', { error: err && err.message });
    return { orgs: 0, threadsMatched: 0, messagesSynced: 0, error: err && err.message };
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
  logger.info?.('gmail_inbound_sync_worker_started', { intervalMinutes, minIntervalMinutes });
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
