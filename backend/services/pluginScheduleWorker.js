// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Plugin schedule worker (migration 164) — fires plugins whose trigger_event
// is 'schedule.hourly' or 'schedule.daily'.
//
// Scheduler shape mirrors sequenceWorker.js:
//   1. Leased tick via workerLease keyed on the UTC hour bucket — with
//      multiple Cloud Run instances exactly one pod dispatches per hour.
//      This is belt; the per-(plugin, dedupe_key) claim in pluginEvents is
//      suspenders (even two concurrent ticks can't double-run a plugin).
//   2. One SELECT across all orgs for active scheduled plugins, then a
//      per-org plugins_enabled flag check (cached per tick).
//   3. Sequential dispatch through pluginEvents.runTriggeredPlugin:
//        schedule.hourly → dedupe 'schedule.hourly:<YYYY-MM-DDTHH>'
//                          input { trigger: { event, date, hour } }
//        schedule.daily  → dedupe 'schedule.daily:<YYYY-MM-DD>'
//                          input { trigger: { event, date } }
//      The daily dedupe key means a daily plugin fires ONCE per UTC day no
//      matter how many hourly ticks (or instances) see it — the "fires once
//      per org-day" guarantee lives in the claim, not the clock.
//   4. Retention: dedupe-claim rows older than 30 days are swept here (the
//      only worker that owns plugin_trigger_dedupe).
//
// Runs are recorded by pluginRunner with trigger_kind='schedule' and
// trigger_source = the schedule event name; failures feed the same
// consecutive-failure auto-pause as event triggers.
//
// NOTE: 'schedule.weekly' exists in the authoring allowlist
// (pluginSpecValidator.TRIGGER_EVENTS) but is NOT dispatched yet — adding it
// is a one-line IN-list + dedupe-key change here when the product wants it.
//
// On a thrown tick the lease is released so the period can be retried.

const pool = require('../db');
const logger = require('./logger');
const workerLease = require('./workerLease');
const featureFlags = require('./featureFlags');
const pluginEvents = require('./pluginEvents');

const WORKER_NAME = 'plugin_schedule';
const DEFAULT_INTERVAL_MIN = 60; // hourly cadence
const DEDUPE_RETENTION_DAYS = 30;

let timer = null;

/**
 * Period key = the UTC hour bucket, e.g. '2026-09-17T14'. One lease per hour
 * regardless of the configured interval (a shorter interval just means the
 * losing ticks skip).
 */
function periodKey(now = new Date()) {
  return now.toISOString().slice(0, 13);
}

async function tick({ now = new Date() } = {}) {
  const hourKey = periodKey(now);           // '2026-09-17T14'
  const dateKey = hourKey.slice(0, 10);     // '2026-09-17'
  try {
    const won = await workerLease.claim(WORKER_NAME, hourKey);
    if (!won) {
      logger.info?.('plugin_schedule_lease_skipped', { periodKey: hourKey });
      return { dispatched: 0, skipped: true };
    }

    const r = await pool.query(
      `SELECT id, name, org_id, trigger_event
         FROM plugins
        WHERE status = 'active'
          AND trigger_event IN ('schedule.hourly', 'schedule.daily')
        ORDER BY org_id, id`
    );

    let dispatched = 0;
    let skipped = 0;
    const flagCache = new Map(); // orgId → boolean
    for (const plugin of r.rows) {
      const orgId = plugin.org_id;
      if (!flagCache.has(orgId)) {
        // Same effective-flag resolution as the /api/plugins mount gate.
        const enabled = await featureFlags.hasFeature(orgId, 'plugins_enabled')
          .catch(() => false);
        flagCache.set(orgId, enabled);
      }
      if (!flagCache.get(orgId)) { skipped++; continue; }

      const isDaily = plugin.trigger_event === 'schedule.daily';
      const eventName = plugin.trigger_event;
      const dedupeKey = isDaily
        ? `schedule.daily:${dateKey}`
        : `schedule.hourly:${hourKey}`;
      const payload = isDaily ? { date: dateKey } : { date: dateKey, hour: hourKey };

      // Sequential — bounds host pressure; runTriggeredPlugin never throws.
      const result = await pluginEvents.runTriggeredPlugin(
        plugin, orgId, eventName, payload,
        { dedupeKey, triggerKind: 'schedule' }
      );
      if (result.skipped) skipped++; else dispatched++;
    }

    // Retention sweep for the dedupe-claim table (this worker owns it).
    await pool.query(
      `DELETE FROM plugin_trigger_dedupe
        WHERE created_at < NOW() - INTERVAL '${DEDUPE_RETENTION_DAYS} days'`
    ).catch((err) => {
      logger.warn?.('plugin_schedule_dedupe_sweep_failed', { error: err && err.message });
    });

    logger.info?.('plugin_schedule_tick_end', { periodKey: hourKey, dispatched, skipped });
    return { dispatched, skipped };
  } catch (err) {
    // Release the lease on a failed tick so a retry within the same hour
    // (e.g. another instance) can pick the work back up.
    await workerLease.release(WORKER_NAME, hourKey).catch(() => {});
    logger.warn?.('plugin_schedule_tick_error', { error: err && err.message });
    return { dispatched: 0, error: err && err.message };
  }
}

function startScheduler({ intervalMinutes = DEFAULT_INTERVAL_MIN } = {}) {
  if (timer) return;
  const minutes = Math.max(5, intervalMinutes);
  const ms = minutes * 60 * 1000;
  // First run shortly after boot (after migrations settle), then on interval.
  setTimeout(() => { tick().catch(() => {}); }, 5000);
  timer = setInterval(() => { tick().catch(() => {}); }, ms);
  logger.info?.('plugin_schedule_worker_started', { intervalMinutes: minutes });
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { tick, startScheduler, stopScheduler, periodKey, WORKER_NAME };
