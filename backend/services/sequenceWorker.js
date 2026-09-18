// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Email-sequence send worker (migrations 132/133).
//
// Periodic leased tick that calls sequences.processDueEnrollments() — the
// only automated sender of sequence mail. Scheduler shape mirrors
// recurringTaskWorker.js:
//
//   1. Cheap pre-check: if services/email.js has no transport, skip without
//      even claiming a lease (enrollments stay due; delivery starts when a
//      transport is configured).
//   2. Claim a single-runner lease via workerLease (worker_runs table,
//      migration 098) keyed on the current interval bucket — with multiple
//      Cloud Run instances exactly one pod sends per period. This is belt;
//      the atomic current_step claim inside processDueEnrollments is
//      suspenders (even two concurrent ticks can't double-send a step).
//   3. processDueEnrollments({ maxPerRun }) — capped per tick to bound blast
//      radius / cost; leftovers catch the next tick.
//
// On a thrown tick the lease is released so the period can be retried.

const pool = require('../db');
const email = require('./email');
const logger = require('./logger');
const workerLease = require('./workerLease');
const sequences = require('./sequences');

const WORKER_NAME = 'sequence_send';
const DEFAULT_INTERVAL_MIN = 15;
const DEFAULT_MAX_PER_RUN = 50;

// Gmail daily soft-cap. Gmail app-password SMTP suspends/blocks around ~500
// messages per day per account; blowing through it mid-drip both loses mail
// and risks the whole sending account. When the ACTIVE transport is Gmail we
// count today's rows in email_sends (all sends share the one Gmail account —
// sequences, one-offs, notifications) and stop dispatching sequence steps for
// the rest of the UTC day once the count passes the cap. Enrollments stay
// due, so delivery resumes automatically tomorrow (or immediately after
// switching to SendGrid). Override via GMAIL_DAILY_SEND_CAP.
const DEFAULT_GMAIL_DAILY_SEND_CAP = 400;

function gmailDailySendCap() {
  const n = Number(process.env.GMAIL_DAILY_SEND_CAP);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_GMAIL_DAILY_SEND_CAP;
}

// Returns the number of sends recorded today (UTC) when it matters, or null
// on any error — the guard FAILS OPEN (a broken count must not stop mail).
async function countSendsToday() {
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM email_sends
        WHERE sent_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`
    );
    return r.rows[0]?.n ?? 0;
  } catch (err) {
    logger.warn?.('sequence_worker_gmail_cap_count_failed', { error: err && err.message });
    return null;
  }
}

let timer = null;

/**
 * Period key = UTC timestamp truncated to the interval bucket, e.g.
 * '2026-07-13T14:15' for a 15-minute interval. One lease per bucket.
 */
function periodKey(now = new Date(), intervalMinutes = DEFAULT_INTERVAL_MIN) {
  const bucketMin = Math.floor(now.getUTCMinutes() / intervalMinutes) * intervalMinutes;
  return `${now.toISOString().slice(0, 13)}:${String(bucketMin).padStart(2, '0')}`;
}

async function tick({ maxPerRun = DEFAULT_MAX_PER_RUN, intervalMinutes = DEFAULT_INTERVAL_MIN } = {}) {
  // No transport → nothing to send; don't burn a lease on a no-op.
  if (!email.isConfigured()) {
    logger.info?.('sequence_worker_tick_email_not_configured');
    return { sent: 0, skipped: 'email_not_configured' };
  }

  // Gmail daily soft-cap guard (see DEFAULT_GMAIL_DAILY_SEND_CAP above).
  // Only when the active transport is Gmail; SendGrid has no such account cap.
  if (email.transportKind?.() === 'gmail') {
    const cap = gmailDailySendCap();
    const sentToday = await countSendsToday();
    if (sentToday !== null && sentToday >= cap) {
      logger.warn?.('sequence_worker_gmail_daily_cap_reached', {
        sentToday,
        cap,
        note: 'Gmail transport near its ~500/day account limit — sequence sends paused until the next UTC day. Configure SendGrid (SENDGRID_API_KEY) to lift this.',
      });
      return { sent: 0, skipped: 'gmail_daily_cap', sentToday, cap };
    }
  }

  const key = periodKey(new Date(), intervalMinutes);
  try {
    const won = await workerLease.claim(WORKER_NAME, key);
    if (!won) {
      logger.info?.('sequence_worker_lease_skipped', { periodKey: key });
      return { sent: 0, skipped: true };
    }

    const result = await sequences.processDueEnrollments({ maxPerRun });
    logger.info?.('sequence_worker_tick_end', result);
    return result;
  } catch (err) {
    // Release the lease on a failed tick so a retry within the same period
    // (e.g. another instance) can pick the work back up.
    await workerLease.release(WORKER_NAME, key).catch(() => {});
    logger.warn?.('sequence_worker_tick_error', { error: err && err.message });
    return { sent: 0, failed: 0, error: err && err.message };
  }
}

function startScheduler({ intervalMinutes = DEFAULT_INTERVAL_MIN, maxPerRun = DEFAULT_MAX_PER_RUN } = {}) {
  if (timer) return;
  const minutes = Math.max(5, intervalMinutes);
  const ms = minutes * 60 * 1000;
  // First run shortly after boot (after migrations settle), then on interval.
  setTimeout(() => { tick({ maxPerRun, intervalMinutes: minutes }).catch(() => {}); }, 5000);
  timer = setInterval(() => {
    tick({ maxPerRun, intervalMinutes: minutes }).catch(() => {});
  }, ms);
  logger.info?.('sequence_worker_started', { intervalMinutes: minutes, maxPerRun });
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { tick, startScheduler, stopScheduler, periodKey, WORKER_NAME };
