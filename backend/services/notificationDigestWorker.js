// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Scheduler for the consolidated notification email (spec 204).
//
// Ticks every DIGEST_WORKER_INTERVAL_MINUTES (default 5) and calls
// notificationDigest.tick(), which:
//   - flushes 'batched' users whose oldest pending row is >= 15 min old
//     (claimed per user via notification_email_queue.digest_id — safe with
//     several pods);
//   - sends 'daily' users their digest at their local hour, once per local
//     day (claimed via users.digest_last_sent_at, compare-and-set).
// Once a day (first tick after 03:00 UTC) it also sweeps flushed queue rows
// older than 30 days and spent one-click tokens.
//
// Same shape as every other worker here: module-level interval handle,
// tick(), startScheduler() / stopScheduler(). Errors inside a tick are
// caught per user in the service; a tick never throws out of the interval.

const digest = require('./notificationDigest');

const DEFAULT_INTERVAL_MIN = 5;
let timer = null;
let running = false;
let lastSweepDateKey = null;

async function tick({ now = new Date() } = {}) {
  if (running) return { skipped: 'busy' };
  running = true;
  try {
    const out = await digest.tick({ now });
    const utcKey = now.toISOString().slice(0, 10);
    if (now.getUTCHours() >= 3 && lastSweepDateKey !== utcKey) {
      lastSweepDateKey = utcKey;
      try { out.swept = await digest.sweep(); } catch (err) { console.warn('digest_sweep_failed', err && err.message); }
    }
    if (out.batched || out.daily || out.errors) console.info('[digest] tick', JSON.stringify(out));
    return out;
  } finally {
    running = false;
  }
}

function startScheduler({ intervalMinutes = DEFAULT_INTERVAL_MIN } = {}) {
  if (timer) return;
  const ms = Math.max(1, Number(intervalMinutes) || DEFAULT_INTERVAL_MIN) * 60 * 1000;
  setTimeout(() => { tick().catch((err) => console.warn('digest_tick_failed', err && err.message)); }, 20000);
  timer = setInterval(() => { tick().catch((err) => console.warn('digest_tick_failed', err && err.message)); }, ms);
  if (timer.unref) timer.unref();
  console.log(`📬 Notification digest worker started (every ${ms / 60000} min; default mode ${digest.DEFAULT_MODE}, batch window ${digest.BATCH_WINDOW_MINUTES} min)`);
}

function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { tick, startScheduler, stopScheduler };
