// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Background worker that fires the weekly-summary notification.
//
// Schedule: Mondays at 08:00 UTC. The codebase doesn't ship a real cron lib
// (no node-cron dependency, see services/automation.js + accountDeletionWorker.js
// for the canonical pattern), so we use a check-on-tick approach: the worker
// runs hourly, and on each tick checks "is it Monday and is the UTC hour 08?".
// If yes AND we haven't already run for this ISO-week, fire. Otherwise no-op.
//
// "Same week" is guarded two ways: a process-memory memo (lastFiredISOWeekKey,
// a cheap per-tick fast-path) AND a cross-instance run lease claimed from the
// worker_runs table (services/workerLease.js). The lease is what makes this
// safe with more than one Cloud Run instance or a restart inside the
// Monday-08:00 window — only the instance that wins the (weekly_summary, weekKey)
// claim sends. (The per-user dispatcher also has a natural ceiling: it only
// sends to users with the category enabled.)
//
// For each eligible user we call notificationDispatcher.notifyWeeklySummary
// (fire-and-forget; the dispatcher itself swallows errors). We page users in
// chunks of 100 so a tenant with thousands of users doesn't materialize a
// giant list in memory at once.

const pool   = require('../db');
const logger = require('./logger');
const notificationDispatcher = require('./notificationDispatcher');
const workerLease = require('./workerLease');

const DEFAULT_INTERVAL_MIN = 60;   // hourly tick
const DEFAULT_PAGE_SIZE    = 100;

// Target schedule: Monday (UTC day-of-week = 1), hour = 08 UTC.
const TARGET_DOW_UTC  = 1;
const TARGET_HOUR_UTC = 8;

let timer = null;
let lastFiredISOWeekKey = null;

// Tiny ISO-week key: "YYYY-Wnn". Two tick()s in the same calendar week
// return the same key so we only fire the run once per week even if the
// process happens to tick twice inside the same Monday-08:00 hour.
function isoWeekKey(d) {
  // Copy and shift to Thursday of the same ISO week (ISO weeks are anchored
  // by the Thursday). Then year of that Thursday + week-number-by-counting.
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (tmp.getUTCDay() + 6) % 7; // 0=Mon .. 6=Sun
  tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 4));
  const weekNum = 1 + Math.round(((tmp - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${tmp.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function shouldFireNow(now = new Date()) {
  return now.getUTCDay() === TARGET_DOW_UTC && now.getUTCHours() === TARGET_HOUR_UTC;
}

async function fireRun({ pageSize = DEFAULT_PAGE_SIZE } = {}) {
  // Page through users with notification_preferences set to weekly_summary
  // enabled on at least one channel. Filter at the DB layer with a JSONB
  // expression so we don't pull every user row over the wire just to drop
  // 90% of them. status != 'deleted' avoids anonymized rows from the
  // account_deletions worker.
  let lastId = 0;
  let totalQueued = 0;
  let totalScanned = 0;

  for (;;) {
    const page = await pool.query(
      `SELECT id
         FROM users
        WHERE id > $1
          AND (status IS NULL OR status <> 'deleted')
          AND (
                (notification_preferences -> 'weekly_summary' ->> 'email') = 'true'
             OR (notification_preferences -> 'weekly_summary' ->> 'sms')   = 'true'
              )
        ORDER BY id ASC
        LIMIT $2`,
      [lastId, pageSize]
    );

    if (page.rows.length === 0) break;

    for (const row of page.rows) {
      totalScanned++;
      // Await each dispatch so we don't fan out unbounded concurrency (which
      // would exhaust the pg pool / SMTP connections on a large tenant). The
      // dispatcher already swallows per-user errors, so one failure won't
      // abort the loop.
      // eslint-disable-next-line no-await-in-loop
      await notificationDispatcher.notifyWeeklySummary(row.id)
        .catch(err => console.warn('notify_weekly_summary_failed', err && err.message ? err.message : err));
      totalQueued++;
      lastId = row.id;
    }

    // If we got fewer rows than the page size, we're done.
    if (page.rows.length < pageSize) break;
  }

  return { totalQueued, totalScanned };
}

async function tick({ pageSize = DEFAULT_PAGE_SIZE, now = new Date(), force = false } = {}) {
  try {
    if (!force && !shouldFireNow(now)) {
      return { fired: false, reason: 'outside_window' };
    }
    const weekKey = isoWeekKey(now);
    if (!force && lastFiredISOWeekKey === weekKey) {
      return { fired: false, reason: 'already_fired_this_week', weekKey };
    }

    // Cross-instance guard: claim the week before sending. If another instance
    // (or an earlier restart) already claimed it, don't re-send. `force` (tests)
    // bypasses the lease.
    if (!force) {
      let claimed = false;
      try {
        claimed = await workerLease.claim('weekly_summary', weekKey);
      } catch (err) {
        logger.warn?.('weekly_summary_claim_failed', { error: err && err.message });
        return { fired: false, error: err && err.message };
      }
      if (!claimed) {
        lastFiredISOWeekKey = weekKey; // remember locally so we stop re-checking this week
        return { fired: false, reason: 'already_fired_this_week', weekKey };
      }
    }

    logger.info?.('weekly_summary_worker_run_start', { weekKey });
    let result;
    try {
      result = await fireRun({ pageSize });
    } catch (err) {
      // The send failed after we claimed — release so a later tick can retry.
      if (!force) await workerLease.release('weekly_summary', weekKey).catch(() => {});
      throw err;
    }
    lastFiredISOWeekKey = weekKey;
    logger.info?.('weekly_summary_worker_run_end', { weekKey, ...result });
    return { fired: true, weekKey, ...result };
  } catch (err) {
    logger.warn?.('weekly_summary_worker_tick_error', { error: err && err.message });
    return { fired: false, error: err && err.message };
  }
}

function startScheduler({ intervalMinutes = DEFAULT_INTERVAL_MIN, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  if (timer) return;
  const ms = Math.max(5, intervalMinutes) * 60 * 1000;
  // Run once shortly after startup so a restart inside the Monday-08:00
  // window doesn't miss the run (the lastFiredISOWeekKey memo will prevent
  // double-fire within the hour).
  setTimeout(() => { tick({ pageSize }).catch(() => {}); }, 5000);
  timer = setInterval(() => {
    tick({ pageSize }).catch(() => {});
  }, ms);
  logger.info?.('weekly_summary_worker_started', { intervalMinutes, pageSize, targetDowUtc: TARGET_DOW_UTC, targetHourUtc: TARGET_HOUR_UTC });
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  tick,
  fireRun,
  startScheduler,
  stopScheduler,
  // Exposed for tests
  isoWeekKey,
  shouldFireNow,
};
