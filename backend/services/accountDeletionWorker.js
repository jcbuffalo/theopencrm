// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Background worker that processes scheduled account deletions.
//
// Runs hourly (configurable via DELETION_WORKER_INTERVAL_MINUTES). On each
// tick, finds account_deletions where status=scheduled and scheduled_at has
// passed, then for each one:
//   1. Audit-logs the start of deletion
//   2. Anonymizes / deletes workspace data tied to the user
//   3. Marks the user row as deleted (keeps the row for FK integrity; email
//      is anonymized so the address can be reused)
//   4. Marks account_deletions.status = processed
//   5. Notifies super admins
//
// Operates inside a transaction per deletion. A failure leaves status =
// failed with the error message captured for manual inspection.

const pool = require('../db');
const logger = require('./logger');
const audit = require('./audit');
const adminNotify = require('./adminNotify');

const DEFAULT_INTERVAL_MIN = 60;

let timer = null;

async function processOne(client, deletion) {
  const userId = deletion.user_id;
  const startedAt = new Date();

  // Audit BEFORE we delete anything so the trail isn't lost if the user row
  // is what we anonymize.
  await audit.record({
    event: 'account_deletion.processing',
    actorUserId: null,
    targetType: 'user',
    targetId: userId,
    meta: { deletionId: deletion.id, requested_at: deletion.requested_at, reason: deletion.reason },
  });

  // Fetch the user's email/name BEFORE anonymizing so we can include them
  // in the audit + the operator notification.
  const u = await client.query('SELECT email, name, org_id FROM users WHERE id = $1', [userId]);
  if (u.rows.length === 0) {
    // User row already gone — mark the deletion processed so it isn't re-picked
    // every tick forever (previously this returned without recording completion,
    // causing hourly reprocessing + repeated admin emails).
    await client.query(
      `UPDATE account_deletions
          SET status = 'processed',
              processed_at = NOW(),
              notes = 'User row already absent; nothing to anonymize.'
        WHERE id = $1`,
      [deletion.id]
    );
    return { skipped: true, reason: 'user_already_deleted' };
  }
  const originalEmail = u.rows[0].email;
  const orgId = u.rows[0].org_id;

  // Workspace data tied directly to this user_id. We do NOT cascade-delete
  // org_id rows — those belong to the organization and may have other
  // active users.
  const tablesScopedToUser = [
    'activities', 'tasks',
    // Their personal companies/contacts/deals/quotes — only if no other user
    // in the same org is referenced. Conservatively, we anonymize-but-keep
    // these so org reports remain intact.
  ];
  let countsDeleted = {};
  for (const t of tablesScopedToUser) {
    const r = await client.query(`DELETE FROM ${t} WHERE user_id = $1 RETURNING id`, [userId]);
    countsDeleted[t] = r.rows.length;
  }

  // Anonymize references on records that other users may still want to see
  // (e.g., a deal Alice owned shouldn't be hard-deleted when Alice leaves,
  // but her name should disappear from it).
  const recordsAnonymizedTables = ['companies', 'contacts', 'deals', 'quotes'];
  for (const t of recordsAnonymizedTables) {
    // Blank out this user's ownership/authorship but keep the row so the org's
    // history is intact. Each column is nulled ONLY where it points at the
    // departing user — a row another user owns (and this user merely touched)
    // keeps its user_id; we just scrub the created_by/updated_by references.
    await client.query(
      `UPDATE ${t}
          SET user_id    = CASE WHEN user_id    = $1 THEN NULL ELSE user_id    END,
              created_by = CASE WHEN created_by = $1 THEN NULL ELSE created_by END,
              updated_by = CASE WHEN updated_by = $1 THEN NULL ELSE updated_by END
        WHERE user_id = $1 OR created_by = $1 OR updated_by = $1`,
      [userId]
    );
  }

  // Anonymize the user row. We keep the row (don't DELETE) so foreign keys
  // pointing at it (audit_log.actor_user_id, etc.) survive. The email is
  // randomized so the original address can be re-registered.
  const anonymizedEmail = `deleted-${userId}-${Date.now()}@deleted.theopencrm.invalid`;
  await client.query(
    `UPDATE users
        SET email = $1,
            name  = '[deleted]',
            password_hash = NULL,
            status = 'deleted',
            request_company = NULL,
            request_reason = NULL,
            updated_at = NOW()
      WHERE id = $2`,
    [anonymizedEmail, userId]
  );

  await client.query(
    `UPDATE account_deletions
        SET status = 'processed',
            processed_at = NOW(),
            notes = $1
      WHERE id = $2`,
    [`Processed in ${Date.now() - startedAt.getTime()}ms. Email anonymized.`, deletion.id]
  );

  await audit.record({
    event: 'account_deletion.completed',
    actorUserId: null,
    targetType: 'user',
    targetId: userId,
    meta: { deletionId: deletion.id, originalEmail, anonymizedEmail, orgId, countsDeleted },
  });

  return { processed: true, originalEmail, countsDeleted };
}

async function tick() {
  try {
    const due = await pool.query(
      `SELECT id, user_id, requested_at, scheduled_at, reason
         FROM account_deletions
        WHERE status = 'scheduled'
          AND scheduled_at <= NOW()
        ORDER BY scheduled_at ASC
        LIMIT 50`
    );
    if (due.rows.length === 0) {
      logger.info('account_deletion_worker_tick_idle');
      return { processed: 0, failed: 0 };
    }

    logger.info('account_deletion_worker_tick_start', { count: due.rows.length });

    let processed = 0, failed = 0;
    for (const deletion of due.rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await processOne(client, deletion);
        await client.query('COMMIT');

        if (result?.processed) {
          processed++;
          // Best-effort admin notification — only for an actual anonymization.
          adminNotify.send({
            event: 'signup', // reuse channel; future: dedicated 'account_deletion_processed'
            subject: `[The Open CRM] Account deletion processed for user ${deletion.user_id}`,
            html: `<p>User ${deletion.user_id} (was: ${result.originalEmail || 'unknown'}) has been deleted per their request.</p>
                   <p>Records anonymized/deleted: <code>${JSON.stringify(result.countsDeleted || {})}</code></p>`,
            text: `Account ${deletion.user_id} (${result.originalEmail || 'unknown'}) deletion processed.`,
            throttleKey: `deletion_processed:${deletion.user_id}`,
          }).catch(() => {});
        } else if (result?.skipped) {
          // Deletion row was closed out (user already gone); no email needed.
          processed++;
        }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        failed++;
        await pool.query(
          `UPDATE account_deletions
              SET status = 'failed',
                  notes = $1
            WHERE id = $2`,
          [`Error: ${err.message?.slice(0, 500)}`, deletion.id]
        ).catch(() => {});
        logger.warn('account_deletion_worker_one_failed', { deletionId: deletion.id, error: err.message });
      } finally {
        client.release();
      }
    }

    logger.info('account_deletion_worker_tick_end', { processed, failed });
    return { processed, failed };
  } catch (err) {
    logger.warn('account_deletion_worker_tick_error', { error: err.message });
    return { processed: 0, failed: 0, error: err.message };
  }
}

function startScheduler({ intervalMinutes = DEFAULT_INTERVAL_MIN } = {}) {
  if (timer) return;
  const ms = Math.max(5, intervalMinutes) * 60 * 1000;
  // Run once at startup (5s delay so the rest of boot finishes first), then on interval.
  setTimeout(tick, 5000);
  timer = setInterval(tick, ms);
  logger.info('account_deletion_worker_started', { intervalMinutes });
}

function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  tick,
  startScheduler,
  stopScheduler,
  processOne, // exposed for tests
};
