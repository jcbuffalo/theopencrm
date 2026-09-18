// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Email-sends retention sweep.
//
// GDPR Art. 5(1)(e) "storage limitation" — personal data must not be kept
// in identifiable form for longer than is necessary. email_sends rows
// contain recipient addresses + subject + message body, all of which are
// personal data. We keep two years (matches the audit-log retention
// elsewhere on the platform) and then hard-delete in 1000-row batches.
//
// Why batches:
//   - Bounds lock time on the table so a sweep doesn't stall live sends
//   - Each batch commits independently, so a transient failure mid-sweep
//     doesn't roll back the whole tick's progress
//   - Cooperates with the (sent_at) index introduced in migration 072 —
//     the planner uses an ascending index scan per batch
//
// Why a separate worker file (not folded into accountDeletionWorker):
//   - Different cadence (daily, not hourly)
//   - Different retention rule (rolling 2y, not "scheduled by user")
//   - Mounting is independent in backend/index.js so the notifications
//     agent's worker mounts don't conflict with this one

const pool = require('../db');
const logger = require('./logger');

// Two years. If a future regulator audit demands a different bound,
// override via EMAIL_RETENTION_DAYS env var without redeploying schema.
const DEFAULT_RETENTION_DAYS  = 365 * 2;
const DEFAULT_BATCH_SIZE      = 1000;
const DEFAULT_INTERVAL_HOURS  = 24; // daily

// page_views retention (migration 165). The first-party analytics rows carry
// no PII by schema, but 180 days is all the /admin/traffic page ever charts —
// keeping more is liability without value. Piggybacks on this worker's daily
// tick (same cadence, same batched-delete pattern) rather than adding a
// fourth scheduler. Override via PAGE_VIEW_RETENTION_DAYS.
const DEFAULT_PAGE_VIEW_RETENTION_DAYS = 180;

let timer = null;
let firstRunTimeout = null;

/**
 * Run one full sweep. Loops batches until no more rows match or a safety
 * cap is hit. Returns { deleted, batches } for caller-side logging.
 */
async function tick({
  retentionDays = Number(process.env.EMAIL_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS,
  batchSize     = DEFAULT_BATCH_SIZE,
  // Safety cap on number of batches per tick — prevents an unusually large
  // backlog (e.g., the first run after a long downtime) from monopolising
  // the DB. Remaining rows just get caught on the next daily tick.
  maxBatches    = 100,
} = {}) {
  let deleted = 0;
  let batches = 0;
  try {
    for (let i = 0; i < maxBatches; i++) {
      // CTE-style delete: pick the next batch by sent_at ASC (oldest first)
      // and delete just those ids. Without the inner SELECT, a naked
      // DELETE … WHERE sent_at < $1 with no LIMIT would hold a long lock
      // on big tables. The (sent_at) index from migration 072 makes the
      // inner scan a cheap index range scan.
      const r = await pool.query(
        `WITH expired AS (
            SELECT id
              FROM email_sends
             WHERE sent_at < NOW() - ($1 || ' days')::interval
             ORDER BY sent_at ASC
             LIMIT $2
         )
         DELETE FROM email_sends
          WHERE id IN (SELECT id FROM expired)
         RETURNING id`,
        [retentionDays, batchSize]
      );
      const n = r.rowCount || 0;
      deleted += n;
      batches += 1;
      if (n < batchSize) break; // drained
    }
    logger.info('email_retention_worker_tick_complete', { deleted, batches, retentionDays });
    const pv = await sweepPageViews({ batchSize, maxBatches });
    return { deleted, batches, pageViews: pv };
  } catch (err) {
    logger.warn('email_retention_worker_tick_failed', { error: err.message, deleted, batches });
    // Still attempt the pageview sweep — the two retention rules are
    // independent; a failed email sweep shouldn't starve the other.
    const pv = await sweepPageViews({ batchSize, maxBatches });
    return { deleted, batches, error: err.message, pageViews: pv };
  }
}

/**
 * Purge page_views rows older than the retention window (default 180 days,
 * migration 165). Same batched-delete shape as the email_sends sweep. Errors
 * are contained (logged + returned) so an analytics hiccup never disturbs the
 * GDPR email sweep or the scheduler.
 */
async function sweepPageViews({
  retentionDays = Number(process.env.PAGE_VIEW_RETENTION_DAYS) || DEFAULT_PAGE_VIEW_RETENTION_DAYS,
  batchSize     = DEFAULT_BATCH_SIZE,
  maxBatches    = 100,
} = {}) {
  let deleted = 0;
  let batches = 0;
  try {
    for (let i = 0; i < maxBatches; i++) {
      const r = await pool.query(
        `WITH expired AS (
            SELECT id
              FROM page_views
             WHERE created_at < NOW() - ($1 || ' days')::interval
             ORDER BY created_at ASC
             LIMIT $2
         )
         DELETE FROM page_views
          WHERE id IN (SELECT id FROM expired)
         RETURNING id`,
        [retentionDays, batchSize]
      );
      const n = r.rowCount || 0;
      deleted += n;
      batches += 1;
      if (n < batchSize) break; // drained
    }
    logger.info('page_view_retention_sweep_complete', { deleted, batches, retentionDays });
    return { deleted, batches };
  } catch (err) {
    logger.warn('page_view_retention_sweep_failed', { error: err.message, deleted, batches });
    return { deleted, batches, error: err.message };
  }
}

/**
 * Start the daily scheduler. Fires once shortly after boot (so a fresh
 * deploy catches up), then on a 24h interval. Idempotent — calling twice
 * is a no-op.
 */
function startScheduler({ intervalHours = DEFAULT_INTERVAL_HOURS } = {}) {
  if (timer) return;
  const ms = Math.max(1, intervalHours) * 60 * 60 * 1000;

  // 30s delay on the first run so we don't compete with migration startup
  // or other boot-time workers (account-deletion fires at 5s).
  firstRunTimeout = setTimeout(() => { tick().catch(() => {}); }, 30 * 1000);
  timer = setInterval(() => { tick().catch(() => {}); }, ms);
  logger.info('email_retention_worker_started', { intervalHours, retentionDays: DEFAULT_RETENTION_DAYS, batchSize: DEFAULT_BATCH_SIZE });
}

function stopScheduler() {
  if (firstRunTimeout) { clearTimeout(firstRunTimeout); firstRunTimeout = null; }
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  tick,
  sweepPageViews,
  startScheduler,
  stopScheduler,
  // Exposed for tests
  DEFAULT_RETENTION_DAYS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_PAGE_VIEW_RETENTION_DAYS,
};
